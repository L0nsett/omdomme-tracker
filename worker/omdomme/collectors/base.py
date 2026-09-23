"""Helpers shared by the collectors."""

from __future__ import annotations

import html
import logging
import re
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from html.parser import HTMLParser
from urllib.parse import urlsplit

import httpx

from omdomme.contracts import RawMention

log = logging.getLogger("omdomme.collectors")

Clock = Callable[[], datetime]


def utc_now() -> datetime:
    return datetime.now(UTC)


class CollectorError(RuntimeError):
    """Every request of a collect() call failed. The pipeline records the message."""


def quote_term(term: str) -> str:
    """Exact-phrase query for a search term (`"ReLU NTNU"`)."""
    cleaned = " ".join(term.replace('"', " ").split())
    return f'"{cleaned}"'


def domain_of(url: str | None) -> str | None:
    """Host of `url` without a leading "www." ("https://www.nrk.no/x" -> "nrk.no")."""
    if not url:
        return None
    try:
        host = urlsplit(url.strip()).hostname
    except ValueError:
        return None
    if not host:
        return None
    host = host.lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def is_http_url(url: object) -> bool:
    if not isinstance(url, str):
        return False
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.hostname)


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def html_to_text(markup: str | None) -> str:
    """Plain text of an HTML fragment, whitespace collapsed."""
    if not markup:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(markup)
        parser.close()
        text = " ".join(parser.parts)
    except Exception:  # HTMLParser is lenient; this is belt and braces.
        text = re.sub(r"<[^>]+>", " ", markup)
    return clean_text(html.unescape(text))


def clean_text(text: str | None) -> str:
    if not text:
        return ""
    return " ".join(text.replace("\xa0", " ").split())


def truncate(text: str, limit: int) -> str:
    """Cut `text` at a word boundary so it is at most `limit` characters."""
    text = clean_text(text)
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    space = cut.rfind(" ")
    if space > limit // 2:
        cut = cut[:space]
    return cut.rstrip(" ,.;:-") + "…"


_URL_RE = re.compile(r"https?://[^\s<>\"'()\[\]{}|\\^`]+", re.IGNORECASE)


def find_urls(text: str | None) -> list[str]:
    """http(s) URLs in free text (Markdown links included), in order, deduplicated."""
    if not text:
        return []
    out: list[str] = []
    for match in _URL_RE.finditer(text):
        url = match.group(0).rstrip(".,;:!?*_~")
        if is_http_url(url) and url not in out:
            out.append(url)
    return out


def ensure_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


class Batch:
    """Collects items from several requests of one collect() call.

    Deduplicates by URL (first one wins) and tracks request outcomes so a call in
    which every request failed raises instead of returning an empty list.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.items: list[RawMention] = []
        self._seen: set[str] = set()
        self.ok = 0
        self.errors: list[str] = []

    def add(self, items: Iterable[RawMention]) -> None:
        for item in items:
            if item.url in self._seen:
                continue
            self._seen.add(item.url)
            self.items.append(item)

    def succeeded(self) -> None:
        self.ok += 1

    def failed(self, what: str, exc: BaseException) -> None:
        msg = f"{what}: {describe_error(exc)}"
        log.warning("%s: %s", self.name, msg)
        self.errors.append(msg)

    def result(self) -> list[RawMention]:
        if self.errors and self.ok == 0:
            raise CollectorError(
                f"{self.name}: all {len(self.errors)} requests failed; first: {self.errors[0]}"
            )
        return self.items


def describe_error(exc: BaseException) -> str:
    """Short error text without request URLs/headers (they may carry secrets)."""
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code}"
    if isinstance(exc, httpx.HTTPError):
        return type(exc).__name__
    return f"{type(exc).__name__}: {exc}"[:300]


def parse_each[T](
    items: Iterable[T], parse: Callable[[T], RawMention | None], name: str
) -> list[RawMention]:
    """Apply `parse` to every item, skipping (and logging) items that are malformed.

    `parse` returns None for items it deliberately ignores; raising KeyError,
    TypeError, ValueError (pydantic's ValidationError included), AttributeError or
    IndexError marks the item as malformed.
    """
    out: list[RawMention] = []
    skipped = 0
    for item in items:
        try:
            parsed = parse(item)
        except (KeyError, TypeError, ValueError, AttributeError, IndexError):
            skipped += 1
            continue
        if parsed is not None:
            out.append(parsed)
    if skipped:
        log.info("%s: skipped %d malformed item(s)", name, skipped)
    return out
