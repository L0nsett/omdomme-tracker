"""Reach scoring: how many people an item can reach, as a number in [0, 1].

- Web items (news, GDELT, web search): the domain's rank in the free Tranco top-1M
  list on a log scale. Rank 1 => 1.0, rank 1,000,000 => ~0.05, unknown => 0.02.
- Reddit: upvotes and comment count on a log scale, capped at 1.
"""

from __future__ import annotations

import io
import logging
import math
import zipfile
from collections.abc import Mapping
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from omdomme.contracts import RawMention, ReachScorer, SourceType

log = logging.getLogger(__name__)

TRANCO_URL = "https://tranco-list.eu/top-1m.csv.zip"
TRANCO_SIZE = 1_000_000

# A domain outside the top 1M.
UNKNOWN_DOMAIN_SCORE = 0.02
# Score of the last domain in the list (rank TRANCO_SIZE); rank 1 scores 1.0.
MIN_LISTED_SCORE = 0.05

# Engagement (upvotes + 2 * comments) that gives a Reddit post the full score.
REDDIT_FULL_ENGAGEMENT = 10_000
COMMENT_WEIGHT = 2


def rank_to_score(rank: int) -> float:
    rank = max(1, min(rank, TRANCO_SIZE))
    fraction = 1 - math.log10(rank) / math.log10(TRANCO_SIZE)
    return MIN_LISTED_SCORE + (1 - MIN_LISTED_SCORE) * fraction


def reddit_score(upvotes: int | None, num_comments: int | None) -> float:
    engagement = max(0, upvotes or 0) + COMMENT_WEIGHT * max(0, num_comments or 0)
    score = math.log10(1 + engagement) / math.log10(1 + REDDIT_FULL_ENGAGEMENT)
    return min(1.0, score)


def domain_of(value: str) -> str:
    """Lowercased host of a URL or bare domain, without "www."."""
    value = value.strip()
    if "://" not in value:
        value = "//" + value
    try:
        host = (urlsplit(value).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""
    return host.removeprefix("www.")


def load_tranco_csv(path: Path) -> dict[str, int]:
    """Parse a Tranco `rank,domain` CSV. Bad lines are skipped."""
    ranks: dict[str, int] = {}
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            rank_s, _, domain = line.strip().partition(",")
            if not domain:
                continue
            try:
                rank = int(rank_s)
            except ValueError:
                continue
            ranks.setdefault(domain.lower(), rank)
    return ranks


class TrancoReachScorer(ReachScorer):
    def __init__(self, ranks: Mapping[str, int]) -> None:
        self._ranks = ranks

    @classmethod
    def from_csv(cls, path: Path) -> TrancoReachScorer:
        return cls(load_tranco_csv(path))

    @classmethod
    def from_cache(cls, cache_dir: Path, http: httpx.Client, today: date) -> TrancoReachScorer:
        """Use today's cached list, downloading it at most once a day.

        If the download fails, the newest older list is used; with no list at all
        every web item gets the unknown-domain score (the run still works).
        """
        path = ensure_tranco_list(cache_dir, http, today)
        if path is None:
            log.warning("no Tranco list available; all domains score as unknown")
            return cls({})
        return cls.from_csv(path)

    def rank(self, domain: str) -> int | None:
        """Rank of a domain, trying parent domains ("a.b.nrk.no" -> "nrk.no")."""
        labels = domain_of(domain).split(".")
        while len(labels) >= 2:
            rank = self._ranks.get(".".join(labels))
            if rank is not None:
                return rank
            labels = labels[1:]
        return None

    def score(self, raw: RawMention) -> float:
        if raw.source_type == SourceType.REDDIT:
            return reddit_score(raw.upvotes, raw.num_comments)
        # Google News links are news.google.com redirects: use the publisher.
        if raw.source_type == SourceType.GOOGLE_NEWS:
            candidates = [raw.source_name]
        else:
            candidates = [raw.url, raw.source_name]
        for candidate in candidates:
            rank = self.rank(candidate) if candidate else None
            if rank is not None:
                return rank_to_score(rank)
        return UNKNOWN_DOMAIN_SCORE


def ensure_tranco_list(cache_dir: Path, http: httpx.Client, today: date) -> Path | None:
    """Path to a Tranco CSV in `cache_dir`, downloading today's list if missing."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / f"tranco-{today.isoformat()}.csv"
    if target.exists():
        return target
    try:
        response = http.get(TRANCO_URL, follow_redirects=True, timeout=120)
        response.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(response.content)) as zf:
            member = next(n for n in zf.namelist() if n.endswith(".csv"))
            data = zf.read(member)
        tmp = target.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(target)
    except (httpx.HTTPError, zipfile.BadZipFile, StopIteration, OSError) as exc:
        log.warning("Tranco download failed (%s); using cached list if any", type(exc).__name__)
        older = sorted(cache_dir.glob("tranco-*.csv"))
        return older[-1] if older else None
    for old in cache_dir.glob("tranco-*.csv"):
        if old != target:
            old.unlink(missing_ok=True)
    return target
