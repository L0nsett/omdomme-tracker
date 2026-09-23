from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from omdomme.collectors import CollectorError, GdeltCollector
from omdomme.collectors.gdelt import parse_seendate
from omdomme.contracts import FetchMode, SourceType
from omdomme.limits import GDELT_MAX_LOOKBACK

from .conftest import NOW


@pytest.fixture
def gdelt_body(load_fixture) -> str:
    return json.dumps(load_fixture("gdelt_relu.json"))


def make(rec, clock, sleeps=None):
    return GdeltCollector(
        rec.client,
        clock=clock,
        pause_seconds=5,
        sleep=(sleeps.append if sleeps is not None else lambda s: None),
    )


def test_emits_expected_urls_and_fields(mock_http, clock, gdelt_body, relu_profile, expected_urls):
    rec = mock_http(lambda req: httpx.Response(200, text=gdelt_body))
    sleeps: list[float] = []
    items = make(rec, clock, sleeps).collect(relu_profile, mode=FetchMode.BACKFILL)

    assert len(rec.requests) == 2  # one per search term
    assert sleeps == [5]  # polite pause between the two calls
    assert {i.url for i in items} == expected_urls("gdelt")
    assert len(items) == 4

    first = items[0]
    assert first.source_type is SourceType.GDELT
    assert first.url == "https://www.itavisen.no/2026/09/19/relu-ntnu-nordic-student-ai-conference"
    assert first.title == "ReLU NTNU hosts Nordic student AI conference"
    assert first.source_name == "itavisen.no"
    assert first.published_at == datetime(2026, 9, 19, 10, 15, tzinfo=UTC)
    assert first.snippet == "" and first.links == []
    assert [i.source_name for i in items] == [
        "itavisen.no",
        "analyticsinsight.net",
        "adressa.no",
        "universitetsavisa.no",
    ]


def test_backfill_parameters(mock_http, clock, gdelt_body, one_term_profile):
    rec = mock_http(lambda req: httpx.Response(200, text=gdelt_body))
    make(rec, clock).collect(one_term_profile, mode=FetchMode.BACKFILL, since=NOW)
    (req,) = rec.requests
    assert req.url.host == "api.gdeltproject.org" and req.url.path == "/api/v2/doc/doc"
    assert dict(req.url.params) == {
        "query": '"ReLU NTNU"',
        "mode": "artlist",
        "format": "json",
        "maxrecords": "250",
        "sort": "datedesc",
        "timespan": "3months",
    }


def test_hourly_parameters_use_since(mock_http, clock, gdelt_body, one_term_profile):
    rec = mock_http(lambda req: httpx.Response(200, text=gdelt_body))
    collector = make(rec, clock)

    collector.collect(one_term_profile, mode=FetchMode.HOURLY, since=NOW - timedelta(hours=1))
    params = dict(rec.requests[-1].url.params)
    assert "timespan" not in params
    assert params["startdatetime"] == "20260923103000"  # since minus 30 min overlap
    assert params["enddatetime"] == "20260923120000"

    # No since: a short timespan.
    collector.collect(one_term_profile, mode=FetchMode.HOURLY)
    params = dict(rec.requests[-1].url.params)
    assert params["timespan"] == "1d" and "startdatetime" not in params

    # A very old since is clamped inside GDELT's rolling window.
    collector.collect(one_term_profile, mode=FetchMode.HOURLY, since=NOW - timedelta(days=365))
    start = datetime.strptime(rec.requests[-1].url.params["startdatetime"], "%Y%m%d%H%M%S")
    assert NOW - start.replace(tzinfo=UTC) < GDELT_MAX_LOOKBACK

    # A since in the last minutes still gives GDELT its 15 minute minimum window.
    collector.collect(one_term_profile, mode=FetchMode.HOURLY, since=NOW + timedelta(minutes=20))
    assert rec.requests[-1].url.params["startdatetime"] == "20260923114500"


def test_parse_seendate():
    assert parse_seendate("20260919T101500Z") == datetime(2026, 9, 19, 10, 15, tzinfo=UTC)
    with pytest.raises(ValueError):
        parse_seendate("yesterday")


def test_skips_malformed_articles(mock_http, clock, one_term_profile):
    body = json.dumps(
        {
            "articles": [
                {"url": "https://a.example/1", "title": "Ok &amp; fine", "seendate": "bad"},
                {"title": "no url"},
                {"url": "not-a-url", "title": "x"},
                {"url": "https://b.example/2", "title": ""},
                "garbage",
                {"url": "https://c.example/3", "title": "Dup", "domain": "c.example"},
                {"url": "https://c.example/3", "title": "Dup again"},
            ]
        }
    )
    rec = mock_http(lambda req: httpx.Response(200, text=body))
    items = make(rec, clock).collect(one_term_profile, mode=FetchMode.HOURLY)
    assert [(i.url, i.title, i.source_name) for i in items] == [
        ("https://a.example/1", "Ok & fine", "a.example"),
        ("https://c.example/3", "Dup", "c.example"),
    ]
    assert items[0].published_at is None


def test_empty_result_is_not_an_error(mock_http, clock, one_term_profile):
    rec = mock_http(lambda req: httpx.Response(200, text="{}"))
    assert make(rec, clock).collect(one_term_profile, mode=FetchMode.HOURLY) == []


def test_one_failed_term_keeps_the_other(mock_http, clock, gdelt_body, relu_profile):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.params["query"] == '"ReLU"':
            # GDELT reports query errors as plain text with status 200.
            return httpx.Response(200, text="Your search contained a phrase that was too short.")
        return httpx.Response(200, text=gdelt_body)

    rec = mock_http(handler)
    assert len(make(rec, clock).collect(relu_profile, mode=FetchMode.HOURLY)) == 4


def test_all_failed_raises(mock_http, clock, relu_profile):
    rec = mock_http(lambda req: httpx.Response(429))
    with pytest.raises(CollectorError, match="HTTP 429"):
        make(rec, clock).collect(relu_profile, mode=FetchMode.HOURLY)


def test_retries_once_after_rate_limit_or_timeout(
    mock_http, clock, one_term_profile, load_fixture
) -> None:
    body = json.dumps(load_fixture("gdelt_relu.json"))
    for first in (httpx.Response(429, text="Please limit requests"), "timeout"):
        calls: list[int] = []

        def handler(request: httpx.Request, first=first, calls=calls) -> httpx.Response:
            calls.append(1)
            if len(calls) == 1:
                if first == "timeout":
                    raise httpx.ConnectTimeout("slow", request=request)
                return first
            return httpx.Response(200, text=body)

        sleeps: list[float] = []
        items = make(mock_http(handler), clock, sleeps).collect(
            one_term_profile, mode=FetchMode.BACKFILL
        )
        assert len(calls) == 2 and sleeps == [10.0]
        assert len(items) == 4


def test_gives_up_after_one_retry(mock_http, clock, one_term_profile) -> None:
    rec = mock_http(lambda request: httpx.Response(429, text="Please limit requests"))
    with pytest.raises(CollectorError):
        make(rec, clock).collect(one_term_profile, mode=FetchMode.BACKFILL)
