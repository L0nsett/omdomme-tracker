"""Orchestration: collect -> match -> reach -> classify -> store.

`run_hourly` covers every profile; `run_backfill` fetches history for one new
profile. Both write one row in `runs`.

Failure handling:
- `CollectorUnavailable` (no credentials, no quota) is a normal state: recorded as
  "skipped: <reason>" for that source.
- Any other exception in one collector is recorded and the rest continue.
- A run is `failed` only if every collector call that was attempted failed.
- One profile's failure never stops the others.

Hourly runs are visible to every signed-in user, so stats and error texts hold only
aggregate counters, source names and error types, never profile names or terms.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import psycopg

from omdomme import storage
from omdomme.contracts import (
    BackfillStatus,
    Classifier,
    Collector,
    CollectorUnavailable,
    FetchMode,
    Matcher,
    Mention,
    Profile,
    QuotaManager,
    ReachScorer,
    SourceType,
)

log = logging.getLogger(__name__)

# Hourly runs ask for items newer than the last successful run minus this overlap,
# so nothing falls between two runs. Duplicates are dropped by the unique key.
SINCE_OVERLAP = timedelta(hours=1)


class ProfileNotFound(LookupError):
    pass


@dataclass
class _SourceTally:
    fetched: int = 0
    matched: int = 0
    inserted: int = 0
    ok: int = 0
    skipped: int = 0
    failed: int = 0
    skip_reason: str | None = None
    errors: list[str] = field(default_factory=list)

    def summary(self) -> int | str:
        """Value for `stats.per_source`: rows inserted, or why the source did not run."""
        if self.ok:
            return self.inserted
        if self.errors:
            return f"error: {self.errors[0]}"
        return f"skipped: {self.skip_reason or 'unavailable'}"


@dataclass
class _Tally:
    profiles: int = 0
    sources: dict[str, _SourceTally] = field(default_factory=dict)
    run_errors: list[str] = field(default_factory=list)

    def source(self, name: str) -> _SourceTally:
        return self.sources.setdefault(name, _SourceTally())

    @property
    def ok(self) -> int:
        return sum(s.ok for s in self.sources.values())

    @property
    def failed(self) -> int:
        return sum(s.failed for s in self.sources.values()) + len(self.run_errors)

    @property
    def status(self) -> storage.RunStatus:
        return "failed" if self.failed and not self.ok else "success"

    def stats(self) -> dict[str, Any]:
        srcs = self.sources.values()
        return {
            "profiles": self.profiles,
            "fetched": sum(s.fetched for s in srcs),
            "matched": sum(s.matched for s in srcs),
            "inserted": sum(s.inserted for s in srcs),
            "errors": self.failed,
            "per_source": {name: s.summary() for name, s in self.sources.items()},
        }

    def error_text(self) -> str | None:
        parts = list(self.run_errors)
        for name, s in self.sources.items():
            parts.extend(f"{name}: {e}" for e in dict.fromkeys(s.errors))
        return "; ".join(parts) if parts else None


@dataclass(frozen=True)
class RunReport:
    run_id: UUID
    status: storage.RunStatus
    stats: dict[str, Any]
    error: str | None


def describe_error(exc: BaseException) -> str:
    """Short, non-sensitive description: HTTP status or exception type, no message
    (messages can contain search terms or request URLs)."""
    response = getattr(exc, "response", None)
    code = getattr(response, "status_code", None)
    if isinstance(code, int):
        reason = getattr(response, "reason_phrase", "") or ""
        return f"HTTP {code} {reason}".strip()
    return type(exc).__name__


def _finished_at(started: datetime) -> datetime:
    return max(started, datetime.now(UTC))


def _process(
    conn: psycopg.Connection,
    collector: Collector,
    profile: Profile,
    *,
    mode: FetchMode,
    since: datetime | None,
    matcher: Matcher,
    scorer: ReachScorer,
    classifier: Classifier,
    now: datetime,
    tally: _SourceTally,
) -> None:
    """Run one collector for one profile and store the matches. Raises on failure."""
    raws = collector.collect(profile, mode=mode, since=since)
    mentions: dict[tuple[str, str], Mention] = {}
    for raw in raws:
        try:
            if not matcher.matches(raw, profile):
                continue
            key = (raw.url, raw.source_type.value)
            if key in mentions:
                continue
            mentions[key] = Mention.from_raw(
                raw,
                profile_id=profile.id,
                reach_score=min(1.0, max(0.0, scorer.score(raw))),
                classification=classifier.classify(raw, profile),
                fetched_at=now,
            )
        except Exception as exc:  # one bad item must not sink the batch
            log.warning("skipping one %s item: %s", collector.source_type, describe_error(exc))
    inserted = storage.upsert_mentions(conn, mentions.values())
    tally.fetched += len(raws)
    tally.matched += len(mentions)
    tally.inserted += inserted
    tally.ok += 1


def _run_profile(
    conn: psycopg.Connection,
    profile: Profile,
    collectors: Sequence[Collector],
    *,
    mode: FetchMode,
    since: datetime | None,
    web_search_due: bool,
    matcher: Matcher,
    scorer: ReachScorer,
    classifier: Classifier,
    now: datetime,
    tally: _Tally,
) -> None:
    web_search_attempted = False
    for collector in collectors:
        name = collector.source_type.value
        src = tally.source(name)
        is_web = collector.source_type == SourceType.WEB_SEARCH
        if is_web and not web_search_due:
            src.skipped += 1
            src.skip_reason = src.skip_reason or "not due"
            continue
        try:
            if is_web:
                web_search_attempted = True
            _process(
                conn,
                collector,
                profile,
                mode=mode,
                since=since,
                matcher=matcher,
                scorer=scorer,
                classifier=classifier,
                now=now,
                tally=src,
            )
        except CollectorUnavailable as exc:
            if is_web:
                web_search_attempted = False
            src.skipped += 1
            src.skip_reason = src.skip_reason or (str(exc).strip() or "unavailable")
            log.info("%s skipped for profile %s: %s", name, profile.id, exc)
        except Exception as exc:
            src.failed += 1
            src.errors.append(describe_error(exc))
            log.exception("%s failed for profile %s", name, profile.id)
    if web_search_attempted:
        # Also after an error: credits may have been spent, so wait for the next slot.
        storage.set_last_web_search_at(conn, profile.id, now)


def _web_search_due(
    quota: QuotaManager, profile: Profile, n_profiles: int, now: datetime, tally: _Tally
) -> bool:
    try:
        return quota.is_due(profile, n_profiles, now)
    except Exception as exc:
        src = tally.source(SourceType.WEB_SEARCH.value)
        src.failed += 1
        src.errors.append(describe_error(exc))
        log.exception("quota check failed for profile %s", profile.id)
        return False


def run_hourly(
    conn: psycopg.Connection,
    collectors: Sequence[Collector],
    matcher: Matcher,
    scorer: ReachScorer,
    classifier: Classifier,
    quota: QuotaManager,
    now: datetime,
) -> RunReport:
    """Collect new items for every profile. Web search only for profiles that are due."""
    last_success = storage.last_successful_hourly_run(conn)
    since = last_success - SINCE_OVERLAP if last_success else None
    run_id = storage.start_run(conn, "hourly", now)
    tally = _Tally()
    has_web = any(c.source_type == SourceType.WEB_SEARCH for c in collectors)
    try:
        profiles = storage.load_profiles(conn)
        tally.profiles = len(profiles)
        for profile in profiles:
            try:
                due = has_web and _web_search_due(quota, profile, len(profiles), now, tally)
                _run_profile(
                    conn,
                    profile,
                    collectors,
                    mode=FetchMode.HOURLY,
                    since=since,
                    web_search_due=due,
                    matcher=matcher,
                    scorer=scorer,
                    classifier=classifier,
                    now=now,
                    tally=tally,
                )
            except Exception as exc:
                tally.run_errors.append(f"profile: {describe_error(exc)}")
                log.exception("hourly run failed for profile %s", profile.id)
    except Exception as exc:
        tally.run_errors.append(f"run: {describe_error(exc)}")
        log.exception("hourly run failed")
    return _finish(conn, run_id, tally, now)


def run_backfill(
    conn: psycopg.Connection,
    profile_id: UUID,
    collectors: Sequence[Collector],
    matcher: Matcher,
    scorer: ReachScorer,
    classifier: Classifier,
    now: datetime,
) -> RunReport:
    """Fetch history for one profile. Web search always runs (Serper first).

    Sets `backfill_status` running -> done/failed. Raises `ProfileNotFound`.
    """
    profile = storage.load_profile(conn, profile_id)
    if profile is None:
        raise ProfileNotFound(str(profile_id))
    storage.set_backfill_status(conn, profile.id, BackfillStatus.RUNNING)
    run_id = storage.start_run(conn, "backfill", now, profile_id=profile.id)
    tally = _Tally(profiles=1)
    try:
        _run_profile(
            conn,
            profile,
            collectors,
            mode=FetchMode.BACKFILL,
            since=None,
            web_search_due=True,
            matcher=matcher,
            scorer=scorer,
            classifier=classifier,
            now=now,
            tally=tally,
        )
    except Exception as exc:
        tally.run_errors.append(f"run: {describe_error(exc)}")
        log.exception("backfill failed for profile %s", profile.id)
    report = _finish(conn, run_id, tally, now)
    final = BackfillStatus.DONE if report.status == "success" else BackfillStatus.FAILED
    storage.set_backfill_status(conn, profile.id, final)
    return report


def _finish(conn: psycopg.Connection, run_id: UUID, tally: _Tally, now: datetime) -> RunReport:
    report = RunReport(run_id, tally.status, tally.stats(), tally.error_text())
    storage.finish_run(
        conn,
        run_id,
        status=report.status,
        stats=report.stats,
        error=report.error,
        finished_at=_finished_at(now),
    )
    log.info("run %s finished: %s %s", run_id, report.status, report.stats)
    return report
