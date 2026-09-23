"""Web search over the free tiers of Tavily, Exa and Serper (one collector).

Every request is paid for with `QuotaManager.try_consume` *before* it is sent, so
the recorded usage never exceeds the free limits (docs/source-limits.md). The
provider is chosen per request with `QuotaManager.pick_provider`: Tavily then Exa
for hourly runs; Serper then Tavily then Exa for backfill.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any, ClassVar

import httpx

from omdomme.collectors.base import (
    Batch,
    Clock,
    clean_text,
    domain_of,
    ensure_utc,
    is_http_url,
    log,
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
    QuotaManager,
    RawMention,
    SourceType,
    WebSearchProvider,
)
from omdomme.quota import PROVIDER_ORDER, WEB_SEARCH_RESULTS, request_cost

TAVILY_URL = "https://api.tavily.com/search"
EXA_URL = "https://api.exa.ai/search"
SERPER_URL = "https://google.serper.dev/search"

SNIPPET_CHARS = 500

# Responses meaning "this provider cannot be used now" (bad key, out of credits,
# rate limited). The term is retried with the next provider.
PROVIDER_DOWN_STATUS = frozenset({401, 402, 403, 429, 432, 433})


class WebSearchCollector(Collector):
    source_type: ClassVar[SourceType] = SourceType.WEB_SEARCH

    def __init__(
        self,
        http: httpx.Client,
        quota: QuotaManager,
        *,
        tavily_api_key: str | None = None,
        exa_api_key: str | None = None,
        serper_api_key: str | None = None,
        clock: Clock = utc_now,
    ) -> None:
        self._http = http
        self._quota = quota
        self._keys: dict[WebSearchProvider, str] = {
            p: k
            for p, k in (
                (WebSearchProvider.TAVILY, tavily_api_key),
                (WebSearchProvider.EXA, exa_api_key),
                (WebSearchProvider.SERPER, serper_api_key),
            )
            if k
        }
        self._clock = clock

    @property
    def configured_providers(self) -> list[WebSearchProvider]:
        return list(self._keys)

    # -- Provider choice -----------------------------------------------------

    def _choose(
        self, mode: FetchMode, now: datetime, excluded: set[WebSearchProvider]
    ) -> WebSearchProvider | None:
        eligible = [p for p in PROVIDER_ORDER[mode] if p in self._keys and p not in excluded]
        picked = self._quota.pick_provider(mode, now)
        if picked in eligible:
            return picked
        # The manager's first choice has no key here or failed this call: take
        # the next eligible provider that still has quota for one request.
        for provider in eligible:
            if self._quota.remaining(provider, now) >= request_cost(provider):
                return provider
        return None

    # -- Collect -------------------------------------------------------------

    def collect(
        self, profile: Profile, *, mode: FetchMode, since: datetime | None = None
    ) -> list[RawMention]:
        if not self._keys:
            raise CollectorUnavailable("web_search: no API keys configured")
        eligible = [p for p in PROVIDER_ORDER[mode] if p in self._keys]
        if not eligible:
            raise CollectorUnavailable(f"web_search: no provider configured for {mode.value}")

        batch = Batch("web_search")
        excluded: set[WebSearchProvider] = set()
        sent = 0
        for n, term in enumerate(profile.search_terms, start=1):
            while True:
                now = ensure_utc(self._clock())
                provider = self._choose(mode, now, excluded)
                if provider is None:
                    if sent == 0:
                        raise CollectorUnavailable("web_search: no provider has quota left")
                    log.info("web_search: quota ran out; returning partial results")
                    return batch.result()
                if not self._quota.try_consume(provider, request_cost(provider), now):
                    excluded.add(provider)  # lost a race for the last credits
                    continue
                sent += 1
                try:
                    items = self._search(provider, term, now)
                except httpx.HTTPStatusError as exc:
                    batch.failed(f"{provider.value} term #{n}", exc)
                    if exc.response.status_code in PROVIDER_DOWN_STATUS:
                        excluded.add(provider)
                        continue  # same term, next provider
                    break
                except (httpx.HTTPError, ValueError) as exc:
                    batch.failed(f"{provider.value} term #{n}", exc)
                    break
                batch.succeeded()
                batch.add(items)
                break
        return batch.result()

    def _search(self, provider: WebSearchProvider, term: str, now: datetime) -> list[RawMention]:
        key = self._keys[provider]
        query = quote_term(term)
        match provider:
            case WebSearchProvider.TAVILY:
                resp = self._http.post(
                    TAVILY_URL,
                    json=tavily_request(query),
                    headers={"Authorization": f"Bearer {key}"},
                )
                resp.raise_for_status()
                return parse_tavily(resp.json())
            case WebSearchProvider.EXA:
                resp = self._http.post(EXA_URL, json=exa_request(query), headers={"x-api-key": key})
                resp.raise_for_status()
                return parse_exa(resp.json())
            case WebSearchProvider.SERPER:
                resp = self._http.post(
                    SERPER_URL, json=serper_request(query), headers={"X-API-KEY": key}
                )
                resp.raise_for_status()
                return parse_serper(resp.json(), now)
        raise ValueError(f"unknown provider {provider!r}")


# ---------------------------------------------------------------------------
# Requests (their cost is `quota.request_cost`)
# ---------------------------------------------------------------------------


def tavily_request(query: str) -> dict[str, Any]:
    # Basic depth = 1 credit. Never "advanced" (2 credits).
    return {
        "query": query,
        "search_depth": "basic",
        "max_results": WEB_SEARCH_RESULTS,
        "include_answer": False,
        "include_raw_content": False,
        "include_images": False,
    }


def exa_request(query: str) -> dict[str, Any]:
    # Highlights are billed per page; quota.exa_search_cost accounts for them.
    return {
        "query": query,
        "type": "auto",
        "numResults": WEB_SEARCH_RESULTS,
        "contents": {"highlights": {"numSentences": 3, "highlightsPerUrl": 2}},
    }


def serper_request(query: str) -> dict[str, Any]:
    # num <= 10 costs one query credit.
    return {"q": query, "num": WEB_SEARCH_RESULTS}


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------


def _results(data: Any, key: str) -> list[Any]:
    if not isinstance(data, dict):
        raise ValueError("response is not an object")
    results = data.get(key) or []
    if not isinstance(results, list):
        raise ValueError(f"'{key}' is not a list")
    return results


def _mention(
    provider: WebSearchProvider,
    url: Any,
    title: Any,
    snippet: str,
    published_at: datetime | None,
    raw: dict[str, Any],
) -> RawMention:
    if not is_http_url(url):
        raise ValueError("result without a usable url")
    url = url.strip()
    title = clean_text(title) if isinstance(title, str) else ""
    if not title:
        title = domain_of(url) or url
    return RawMention(
        url=url,
        title=title,
        snippet=truncate(snippet, SNIPPET_CHARS),
        source_type=SourceType.WEB_SEARCH,
        source_name=domain_of(url) or "unknown",
        published_at=published_at,
        provider=provider,
        raw=raw,
    )


def parse_iso_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        return ensure_utc(datetime.fromisoformat(text))
    except ValueError:
        return None


def parse_tavily(data: Any) -> list[RawMention]:
    def parse(r: dict[str, Any]) -> RawMention:
        return _mention(
            WebSearchProvider.TAVILY,
            r["url"],
            r.get("title"),
            r.get("content") or "",
            parse_iso_datetime(r.get("published_date")),
            r,
        )

    return parse_each(_results(data, "results"), parse, "tavily")


def parse_exa(data: Any) -> list[RawMention]:
    def parse(r: dict[str, Any]) -> RawMention:
        highlights = [h for h in (r.get("highlights") or []) if isinstance(h, str)]
        snippet = " … ".join(clean_text(h) for h in highlights) or r.get("text") or ""
        return _mention(
            WebSearchProvider.EXA,
            r["url"],
            r.get("title"),
            snippet if isinstance(snippet, str) else "",
            parse_iso_datetime(r.get("publishedDate")),
            r,
        )

    return parse_each(_results(data, "results"), parse, "exa")


def parse_serper(data: Any, now: datetime) -> list[RawMention]:
    def parse(r: dict[str, Any]) -> RawMention:
        return _mention(
            WebSearchProvider.SERPER,
            r["link"],
            r.get("title"),
            r.get("snippet") or "",
            parse_serper_date(r.get("date"), now),
            r,
        )

    return parse_each(_results(data, "organic"), parse, "serper")


_RELATIVE_RE = re.compile(r"^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$", re.IGNORECASE)
_RELATIVE_UNITS = {
    "minute": timedelta(minutes=1),
    "hour": timedelta(hours=1),
    "day": timedelta(days=1),
    "week": timedelta(weeks=1),
    "month": timedelta(days=30),
    "year": timedelta(days=365),
}


def parse_serper_date(value: Any, now: datetime) -> datetime | None:
    """Serper dates: "Feb 3, 2025", "3 Feb 2025" or relative ("2 days ago")."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    rel = _RELATIVE_RE.match(text)
    if rel:
        return ensure_utc(now) - int(rel.group(1)) * _RELATIVE_UNITS[rel.group(2).lower()]
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%d %b %Y", "%d %B %Y", "%Y-%m-%d"):
        try:
            return ensure_utc(datetime.strptime(text, fmt))
        except ValueError:
            continue
    return None
