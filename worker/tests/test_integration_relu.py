"""Phase 2 end-to-end: ReLU NTNU through the real CLI, real collectors and the
real pipeline, against stored API responses (respx) and the local Postgres.

This is the only test that exercises the wiring in omdomme.cli (agent A's
collectors and quota manager plugged into agent B's pipeline).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import psycopg
import pytest
import respx

from omdomme import cli
from omdomme.collectors.gdelt import GdeltCollector

pytestmark = pytest.mark.db

RELU_ID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def relu_in_db(db: psycopg.Connection, load_fixture) -> dict:
    p = load_fixture("profile_relu.json")
    db.execute(
        "insert into profiles (id, name, website_url, social_links, created_at)"
        " values (%s, %s, %s, %s, %s)",
        (p["id"], p["name"], p["website_url"], p["social_links"], p["created_at"]),
    )
    for r in p["keyword_rules"]:
        db.execute(
            "insert into keyword_rules (profile_id, term, context_terms, is_exclusion)"
            " values (%s, %s, %s, %s)",
            (p["id"], r["term"], r["context_terms"], r["is_exclusion"]),
        )
    return p


@pytest.fixture
def mocked_apis(load_fixture, fixtures_dir):
    with respx.mock(assert_all_mocked=True, assert_all_called=False) as mock:
        mock.get(url__startswith="https://news.google.com/rss/search").respond(
            200,
            text=load_fixture("google_news_relu.xml"),
            headers={"content-type": "application/xml"},
        )
        mock.get(url__startswith="https://api.gdeltproject.org/").respond(
            200, json=load_fixture("gdelt_relu.json")
        )
        mock.post("https://www.reddit.com/api/v1/access_token").respond(
            200, json=load_fixture("reddit_token.json")
        )
        mock.get(url__startswith="https://oauth.reddit.com/search").respond(
            200, json=load_fixture("reddit_search_relu.json")
        )
        mock.post("https://api.tavily.com/search").respond(
            200, json=load_fixture("tavily_relu.json")
        )
        mock.post("https://api.exa.ai/search").respond(200, json=load_fixture("exa_relu.json"))
        mock.post("https://google.serper.dev/search").respond(
            200, json=load_fixture("serper_relu.json")
        )
        mock.get(url__startswith="https://tranco-list.eu/").mock(
            side_effect=httpx.ConnectError("Tranco comes from the pre-filled cache")
        )
        yield mock


@pytest.fixture
def worker_env(monkeypatch, tmp_path, fixtures_dir, _migrated_db):
    for key, value in {
        "DATABASE_URL": _migrated_db,
        "REDDIT_CLIENT_ID": "test-id",
        "REDDIT_CLIENT_SECRET": "test-secret",
        "REDDIT_USER_AGENT": "omdomme-tests",
        "TAVILY_API_KEY": "test-tavily",
        "EXA_API_KEY": "test-exa",
        "SERPER_API_KEY": "test-serper",
    }.items():
        monkeypatch.setenv(key, value)
    # Today's Tranco list is already cached, so nothing is downloaded.
    today = datetime.now(UTC).date().isoformat()
    (tmp_path / f"tranco-{today}.csv").write_text((fixtures_dir / "tranco_sample.csv").read_text())
    monkeypatch.setattr(cli, "CACHE_DIR", tmp_path)
    # No real 5 s pauses between GDELT queries.
    monkeypatch.setitem(GdeltCollector.__init__.__kwdefaults__, "pause_seconds", 0)


def stored(db: psycopg.Connection) -> set[tuple[str, str]]:
    return {(r[0], r[1]) for r in db.execute("select source_type, url from mentions")}


def test_relu_ntnu_end_to_end(db, relu_in_db, mocked_apis, worker_env, load_fixture) -> None:
    expected = load_fixture("expected_matches.json")["items"]
    should_match = {(i["source_type"], i["url"]) for i in expected if i["match"]}
    should_not = {(i["source_type"], i["url"]) for i in expected if not i["match"]}

    # 1. Backfill, as triggered by repository_dispatch when the profile is created.
    assert cli.main(["backfill", "--profile-id", RELU_ID]) == 0
    status = db.execute("select backfill_status from profiles where id=%s", (RELU_ID,)).fetchone()
    assert status[0] == "done"
    # Backfill web search uses Serper first.
    assert mocked_apis.routes[6].called and not mocked_apis.routes[4].called

    # 2. Right after backfill, web search is not due in the hourly run...
    assert cli.main(["hourly"]) == 0
    assert not mocked_apis.routes[4].called
    # ...but once it is due again, the hourly run uses Tavily.
    db.execute("update profiles set last_web_search_at = null")
    assert cli.main(["hourly"]) == 0
    assert mocked_apis.routes[4].called

    # 3. Tavily is out of quota and web search is due again: Exa is the fallback.
    month = datetime.now(UTC).date().replace(day=1)
    db.execute(
        "update quota_usage set credits_used = 950 where provider='tavily' and month=%s", (month,)
    )
    db.execute("update profiles set last_web_search_at = null")
    assert cli.main(["hourly"]) == 0
    assert mocked_apis.routes[5].called

    rows = stored(db)
    assert rows == should_match
    assert not rows & should_not

    # Sentiment stays empty in v1; reach is set and ordered sensibly.
    reach = dict(
        db.execute(
            "select url, reach_score from mentions where source_type in ('gdelt','web_search')"
        ).fetchall()
    )
    assert (
        reach["https://www.adressa.no/nyheter/trondheim/relu-apen-kildekode-modell"]
        > reach["https://www.universitetsavisa.no/relu-hackathon"]
    )
    assert (
        db.execute("select count(*) from mentions where sentiment is not null").fetchone()[0] == 0
    )

    # Quota was recorded for every provider that was used, and never overshot.
    usage = dict(db.execute("select provider, sum(credits_used) from quota_usage group by 1"))
    assert usage["serper"] == Decimal(2)  # one query per search term
    assert usage["tavily"] == Decimal(950)  # unchanged: exhausted, so not used in run 3
    assert usage["exa"] > 0

    # Four runs recorded, all successful, with aggregate stats only.
    runs = db.execute("select kind, status, stats from runs order by started_at").fetchall()
    assert [(k, s) for k, s, _ in runs] == [("backfill", "success")] + [("hourly", "success")] * 3
    assert "ReLU" not in json.dumps([r[2] for r in runs])

    # A member hides one mention; a new run neither duplicates nor un-hides anything.
    db.execute("update mentions set hidden = true where source_type = 'reddit'")
    db.execute("update profiles set last_web_search_at = null")
    assert cli.main(["hourly"]) == 0
    assert stored(db) == should_match
    assert db.execute(
        "select bool_and(hidden) from mentions where source_type='reddit'"
    ).fetchone()[0]


def test_hourly_catches_up_a_lost_backfill(db, relu_in_db, mocked_apis, worker_env) -> None:
    # The profile was created long ago but its backfill dispatch never ran.
    assert cli.main(["hourly"]) == 0
    status = db.execute("select backfill_status from profiles where id=%s", (RELU_ID,)).fetchone()
    assert status[0] == "done"
    kinds = [r[0] for r in db.execute("select kind from runs order by started_at")]
    assert kinds == ["hourly", "backfill"]
    # A later dispatch for the same profile is a no-op (no second Serper spend).
    serper_calls = mocked_apis.routes[6].call_count
    assert cli.main(["backfill", "--profile-id", RELU_ID]) == 0
    assert mocked_apis.routes[6].call_count == serper_calls


def test_logs_never_contain_search_terms(
    db, relu_in_db, mocked_apis, worker_env, caplog, capsys
) -> None:
    import logging

    caplog.set_level(logging.DEBUG)
    assert cli.main(["backfill", "--profile-id", RELU_ID]) == 0
    assert cli.main(["hourly"]) == 0
    logged = caplog.text + capsys.readouterr().out
    assert "ReLU" not in logged and "relu" not in logged.lower().replace("relu_", "")
