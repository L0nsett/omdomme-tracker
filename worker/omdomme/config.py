"""Runtime settings from environment variables (.env locally, GitHub Secrets in Actions)."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    database_url: str | None
    reddit_client_id: str | None
    reddit_client_secret: str | None
    reddit_user_agent: str
    tavily_api_key: str | None
    exa_api_key: str | None
    serper_api_key: str | None


def _get(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def load_settings() -> Settings:
    load_dotenv()
    return Settings(
        database_url=_get("DATABASE_URL"),
        reddit_client_id=_get("REDDIT_CLIENT_ID"),
        reddit_client_secret=_get("REDDIT_CLIENT_SECRET"),
        reddit_user_agent=_get("REDDIT_USER_AGENT") or "omdomme-tracker/0.1",
        tavily_api_key=_get("TAVILY_API_KEY"),
        exa_api_key=_get("EXA_API_KEY"),
        serper_api_key=_get("SERPER_API_KEY"),
    )
