"""Command line entry point used by GitHub Actions.

    python -m omdomme hourly
    python -m omdomme backfill --profile-id <uuid>

Exit codes: 0 success, 1 run failed, 2 bad usage or configuration.
"""

from __future__ import annotations

import argparse
import logging
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

import httpx
import psycopg

from omdomme import pipeline, storage
from omdomme.config import load_settings
from omdomme.contracts import NullClassifier
from omdomme.matching import KeywordMatcher
from omdomme.reach import TrancoReachScorer

log = logging.getLogger("omdomme")

# worker/.cache (cached in Actions between runs; ignored by git).
CACHE_DIR = Path(__file__).resolve().parents[1] / ".cache"
HTTP_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
# A profile still `pending` this long after creation lost its backfill dispatch
# (e.g. a queued Actions run was dropped); the hourly job runs it instead.
STALE_BACKFILL_AFTER = timedelta(minutes=20)
USER_AGENT = "omdomme-tracker/0.1 (+https://github.com/L0nsett/omdomme-tracker)"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="omdomme", description="Omdømme-tracker worker")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("hourly", help="collect new mentions for every profile")
    backfill = sub.add_parser("backfill", help="fetch history for one new profile")
    backfill.add_argument("--profile-id", required=True, type=UUID, help="profile uuid")
    backfill.add_argument(
        "--force", action="store_true", help="run again even if the backfill already ran"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    # httpx logs every request URL at INFO; those URLs carry search terms, and
    # Actions logs are public.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    settings = load_settings()
    if not settings.database_url:
        log.error("DATABASE_URL is not set")
        return 2

    # Collectors and quota manager (agent A). Imported lazily so the rest of the
    # worker and its tests do not depend on them.
    from omdomme.collectors import build_collectors
    from omdomme.quota import PostgresQuotaManager

    now = datetime.now(UTC)
    with (
        psycopg.connect(settings.database_url, autocommit=True, prepare_threshold=None) as conn,
        httpx.Client(
            # No redirects: custom API key headers (Exa, Serper) would be forwarded.
            timeout=HTTP_TIMEOUT,
            follow_redirects=False,
            headers={"User-Agent": USER_AGENT},
        ) as http,
    ):
        quota = PostgresQuotaManager(conn)
        collectors = build_collectors(settings, http, quota)
        scorer = TrancoReachScorer.from_cache(CACHE_DIR, http, now.date())
        matcher = KeywordMatcher()
        classifier = NullClassifier()

        if args.command == "hourly":
            report = pipeline.run_hourly(conn, collectors, matcher, scorer, classifier, quota, now)
            ok = report.status == "success"
            print(f"hourly run {report.run_id}: {report.status} {report.stats}")
            for profile_id in storage.stale_pending_backfills(conn, now - STALE_BACKFILL_AFTER):
                try:
                    late = pipeline.run_backfill(
                        conn, profile_id, collectors, matcher, scorer, classifier, now
                    )
                except (pipeline.BackfillNotNeeded, pipeline.ProfileNotFound):
                    continue
                print(f"catch-up backfill run {late.run_id}: {late.status} {late.stats}")
                ok = ok and late.status == "success"
            return 0 if ok else 1

        try:
            report = pipeline.run_backfill(
                conn,
                args.profile_id,
                collectors,
                matcher,
                scorer,
                classifier,
                now,
                force=args.force,
            )
        except pipeline.ProfileNotFound:
            log.error("profile %s not found", args.profile_id)
            return 2
        except pipeline.BackfillNotNeeded:
            print(
                f"backfill for {args.profile_id} already ran or is running; use --force to repeat"
            )
            return 0

    print(f"backfill run {report.run_id}: {report.status} {report.stats}")
    return 0 if report.status == "success" else 1
