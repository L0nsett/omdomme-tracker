"""Keyword matching: decides if a raw item is about a profile.

Implements the rules in the `Matcher` contract (omdomme.contracts):

1. an exact (non-ambiguous) term occurs,
2. an ambiguous term occurs together with one of its context terms,
3. the item links to the profile's website or a social account, or mentions a
   username from one of the social links,

and no exclusion term occurs (an exclusion always wins).

Terms are compared case-insensitively over title + snippet. A term occurs when it
starts at a word boundary; it may be followed by letters, so inflections count
("Studentorganisasjonen" contains "studentorganisasjon", "ReLU NTNU's" and
"ReLU NTNU-lag" contain "ReLU NTNU"). "relu" does not occur in "prelude".
"""

from __future__ import annotations

import re
from functools import lru_cache
from urllib.parse import urlsplit

from omdomme.contracts import Matcher, Profile, RawMention

# URL-like tokens in free text: "https://x.no/a", "www.x.no", "x.no/path".
_URL_IN_TEXT = re.compile(
    r"(?<![\w@.-])(?:https?://)?(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:/[^\s<>\"'()\[\]{}]*)?",
    re.IGNORECASE,
)
_TRAILING_PUNCT = ".,;:!?"

# Last path segments of social links that are not usernames.
_NOT_USERNAMES = frozenset(
    {"profile.php", "company", "in", "user", "channel", "c", "pages", "people", "school", "groups"}
)
_USERNAME_RE = re.compile(r"^[\w.-]{3,}$")


@lru_cache(maxsize=1024)
def term_pattern(term: str) -> re.Pattern[str]:
    """Pattern for a term: word boundary at the start, anything may follow.

    Whitespace inside a term matches any run of whitespace.
    """
    body = r"\s+".join(re.escape(part) for part in term.split())
    return re.compile(rf"(?<!\w){body}", re.IGNORECASE)


def term_occurs(term: str, text: str) -> bool:
    if not term.strip():
        return False
    return term_pattern(term).search(text) is not None


def _split(url: str) -> tuple[str, str]:
    """(host without www./m., lowercased path without trailing slash)."""
    url = url.strip()
    if "://" not in url:
        url = "//" + url
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return "", ""
    for prefix in ("www.", "m."):
        if host.startswith(prefix):
            host = host[len(prefix) :]
            break
    return host, parts.path.rstrip("/").lower()


def _host_in_domain(host: str, domain: str) -> bool:
    return bool(host) and (host == domain or host.endswith("." + domain))


def _urls_in_text(text: str) -> list[str]:
    return [m.group(0).rstrip(_TRAILING_PUNCT) for m in _URL_IN_TEXT.finditer(text)]


def _username(link: str) -> str | None:
    _, path = _split(link)
    segments = [s for s in path.split("/") if s]
    if not segments:
        return None
    name = segments[-1].lstrip("@")
    if name in _NOT_USERNAMES or name.endswith((".php", ".html", ".htm")):
        return None
    return name if _USERNAME_RE.match(name) else None


class KeywordMatcher(Matcher):
    """Rule-based matcher for v1 (no ML). Ground truth: tests/fixtures/expected_matches.json."""

    def matches(self, raw: RawMention, profile: Profile) -> bool:
        text = f"{raw.title}\n{raw.snippet}"
        if any(term_occurs(t, text) for t in profile.exclusion_terms):
            return False
        return self._keyword_match(text, profile) or self._link_match(raw, text, profile)

    @staticmethod
    def _keyword_match(text: str, profile: Profile) -> bool:
        for rule in profile.keyword_rules:
            if rule.is_exclusion or not term_occurs(rule.term, text):
                continue
            if not rule.is_ambiguous:
                return True  # rule 1
            if any(term_occurs(c, text) for c in rule.context_terms):
                return True  # rule 2
        return False

    @staticmethod
    def _link_match(raw: RawMention, text: str, profile: Profile) -> bool:
        """Rule 3: links to the website or a social account, or mentions a username."""
        # Account-like targets: (host, path prefix). A website without a path
        # matches its whole domain; one with a path ("ntnu.no/relu") only that prefix.
        domains: list[str] = []
        prefixes: list[tuple[str, str]] = []
        if profile.website_url:
            host, path = _split(profile.website_url)
            if host and path:
                prefixes.append((host, path))
            elif host:
                domains.append(host)
        for link in profile.social_links:
            host, path = _split(link)
            if host and path:
                prefixes.append((host, path))

        candidates = [raw.url, *raw.links, *_urls_in_text(text)]
        for candidate in candidates:
            host, path = _split(candidate)
            if any(_host_in_domain(host, d) for d in domains):
                return True
            for p_host, p_path in prefixes:
                if host == p_host and (path == p_path or path.startswith(p_path + "/")):
                    return True

        for link in profile.social_links:
            name = _username(link)
            if name and re.search(rf"(?<!\w)@?{re.escape(name)}(?!\w)", text, re.IGNORECASE):
                return True
        return False
