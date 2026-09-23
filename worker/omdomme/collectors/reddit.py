"""Reddit search through the Data API (OAuth app-only). See docs/source-limits.md."""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar

import httpx

from omdomme.collectors.base import (
    Batch,
    Clock,
    CollectorError,
    clean_text,
    describe_error,
    domain_of,
    ensure_utc,
    find_urls,
    is_http_url,
    parse_each,
    quote_term,
    truncate,
    utc_now,
)
from omdomme.contracts import (
    Collector,
    CollectorUnavailable,
    FetchMode,
    Profile,
    RawMention,
    SourceType,
)
from omdomme.limits import REDDIT_MAX_REQUESTS_PER_MINUTE

REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
REDDIT_SEARCH_URL = "https://oauth.reddit.com/search"
REDDIT_WEB = "https://www.reddit.com"

PAGE_SIZE = 100
# The hourly job and one backfill job may run at the same time (separate
# concurrency groups), so each process uses at most half of Reddit's limit.
REQUESTS_PER_MINUTE_PER_PROCESS = REDDIT_MAX_REQUESTS_PER_MINUTE // 2
# Backfill pages per term: Reddit search stops around 1000 results anyway.
BACKFILL_MAX_PAGES = 10
SNIPPET_CHARS = 500
# Hosts that are Reddit itself (a post's url pointing here is not an outbound link).
REDDIT_HOSTS = ("reddit.com", "redd.it", "redditmedia.com", "redditstatic.com")


def time_filter(mode: FetchMode, now: datetime, since: datetime | None) -> str:
    """Reddit's `t` parameter: the smallest window that still reaches `since`."""
    if mode is FetchMode.BACKFILL:
        return "all"
    if since is None:
        return "day"
    gap = now - ensure_utc(since)
    for limit, value in (
        (timedelta(days=1), "day"),
        (timedelta(days=7), "week"),
        (timedelta(days=31), "month"),
        (timedelta(days=365), "year"),
    ):
        if gap <= limit:
            return value
    return "all"


