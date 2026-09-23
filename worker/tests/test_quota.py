from __future__ import annotations

import random
import threading
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal

import psycopg
import pytest

from omdomme.contracts import FetchMode, Profile, WebSearchProvider
from omdomme.limits import MIN_WEB_SEARCH_INTERVAL, QUOTA_LIMITS, SAFETY_MARGIN, usable_limit
from omdomme.quota import (
    BaseQuotaManager,
    InMemoryQuotaManager,
    PostgresQuotaManager,
    exa_search_cost,
    month_start,
    next_month_start,
    request_cost,
)

T, E, S = WebSearchProvider.TAVILY, WebSearchProvider.EXA, WebSearchProvider.SERPER
SEP = datetime(2026, 9, 15, 12, 0, tzinfo=UTC)
OCT = datetime(2026, 10, 2, 8, 0, tzinfo=UTC)
AUG = datetime(2026, 8, 20, tzinfo=UTC)


@pytest.fixture(params=["memory", pytest.param("postgres", marks=pytest.mark.db)])
def quota(request) -> BaseQuotaManager:
    if request.param == "memory":
        return InMemoryQuotaManager()
    return PostgresQuotaManager(request.getfixturevalue("db"))


def spend_to(quota: BaseQuotaManager, provider: WebSearchProvider, left: float, now: datetime):
    """Record usage so that exactly `left` remains."""
    amount = usable_limit(provider) - left
    assert quota.try_consume(provider, amount, now)
    assert quota.remaining(provider, now) == pytest.approx(left)


# ---------------------------------------------------------------------------
# Limits and costs
# ---------------------------------------------------------------------------


def test_usable_limits_keep_the_safety_margin():
    assert SAFETY_MARGIN == 0.05
    assert usable_limit(T) == pytest.approx(950)
    assert usable_limit(E) == pytest.approx(9.5)
    assert usable_limit(S) == pytest.approx(2375)
    for p in WebSearchProvider:
        assert usable_limit(p) < QUOTA_LIMITS[p]


def test_request_costs():
    assert request_cost(T) == 1
    assert request_cost(S) == 1
    assert request_cost(E) == pytest.approx(0.017)
    assert exa_search_cost(5) == pytest.approx(0.012)
    assert exa_search_cost(20) == pytest.approx(0.007 + 0.010 + 0.020)
    assert exa_search_cost(10, highlights=False) == pytest.approx(0.007)


def test_month_helpers():
    assert month_start(SEP) == date(2026, 9, 1)
    assert month_start(datetime(2026, 12, 31, 23, 30, tzinfo=UTC)) == date(2026, 12, 1)
    assert next_month_start(datetime(2026, 12, 31, 23, 30, tzinfo=UTC)) == datetime(
        2027, 1, 1, tzinfo=UTC
    )
    # 01:30 on Oct 1 in Oslo (UTC+2) is still September in UTC.
    oslo = datetime(2026, 10, 1, 1, 30, tzinfo=timezone(timedelta(hours=2)))
    assert month_start(oslo) == date(2026, 9, 1)


# ---------------------------------------------------------------------------
# try_consume / remaining (both backends)
# ---------------------------------------------------------------------------


def test_fresh_quota_is_full(quota):
    for p in WebSearchProvider:
        assert quota.remaining(p, SEP) == pytest.approx(usable_limit(p))


def test_try_consume_refuses_beyond_limit(quota):
    assert quota.try_consume(T, 949, SEP)
    assert not quota.try_consume(T, 2, SEP)
    assert quota.remaining(T, SEP) == pytest.approx(1)
    assert quota.try_consume(T, 1, SEP)
    assert not quota.try_consume(T, 1, SEP)
    assert quota.remaining(T, SEP) == 0
    assert quota.try_consume(T, 0, SEP)  # spending nothing is always fine


def test_single_request_larger_than_limit_is_refused(quota):
    assert not quota.try_consume(E, 9.51, SEP)
    assert quota.remaining(E, SEP) == pytest.approx(9.5)


