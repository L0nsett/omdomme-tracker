"""Collectors: one per source (contracts.Collector).

The pipeline builds them with `build_collectors` and calls `collect()` per profile.
A collector raises `contracts.CollectorUnavailable` when it cannot run at all
(no credentials, no web search quota) and `CollectorError` when every request of
the call failed; partial failures are logged and the successful results returned.
"""

from __future__ import annotations

import httpx

from omdomme.collectors.base import CollectorError
from omdomme.collectors.gdelt import GdeltCollector
from omdomme.collectors.google_news import GoogleNewsCollector
from omdomme.collectors.reddit import RedditCollector
from omdomme.collectors.web_search import WebSearchCollector
from omdomme.config import Settings
from omdomme.contracts import Collector, QuotaManager

__all__ = [
    "CollectorError",
    "GdeltCollector",
    "GoogleNewsCollector",
    "RedditCollector",
    "WebSearchCollector",
    "build_collectors",
]


def build_collectors(
    settings: Settings, http: httpx.Client, quota: QuotaManager
) -> list[Collector]:
    """All four collectors. Ones without credentials raise CollectorUnavailable when used."""
    return [
        GoogleNewsCollector(http),
        GdeltCollector(http),
        RedditCollector(
            http,
            client_id=settings.reddit_client_id,
            client_secret=settings.reddit_client_secret,
            user_agent=settings.reddit_user_agent,
        ),
        WebSearchCollector(
            http,
            quota,
            tavily_api_key=settings.tavily_api_key,
            exa_api_key=settings.exa_api_key,
            serper_api_key=settings.serper_api_key,
        ),
    ]
