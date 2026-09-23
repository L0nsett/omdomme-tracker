"""Quota bookkeeping for the web search providers (contracts.QuotaManager).

Units per provider (docs/source-limits.md): Tavily credits, Exa US dollars, Serper
queries. Tavily and Exa reset every calendar month (UTC); Serper is a one-time
quota, so its usage is the sum over every row of `quota_usage`.

Invariant: the recorded usage for a provider never exceeds `limits.usable_limit`.
`try_consume` is the only writer and checks the limit in the same atomic step as
the write, so two parallel runs cannot overshoot.
"""

from __future__ import annotations

import threading
from abc import abstractmethod
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import psycopg

from omdomme.contracts import FetchMode, Profile, QuotaManager, WebSearchProvider
from omdomme.limits import (
    EXA_CONTENTS_PER_PAGE_USD,
    EXA_EXTRA_RESULT_USD,
    EXA_SEARCH_USD_UP_TO_10_RESULTS,
    LIFETIME_QUOTA,
    MIN_WEB_SEARCH_INTERVAL,
    SERPER_QUERY_CREDITS,
    TAVILY_BASIC_SEARCH_CREDITS,
    usable_limit,
)

# Results requested per web search. Exa's price depends on it.
WEB_SEARCH_RESULTS = 10

# Provider order per mode (PLAN.md, "Nettsøk uten å betale").
PROVIDER_ORDER: dict[FetchMode, tuple[WebSearchProvider, ...]] = {
    FetchMode.HOURLY: (WebSearchProvider.TAVILY, WebSearchProvider.EXA),
    FetchMode.BACKFILL: (
        WebSearchProvider.SERPER,
        WebSearchProvider.TAVILY,
        WebSearchProvider.EXA,
    ),
}

# Providers whose credits the hourly allocator spreads over the month.
HOURLY_PROVIDERS = PROVIDER_ORDER[FetchMode.HOURLY]

# GitHub Actions cron fires a few minutes late at random. Without some slack a
# profile with a one-hour interval would only run every second hour. Quota safety
# does not depend on this: `try_consume` still enforces the limits.
IS_DUE_GRACE = timedelta(minutes=5)


def exa_search_cost(num_results: int = WEB_SEARCH_RESULTS, *, highlights: bool = True) -> float:
    """USD for one Exa search returning `num_results` results (worst case)."""
    cost = EXA_SEARCH_USD_UP_TO_10_RESULTS + max(0, num_results - 10) * EXA_EXTRA_RESULT_USD
    if highlights:
        cost += num_results * EXA_CONTENTS_PER_PAGE_USD
    return round(cost, 6)


def request_cost(provider: WebSearchProvider) -> float:
    """Cost of one search request as the web search collector sends it."""
    match provider:
        case WebSearchProvider.TAVILY:
            return TAVILY_BASIC_SEARCH_CREDITS
        case WebSearchProvider.EXA:
            return exa_search_cost()
        case WebSearchProvider.SERPER:
            return SERPER_QUERY_CREDITS
    raise ValueError(f"unknown provider {provider!r}")


def month_start(now: datetime) -> date:
    """First day of `now`'s month in UTC."""
    now = _as_utc(now)
    return date(now.year, now.month, 1)


def next_month_start(now: datetime) -> datetime:
    now = _as_utc(now)
    if now.month == 12:
        return datetime(now.year + 1, 1, 1, tzinfo=UTC)
    return datetime(now.year, now.month + 1, 1, tzinfo=UTC)


def _as_utc(now: datetime) -> datetime:
    if now.tzinfo is None:
        return now.replace(tzinfo=UTC)
    return now.astimezone(UTC)


def _dec(value: float) -> Decimal:
    # Via str so 0.007 stays 0.007 in the numeric column (no float noise).
    return Decimal(str(value))


