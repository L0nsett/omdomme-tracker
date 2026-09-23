from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest

from omdomme.collectors import CollectorError, WebSearchCollector
from omdomme.collectors.web_search import parse_serper_date
from omdomme.contracts import (
    CollectorUnavailable,
    FetchMode,
    QuotaManager,
    SourceType,
    WebSearchProvider,
)
from omdomme.limits import usable_limit
from omdomme.quota import InMemoryQuotaManager, exa_search_cost, request_cost

from .conftest import NOW

T, E, S = WebSearchProvider.TAVILY, WebSearchProvider.EXA, WebSearchProvider.SERPER
MONTH = date(2026, 9, 1)
KEYS = {"tavily_api_key": "tvly-test", "exa_api_key": "exa-test", "serper_api_key": "serper-test"}
HOSTS = {"api.tavily.com": T, "api.exa.ai": E, "google.serper.dev": S}


def exhausted(*providers: WebSearchProvider) -> dict:
    return {(p, MONTH): usable_limit(p) for p in providers}


def provider_handler(load_fixture, overrides=None):
    bodies = {
        T: load_fixture("tavily_relu.json"),
        E: load_fixture("exa_relu.json"),
        S: load_fixture("serper_relu.json"),
    }
    overrides = overrides or {}

    def handler(req: httpx.Request) -> httpx.Response:
        provider = HOSTS.get(req.url.host)
        if provider is None:
            return httpx.Response(404)
        if provider in overrides:
            return overrides[provider](req)
        return httpx.Response(200, json=bodies[provider])

    return handler


def make(rec, quota: QuotaManager, clock, **keys):
    return WebSearchCollector(rec.client, quota, clock=clock, **(keys or KEYS))


def providers_called(rec) -> list[WebSearchProvider]:
    return [HOSTS[r.url.host] for r in rec.requests]


