"""Shared contracts for the worker (phase 0).

CONTRACT: the models and interfaces in this file are locked. Phase 1 agents build
against them and must not change them. If a change is needed, stop and report it
to the main agent, who asks Leon for approval.

Mirrors the database schema in supabase/migrations/ and the TypeScript types in
web/src/lib/types.ts.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any, ClassVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------------------
# Enums (values match the CHECK constraints in the schema)
# ---------------------------------------------------------------------------


class SourceType(StrEnum):
    GOOGLE_NEWS = "google_news"
    GDELT = "gdelt"
    REDDIT = "reddit"
    WEB_SEARCH = "web_search"


class WebSearchProvider(StrEnum):
    TAVILY = "tavily"
    EXA = "exa"
    SERPER = "serper"


class FetchMode(StrEnum):
    """HOURLY: only new items. BACKFILL: as far back as the source allows."""

    HOURLY = "hourly"
    BACKFILL = "backfill"


class BackfillStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class Sentiment(StrEnum):
    POSITIVE = "positive"
    NEUTRAL = "neutral"
    NEGATIVE = "negative"


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------


class KeywordRule(BaseModel):
    """One row of `keyword_rules`.

    - Exact term:      term="ReLU NTNU", context_terms=[], is_exclusion=False
    - Ambiguous term:  term="ReLU", context_terms=["NTNU", "student"], is_exclusion=False
    - Exclusion:       term="activation function", is_exclusion=True
    """

    model_config = ConfigDict(frozen=True)

    term: str
    context_terms: list[str] = Field(default_factory=list)
    is_exclusion: bool = False

    @property
    def is_ambiguous(self) -> bool:
        return not self.is_exclusion and bool(self.context_terms)


class Profile(BaseModel):
    """A monitored organisation: one row of `profiles` plus its keyword rules."""

    id: UUID
    name: str
    website_url: str | None = None
    social_links: list[str] = Field(default_factory=list)
    keyword_rules: list[KeywordRule] = Field(default_factory=list)
    created_at: datetime
    backfill_status: BackfillStatus = BackfillStatus.PENDING
    last_web_search_at: datetime | None = None

    @property
    def search_terms(self) -> list[str]:
        """Terms that collectors send to sources (exact and ambiguous, not exclusions)."""
        return [r.term for r in self.keyword_rules if not r.is_exclusion]

    @property
    def exclusion_terms(self) -> list[str]:
        return [r.term for r in self.keyword_rules if r.is_exclusion]


# ---------------------------------------------------------------------------
# Mentions
# ---------------------------------------------------------------------------


class RawMention(BaseModel):
    """What every Collector returns, in the same format for all sources.

    Nothing here is stored as-is: the pipeline matches, scores and classifies it
    and turns it into a `Mention`.
    """

    url: str
    title: str
    snippet: str = ""
    source_type: SourceType
    # Publisher domain ("nrk.no"), "r/<subreddit>" for Reddit.
    source_name: str
    published_at: datetime | None = None
    # Outbound links found in the item (used by matching rule 3). May be empty.
    links: list[str] = Field(default_factory=list)
    # Reddit engagement; None for other sources.
    upvotes: int | None = None
    num_comments: int | None = None
    # Which web search provider produced it (only for source_type=web_search).
    provider: WebSearchProvider | None = None
    # Original payload for debugging. Never stored in the database.
    raw: dict[str, Any] = Field(default_factory=dict, repr=False)


class Classification(BaseModel):
    """Output of a Classifier. All fields are None in v1 (NullClassifier)."""

    sentiment: Sentiment | None = None
    # Jev five-level score mapped to [-1, 1].
    sentiment_score: float | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    classifier_version: str | None = None


class Mention(BaseModel):
    """One row of `mentions`, ready to upsert. Unique per (profile_id, url, source_type)."""

    profile_id: UUID
    url: str
    title: str
    snippet: str = ""
    source_type: SourceType
    source_name: str
    published_at: datetime | None = None
    fetched_at: datetime
    reach_score: float = Field(ge=0, le=1)
    sentiment: Sentiment | None = None
    sentiment_score: float | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    classifier_version: str | None = None
    hidden: bool = False

    @classmethod
    def from_raw(
        cls,
        raw: RawMention,
        *,
        profile_id: UUID,
        reach_score: float,
        classification: Classification,
        fetched_at: datetime,
    ) -> Mention:
        return cls(
            profile_id=profile_id,
            url=raw.url,
            title=raw.title,
            snippet=raw.snippet,
            source_type=raw.source_type,
            source_name=raw.source_name,
            published_at=raw.published_at,
            fetched_at=fetched_at,
            reach_score=reach_score,
            **classification.model_dump(),
        )


# ---------------------------------------------------------------------------
# Interfaces
# ---------------------------------------------------------------------------


class Collector(ABC):
    """One implementation per source. Takes a profile, returns raw items.

    Implementations receive an `httpx.Client` in their constructor so tests can
    inject `httpx.MockTransport`/respx. A collector must:
    - never raise on a single bad item (skip it),
    - raise `CollectorUnavailable` when it cannot run at all (missing credentials,
      quota exhausted); the pipeline records that and moves on,
    - not do matching; it may return items that later fail matching.
    """

    source_type: ClassVar[SourceType]

    @abstractmethod
    def collect(
        self,
        profile: Profile,
        *,
        mode: FetchMode,
        since: datetime | None = None,
    ) -> list[RawMention]:
        """Fetch items for `profile.search_terms`.

        HOURLY: items newer than `since` (if the source can filter; else recent items).
        BACKFILL: as far back as the source allows (`since` is ignored).
        """


class CollectorUnavailable(Exception):
    """Raised by a Collector that cannot run now (no credentials, no quota)."""


class Matcher(ABC):
    """Decides if a raw item is about the profile (PLAN.md, "Matching").

    Match if at least one of these holds, and no exclusion term occurs:
    1. an exact (non-ambiguous) term occurs,
    2. an ambiguous term occurs together with one of its context terms,
    3. it links to the profile's website or a social account, or mentions a
       username from one of the social links.
    Comparison is case-insensitive over title + snippet (+ url and links for rule 3).
    A term occurs when it starts at a word boundary; it may be followed by letters
    so Norwegian/English inflections count ("studentorganisasjon" matches
    "Studentorganisasjonen", "ReLU NTNU" matches "ReLU NTNU's" and "ReLU NTNU-lag").
    Ground truth: tests/fixtures/expected_matches.json.
    """

    @abstractmethod
    def matches(self, raw: RawMention, profile: Profile) -> bool: ...


class ReachScorer(ABC):
    """Gives an item a reach score in [0, 1].

    Web items: domain rank in the Tranco list mapped to [0, 1] (unknown domain => low).
    Reddit: from upvotes and comment count.
    """

    @abstractmethod
    def score(self, raw: RawMention) -> float: ...


class Classifier(ABC):
    """Returns sentiment and confidence for an item. Jev plugs in here later."""

    @abstractmethod
    def classify(self, raw: RawMention, profile: Profile) -> Classification: ...


class NullClassifier(Classifier):
    """v1 classifier: leaves every sentiment field empty."""

    def classify(self, raw: RawMention, profile: Profile) -> Classification:
        return Classification()


class QuotaManager(ABC):
    """Tracks remaining free credits per web search provider (`quota_usage`).

    Units per provider are documented in docs/source-limits.md. Invariant: the
    recorded usage for a provider never exceeds its free limit minus the safety
    margin; `try_consume` is the only way to spend credits and refuses otherwise.
    """

    @abstractmethod
    def remaining(self, provider: WebSearchProvider, now: datetime) -> float:
        """Credits left for the current period (month, or lifetime for Serper)."""

    @abstractmethod
    def try_consume(self, provider: WebSearchProvider, amount: float, now: datetime) -> bool:
        """Atomically record `amount` as spent. False (and nothing recorded) if it
        would exceed the limit."""

    @abstractmethod
    def pick_provider(self, mode: FetchMode, now: datetime) -> WebSearchProvider | None:
        """HOURLY: Tavily, then Exa. BACKFILL: Serper, then Tavily, then Exa.
        None when every eligible provider is exhausted."""

    @abstractmethod
    def web_search_interval(self, n_profiles: int, n_terms: int, now: datetime) -> timedelta | None:
        """How often one profile may run web search so the remaining credits last
        until the end of the month, spread over `n_profiles` with `n_terms` terms
        each on average. Never below one hour. None => skip web search until next
        month."""

    @abstractmethod
    def is_due(self, profile: Profile, n_profiles: int, now: datetime) -> bool:
        """True if `profile` should run web search in this hourly run."""
