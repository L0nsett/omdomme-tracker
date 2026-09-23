"""End-to-end: fake collectors -> pipeline -> real (test) Postgres."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID

import psycopg
import pytest
from psycopg.rows import dict_row

from omdomme import pipeline, storage
from omdomme.contracts import (
    BackfillStatus,
    Collector,
    CollectorUnavailable,
    FetchMode,
    KeywordRule,
    NullClassifier,
    Profile,
    RawMention,
    SourceType,
)
from omdomme.matching import KeywordMatcher
from omdomme.reach import rank_to_score, reddit_score
from tests.pipeline.fixture_items import (
    FakeQuota,
    exa_items,
    expected,
    gdelt_items,
    google_news_items,
    insert_profile,
    reddit_items,
    serper_items,
    tavily_items,
    tranco_scorer,
)

pytestmark = pytest.mark.db

NOW = datetime(2026, 9, 23, 9, 17, tzinfo=UTC)
EXPECTED_ROWS = {k for k, match in expected().items() if match}


class FakeCollector(Collector):
    def __init__(
        self,
        source_type: SourceType,
        items: Callable[[FetchMode], list[RawMention]] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.source_type = source_type  # type: ignore[misc]
        self._items = items or (lambda mode: [])
        self._error = error
        self.calls: list[tuple[UUID, FetchMode, datetime | None]] = []

    def collect(self, profile, *, mode, since=None):
        self.calls.append((profile.id, mode, since))
        if self._error is not None:
            raise self._error
        return self._items(mode)


def web_items(mode: FetchMode) -> list[RawMention]:
    if mode == FetchMode.HOURLY:
        return tavily_items() + exa_items()
    return serper_items() + tavily_items() + exa_items()


def good_collectors() -> list[FakeCollector]:
    return [
        FakeCollector(SourceType.GOOGLE_NEWS, lambda m: google_news_items()),
        FakeCollector(SourceType.GDELT, lambda m: gdelt_items()),
        FakeCollector(SourceType.REDDIT, lambda m: reddit_items()),
        FakeCollector(SourceType.WEB_SEARCH, web_items),
    ]


def hourly(conn, collectors, quota=None, now=NOW) -> pipeline.RunReport:
    return pipeline.run_hourly(
        conn,
        collectors,
        KeywordMatcher(),
        tranco_scorer(),
        NullClassifier(),
        quota or FakeQuota(),
        now,
    )


def backfill(conn, profile_id, collectors, now=NOW, force=True) -> pipeline.RunReport:
    return pipeline.run_backfill(
        conn,
        profile_id,
        collectors,
        KeywordMatcher(),
        tranco_scorer(),
        NullClassifier(),
        now,
        force=force,
    )


def mentions(conn: psycopg.Connection, profile_id: UUID | None = None) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        if profile_id:
            cur.execute("select * from mentions where profile_id = %s", (profile_id,))
        else:
            cur.execute("select * from mentions")
        return cur.fetchall()


def keys(rows: list[dict]) -> set[tuple[str, str]]:
    return {(r["source_type"], r["url"]) for r in rows}


def runs(conn: psycopg.Connection) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("select * from runs order by started_at, finished_at")
        return cur.fetchall()


@pytest.fixture
def relu(db: psycopg.Connection, relu_profile: Profile) -> Profile:
    profile = relu_profile.model_copy(update={"backfill_status": BackfillStatus.PENDING})
    insert_profile(db, profile)
    return profile


def test_storage_loads_profile_with_rules(db, relu: Profile) -> None:
    loaded = storage.load_profile(db, relu.id)
    assert loaded == relu
    assert storage.load_profiles(db) == [relu]
    assert storage.load_profile(db, UUID(int=1)) is None


def test_hourly_then_backfill_gives_exactly_the_expected_rows(db, relu: Profile) -> None:
    gdelt_broken = FakeCollector(SourceType.GDELT, error=RuntimeError("boom 'ReLU NTNU'"))
    reddit_off = FakeCollector(SourceType.REDDIT, error=CollectorUnavailable("no credentials"))
    news, web = good_collectors()[0], good_collectors()[3]
    quota = FakeQuota()

    report = hourly(db, [news, gdelt_broken, reddit_off, web], quota)

    hourly_expected = {k for k in EXPECTED_ROWS if k[0] in ("google_news", "web_search")}
    hourly_expected -= {("web_search", i.url) for i in serper_items()}
    assert len(hourly_expected) == 6
    rows = mentions(db)
    assert keys(rows) == hourly_expected
    assert report.status == "success"
    assert report.stats == {
        "profiles": 1,
        "fetched": 5 + 5,
        "matched": 6,
        "inserted": 6,
        "errors": 1,
        "per_source": {
            "google_news": 3,
            "gdelt": "error: RuntimeError",
            "reddit": "skipped: no credentials",
            "web_search": 3,
        },
    }
    # error text names the source and exception type, never the message or terms
    assert report.error == "gdelt: RuntimeError"
    assert quota.is_due_calls == [(relu.id, 1, NOW)]
    assert news.calls == [(relu.id, FetchMode.HOURLY, None)]
    assert storage.load_profile(db, relu.id).last_web_search_at == NOW

    [run] = runs(db)
    assert run["kind"] == "hourly" and run["profile_id"] is None
    assert run["status"] == "success" and run["finished_at"] >= run["started_at"]
    assert run["stats"] == report.stats and run["error"] == report.error

    # Backfill with every source working fills in the rest.
    later = NOW + timedelta(minutes=5)
    report = backfill(db, relu.id, good_collectors(), now=later)
    assert report.status == "success" and report.error is None
    assert report.stats["inserted"] == len(EXPECTED_ROWS) - 6
    assert report.stats["matched"] == len(EXPECTED_ROWS)
    assert report.stats["fetched"] == 5 + 4 + 4 + 3 + 3 + 2
    rows = mentions(db)
    assert keys(rows) == EXPECTED_ROWS
    assert len(rows) == 14

    profile = storage.load_profile(db, relu.id)
    assert profile.backfill_status == BackfillStatus.DONE
    assert profile.last_web_search_at == later
    backfill_run = runs(db)[-1]
    assert backfill_run["kind"] == "backfill" and backfill_run["profile_id"] == relu.id
    assert backfill_run["status"] == "success"


def test_rows_have_reach_and_empty_sentiment(db, relu: Profile) -> None:
    backfill(db, relu.id, good_collectors())
    by_url = {r["url"]: r for r in mentions(db)}
    for row in by_url.values():
        assert 0 <= row["reach_score"] <= 1
        assert row["sentiment"] is None and row["sentiment_score"] is None
        assert row["confidence"] is None and row["classifier_version"] is None
        assert row["hidden"] is False and row["fetched_at"] == NOW
        assert row["profile_id"] == relu.id


def test_reach_values(db, relu: Profile) -> None:
    backfill(db, relu.id, good_collectors())
    rows = {(r["source_type"], r["title"]): r for r in mentions(db)}
    nrk = next(r for (s, t), r in rows.items() if s == "google_news" and "ReLU NTNU-lag" in t)
    assert nrk["source_name"] == "nrk.no"
    assert nrk["reach_score"] == pytest.approx(rank_to_score(1500), abs=1e-6)
    reddit = next(r for (s, t), r in rows.items() if s == "reddit" and "workshop" in t)
    assert reddit["reach_score"] == pytest.approx(reddit_score(45, 12), abs=1e-6)
    gdelt = {r["url"]: r["reach_score"] for r in rows.values() if r["source_type"] == "gdelt"}
    itavisen = gdelt["https://www.itavisen.no/2026/09/19/relu-ntnu-nordic-student-ai-conference"]
    unia = gdelt["https://www.universitetsavisa.no/relu-hackathon"]
    assert itavisen > unia > 0


def test_rerun_inserts_nothing_and_keeps_hidden_flag(db, relu: Profile) -> None:
    backfill(db, relu.id, good_collectors())
    hidden_url = "https://www.reddit.com/r/trondheim/comments/1abc04/gratis_aikurs_for_studenter_denne_helgen/"
    db.execute(
        "update mentions set hidden = true, reach_score = 0.99 where url = %s", (hidden_url,)
    )

    report = hourly(db, good_collectors(), now=NOW + timedelta(hours=1))
    assert report.stats["inserted"] == 0
    assert report.stats["matched"] == 14 - 2  # hourly web search: no Serper (2 matches)
    report = backfill(db, relu.id, good_collectors(), now=NOW + timedelta(hours=2))
    assert report.stats["inserted"] == 0

    rows = mentions(db)
    assert len(rows) == 14
    [hidden] = [r for r in rows if r["url"] == hidden_url]
    assert hidden["hidden"] is True and hidden["reach_score"] == pytest.approx(0.99)
    assert hidden["fetched_at"] == NOW  # original row untouched


def test_web_search_only_when_due(db, relu: Profile) -> None:
    web = FakeCollector(SourceType.WEB_SEARCH, web_items)
    news = FakeCollector(SourceType.GOOGLE_NEWS, lambda m: google_news_items())
    report = hourly(db, [news, web], FakeQuota(due_all=False))
    assert web.calls == []
    assert report.stats["per_source"] == {"google_news": 3, "web_search": "skipped: not due"}
    assert report.status == "success"
    assert storage.load_profile(db, relu.id).last_web_search_at is None

    # Backfill ignores the quota schedule.
    backfill(db, relu.id, [web])
    assert web.calls == [(relu.id, FetchMode.BACKFILL, None)]
    assert storage.load_profile(db, relu.id).last_web_search_at == NOW


def test_unavailable_web_search_does_not_set_last_search(db, relu: Profile) -> None:
    web = FakeCollector(SourceType.WEB_SEARCH, error=CollectorUnavailable("quota exhausted"))
    report = hourly(db, [web])
    assert report.stats["per_source"] == {"web_search": "skipped: quota exhausted"}
    assert report.status == "success" and report.error is None
    assert storage.load_profile(db, relu.id).last_web_search_at is None


def test_hourly_since_is_last_successful_run(db, relu: Profile) -> None:
    news = FakeCollector(SourceType.GOOGLE_NEWS, lambda m: [])
    hourly(db, [news], now=NOW)
    broken = FakeCollector(SourceType.GOOGLE_NEWS, error=RuntimeError())
    assert hourly(db, [broken], now=NOW + timedelta(hours=1)).status == "failed"
    hourly(db, [news], now=NOW + timedelta(hours=2))
    assert news.calls == [
        (relu.id, FetchMode.HOURLY, None),
        (relu.id, FetchMode.HOURLY, NOW - pipeline.SINCE_OVERLAP),  # failed run is ignored
    ]


def test_run_fails_only_if_everything_failed(db, relu: Profile) -> None:
    report = hourly(
        db,
        [
            FakeCollector(SourceType.GDELT, error=RuntimeError()),
            FakeCollector(SourceType.REDDIT, error=CollectorUnavailable("no credentials")),
            FakeCollector(SourceType.GOOGLE_NEWS, error=ValueError()),
        ],
        FakeQuota(),
    )
    assert report.status == "failed"
    assert report.error == "gdelt: RuntimeError; google_news: ValueError"
    assert report.stats["per_source"]["reddit"] == "skipped: no credentials"
    assert runs(db)[-1]["status"] == "failed"

    # Only skipped sources is not a failure.
    off = FakeCollector(SourceType.REDDIT, error=CollectorUnavailable("no credentials"))
    assert hourly(db, [off]).status == "success"


def test_http_errors_are_described_by_status(db, relu: Profile) -> None:
    import httpx

    request = httpx.Request("GET", "https://api.gdeltproject.org/api/v2/doc/doc?query=secret")
    exc = httpx.HTTPStatusError("x", request=request, response=httpx.Response(503, request=request))
    report = hourly(db, [FakeCollector(SourceType.GDELT, error=exc)])
    assert report.error == "gdelt: HTTP 503 Service Unavailable"
    assert "secret" not in str(report.stats)


def test_one_profiles_failure_does_not_stop_others(db, relu: Profile) -> None:
    other = Profile(
        id=UUID("22222222-2222-4222-8222-222222222222"),
        name="Other Org",
        keyword_rules=[KeywordRule(term="Universitetsavisa")],
        created_at=NOW - timedelta(days=1),
    )
    insert_profile(db, other)

    class PickyCollector(Collector):
        source_type = SourceType.GDELT

        def collect(self, profile, *, mode, since=None):
            if profile.id == relu.id:
                raise RuntimeError("relu only")
            return [
                RawMention(
                    url="https://www.universitetsavisa.no/om",
                    title="Om Universitetsavisa",
                    source_type=SourceType.GDELT,
                    source_name="universitetsavisa.no",
                )
            ]

    quota = FakeQuota()
    report = hourly(db, [PickyCollector()], quota)
    assert report.status == "success"
    assert report.stats["profiles"] == 2 and report.stats["inserted"] == 1
    assert report.error == "gdelt: RuntimeError"
    assert keys(mentions(db, other.id)) == {("gdelt", "https://www.universitetsavisa.no/om")}
    assert mentions(db, relu.id) == []
    assert quota.is_due_calls == []  # no web search collector => no quota checks


def test_backfill_failure_sets_status_failed(db, relu: Profile) -> None:
    report = backfill(db, relu.id, [FakeCollector(SourceType.GDELT, error=RuntimeError())])
    assert report.status == "failed"
    assert storage.load_profile(db, relu.id).backfill_status == BackfillStatus.FAILED
    run = runs(db)[-1]
    assert run["kind"] == "backfill" and run["status"] == "failed"
    assert run["error"] == "gdelt: RuntimeError"


def test_backfill_status_is_running_during_the_run(db, relu: Profile) -> None:
    seen = []

    class Spy(Collector):
        source_type = SourceType.GDELT

        def collect(self, profile, *, mode, since=None):
            seen.append(storage.load_profile(db, relu.id).backfill_status)
            [run] = runs(db)
            seen.append(run["status"])
            return []

    backfill(db, relu.id, [Spy()])
    assert seen == [BackfillStatus.RUNNING, "running"]
    assert storage.load_profile(db, relu.id).backfill_status == BackfillStatus.DONE


def test_backfill_unknown_profile(db) -> None:
    with pytest.raises(pipeline.ProfileNotFound):
        backfill(db, UUID(int=7), good_collectors())
    assert runs(db) == []


def test_bad_item_is_skipped_not_fatal(db, relu: Profile) -> None:
    class BadScorer:
        def score(self, raw):
            if "hackathon" in raw.url:
                raise ValueError("bad")
            return 0.5

    collector = FakeCollector(SourceType.GDELT, lambda m: gdelt_items())
    report = pipeline.run_hourly(
        db, [collector], KeywordMatcher(), BadScorer(), NullClassifier(), FakeQuota(), NOW
    )
    assert report.status == "success"
    assert report.stats["inserted"] == 2  # 3 matches minus the bad one


def test_backfill_is_claimed_once(db, relu: Profile) -> None:
    db.execute("update profiles set backfill_status = 'pending' where id = %s", (relu.id,))
    assert backfill(db, relu.id, good_collectors(), force=False).status == "success"
    # A second dispatch (e.g. the user clicking again) must not spend Serper again.
    with pytest.raises(pipeline.BackfillNotNeeded):
        backfill(db, relu.id, good_collectors(), force=False)
    # A failed backfill may be retried.
    storage.set_backfill_status(db, relu.id, BackfillStatus.FAILED)
    assert backfill(db, relu.id, good_collectors(), force=False).status == "success"


def test_stale_pending_backfills(db, relu: Profile) -> None:
    db.execute(
        "update profiles set backfill_status = 'pending', created_at = %s where id = %s",
        (NOW - timedelta(hours=1), relu.id),
    )
    assert storage.stale_pending_backfills(db, NOW - timedelta(minutes=20)) == [relu.id]
    assert storage.stale_pending_backfills(db, NOW - timedelta(hours=2)) == []
    storage.claim_backfill(db, relu.id)
    assert storage.stale_pending_backfills(db, NOW - timedelta(minutes=20)) == []