def test_negative_amount_is_rejected(quota):
    with pytest.raises(ValueError):
        quota.try_consume(T, -1, SEP)


def test_exa_cents_add_up_exactly(quota):
    n = 0
    while quota.try_consume(E, exa_search_cost(), SEP):
        n += 1
    assert n == int(Decimal("9.5") / Decimal("0.017"))  # 558, no float drift
    assert quota.remaining(E, SEP) < exa_search_cost()


def test_month_rollover(quota):
    spend_to(quota, T, 0, SEP)
    spend_to(quota, E, 0, SEP)
    assert quota.pick_provider(FetchMode.HOURLY, SEP) is None
    # New month: full monthly quotas again.
    assert quota.remaining(T, OCT) == pytest.approx(950)
    assert quota.remaining(E, OCT) == pytest.approx(9.5)
    assert quota.pick_provider(FetchMode.HOURLY, OCT) is T
    assert quota.try_consume(T, 1, OCT)
    assert quota.remaining(T, SEP) == 0  # September untouched


def test_serper_is_lifetime(quota):
    assert quota.try_consume(S, 2000, AUG)
    assert quota.remaining(S, SEP) == pytest.approx(375)
    assert quota.try_consume(S, 300, SEP)
    assert quota.remaining(S, OCT) == pytest.approx(75)
    assert not quota.try_consume(S, 76, OCT)  # a new month does not reset it
    assert quota.try_consume(S, 75, OCT)
    assert quota.remaining(S, datetime(2027, 6, 1, tzinfo=UTC)) == 0
    assert quota.pick_provider(FetchMode.BACKFILL, OCT) is T


@pytest.mark.parametrize("seed", range(5))
def test_random_sequences_never_exceed_limits(quota, seed):
    """Property: whatever is asked, recorded usage stays <= usable_limit and
    try_consume's answer matches what was recorded."""
    rng = random.Random(seed)
    months = [AUG, SEP, OCT]
    recorded: dict[tuple[WebSearchProvider, date], Decimal] = {}
    for _ in range(150):
        p = rng.choice(list(WebSearchProvider))
        now = rng.choice(months)
        limit = usable_limit(p)
        amount = rng.choice(
            [request_cost(p), rng.uniform(0, limit / 3), limit, rng.uniform(0, limit * 2)]
        )
        amount = round(amount, 3)
        before = quota.remaining(p, now)
        ok = quota.try_consume(p, amount, now)
        after = quota.remaining(p, now)
        assert ok == (amount <= before + 1e-9)
        assert after == pytest.approx(before - amount if ok else before)
        assert 0 <= after <= limit
        if ok:
            key = (p, month_start(now))
            recorded[key] = recorded.get(key, Decimal(0)) + Decimal(str(amount))
    for (p, _month), used in recorded.items():
        if p is S:
            used = sum(v for (q, _), v in recorded.items() if q is S)
        assert used <= Decimal(str(usable_limit(p)))


# ---------------------------------------------------------------------------
# Provider order
# ---------------------------------------------------------------------------


def test_pick_provider_order(quota):
    assert quota.pick_provider(FetchMode.HOURLY, SEP) is T
    assert quota.pick_provider(FetchMode.BACKFILL, SEP) is S

    spend_to(quota, T, 0.5, SEP)  # less than one request left
    assert quota.pick_provider(FetchMode.HOURLY, SEP) is E
    assert quota.pick_provider(FetchMode.BACKFILL, SEP) is S

    spend_to(quota, S, 0, SEP)
    assert quota.pick_provider(FetchMode.BACKFILL, SEP) is E

    spend_to(quota, E, 0.01, SEP)  # below one Exa search (0.017)
    assert quota.pick_provider(FetchMode.HOURLY, SEP) is None
    assert quota.pick_provider(FetchMode.BACKFILL, SEP) is None


