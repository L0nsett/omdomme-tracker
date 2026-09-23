from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from omdomme.collectors import CollectorError, GoogleNewsCollector
from omdomme.collectors.google_news import strip_publisher, when_operator
from omdomme.contracts import FetchMode, SourceType

from .conftest import NOW


@pytest.fixture
def rss(load_fixture) -> str:
    return load_fixture("google_news_relu.xml")


def test_emits_expected_urls_and_fields(mock_http, clock, rss, relu_profile, expected_urls):
    rec = mock_http(lambda req: httpx.Response(200, text=rss))
    items = GoogleNewsCollector(rec.client, clock=clock).collect(
        relu_profile, mode=FetchMode.HOURLY
    )

    # 2 terms x 2 editions, all returning the same feed: deduplicated to 5 items.
    assert len(rec.requests) == 4
    assert [i.url for i in items] == [
        "https://news.google.com/rss/articles/CBMiQmh0dHBzOi8vd3d3LnVuaXZlcnNpdGV0c2F2aXNhLm5vL3JlbHUtaGFja2F0aG9u0gEA?oc=5",
        "https://news.google.com/rss/articles/CBMiOGh0dHBzOi8vd3d3LmFkcmVzc2Eubm8vbnloZXRlci9yZWx1LWt2aW5uZXItbWFza2lubGFlcmluZ9IBAA?oc=5",
        "https://news.google.com/rss/articles/CBMiL2h0dHBzOi8vdG93YXJkc2RhdGFzY2llbmNlLmNvbS9yZWx1LXZzLXNpZ21vaWTSAQA?oc=5",
        "https://news.google.com/rss/articles/CBMiNWh0dHBzOi8vd3d3Lm5yay5uby90cm9uZGVsYWcvbnRudS1zdHVkZW50ZXItdmFudC1hadIBAA?oc=5",
        "https://news.google.com/rss/articles/CBMiK2h0dHBzOi8vd3d3LmtvZGUyNC5uby9sZWFreS1yZWx1LWZvcmtsYXJ00gEA?oc=5",
    ]
    assert {i.url for i in items} == expected_urls("google_news")

    first = items[0]
    assert first.source_type is SourceType.GOOGLE_NEWS
    assert first.title == "ReLU NTNU arrangerer AI-hackathon i Trondheim"
    assert first.source_name == "universitetsavisa.no"
    assert first.published_at == datetime(2026, 9, 22, 8, 0, tzinfo=UTC)
    assert first.snippet == ""  # description only repeats title + publisher
    assert first.provider is None and first.upvotes is None
    assert [i.source_name for i in items] == [
        "universitetsavisa.no",
        "adressa.no",
        "towardsdatascience.com",
        "nrk.no",
        "kode24.no",
    ]
    assert items[3].title == "NTNU-studenter vant nordisk AI-konkurranse med ReLU NTNU-lag"
    assert items[4].title == "Leaky ReLU forklart: pensum i NTNU-emnet TDT4265"


def test_request_parameters_hourly_and_backfill(mock_http, clock, rss, one_term_profile):
    rec = mock_http(lambda req: httpx.Response(200, text=rss))
    collector = GoogleNewsCollector(rec.client, clock=clock)

    collector.collect(one_term_profile, mode=FetchMode.HOURLY, since=NOW - timedelta(hours=1))
    hourly = [dict(r.url.params) for r in rec.requests]
    assert all(
        r.url.host == "news.google.com" and r.url.path == "/rss/search" for r in rec.requests
    )
    assert hourly == [
        {"q": '"ReLU NTNU" when:1d', "hl": "en-US", "gl": "US", "ceid": "US:en"},
        {"q": '"ReLU NTNU" when:1d', "hl": "no", "gl": "NO", "ceid": "NO:no"},
    ]

    rec.requests.clear()
    collector.collect(one_term_profile, mode=FetchMode.BACKFILL, since=NOW)
    backfill = [dict(r.url.params) for r in rec.requests]
    assert [p["q"] for p in backfill] == ['"ReLU NTNU"', '"ReLU NTNU"']
    assert [p["ceid"] for p in backfill] == ["US:en", "NO:no"]


def test_when_operator_widens_after_missed_runs():
    assert when_operator(NOW, None) == "when:1d"
    assert when_operator(NOW, NOW - timedelta(minutes=5)) == "when:1d"
    assert when_operator(NOW, NOW - timedelta(days=2, hours=1)) == "when:3d"
    assert when_operator(NOW, NOW - timedelta(days=400)) == "when:30d"
    assert when_operator(NOW, NOW + timedelta(hours=1)) == "when:1d"


def test_strip_publisher():
    assert strip_publisher("A - B - NRK", "NRK") == "A - B"
    assert strip_publisher("Title - Other", "NRK") == "Title - Other"
    assert strip_publisher("Title", "") == "Title"
    assert strip_publisher(" - NRK", "NRK") == " - NRK"


def test_skips_malformed_items(mock_http, clock, one_term_profile):
    feed = """<?xml version="1.0"?><rss><channel>
    <item><title>No link here</title></item>
    <item><title>Bad link</title><link>javascript:alert(1)</link></item>
    <item><link>https://news.google.com/rss/articles/notitle</link></item>
    <item>
      <title>Good one - Example</title>
      <link>https://news.google.com/rss/articles/good</link>
      <pubDate>not a date</pubDate>
      <description>&lt;b&gt;Longer&lt;/b&gt; summary text Example</description>
      <source url="https://example.com">Example</source>
    </item>
    <item><title>No source</title><link>https://news.google.com/rss/articles/nosource</link></item>
    </channel></rss>"""
    rec = mock_http(lambda req: httpx.Response(200, text=feed))
    items = GoogleNewsCollector(rec.client, clock=clock).collect(
        one_term_profile, mode=FetchMode.BACKFILL
    )
    assert [i.url for i in items] == [
        "https://news.google.com/rss/articles/good",
        "https://news.google.com/rss/articles/nosource",
    ]
    good, nosource = items
    assert good.title == "Good one"
    assert good.snippet == "Longer summary text"
    assert good.published_at is None
    assert good.source_name == "example.com"
    assert nosource.source_name == "news.google.com"


def test_one_failing_request_keeps_the_others(mock_http, clock, rss, one_term_profile):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.params["ceid"] == "US:en":
            return httpx.Response(503)
        return httpx.Response(200, text=rss)

    rec = mock_http(handler)
    items = GoogleNewsCollector(rec.client, clock=clock).collect(
        one_term_profile, mode=FetchMode.HOURLY
    )
    assert len(items) == 5


def test_all_requests_failing_raises(mock_http, clock, relu_profile):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.params["hl"] == "en":
            return httpx.Response(500)
        return httpx.Response(200, text="<html>not rss")

    rec = mock_http(handler)
    with pytest.raises(CollectorError, match="all 4 requests failed"):
        GoogleNewsCollector(rec.client, clock=clock).collect(relu_profile, mode=FetchMode.HOURLY)


def test_network_error_raises_when_nothing_succeeds(mock_http, clock, one_term_profile):
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=req)

    rec = mock_http(handler)
    with pytest.raises(CollectorError):
        GoogleNewsCollector(rec.client, clock=clock).collect(
            one_term_profile, mode=FetchMode.HOURLY
        )


def test_profile_without_terms_makes_no_requests(mock_http, clock, relu_profile):
    rec = mock_http(lambda req: httpx.Response(500))
    profile = relu_profile.model_copy(update={"keyword_rules": []})
    assert (
        GoogleNewsCollector(rec.client, clock=clock).collect(profile, mode=FetchMode.HOURLY) == []
    )
    assert rec.requests == []
