"""GDELT DOC 2.0 article list (no key). See docs/source-limits.md."""

from __future__ import annotations

import html
import json
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

import httpx

from omdomme.collectors.base import (
    Batch,
    Clock,
    clean_text,
    domain_of,
    ensure_utc,
    is_http_url,
    parse_each,
    quote_term,
    utc_now,
)
from omdomme.contracts import Collector, FetchMode, Profile, RawMention, SourceType
from omdomme.limits import GDELT_MAX_LOOKBACK, GDELT_MAX_RECORDS

GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc"

# GDELT allows one request every 5 seconds (it answers 429 otherwise).
DEFAULT_PAUSE_SECONDS = 6.0
# GDELT is slow (15+ s per query is normal), so it gets a longer timeout than
# the shared client, and one retry after a 429 or a timeout.
GDELT_TIMEOUT = httpx.Timeout(60.0, connect=30.0)
RETRY_PAUSE_SECONDS = 10.0
# Hourly runs re-read this much before `since` (GDELT indexes with some delay).
HOURLY_OVERLAP = timedelta(minutes=30)
# Hourly window when no `since` is known.
HOURLY_DEFAULT_TIMESPAN = "1d"
# Minimum window GDELT accepts.
MIN_WINDOW = timedelta(minutes=15)
# Backfill: the whole rolling window GDELT serves.
BACKFILL_TIMESPAN = "3months"


def format_gdelt_datetime(dt: datetime) -> str:
    return ensure_utc(dt).strftime("%Y%m%d%H%M%S")


def parse_seendate(value: str) -> datetime:
    """Parse "20260919T101500Z" into an aware UTC datetime."""
    value = value.strip()
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y%m%d%H%M%S"):
        try:
            return datetime.strptime(value, fmt).replace(tzinfo=UTC)
        except ValueError:
            continue
    raise ValueError(f"bad seendate {value!r}")


class GdeltCollector(Collector):
    source_type: ClassVar[SourceType] = SourceType.GDELT

    def __init__(
        self,
        http: httpx.Client,
        *,
        clock: Clock = utc_now,
        pause_seconds: float = DEFAULT_PAUSE_SECONDS,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._http = http
        self._clock = clock
        self._pause = pause_seconds
        self._sleep = sleep

    def request_params(self, term: str, mode: FetchMode, since: datetime | None) -> dict[str, str]:
        params = {
            "query": quote_term(term),
            "mode": "artlist",
            "format": "json",
            "maxrecords": str(GDELT_MAX_RECORDS),
            "sort": "datedesc",
        }
        if mode is FetchMode.BACKFILL:
            params["timespan"] = BACKFILL_TIMESPAN
        elif since is None:
            params["timespan"] = HOURLY_DEFAULT_TIMESPAN
        else:
            now = ensure_utc(self._clock())
            oldest = now - GDELT_MAX_LOOKBACK + timedelta(days=1)
            start = max(ensure_utc(since) - HOURLY_OVERLAP, oldest)
            start = min(start, now - MIN_WINDOW)
            params["startdatetime"] = format_gdelt_datetime(start)
            params["enddatetime"] = format_gdelt_datetime(now)
        return params

    def _get(self, params: dict[str, str]) -> httpx.Response:
        """GET with one retry after a rate limit (429) or a timeout."""
        try:
            resp = self._http.get(GDELT_DOC_URL, params=params, timeout=GDELT_TIMEOUT)
            if resp.status_code != 429:
                return resp
        except httpx.TimeoutException:
            pass
        self._sleep(RETRY_PAUSE_SECONDS)
        return self._http.get(GDELT_DOC_URL, params=params, timeout=GDELT_TIMEOUT)

    def collect(
        self, profile: Profile, *, mode: FetchMode, since: datetime | None = None
    ) -> list[RawMention]:
        batch = Batch("gdelt")
        for i, term in enumerate(profile.search_terms):
            if i and self._pause > 0:
                self._sleep(self._pause)
            try:
                resp = self._get(self.request_params(term, mode, since))
                resp.raise_for_status()
                items = parse_artlist(resp.text)
            except (httpx.HTTPError, ValueError) as exc:
                batch.failed(f"term #{i + 1}", exc)
                continue
            batch.succeeded()
            batch.add(items)
        return batch.result()


def parse_artlist(body: str) -> list[RawMention]:
    """RawMentions from an artlist JSON body.

    GDELT answers errors (e.g. "phrase too short") with plain text and HTTP 200;
    that raises ValueError. An empty result is `{}`.
    """
    body = body.strip()
    if not body:
        return []
    try:
        data: Any = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError(f"GDELT did not return JSON: {body[:120]!r}") from exc
    if not isinstance(data, dict):
        raise ValueError("GDELT response is not an object")
    articles = data.get("articles") or []
    if not isinstance(articles, list):
        raise ValueError("GDELT 'articles' is not a list")
    return parse_each(articles, _parse_article, "gdelt")


def _parse_article(article: dict[str, Any]) -> RawMention:
    url = article["url"].strip()
    title = clean_text(html.unescape(article["title"]))
    if not is_http_url(url) or not title:
        raise ValueError("article without url or title")
    published_at = None
    seendate = article.get("seendate")
    if isinstance(seendate, str) and seendate:
        try:
            published_at = parse_seendate(seendate)
        except ValueError:
            published_at = None  # keep the article, just without a date
    source_name = domain_of("http://" + article["domain"]) if article.get("domain") else None
    return RawMention(
        url=url,
        title=title,
        source_type=SourceType.GDELT,
        source_name=source_name or domain_of(url) or "unknown",
        published_at=published_at,
        raw=article,
    )
