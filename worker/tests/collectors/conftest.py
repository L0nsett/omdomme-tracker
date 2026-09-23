from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

import httpx
import pytest

from omdomme.contracts import Profile

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)

Handler = Callable[[httpx.Request], httpx.Response]


class Recorder:
    """httpx.MockTransport that records every request and answers with `handler`."""

    def __init__(self, handler: Handler) -> None:
        self.handler = handler
        self.requests: list[httpx.Request] = []
        self.client = httpx.Client(transport=httpx.MockTransport(self._handle))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)

    def to(self, host: str) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.host == host]


@pytest.fixture
def mock_http() -> Callable[[Handler], Recorder]:
    recorders: list[Recorder] = []

    def make(handler: Handler) -> Recorder:
        rec = Recorder(handler)
        recorders.append(rec)
        return rec

    yield make
    for rec in recorders:
        rec.client.close()


@pytest.fixture
def clock() -> Callable[[], datetime]:
    return lambda: NOW


@pytest.fixture
def expected_urls(load_fixture) -> Callable[[str], set[str]]:
    def urls(source_type: str) -> set[str]:
        items = load_fixture("expected_matches.json")["items"]
        return {i["url"] for i in items if i["source_type"] == source_type}

    return urls


@pytest.fixture
def one_term_profile(relu_profile: Profile) -> Profile:
    """The ReLU profile with only its exact term (one request per edition/provider)."""
    rules = [r for r in relu_profile.keyword_rules if r.term == "ReLU NTNU" or r.is_exclusion]
    return relu_profile.model_copy(update={"keyword_rules": rules})
