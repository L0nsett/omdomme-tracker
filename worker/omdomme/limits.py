"""Verified free-tier limits. Source and date: docs/source-limits.md.

CONTRACT (phase 0): shared by collectors (agent A) and the pipeline (agent B).
"""

from __future__ import annotations

from datetime import timedelta

from omdomme.contracts import WebSearchProvider

# Fraction of every free quota that is never spent.
SAFETY_MARGIN = 0.05

# Free limit per provider, in the provider's own unit (see docs/source-limits.md).
QUOTA_LIMITS: dict[WebSearchProvider, float] = {
    WebSearchProvider.TAVILY: 1000.0,  # credits per month
    WebSearchProvider.EXA: 10.0,  # USD per month
    WebSearchProvider.SERPER: 2500.0,  # queries, one time (lifetime)
}

# Providers whose limit is lifetime instead of per calendar month.
LIFETIME_QUOTA: frozenset[WebSearchProvider] = frozenset({WebSearchProvider.SERPER})

# Cost of one search request in the provider's unit.
TAVILY_BASIC_SEARCH_CREDITS = 1.0
EXA_SEARCH_USD_UP_TO_10_RESULTS = 0.007
EXA_EXTRA_RESULT_USD = 0.001
EXA_CONTENTS_PER_PAGE_USD = 0.001
SERPER_QUERY_CREDITS = 1.0

# Never search the web for one profile more often than this.
MIN_WEB_SEARCH_INTERVAL = timedelta(hours=1)

# GDELT DOC 2.0
GDELT_MAX_LOOKBACK = timedelta(days=90)
GDELT_MAX_RECORDS = 250

# Reddit: 100 requests/minute per OAuth client, averaged over 10 minutes.
REDDIT_MAX_REQUESTS_PER_MINUTE = 100


def usable_limit(provider: WebSearchProvider) -> float:
    """The limit we allow ourselves to spend, after the safety margin."""
    return QUOTA_LIMITS[provider] * (1 - SAFETY_MARGIN)
