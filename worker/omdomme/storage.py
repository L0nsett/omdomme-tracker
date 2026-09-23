"""Database access for the worker (psycopg 3, connected as `postgres`, bypasses RLS).

Every function takes an open connection. The CLI opens it with autocommit, so each
statement commits on its own and a failed statement never poisons later ones;
multi-row writes use an explicit transaction.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from omdomme.contracts import BackfillStatus, Mention, Profile

RunKind = Literal["hourly", "backfill"]
RunStatus = Literal["running", "success", "failed"]

_PROFILE_SELECT = """
select p.id, p.name, p.website_url, p.social_links, p.created_at,
       p.backfill_status, p.last_web_search_at,
       coalesce(
         json_agg(
           json_build_object(
             'term', r.term,
             'context_terms', r.context_terms,
             'is_exclusion', r.is_exclusion
           ) order by r.created_at, r.id
         ) filter (where r.id is not null),
         '[]'::json
       ) as keyword_rules
from public.profiles p
left join public.keyword_rules r on r.profile_id = p.id
"""


def _to_profile(row: dict[str, Any]) -> Profile:
    return Profile.model_validate(row)


def load_profiles(conn: psycopg.Connection) -> list[Profile]:
    """All profiles with their keyword rules, oldest first."""
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_PROFILE_SELECT + " group by p.id order by p.created_at, p.id")
        return [_to_profile(row) for row in cur.fetchall()]


def load_profile(conn: psycopg.Connection, profile_id: UUID) -> Profile | None:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_PROFILE_SELECT + " where p.id = %s group by p.id", (profile_id,))
        row = cur.fetchone()
    return _to_profile(row) if row else None


_INSERT_MENTION = """
insert into public.mentions (
  profile_id, url, title, snippet, source_type, source_name, published_at, fetched_at,
  reach_score, sentiment, sentiment_score, confidence, classifier_version, hidden
) values (
  %(profile_id)s, %(url)s, %(title)s, %(snippet)s, %(source_type)s, %(source_name)s,
  %(published_at)s, %(fetched_at)s, %(reach_score)s, %(sentiment)s, %(sentiment_score)s,
  %(confidence)s, %(classifier_version)s, %(hidden)s
)
on conflict (profile_id, url, source_type) do nothing
returning id
"""


def upsert_mentions(conn: psycopg.Connection, mentions: Iterable[Mention]) -> int:
    """Insert new mentions; existing rows (and their `hidden` flag) are left untouched.

    Returns the number of rows actually inserted.
    """
    inserted = 0
    with conn.transaction(), conn.cursor() as cur:
        for mention in mentions:
            cur.execute(_INSERT_MENTION, mention.model_dump(mode="json"))
            if cur.fetchone() is not None:
                inserted += 1
    return inserted


def start_run(
    conn: psycopg.Connection,
    kind: RunKind,
    started_at: datetime,
    profile_id: UUID | None = None,
) -> UUID:
    row = conn.execute(
        "insert into public.runs (kind, profile_id, started_at, status) "
        "values (%s, %s, %s, 'running') returning id",
        (kind, profile_id, started_at),
    ).fetchone()
    assert row is not None
    return row[0]


def finish_run(
    conn: psycopg.Connection,
    run_id: UUID,
    *,
    status: RunStatus,
    stats: dict[str, Any],
    error: str | None,
    finished_at: datetime,
) -> None:
    """Close a run. `stats` must hold aggregate counters only (runs are readable
    by every signed-in user for hourly runs)."""
    conn.execute(
        "update public.runs set status = %s, stats = %s, error = %s, finished_at = %s "
        "where id = %s",
        (status, Jsonb(stats), error, finished_at, run_id),
    )


def set_backfill_status(conn: psycopg.Connection, profile_id: UUID, status: BackfillStatus) -> None:
    conn.execute(
        "update public.profiles set backfill_status = %s where id = %s",
        (status.value, profile_id),
    )


def claim_backfill(conn: psycopg.Connection, profile_id: UUID, *, force: bool = False) -> bool:
    """Atomically mark a backfill as running. False if one already ran or is running,
    so a repeated dispatch can't spend the one-time Serper quota twice."""
    row = conn.execute(
        "update public.profiles set backfill_status = 'running'"
        " where id = %s and (%s or backfill_status in ('pending', 'failed'))"
        " returning id",
        (profile_id, force),
    ).fetchone()
    return row is not None


def stale_pending_backfills(conn: psycopg.Connection, created_before: datetime) -> list[UUID]:
    """Profiles whose backfill never started (e.g. a queued Actions run was dropped)."""
    rows = conn.execute(
        "select id from public.profiles where backfill_status = 'pending' and created_at < %s"
        " order by created_at",
        (created_before,),
    ).fetchall()
    return [r[0] for r in rows]


def set_last_web_search_at(conn: psycopg.Connection, profile_id: UUID, when: datetime) -> None:
    conn.execute(
        "update public.profiles set last_web_search_at = %s where id = %s",
        (when, profile_id),
    )


def last_successful_hourly_run(conn: psycopg.Connection) -> datetime | None:
    """Start time of the latest successful hourly run (used as `since`)."""
    row = conn.execute(
        "select max(started_at) from public.runs where kind = 'hourly' and status = 'success'"
    ).fetchone()
    return row[0] if row else None
