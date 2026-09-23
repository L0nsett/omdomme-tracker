from __future__ import annotations

import pytest

from omdomme.contracts import KeywordRule, Profile, RawMention, SourceType
from omdomme.matching import KeywordMatcher, term_occurs
from tests.pipeline.fixture_items import all_fixture_items, expected

matcher = KeywordMatcher()

FIXTURE_ITEMS = {(r.source_type.value, r.url): r for r in all_fixture_items()}
EXPECTED = expected()


def test_every_expected_item_is_built_from_the_fixtures() -> None:
    assert set(EXPECTED) <= set(FIXTURE_ITEMS)
    assert len(EXPECTED) == 21


@pytest.mark.parametrize("key", sorted(EXPECTED), ids=lambda k: f"{k[0]}:{k[1][-40:]}")
def test_matches_ground_truth(key: tuple[str, str], relu_profile: Profile) -> None:
    assert matcher.matches(FIXTURE_ITEMS[key], relu_profile) is EXPECTED[key]


def _raw(title: str, snippet: str = "", url: str = "https://example.com/x", links=()) -> RawMention:
    return RawMention(
        url=url,
        title=title,
        snippet=snippet,
        source_type=SourceType.WEB_SEARCH,
        source_name="example.com",
        links=list(links),
    )


@pytest.mark.parametrize(
    ("title", "snippet", "match"),
    [
        ("relu ntnu holder kurs", "", True),  # case
        ("RELU NTNU", "", True),
        ("ReLU  NTNU\ter her", "", True),  # any whitespace inside a term
        ("ReLU NTNU's workshop", "", True),  # possessive
        ("ReLU NTNU-lag vant", "", True),  # hyphen after term
        ("Studentorganisasjonen ReLU", "", True),  # inflected context term
        ("ReLU", "Møt oss i Trondheim", True),  # context term in snippet
        ("ReLU", "", False),  # ambiguous without context
        ("A prelude to NTNU", "", False),  # "relu" inside "prelude" is no term
        ("PreLU NTNU", "", False),
        ("ReLU NTNU", "uses a leaky ReLU", False),  # exclusion beats exact term
        ("ReLU NTNU", "an Activation Function primer", False),  # exclusion, any case
        ("ReLU NTNU", "aktiveringsfunksjonen", False),  # inflected exclusion
        ("Om NTNU og studentliv", "", False),  # context term alone
    ],
)
def test_keyword_rules(title: str, snippet: str, match: bool, relu_profile: Profile) -> None:
    assert matcher.matches(_raw(title, snippet), relu_profile) is match


@pytest.mark.parametrize(
    ("raw", "match"),
    [
        (_raw("Kurs", url="https://relu-ntnu.no/kurs"), True),  # own site, no www
        (_raw("Kurs", url="https://events.relu-ntnu.no/a"), True),  # subdomain
        (_raw("Kurs", url="https://notrelu-ntnu.no/a"), False),
        (_raw("Kurs", links=["https://www.relu-ntnu.no/events/1"]), True),
        (_raw("Kurs", "Påmelding: www.relu-ntnu.no/kurs."), True),  # bare domain in text
        (_raw("Kurs", "Se linkedin.com/company/relu-ntnu for mer"), True),
        (_raw("Kurs", url="https://www.instagram.com/relu_ntnu/p/abc"), True),
        (_raw("Kurs", url="https://www.instagram.com/relu_ntnu_fan"), False),
        (_raw("Følg @relu_ntnu", ""), True),  # username
        (_raw("Følg", "RELU_NTNU på Insta"), True),
        (_raw("Følg @relu_ntnu_fans", ""), False),
        (_raw("Kurs", "Følg @relu_ntnu", links=[]), True),
        # exclusion wins over rule 3 as well
        (_raw("Leaky ReLU forklart", url="https://www.relu-ntnu.no/blog"), False),
    ],
)
def test_link_and_username_rule(raw: RawMention, match: bool, relu_profile: Profile) -> None:
    assert matcher.matches(raw, relu_profile) is match


def test_website_with_path_matches_only_that_path(relu_profile: Profile) -> None:
    profile = relu_profile.model_copy(
        update={"website_url": "https://www.ntnu.no/relu", "social_links": []}
    )
    assert matcher.matches(_raw("Kurs", url="https://ntnu.no/relu/kurs"), profile)
    assert not matcher.matches(_raw("Kurs", url="https://www.ntnu.no/studier"), profile)


def test_profile_without_rules_or_links_matches_nothing(relu_profile: Profile) -> None:
    empty = relu_profile.model_copy(
        update={"keyword_rules": [], "website_url": None, "social_links": []}
    )
    assert not any(matcher.matches(r, empty) for r in FIXTURE_ITEMS.values())


def test_term_occurs_word_boundary_and_inflection() -> None:
    assert term_occurs("linjeforening", "Linjeforeningen ReLU")
    assert term_occurs("ReLU", "(ReLU)")
    assert not term_occurs("ReLU", "prelude")
    assert not term_occurs("   ", "anything")
    assert term_occurs("c++", "we like C++ a lot")  # special characters are escaped


def test_unicode_terms(relu_profile: Profile) -> None:
    profile = relu_profile.model_copy(
        update={"keyword_rules": [KeywordRule(term="Økonomiforeningen")]}
    )
    assert matcher.matches(_raw("økonomiforeningens nye styre"), profile)
    assert not matcher.matches(_raw("Studentøkonomiforeningen"), profile)
