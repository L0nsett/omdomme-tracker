"""Google News RSS search (no key). See docs/source-limits.md."""

from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import ClassVar

import httpx

from omdomme.collectors.base import (
    Batch,
    Clock,
    clean_text,
    domain_of,
    ensure_utc,
    html_to_text,
    is_http_url,
    parse_each,
    quote_term,
    utc_now,
)
from omdomme.contracts import Collector, FetchMode, Profile, RawMention, SourceType

GOOGLE_NEWS_RSS_URL = "https://news.google.com/rss/search"

# (hl, gl, ceid): the English and the Norwegian edition for Norway.
EDITIONS: tuple[tuple[str, str, str], ...] = (
    ("en", "NO", "NO:en"),
    ("no", "NO", "NO:no"),
)

# Longest `when:` window used in hourly mode. Older items come from backfill.
MAX_HOURLY_WINDOW = timedelta(days=30)


def when_operator(now: datetime, since: datetime | None) -> str:
    """`when:Nd` window for hourly mode: at least one day, enough to reach `since`.

    Google News pubDates lag indexing, so a window of exactly `now - since` would
    lose late-indexed items; the pipeline dedupes the overlap.
    """
    if since is None:
        return "when:1d"
    gap = min(max(now - ensure_utc(since), timedelta(0)), MAX_HOURLY_WINDOW)
    days = max(1, math.ceil(gap / timedelta(days=1)))
    return f"when:{days}d"


class GoogleNewsCollector(Collector):
    source_type: ClassVar[SourceType] = SourceType.GOOGLE_NEWS

    def __init__(self, http: httpx.Client, *, clock: Clock = utc_now) -> None:
        self._http = http
        self._clock = clock

    def request_params(
        self, term: str, edition: tuple[str, str, str], mode: FetchMode, since: datetime | None
    ) -> dict[str, str]:
        hl, gl, ceid = edition
        query = quote_term(term)
        if mode is FetchMode.HOURLY:
            query = f"{query} {when_operator(ensure_utc(self._clock()), since)}"
        return {"q": query, "hl": hl, "gl": gl, "ceid": ceid}

    def collect(
        self, profile: Profile, *, mode: FetchMode, since: datetime | None = None
    ) -> list[RawMention]:
        batch = Batch("google_news")
        for term in profile.search_terms:
            for edition in EDITIONS:
                params = self.request_params(term, edition, mode, since)
                try:
                    resp = self._http.get(GOOGLE_NEWS_RSS_URL, params=params)
                    resp.raise_for_status()
                    items = parse_rss(resp.text)
                except (httpx.HTTPError, ET.ParseError) as exc:
                    batch.failed(f"term {term!r} ({edition[2]})", exc)
                    continue
                batch.succeeded()
                batch.add(items)
        return batch.result()


def parse_rss(xml_text: str) -> list[RawMention]:
    """RawMentions from a Google News RSS document. Raises ET.ParseError if not XML."""
    root = ET.fromstring(xml_text)
    return parse_each(root.iter("item"), _parse_item, "google_news")


def _parse_item(item: ET.Element) -> RawMention | None:
    link = (item.findtext("link") or "").strip()
    raw_title = clean_text(item.findtext("title"))
    if not is_http_url(link) or not raw_title:
        raise ValueError("item without link or title")

    source = item.find("source")
    publisher = clean_text(source.text) if source is not None else ""
    publisher_url = source.get("url") if source is not None else None

    title = strip_publisher(raw_title, publisher)
    snippet = html_to_text(item.findtext("description"))
    if publisher and snippet.endswith(publisher):
        snippet = snippet[: -len(publisher)].strip()
    if snippet in (title, raw_title):
        snippet = ""

    published_at = None
    pub_date = item.findtext("pubDate")
    if pub_date:
        try:
            published_at = ensure_utc(parsedate_to_datetime(pub_date.strip()))
        except (TypeError, ValueError):
            published_at = None

    source_name = domain_of(publisher_url) or publisher or "news.google.com"
    return RawMention(
        url=link,
        title=title,
        snippet=snippet,
        source_type=SourceType.GOOGLE_NEWS,
        source_name=source_name,
        published_at=published_at,
        raw={
            "title": raw_title,
            "link": link,
            "pubDate": pub_date,
            "source": publisher,
            "source_url": publisher_url,
        },
    )


def strip_publisher(title: str, publisher: str) -> str:
    """Turn "Headline - Publisher" into "Headline" (only if the suffix is the publisher)."""
    if publisher:
        suffix = f" - {publisher}"
        if title.endswith(suffix) and len(title) > len(suffix):
            return title[: -len(suffix)].strip()
    return title