def test_serper_never_picked_hourly():
    quota = InMemoryQuotaManager({(T, date(2026, 9, 1)): 950, (E, date(2026, 9, 1)): 9.5})
    assert quota.remaining(S, SEP) > 0
    assert quota.pick_provider(FetchMode.HOURLY, SEP) is None


# ---------------------------------------------------------------------------
# Allocation: interval and is_due
# ---------------------------------------------------------------------------

MONTH_START = datetime(2026, 9, 1, tzinfo=UTC)  # September: 30 days left
FULL_SEARCHES = 950 + 558  # Tavily credits + whole Exa searches


def test_interval_spreads_credits_over_the_month():
    quota = InMemoryQuotaManager()
    assert quota.searches_left(MONTH_START) == FULL_SEARCHES
    interval = quota.web_search_interval(10, 2, MONTH_START)
    assert interval == timedelta(days=30) * 20 / FULL_SEARCHES  # ~9.5 hours
    # Searching every profile at that interval until month end fits the credits.
    runs = timedelta(days=30) / interval
    assert runs * 10 * 2 <= FULL_SEARCHES + 1e-6


def test_interval_never_below_one_hour():
    quota = InMemoryQuotaManager()
    assert quota.web_search_interval(1, 1, MONTH_START) == MIN_WEB_SEARCH_INTERVAL
    assert quota.web_search_interval(0, 0, MONTH_START) == MIN_WEB_SEARCH_INTERVAL


def test_interval_uses_what_is_left_and_time_left():
    usage = {(T, date(2026, 9, 1)): 950 - 100, (E, date(2026, 9, 1)): 9.5}
    quota = InMemoryQuotaManager(usage)
    now = datetime(2026, 9, 21, tzinfo=UTC)  # 10 days left, 100 searches left
    assert quota.web_search_interval(5, 2, now) == timedelta(days=10) * 10 / 100  # 1 day


def test_interval_none_when_exhausted():
    month = date(2026, 9, 1)
    assert (
        InMemoryQuotaManager({(T, month): 950, (E, month): 9.5}).web_search_interval(3, 2, SEP)
        is None
    )
    # One search left but a profile needs two.
    one_left = InMemoryQuotaManager({(T, month): 949, (E, month): 9.5})
    assert one_left.web_search_interval(3, 2, SEP) is None
    assert one_left.web_search_interval(3, 1, SEP) is not None


def test_interval_ignores_serper():
    month = date(2026, 9, 1)
    quota = InMemoryQuotaManager({(T, month): 950, (E, month): 9.5})
    assert quota.remaining(S, SEP) == pytest.approx(2375)
    assert quota.web_search_interval(1, 1, SEP) is None


def test_interval_resets_next_month():
    month = date(2026, 9, 1)
    quota = InMemoryQuotaManager({(T, month): 950, (E, month): 9.5})
    assert quota.web_search_interval(1, 1, SEP) is None
    assert quota.web_search_interval(1, 1, OCT) == MIN_WEB_SEARCH_INTERVAL


def test_is_due(relu_profile: Profile):
    quota = InMemoryQuotaManager()
    now = MONTH_START + timedelta(days=1)
    assert quota.is_due(relu_profile, 1, now)  # never searched

    def last(delta: timedelta) -> Profile:
        return relu_profile.model_copy(update={"last_web_search_at": now - delta})

    # One profile: interval is the one hour minimum.
    assert not quota.is_due(last(timedelta(minutes=30)), 1, now)
    assert quota.is_due(last(timedelta(minutes=58)), 1, now)  # cron jitter grace
    assert quota.is_due(last(timedelta(hours=1)), 1, now)

    # 100 profiles: interval grows, the same gap is no longer enough.
    interval = quota.web_search_interval(100, len(relu_profile.search_terms), now)
    assert interval is not None and interval > timedelta(hours=2)
    assert not quota.is_due(last(timedelta(hours=1)), 100, now)
    assert quota.is_due(last(interval), 100, now)