def test_hourly_uses_tavily_and_pays_first(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(provider_handler(load_fixture))
    quota = InMemoryQuotaManager()
    items = make(rec, quota, clock).collect(relu_profile, mode=FetchMode.HOURLY)

    assert providers_called(rec) == [T, T]  # one per term
    assert quota.usage() == {(T, MONTH): 2.0}
    assert [i.url for i in items] == [
        "https://www.relu-ntnu.no/about",
        "https://machinelearningmastery.com/rectified-linear-activation-function",
        "https://www.nidaros.no/studentfrivillige-trondheim",
    ]
    first = items[0]
    assert first.source_type is SourceType.WEB_SEARCH
    assert first.provider is T
    assert first.source_name == "relu-ntnu.no"
    assert first.title == "ReLU NTNU – Student organization for AI at NTNU"
    assert first.snippet.startswith("ReLU NTNU is a student organization in Trondheim")
    assert first.published_at is None

    req = rec.requests[0]
    assert req.method == "POST" and req.url.path == "/search"
    assert req.headers["authorization"] == "Bearer tvly-test"
    body = json.loads(req.content)
    assert body["query"] == '"ReLU NTNU"'
    assert body["search_depth"] == "basic"  # 1 credit, never "advanced"
    assert body["max_results"] == 10


def test_hourly_falls_back_to_exa_with_highlights(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(provider_handler(load_fixture))
    quota = InMemoryQuotaManager(exhausted(T))
    items = make(rec, quota, clock).collect(relu_profile, mode=FetchMode.HOURLY)

    assert providers_called(rec) == [E, E]
    assert quota.usage()[(E, MONTH)] == pytest.approx(2 * exa_search_cost())
    assert exa_search_cost() == pytest.approx(0.017)  # $0.007 search + 10 x $0.001 highlights
    req = rec.requests[0]
    assert req.headers["x-api-key"] == "exa-test"
    body = json.loads(req.content)
    assert body["numResults"] == 10
    assert "highlights" in body["contents"]

    assert [i.url for i in items] == [
        "https://www.digi.no/artikler/studentene-som-bygger-norsk-ai/560123",
        "https://paperswithcode.com/method/relu",
    ]
    digi = items[0]
    assert digi.provider is E
    assert digi.snippet == "Linjeforeningen ReLU ved NTNU har vokst til over 400 medlemmer."
    assert digi.published_at == datetime(2026, 9, 12, tzinfo=UTC)
    assert digi.source_name == "digi.no"


def test_backfill_prefers_serper(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(provider_handler(load_fixture))
    quota = InMemoryQuotaManager()
    items = make(rec, quota, clock).collect(relu_profile, mode=FetchMode.BACKFILL)

    assert providers_called(rec) == [S, S]
    assert quota.usage() == {(S, MONTH): 2.0}
    req = rec.requests[0]
    assert req.headers["x-api-key"] == "serper-test"
    assert json.loads(req.content) == {"q": '"ReLU NTNU"', "num": 10}
    assert [i.url for i in items] == [
        "https://www.universitetsavisa.no/relu-ntnu-starter-opp",
        "https://www.instagram.com/relu_ntnu/",
        "https://www.ibm.com/think/topics/relu",
    ]
    assert items[0].published_at == datetime(2025, 2, 3, tzinfo=UTC)
    assert items[0].provider is S
    assert items[1].published_at is None
    assert items[1].source_name == "instagram.com"


def test_serper_is_never_used_hourly(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(provider_handler(load_fixture))
    quota = InMemoryQuotaManager(exhausted(T, E))
    with pytest.raises(CollectorUnavailable, match="no provider has quota"):
        make(rec, quota, clock).collect(relu_profile, mode=FetchMode.HOURLY)
    assert rec.requests == []

    only_serper = {"serper_api_key": "serper-test"}
    with pytest.raises(CollectorUnavailable, match="no provider configured for hourly"):
        make(rec, InMemoryQuotaManager(), clock, **only_serper).collect(
            relu_profile, mode=FetchMode.HOURLY
        )
    assert rec.requests == []


def test_all_fixture_urls_are_emitted(mock_http, clock, load_fixture, relu_profile, expected_urls):
    rec = mock_http(provider_handler(load_fixture))
    urls: set[str] = set()
    urls |= {
        i.url
        for i in make(rec, InMemoryQuotaManager(), clock).collect(
            relu_profile, mode=FetchMode.HOURLY
        )
    }
    urls |= {
        i.url
        for i in make(rec, InMemoryQuotaManager(exhausted(T)), clock).collect(
            relu_profile, mode=FetchMode.HOURLY
        )
    }
    urls |= {
        i.url
        for i in make(rec, InMemoryQuotaManager(), clock).collect(
            relu_profile, mode=FetchMode.BACKFILL
        )
    }
    assert urls == expected_urls("web_search")


def test_no_keys_is_unavailable(mock_http, clock, relu_profile):
    rec = mock_http(lambda req: httpx.Response(500))
    collector = WebSearchCollector(rec.client, InMemoryQuotaManager(), clock=clock)
    with pytest.raises(CollectorUnavailable, match="no API keys"):
        collector.collect(relu_profile, mode=FetchMode.BACKFILL)
    assert rec.requests == []


def test_provider_without_key_is_skipped(mock_http, clock, load_fixture, relu_profile):
    # pick_provider says Serper, but there is no Serper key: use Tavily instead.
    rec = mock_http(provider_handler(load_fixture))
    quota = InMemoryQuotaManager()
    make(rec, quota, clock, tavily_api_key="t").collect(relu_profile, mode=FetchMode.BACKFILL)
    assert providers_called(rec) == [T, T]
    assert (S, MONTH) not in quota.usage()


def test_quota_running_out_midway_returns_partial(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(provider_handler(load_fixture))
    # One Tavily credit left, Exa exhausted.
    usage = exhausted(E) | {(T, MONTH): usable_limit(T) - 1}
    quota = InMemoryQuotaManager(usage)
    items = make(rec, quota, clock).collect(relu_profile, mode=FetchMode.HOURLY)
    assert providers_called(rec) == [T]
    assert len(items) == 3
    assert quota.remaining(T, NOW) == 0


def test_bad_key_moves_on_to_next_provider(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(
        provider_handler(load_fixture, {T: lambda req: httpx.Response(401, json={"detail": "x"})})
    )
    quota = InMemoryQuotaManager()
    items = make(rec, quota, clock).collect(relu_profile, mode=FetchMode.HOURLY)
    # Tavily fails once, is dropped for this call; both terms go to Exa.
    assert providers_called(rec) == [T, E, E]
    assert {i.provider for i in items} == {E}
    # The failed request was still paid for (it may have been billed).
    assert quota.usage()[(T, MONTH)] == 1.0


def test_server_error_on_one_term_keeps_other(mock_http, clock, load_fixture, relu_profile):
    body = load_fixture("tavily_relu.json")

    def tavily(req: httpx.Request) -> httpx.Response:
        if json.loads(req.content)["query"] == '"ReLU"':
            return httpx.Response(500)
        return httpx.Response(200, json=body)

    rec = mock_http(provider_handler(load_fixture, {T: tavily}))
    items = make(rec, InMemoryQuotaManager(), clock).collect(relu_profile, mode=FetchMode.HOURLY)
    assert providers_called(rec) == [T, T]
    assert len(items) == 3


def test_all_failing_raises(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(provider_handler(load_fixture, {T: lambda req: httpx.Response(502)}))
    with pytest.raises(CollectorError, match="all 2 requests failed"):
        make(rec, InMemoryQuotaManager(), clock).collect(relu_profile, mode=FetchMode.HOURLY)


def test_skips_malformed_results(mock_http, clock, load_fixture, one_term_profile):
    body = {
        "results": [
            {"title": "no url"},
            {"url": "ftp://x.example/file", "title": "wrong scheme"},
            "garbage",
            {"url": "https://ok.example/a", "title": None, "content": None},
            {"url": "https://ok.example/a", "title": "duplicate"},
            {"url": "https://ok.example/b", "title": "B", "published_date": "2026-09-01T10:00:00Z"},
        ]
    }
    rec = mock_http(provider_handler(load_fixture, {T: lambda req: httpx.Response(200, json=body)}))
    items = make(rec, InMemoryQuotaManager(), clock).collect(
        one_term_profile, mode=FetchMode.HOURLY
    )
    assert [(i.url, i.title) for i in items] == [
        ("https://ok.example/a", "ok.example"),
        ("https://ok.example/b", "B"),
    ]
    assert items[1].published_at == datetime(2026, 9, 1, 10, tzinfo=UTC)


def test_lost_race_for_last_credit_tries_next_provider(
    mock_http, clock, load_fixture, relu_profile
):
    class RacingQuota(InMemoryQuotaManager):
        """Tavily looks available but another run takes the credit first."""

        def try_consume(self, provider, amount, now):
            if provider is T:
                return False
            return super().try_consume(provider, amount, now)

    rec = mock_http(provider_handler(load_fixture))
    quota = RacingQuota()
    make(rec, quota, clock).collect(relu_profile, mode=FetchMode.HOURLY)
    assert providers_called(rec) == [E, E]
    assert (T, MONTH) not in quota.usage()


def test_never_spends_beyond_quota(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(provider_handler(load_fixture))
    quota = InMemoryQuotaManager(
        {(T, MONTH): usable_limit(T) - 5, (E, MONTH): usable_limit(E) - 3 * request_cost(E)}
    )
    collector = make(rec, quota, clock)
    for _ in range(10):
        try:
            collector.collect(relu_profile, mode=FetchMode.HOURLY)
        except CollectorUnavailable:
            break
    assert len(rec.requests) == 5 + 3
    for provider in (T, E):
        assert quota.usage()[(provider, MONTH)] <= usable_limit(provider) + 1e-9


def test_parse_serper_date():
    assert parse_serper_date("Feb 3, 2025", NOW) == datetime(2025, 2, 3, tzinfo=UTC)
    assert parse_serper_date("3 February 2025", NOW) == datetime(2025, 2, 3, tzinfo=UTC)
    assert parse_serper_date("2 days ago", NOW) == NOW - timedelta(days=2)
    assert parse_serper_date("1 hour ago", NOW) == NOW - timedelta(hours=1)
    assert parse_serper_date("sometime", NOW) is None
    assert parse_serper_date(None, NOW) is None
