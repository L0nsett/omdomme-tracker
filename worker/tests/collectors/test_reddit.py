from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from omdomme.collectors import CollectorError, RedditCollector
from omdomme.collectors.reddit import REQUESTS_PER_MINUTE_PER_PROCESS, time_filter
from omdomme.contracts import CollectorUnavailable, FetchMode, SourceType
from omdomme.limits import REDDIT_MAX_REQUESTS_PER_MINUTE

from .conftest import NOW

UA = "omdomme-tracker/test"


def reddit_handler(load_fixture, search=None):
    token = load_fixture("reddit_token.json")
    listing = load_fixture("reddit_search_relu.json")

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "www.reddit.com" and req.url.path == "/api/v1/access_token":
            return httpx.Response(200, json=token)
        if req.url.host == "oauth.reddit.com" and req.url.path == "/search":
            if search is not None:
                return search(req)
            return httpx.Response(200, json=listing)
        return httpx.Response(404)

    return handler


def make(rec, clock, **kw):
    return RedditCollector(
        rec.client,
        client_id=kw.pop("client_id", "id"),
        client_secret=kw.pop("client_secret", "secret"),
        user_agent=UA,
        clock=clock,
        **kw,
    )


def test_emits_expected_urls_and_fields(
    mock_http, clock, load_fixture, relu_profile, expected_urls
):
    rec = mock_http(reddit_handler(load_fixture))
    items = make(rec, clock).collect(relu_profile, mode=FetchMode.HOURLY)

    assert {i.url for i in items} == expected_urls("reddit")
    assert len(items) == 4
    first = items[0]
    assert first.source_type is SourceType.REDDIT
    assert first.url == (
        "https://www.reddit.com/r/ntnu/comments/1abc01/anyone_joining_relu_ntnus_workshop_on_thursday/"
    )
    assert first.title == "Anyone joining ReLU NTNU's workshop on Thursday?"
    assert first.snippet.startswith("Heard they are doing an intro")
    assert first.source_name == "r/ntnu"
    assert first.upvotes == 45 and first.num_comments == 12
    assert first.published_at == datetime.fromtimestamp(1758528000, tz=UTC)
    assert first.links == []  # self post: its own url is not an outbound link

    course = items[3]
    assert course.source_name == "r/trondheim"
    assert course.links == ["https://www.relu-ntnu.no/events/ai-kurs-host-2026"]


