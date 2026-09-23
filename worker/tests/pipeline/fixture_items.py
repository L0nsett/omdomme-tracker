"""Test helpers for pipeline tests: RawMentions built from the stored API responses the
way a collector would build them, a fake QuotaManager and a DB profile inserter."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from html import unescape
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

from omdomme.contracts import (
    FetchMode,
    Profile,
    QuotaManager,
    RawMention,
    SourceType,
    WebSearchProvider,
)
from omdomme.reach import TrancoReachScorer

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
_URL = re.compile(r"https?://[^\s<>\"')\]]+")
_TAG = re.compile(r"<[^>]+>")


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").removeprefix("www.")


def _json(name: str):
    import json

    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def google_news_items() -> list[RawMention]:
    root = ET.fromstring((FIXTURES / "google_news_relu.xml").read_text(encoding="utf-8"))
    items = []
    for item in root.iter("item"):
        source = item.find("source")
        publisher = source.text if source is not None else ""
        title = item.findtext("title", "")
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(f" - {publisher}")]
        snippet = " ".join(unescape(_TAG.sub(" ", item.findtext("description", ""))).split())
        items.append(
            RawMention(
                url=item.findtext("link", ""),
                title=title,
                snippet=snippet,
                source_type=SourceType.GOOGLE_NEWS,
                source_name=_host(source.get("url", "")) if source is not None else "",
                published_at=parsedate_to_datetime(item.findtext("pubDate", "")),
            )
        )
    return items


def gdelt_items() -> list[RawMention]:
    return [
        RawMention(
            url=a["url"],
            title=a["title"],
            source_type=SourceType.GDELT,
            source_name=a["domain"],
            published_at=datetime.strptime(a["seendate"], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC),
        )
        for a in _json("gdelt_relu.json")["articles"]
    ]


def reddit_items() -> list[RawMention]:
    out = []
    for child in _json("reddit_search_relu.json")["data"]["children"]:
        d = child["data"]
        out.append(
            RawMention(
                url="https://www.reddit.com" + d["permalink"],
                title=d["title"],
                snippet=d["selftext"],
                source_type=SourceType.REDDIT,
                source_name=d["subreddit_name_prefixed"],
                published_at=datetime.fromtimestamp(d["created_utc"], tz=UTC),
                links=_URL.findall(d["selftext"]),
                upvotes=d["ups"],
                num_comments=d["num_comments"],
            )
        )
    return out


def tavily_items() -> list[RawMention]:
    return [
        RawMention(
            url=r["url"],
            title=r["title"],
            snippet=r["content"],
            source_type=SourceType.WEB_SEARCH,
            source_name=_host(r["url"]),
            provider=WebSearchProvider.TAVILY,
        )
        for r in _json("tavily_relu.json")["results"]
    ]


def exa_items() -> list[RawMention]:
    return [
        RawMention(
            url=r["url"],
            title=r["title"],
            snippet=" ".join(r.get("highlights") or []),
            source_type=SourceType.WEB_SEARCH,
            source_name=_host(r["url"]),
            published_at=r["publishedDate"],
            provider=WebSearchProvider.EXA,
        )
        for r in _json("exa_relu.json")["results"]
    ]


def serper_items() -> list[RawMention]:
    return [
        RawMention(
            url=r["link"],
            title=r["title"],
            snippet=r.get("snippet", ""),
            source_type=SourceType.WEB_SEARCH,
            source_name=_host(r["link"]),
            provider=WebSearchProvider.SERPER,
        )
        for r in _json("serper_relu.json")["organic"]
    ]


def all_fixture_items() -> list[RawMention]:
    return (
        google_news_items()
        + gdelt_items()
        + reddit_items()
        + tavily_items()
        + exa_items()
        + serper_items()
    )


def expected() -> dict[tuple[str, str], bool]:
    return {
        (i["source_type"], i["url"]): i["match"] for i in _json("expected_matches.json")["items"]
    }


class FakeQuota(QuotaManager):
    """In-memory quota: `due` holds the profile ids that are due for web search."""

    def __init__(self, due: set | None = None, due_all: bool = True) -> None:
        self.due = due or set()
        self.due_all = due_all
        self.is_due_calls: list[tuple] = []

    def remaining(self, provider, now):
        return 100.0

    def try_consume(self, provider, amount, now):
        return True

    def pick_provider(self, mode, now):
        return WebSearchProvider.SERPER if mode == FetchMode.BACKFILL else WebSearchProvider.TAVILY

    def web_search_interval(self, n_profiles, n_terms, now):
        return timedelta(hours=1)

    def is_due(self, profile, n_profiles, now):
        self.is_due_calls.append((profile.id, n_profiles, now))
        return self.due_all or profile.id in self.due


def insert_profile(conn: psycopg.Connection, profile: Profile) -> None:
    conn.execute(
        "insert into profiles (id, name, website_url, social_links, created_at, "
        "backfill_status, last_web_search_at) values (%s, %s, %s, %s, %s, %s, %s)",
        (
            profile.id,
            profile.name,
            profile.website_url,
            profile.social_links,
            profile.created_at,
            profile.backfill_status.value,
            profile.last_web_search_at,
        ),
    )
    for rule in profile.keyword_rules:
        conn.execute(
            "insert into keyword_rules (profile_id, term, context_terms, is_exclusion) "
            "values (%s, %s, %s, %s)",
            (profile.id, rule.term, rule.context_terms, rule.is_exclusion),
        )


def tranco_scorer() -> TrancoReachScorer:
    return TrancoReachScorer.from_csv(FIXTURES / "tranco_sample.csv")