def test_is_due_false_when_exhausted(relu_profile: Profile):
    month = date(2026, 9, 1)
    quota = InMemoryQuotaManager({(T, month): 950, (E, month): 9.5})
    assert not quota.is_due(relu_profile, 1, SEP)


# ---------------------------------------------------------------------------
# Postgres specifics
# ---------------------------------------------------------------------------


@pytest.mark.db
def test_postgres_rows(db):
    quota = PostgresQuotaManager(db)
    assert quota.try_consume(T, 3, SEP)
    assert quota.try_consume(T, 2, SEP)
    assert quota.try_consume(E, 0.017, SEP)
    assert quota.try_consume(S, 1, AUG)
    assert quota.try_consume(S, 1, SEP)
    rows = db.execute(
        "select provider, month, credits_used from quota_usage order by provider, month"
    ).fetchall()
    assert rows == [
        ("exa", date(2026, 9, 1), Decimal("0.017")),
        ("serper", date(2026, 8, 1), Decimal("1")),
        ("serper", date(2026, 9, 1), Decimal("1")),
        ("tavily", date(2026, 9, 1), Decimal("5")),
    ]


@pytest.mark.db
def test_postgres_works_inside_a_caller_transaction(_migrated_db, db):
    with psycopg.connect(_migrated_db) as conn:  # not autocommit
        quota = PostgresQuotaManager(conn)
        with conn.transaction():
            assert quota.try_consume(T, 10, SEP)
            assert quota.remaining(T, SEP) == pytest.approx(940)
        conn.commit()
    assert PostgresQuotaManager(db).remaining(T, SEP) == pytest.approx(940)


def _race(url: str, provider: WebSearchProvider, amount: float, times: list[datetime], n: int):
    """Run `n` try_consume calls per connection, one thread per entry in `times`."""
    successes: list[int] = [0] * len(times)
    barrier = threading.Barrier(len(times))
    errors: list[BaseException] = []

    def worker(i: int) -> None:
        try:
            with psycopg.connect(url, autocommit=True) as conn:
                quota = PostgresQuotaManager(conn)
                barrier.wait()
                for _ in range(n):
                    if quota.try_consume(provider, amount, times[i]):
                        successes[i] += 1
        except BaseException as exc:  # surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(len(times))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)
    assert not errors, errors
    return successes


@pytest.mark.db
def test_parallel_runs_cannot_overshoot_monthly_quota(_migrated_db, db):
    quota = PostgresQuotaManager(db)
    spend_to(quota, T, 40, SEP)
    successes = _race(_migrated_db, T, 1, [SEP, SEP, SEP, SEP], n=25)
    assert sum(successes) == 40
    assert quota.remaining(T, SEP) == 0
    (used,) = db.execute(
        "select credits_used from quota_usage where provider = 'tavily'"
    ).fetchone()
    assert used == Decimal("950")


@pytest.mark.db
def test_parallel_runs_cannot_overshoot_first_insert(_migrated_db, db):
    # No row yet: both connections race to insert it.
    successes = _race(_migrated_db, E, 3, [SEP, SEP], n=3)
    assert sum(successes) == 3  # 3 x $3 fits in $9.50, a 4th does not
    assert PostgresQuotaManager(db).remaining(E, SEP) == pytest.approx(0.5)


@pytest.mark.db
def test_parallel_runs_cannot_overshoot_lifetime_quota_across_months(_migrated_db, db):
    # Serper rows for different months: a per-row check alone would let both through.
    quota = PostgresQuotaManager(db)
    spend_to(quota, S, 30, AUG)
    successes = _race(_migrated_db, S, 1, [SEP, OCT, SEP, OCT], n=20)
    assert sum(successes) == 30
    (total,) = db.execute(
        "select sum(credits_used) from quota_usage where provider = 'serper'"
    ).fetchone()
    assert total == Decimal("2375")