def test_oauth_and_search_requests(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(reddit_handler(load_fixture))
    collector = make(rec, clock)
    collector.collect(relu_profile, mode=FetchMode.HOURLY)
    collector.collect(relu_profile, mode=FetchMode.HOURLY)

    token_reqs = rec.to("www.reddit.com")
    assert len(token_reqs) == 1  # token is cached
    tok = token_reqs[0]
    assert tok.method == "POST"
    assert tok.headers["authorization"].startswith("Basic ")
    assert tok.content == b"grant_type=client_credentials"
    assert tok.headers["user-agent"] == UA

    searches = rec.to("oauth.reddit.com")
    assert len(searches) == 4
    s = searches[0]
    assert s.headers["authorization"] == "bearer test-token-not-real"
    assert s.headers["user-agent"] == UA
    assert dict(s.url.params) == {
        "q": '"ReLU NTNU"',
        "sort": "new",
        "t": "day",
        "limit": "100",
        "type": "link",
        "raw_json": "1",
    }
    assert searches[1].url.params["q"] == '"ReLU"'


def test_backfill_uses_t_all_and_paginates(mock_http, clock, load_fixture, one_term_profile):
    listing = load_fixture("reddit_search_relu.json")
    pages = {
        None: {"kind": "Listing", "data": {**listing["data"], "after": "t3_page2"}},
        "t3_page2": {
            "kind": "Listing",
            "data": {
                "after": None,
                "children": [
                    {
                        "kind": "t3",
                        "data": {
                            **listing["data"]["children"][0]["data"],
                            "permalink": "/r/ntnu/comments/older/old_post/",
                            "is_self": False,
                            "url": "https://www.nrk.no/relu-sak",
                            "selftext": "",
                        },
                    }
                ],
            },
        },
    }

    def search(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=pages[req.url.params.get("after")])

    rec = mock_http(reddit_handler(load_fixture, search))
    items = make(rec, clock).collect(one_term_profile, mode=FetchMode.BACKFILL, since=NOW)
    searches = rec.to("oauth.reddit.com")
    assert [r.url.params["t"] for r in searches] == ["all", "all"]
    assert [r.url.params.get("after") for r in searches] == [None, "t3_page2"]
    assert len(items) == 5
    older = items[-1]
    assert older.url == "https://www.reddit.com/r/ntnu/comments/older/old_post/"
    assert older.links == ["https://www.nrk.no/relu-sak"]  # external link post


def test_time_filter():
    assert time_filter(FetchMode.BACKFILL, NOW, NOW) == "all"
    assert time_filter(FetchMode.HOURLY, NOW, None) == "day"
    assert time_filter(FetchMode.HOURLY, NOW, NOW - timedelta(hours=2)) == "day"
    assert time_filter(FetchMode.HOURLY, NOW, NOW - timedelta(days=3)) == "week"
    assert time_filter(FetchMode.HOURLY, NOW, NOW - timedelta(days=20)) == "month"
    assert time_filter(FetchMode.HOURLY, NOW, NOW - timedelta(days=200)) == "year"
    assert time_filter(FetchMode.HOURLY, NOW, NOW - timedelta(days=900)) == "all"


@pytest.mark.parametrize(
    ("client_id", "client_secret"), [(None, None), ("id", None), (None, "secret"), ("", "")]
)
def test_missing_credentials_is_unavailable(
    mock_http, clock, relu_profile, client_id, client_secret
):
    rec = mock_http(lambda req: httpx.Response(500))
    collector = make(rec, clock, client_id=client_id, client_secret=client_secret)
    with pytest.raises(CollectorUnavailable, match="no credentials"):
        collector.collect(relu_profile, mode=FetchMode.HOURLY)
    assert rec.requests == []


def test_rejected_credentials_raise_collector_error(mock_http, clock, relu_profile):
    rec = mock_http(lambda req: httpx.Response(401, json={"error": "invalid_grant"}))
    with pytest.raises(CollectorError, match="OAuth token: HTTP 401"):
        make(rec, clock).collect(relu_profile, mode=FetchMode.HOURLY)


def test_expired_token_is_renewed_once(mock_http, clock, load_fixture, one_term_profile):
    listing = load_fixture("reddit_search_relu.json")
    calls = {"n": 0}

    def search(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(401) if calls["n"] == 1 else httpx.Response(200, json=listing)

    rec = mock_http(reddit_handler(load_fixture, search))
    items = make(rec, clock).collect(one_term_profile, mode=FetchMode.HOURLY)
    assert len(items) == 4
    assert len(rec.to("www.reddit.com")) == 2


def test_one_failing_term_keeps_the_other(mock_http, clock, load_fixture, relu_profile):
    listing = load_fixture("reddit_search_relu.json")

    def search(req: httpx.Request) -> httpx.Response:
        if req.url.params["q"] == '"ReLU"':
            return httpx.Response(503)
        return httpx.Response(200, json=listing)

    rec = mock_http(reddit_handler(load_fixture, search))
    assert len(make(rec, clock).collect(relu_profile, mode=FetchMode.HOURLY)) == 4


def test_all_searches_failing_raises(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(reddit_handler(load_fixture, lambda req: httpx.Response(200, text="<html>")))
    with pytest.raises(CollectorError, match="all 2 requests failed"):
        make(rec, clock).collect(relu_profile, mode=FetchMode.HOURLY)


def test_skips_malformed_posts(mock_http, clock, load_fixture, one_term_profile):
    good = load_fixture("reddit_search_relu.json")["data"]["children"][0]
    long_text = "word " * 400 + "https://example.com/end."
    body = {
        "kind": "Listing",
        "data": {
            "after": None,
            "children": [
                {"kind": "t1", "data": {"body": "a comment"}},
                {"kind": "t3", "data": {"title": "no permalink"}},
                {"kind": "t3", "data": {**good["data"], "permalink": "http://evil"}},
                {"kind": "t3", "data": {**good["data"], "title": "   "}},
                "garbage",
                {
                    "kind": "t3",
                    "data": {
                        **good["data"],
                        "permalink": "/r/x/comments/long/",
                        "selftext": long_text,
                        "score": None,
                        "created_utc": "nope",
                        "subreddit_name_prefixed": None,
                        "subreddit": "x",
                    },
                },
                good,
            ],
        },
    }
    rec = mock_http(reddit_handler(load_fixture, lambda req: httpx.Response(200, json=body)))
    items = make(rec, clock).collect(one_term_profile, mode=FetchMode.HOURLY)
    assert [i.url for i in items] == [
        "https://www.reddit.com/r/x/comments/long/",
        "https://www.reddit.com" + good["data"]["permalink"],
    ]
    long = items[0]
    assert len(long.snippet) <= 500 and long.snippet.endswith("…")
    assert long.links == ["https://example.com/end"]  # found beyond the snippet
    assert long.source_name == "r/x"
    assert long.published_at is None
    assert long.upvotes == 45  # falls back to ups when score is missing


def test_throttle_stays_under_rate_limit(mock_http, clock, load_fixture, relu_profile):
    rec = mock_http(reddit_handler(load_fixture))
    t = {"now": 0.0}
    sleeps: list[float] = []

    def sleep(s: float) -> None:
        sleeps.append(s)
        t["now"] += s

    collector = make(rec, clock, sleep=sleep, monotonic=lambda: t["now"])
    # Each process uses half of Reddit's limit (hourly + one backfill may overlap).
    assert REQUESTS_PER_MINUTE_PER_PROCESS * 2 <= REDDIT_MAX_REQUESTS_PER_MINUTE
    rounds = REQUESTS_PER_MINUTE_PER_PROCESS // 2 + 1  # 2 requests per round
    for _ in range(rounds):
        collector.collect(relu_profile, mode=FetchMode.HOURLY)
    assert len(rec.to("oauth.reddit.com")) == rounds * 2
    assert sleeps == [60.0]  # request 51 waits for the window to roll over
