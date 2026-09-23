from __future__ import annotations

import httpx
import pytest

from omdomme.collectors import (
    GdeltCollector,
    GoogleNewsCollector,
    RedditCollector,
    WebSearchCollector,
    build_collectors,
)
from omdomme.config import Settings
from omdomme.contracts import CollectorUnavailable, FetchMode, SourceType, WebSearchProvider
from omdomme.quota import InMemoryQuotaManager


def settings(**overrides) -> Settings:
    values = {
        "database_url": None,
        "reddit_client_id": None,
        "reddit_client_secret": None,
        "reddit_user_agent": "omdomme-tracker/test",
        "tavily_api_key": None,
        "exa_api_key": None,
        "serper_api_key": None,
    }
    return Settings(**(values | overrides))


def test_build_collectors_returns_all_four_sources():
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))) as http:
        collectors = build_collectors(settings(), http, InMemoryQuotaManager())
    assert [type(c) for c in collectors] == [
        GoogleNewsCollector,
        GdeltCollector,
        RedditCollector,
        WebSearchCollector,
    ]
    assert {c.source_type for c in collectors} == set(SourceType)


def test_collectors_without_credentials_are_unavailable(relu_profile):
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))) as http:
        collectors = build_collectors(settings(), http, InMemoryQuotaManager())
        by_type = {c.source_type: c for c in collectors}
        for source in (SourceType.REDDIT, SourceType.WEB_SEARCH):
            with pytest.raises(CollectorUnavailable):
                by_type[source].collect(relu_profile, mode=FetchMode.HOURLY)


def test_keys_are_passed_through():
    s = settings(tavily_api_key="t", serper_api_key="s", reddit_client_id="i")
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))) as http:
        collectors = build_collectors(s, http, InMemoryQuotaManager())
    web = collectors[3]
    assert isinstance(web, WebSearchCollector)
    assert web.configured_providers == [WebSearchProvider.TAVILY, WebSearchProvider.SERPER]
    reddit = collectors[2]
    assert isinstance(reddit, RedditCollector)
    assert not reddit.has_credentials  # secret missing