class RedditCollector(Collector):
    source_type: ClassVar[SourceType] = SourceType.REDDIT

    def __init__(
        self,
        http: httpx.Client,
        *,
        client_id: str | None,
        client_secret: str | None,
        user_agent: str,
        clock: Clock = utc_now,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._http = http
        self._sleep = sleep
        self._monotonic = monotonic
        self._recent: deque[float] = deque()
        self._client_id = client_id
        self._client_secret = client_secret
        self._user_agent = user_agent
        self._clock = clock
        self._token: str | None = None
        self._token_expires: datetime | None = None

    @property
    def has_credentials(self) -> bool:
        return bool(self._client_id and self._client_secret)

    # -- OAuth ---------------------------------------------------------------

    def _access_token(self) -> str:
        now = ensure_utc(self._clock())
        if self._token and self._token_expires and now < self._token_expires:
            return self._token
        resp = self._http.post(
            REDDIT_TOKEN_URL,
            auth=(self._client_id or "", self._client_secret or ""),
            data={"grant_type": "client_credentials"},
            headers={"User-Agent": self._user_agent},
        )
        resp.raise_for_status()
        data = resp.json()
        token = data.get("access_token") if isinstance(data, dict) else None
        if not token:
            raise ValueError("Reddit token response without access_token")
        expires_in = data.get("expires_in")
        lifetime = float(expires_in) if isinstance(expires_in, int | float) else 3600.0
        # Renew a minute early.
        self._token = token
        self._token_expires = now + timedelta(seconds=max(0.0, lifetime - 60))
        return token

    def _throttle(self) -> None:
        """Stay under REDDIT_MAX_REQUESTS_PER_MINUTE in any 60 second window."""
        now = self._monotonic()
        while self._recent and now - self._recent[0] >= 60:
            self._recent.popleft()
        if len(self._recent) >= REQUESTS_PER_MINUTE_PER_PROCESS:
            self._sleep(60 - (now - self._recent[0]))
            self._recent.popleft()
        self._recent.append(self._monotonic())

    def _get(self, params: dict[str, str]) -> httpx.Response:
        for attempt in range(2):
            token = self._access_token()
            self._throttle()
            resp = self._http.get(
                REDDIT_SEARCH_URL,
                params=params,
                headers={"Authorization": f"bearer {token}", "User-Agent": self._user_agent},
            )
            if resp.status_code == 401 and attempt == 0:
                self._token = None  # expired or revoked: fetch a new one once
                continue
            resp.raise_for_status()
            return resp
        raise AssertionError("unreachable")

    # -- Collect -------------------------------------------------------------

    def request_params(
        self, term: str, mode: FetchMode, since: datetime | None, after: str | None = None
    ) -> dict[str, str]:
        params = {
            "q": quote_term(term),
            "sort": "new",
            "t": time_filter(mode, ensure_utc(self._clock()), since),
            "limit": str(PAGE_SIZE),
            "type": "link",
            "raw_json": "1",
        }
        if after:
            params["after"] = after
        return params

    def collect(
        self, profile: Profile, *, mode: FetchMode, since: datetime | None = None
    ) -> list[RawMention]:
        if not self.has_credentials:
            raise CollectorUnavailable("reddit: no credentials")
        try:
            self._access_token()
        except (httpx.HTTPError, ValueError) as exc:
            msg = f"reddit: could not get an OAuth token: {describe_error(exc)}"
            raise CollectorError(msg) from exc

        batch = Batch("reddit")
        max_pages = BACKFILL_MAX_PAGES if mode is FetchMode.BACKFILL else 1
        for n, term in enumerate(profile.search_terms, start=1):
            after: str | None = None
            for page in range(max_pages):
                try:
                    resp = self._get(self.request_params(term, mode, since, after))
                    items, after = parse_listing(resp.json())
                except (httpx.HTTPError, ValueError) as exc:
                    batch.failed(f"term #{n} page {page + 1}", exc)
                    break
                batch.succeeded()
                batch.add(items)
                if not after or not items:
                    break
        return batch.result()


def parse_listing(data: Any) -> tuple[list[RawMention], str | None]:
    """RawMentions and the `after` cursor from a /search Listing."""
    if not isinstance(data, dict) or not isinstance(data.get("data"), dict):
        raise ValueError("not a Reddit listing")
    listing = data["data"]
    children = listing.get("children") or []
    if not isinstance(children, list):
        raise ValueError("listing children is not a list")
    after = listing.get("after")
    return parse_each(children, _parse_post, "reddit"), after if isinstance(after, str) else None


def _parse_post(child: dict[str, Any]) -> RawMention | None:
    if child.get("kind") != "t3":
        return None
    post = child["data"]
    permalink = post["permalink"]
    if not isinstance(permalink, str) or not permalink.startswith("/"):
        raise ValueError("bad permalink")
    title = clean_text(post["title"])
    if not title:
        raise ValueError("post without title")

    selftext = post.get("selftext") or ""
    if not isinstance(selftext, str):
        selftext = ""
    links = find_urls(selftext)
    post_url = post.get("url")
    if is_http_url(post_url) and not _is_reddit_url(post_url) and post_url not in links:
        links.append(post_url)

    created = post.get("created_utc")
    published_at = (
        datetime.fromtimestamp(float(created), tz=UTC) if isinstance(created, int | float) else None
    )
    score = post.get("score")
    if not isinstance(score, int | float):
        score = post.get("ups")
    num_comments = post.get("num_comments")
    source_name = post.get("subreddit_name_prefixed") or f"r/{post['subreddit']}"

    return RawMention(
        url=REDDIT_WEB + permalink,
        title=title,
        snippet=truncate(selftext, SNIPPET_CHARS),
        source_type=SourceType.REDDIT,
        source_name=source_name,
        published_at=published_at,
        links=links,
        upvotes=int(score) if isinstance(score, int | float) else None,
        num_comments=int(num_comments) if isinstance(num_comments, int | float) else None,
        raw=post,
    )


def _is_reddit_url(url: str) -> bool:
    host = domain_of(url) or ""
    return any(host == h or host.endswith("." + h) for h in REDDIT_HOSTS)
