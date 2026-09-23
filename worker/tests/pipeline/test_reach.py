from __future__ import annotations

import io
import os
import zipfile
from datetime import date
from pathlib import Path

import httpx
import pytest

from omdomme.contracts import RawMention, SourceType
from omdomme.reach import (
    TRANCO_URL,
    UNKNOWN_DOMAIN_SCORE,
    TrancoReachScorer,
    rank_to_score,
    reddit_score,
)
from tests.pipeline.fixture_items import all_fixture_items, tranco_scorer


def _web(url: str, source_type: SourceType = SourceType.WEB_SEARCH, source_name: str = ""):
    return RawMention(url=url, title="t", source_type=source_type, source_name=source_name)


def test_ordering_by_rank() -> None:
    scorer = tranco_scorer()
    nrk = scorer.score(_web("https://www.nrk.no/a", SourceType.GDELT, "nrk.no"))
    ua = scorer.score(_web("https://www.universitetsavisa.no/a", SourceType.GDELT))
    unknown = scorer.score(_web("https://www.nidaros.no/a"))
    assert 1 >= nrk > ua > unknown >= 0
    assert unknown == UNKNOWN_DOMAIN_SCORE


def test_rank_scale_bounds() -> None:
    assert rank_to_score(1) == pytest.approx(1.0)
    assert rank_to_score(1_000_000) < 0.1
    assert rank_to_score(5_000_000) == rank_to_score(1_000_000)
    assert rank_to_score(1_000_000) > UNKNOWN_DOMAIN_SCORE
    assert rank_to_score(10) > rank_to_score(100) > rank_to_score(10_000)


def test_parent_domains_and_www() -> None:
    scorer = tranco_scorer()
    assert scorer.rank("https://www.nrk.no/x") == 1500
    assert scorer.rank("tv.nrk.no") == 1500
    assert scorer.rank("NRK.no") == 1500
    assert scorer.rank("no") is None
    assert scorer.rank("") is None


def test_google_news_uses_publisher_not_redirect() -> None:
    scorer = tranco_scorer()
    raw = _web("https://news.google.com/rss/articles/abc", SourceType.GOOGLE_NEWS, "nrk.no")
    assert scorer.score(raw) == rank_to_score(1500)
    # google.com (rank 1) must not leak in through the redirect link
    unknown = _web("https://news.google.com/rss/articles/x", SourceType.GOOGLE_NEWS, "nidaros.no")
    assert scorer.score(unknown) == UNKNOWN_DOMAIN_SCORE


def test_falls_back_to_source_name() -> None:
    scorer = tranco_scorer()
    raw = _web("https://amp-cache.example/abc", SourceType.GDELT, "adressa.no")
    assert scorer.score(raw) == rank_to_score(5200)


def test_reddit_engagement() -> None:
    def post(ups, comments):
        return RawMention(
            url="https://www.reddit.com/r/x/comments/1/",
            title="t",
            source_type=SourceType.REDDIT,
            source_name="r/x",
            upvotes=ups,
            num_comments=comments,
        )

    scorer = tranco_scorer()
    assert scorer.score(post(0, 0)) == 0
    assert scorer.score(post(None, None)) == 0
    assert scorer.score(post(-5, 0)) == 0
    assert scorer.score(post(10**9, 10**9)) == 1
    assert 0 < scorer.score(post(18, 3)) < scorer.score(post(45, 12)) < scorer.score(post(812, 240))
    assert reddit_score(45, 12) < 1


def test_all_fixture_items_in_bounds() -> None:
    scorer = tranco_scorer()
    for raw in all_fixture_items():
        assert 0 <= scorer.score(raw) <= 1


def _zip_csv(text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("top-1m.csv", text)
    return buf.getvalue()


def test_from_cache_downloads_once_per_day(tmp_path: Path) -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, content=_zip_csv("1,google.com\n1500,nrk.no\n"))

    (tmp_path / "tranco-2026-09-22.csv").write_text("1,old.com\n")
    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        scorer = TrancoReachScorer.from_cache(tmp_path, http, date(2026, 9, 23))
        again = TrancoReachScorer.from_cache(tmp_path, http, date(2026, 9, 23))
    assert calls == [TRANCO_URL]
    assert scorer.rank("nrk.no") == 1500 and again.rank("nrk.no") == 1500
    assert sorted(os.listdir(tmp_path)) == ["tranco-2026-09-23.csv"]


def test_from_cache_falls_back_to_older_list(tmp_path: Path) -> None:
    (tmp_path / "tranco-2026-09-20.csv").write_text("7,old.com\n")
    (tmp_path / "tranco-2026-09-22.csv").write_text("1500,nrk.no\n")
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503))) as http:
        scorer = TrancoReachScorer.from_cache(tmp_path, http, date(2026, 9, 23))
    assert scorer.rank("nrk.no") == 1500


def test_from_cache_without_any_list(tmp_path: Path) -> None:
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200))) as http:
        scorer = TrancoReachScorer.from_cache(tmp_path / "c", http, date(2026, 9, 23))
    assert scorer.score(_web("https://www.nrk.no/")) == UNKNOWN_DOMAIN_SCORE


def test_csv_loader_skips_bad_lines(tmp_path: Path) -> None:
    path = tmp_path / "t.csv"
    path.write_text("rank,domain\n1,google.com\nbroken\nx,y.com\n2,Reddit.com\n")
    scorer = TrancoReachScorer.from_csv(path)
    assert scorer.rank("reddit.com") == 2 and scorer.rank("y.com") is None
