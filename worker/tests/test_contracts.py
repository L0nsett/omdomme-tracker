from datetime import UTC, datetime

from omdomme.contracts import (
    Classification,
    Mention,
    NullClassifier,
    Profile,
    RawMention,
    SourceType,
)


def test_relu_profile_fixture_parses(relu_profile: Profile) -> None:
    assert relu_profile.name == "ReLU NTNU"
    assert relu_profile.search_terms == ["ReLU NTNU", "ReLU"]
    assert "leaky ReLU" in relu_profile.exclusion_terms
    ambiguous = [r for r in relu_profile.keyword_rules if r.is_ambiguous]
    assert [r.term for r in ambiguous] == ["ReLU"]


def test_null_classifier_leaves_sentiment_empty(relu_profile: Profile) -> None:
    raw = RawMention(
        url="https://example.com/a",
        title="ReLU NTNU",
        source_type=SourceType.GDELT,
        source_name="example.com",
    )
    assert NullClassifier().classify(raw, relu_profile) == Classification()


def test_mention_from_raw(relu_profile: Profile) -> None:
    raw = RawMention(
        url="https://example.com/a",
        title="ReLU NTNU",
        snippet="s",
        source_type=SourceType.REDDIT,
        source_name="r/ntnu",
        upvotes=3,
    )
    now = datetime(2026, 9, 23, tzinfo=UTC)
    m = Mention.from_raw(
        raw,
        profile_id=relu_profile.id,
        reach_score=0.4,
        classification=Classification(),
        fetched_at=now,
    )
    assert m.profile_id == relu_profile.id
    assert m.sentiment is None and m.confidence is None
    assert m.reach_score == 0.4 and not m.hidden


def test_expected_matches_cover_every_source(load_fixture) -> None:
    items = load_fixture("expected_matches.json")["items"]
    assert {i["source_type"] for i in items} == {s.value for s in SourceType}
    assert any(i["match"] for i in items) and any(not i["match"] for i in items)
