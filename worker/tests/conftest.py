"""Shared test setup.

- Network is blocked by pytest-socket (see pyproject.toml); only the local test
  Postgres is reachable.
- `fixtures_dir`, `load_fixture` and `relu_profile` give access to stored API
  responses in tests/fixtures/.
- `db` gives a clean database (schema from supabase/migrations) as the
  `postgres` superuser, like the worker in production. Tests using it are marked
  `db` and are skipped if Postgres is not reachable.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest

from omdomme.contracts import Profile

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "postgresql://localhost:5432/omdomme_test")
PUBLIC_TABLES = "quota_usage, runs, mentions, invites, keyword_rules, profile_members, profiles"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES


def _load(name: str) -> Any:
    text = (FIXTURES / name).read_text(encoding="utf-8")
    return json.loads(text) if name.endswith(".json") else text


@pytest.fixture
def load_fixture():
    """load_fixture("gdelt_relu.json") -> parsed JSON; other files -> str."""
    return _load


@pytest.fixture
def relu_profile() -> Profile:
    return Profile.model_validate(_load("profile_relu.json"))


@pytest.fixture(scope="session")
def _migrated_db() -> str:
    try:
        with psycopg.connect(TEST_DATABASE_URL, connect_timeout=3):
            pass
    except psycopg.OperationalError as exc:
        pytest.skip(f"test Postgres not reachable at {TEST_DATABASE_URL}: {exc}")
    subprocess.run(
        [str(ROOT / "scripts" / "reset-test-db.sh")],
        check=True,
        env={**os.environ, "TEST_DATABASE_URL": TEST_DATABASE_URL},
        capture_output=True,
    )
    return TEST_DATABASE_URL


@pytest.fixture
def db(_migrated_db: str) -> Iterator[psycopg.Connection]:
    """Autocommit connection to an empty, migrated database."""
    with psycopg.connect(_migrated_db, autocommit=True) as conn:
        conn.execute(f"truncate {PUBLIC_TABLES}, auth.users cascade")
        yield conn