class BaseQuotaManager(QuotaManager):
    """Shared policy on top of a storage backend (`_used`, `try_consume`)."""

    @abstractmethod
    def _used(self, provider: WebSearchProvider, now: datetime) -> Decimal:
        """Usage recorded for the current period (month, or lifetime)."""

    def remaining(self, provider: WebSearchProvider, now: datetime) -> float:
        left = _dec(usable_limit(provider)) - self._used(provider, now)
        return max(0.0, float(left))

    def can_afford(self, provider: WebSearchProvider, now: datetime) -> bool:
        return self.remaining(provider, now) >= request_cost(provider)

    def pick_provider(self, mode: FetchMode, now: datetime) -> WebSearchProvider | None:
        for provider in PROVIDER_ORDER[mode]:
            if self.can_afford(provider, now):
                return provider
        return None

    def searches_left(self, now: datetime) -> int:
        """Whole hourly-mode searches the remaining monthly credits pay for."""
        total = 0
        for provider in HOURLY_PROVIDERS:
            total += int(_dec(self.remaining(provider, now)) // _dec(request_cost(provider)))
        return total

    def web_search_interval(self, n_profiles: int, n_terms: int, now: datetime) -> timedelta | None:
        now = _as_utc(now)
        searches_per_round = max(1, n_profiles) * max(1, n_terms)
        searches = self.searches_left(now)
        if searches < max(1, n_terms):
            # Not even one profile's terms can be searched: wait for next month.
            return None
        time_left = next_month_start(now) - now
        interval = time_left * searches_per_round / searches
        return max(MIN_WEB_SEARCH_INTERVAL, interval)

    def is_due(self, profile: Profile, n_profiles: int, now: datetime) -> bool:
        interval = self.web_search_interval(n_profiles, len(profile.search_terms), now)
        if interval is None:
            return False
        last = profile.last_web_search_at
        if last is None:
            return True
        return _as_utc(now) - _as_utc(last) >= interval - IS_DUE_GRACE


class InMemoryQuotaManager(BaseQuotaManager):
    """Same policy as PostgresQuotaManager, kept in memory (tests, dry runs)."""

    def __init__(self, usage: dict[tuple[WebSearchProvider, date], float] | None = None) -> None:
        self._usage: dict[tuple[WebSearchProvider, date], Decimal] = {
            key: _dec(value) for key, value in (usage or {}).items()
        }
        self._lock = threading.Lock()

    def _used(self, provider: WebSearchProvider, now: datetime) -> Decimal:
        if provider in LIFETIME_QUOTA:
            return sum(
                (v for (p, _), v in self._usage.items() if p == provider),
                Decimal(0),
            )
        return self._usage.get((provider, month_start(now)), Decimal(0))

    def try_consume(self, provider: WebSearchProvider, amount: float, now: datetime) -> bool:
        if amount < 0:
            raise ValueError("amount must be >= 0")
        with self._lock:
            amt = _dec(amount)
            if self._used(provider, now) + amt > _dec(usable_limit(provider)):
                return False
            key = (provider, month_start(now))
            self._usage[key] = self._usage.get(key, Decimal(0)) + amt
            return True

    def usage(self) -> dict[tuple[WebSearchProvider, date], float]:
        return {k: float(v) for k, v in self._usage.items()}


class PostgresQuotaManager(BaseQuotaManager):
    """QuotaManager on the `quota_usage` table (one row per provider and month).

    `try_consume` runs in its own transaction (a savepoint if the connection is
    already inside one) and serialises writers per provider with a
    transaction-scoped advisory lock, then checks and records the spend. For the
    monthly providers the UPSERT additionally carries the limit in its WHERE
    clause, so the row-level check holds even without the advisory lock.
    """

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def _used(self, provider: WebSearchProvider, now: datetime) -> Decimal:
        if provider in LIFETIME_QUOTA:
            row = self._conn.execute(
                "select coalesce(sum(credits_used), 0) from quota_usage where provider = %s",
                (provider.value,),
            ).fetchone()
        else:
            row = self._conn.execute(
                "select coalesce(sum(credits_used), 0) from quota_usage"
                " where provider = %s and month = %s",
                (provider.value, month_start(now)),
            ).fetchone()
        return Decimal(row[0]) if row else Decimal(0)

    def try_consume(self, provider: WebSearchProvider, amount: float, now: datetime) -> bool:
        if amount < 0:
            raise ValueError("amount must be >= 0")
        amt = _dec(amount)
        limit = _dec(usable_limit(provider))
        month = month_start(now)
        with self._conn.transaction():
            self._conn.execute(
                "select pg_advisory_xact_lock(hashtext('omdomme.quota_usage'), hashtext(%s))",
                (provider.value,),
            )
            if provider in LIFETIME_QUOTA:
                # Other months' rows count too: check the sum under the lock.
                if self._used(provider, now) + amt > limit:
                    return False
                self._conn.execute(
                    "insert into quota_usage (provider, month, credits_used) values (%s, %s, %s)"
                    " on conflict (provider, month)"
                    " do update set credits_used = quota_usage.credits_used"
                    " + excluded.credits_used",
                    (provider.value, month, amt),
                )
                return True
            if amt > limit:
                return False
            row = self._conn.execute(
                "insert into quota_usage (provider, month, credits_used) values (%s, %s, %s)"
                " on conflict (provider, month) do update"
                " set credits_used = quota_usage.credits_used + excluded.credits_used"
                " where quota_usage.credits_used + excluded.credits_used <= %s"
                " returning credits_used",
                (provider.value, month, amt, limit),
            ).fetchone()
            return row is not None
