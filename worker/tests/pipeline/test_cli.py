from __future__ import annotations

import pytest

from omdomme import cli


def test_missing_database_url_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "")
    assert cli.main(["hourly"]) == 2


@pytest.mark.parametrize(
    "argv",
    [[], ["backfill"], ["backfill", "--profile-id", "not-a-uuid; rm -rf /"], ["weekly"]],
)
def test_bad_usage_exits_2(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        cli.main(argv)
    assert exc.value.code == 2


def test_parser_accepts_uuid() -> None:
    args = cli.build_parser().parse_args(
        ["backfill", "--profile-id", "11111111-1111-4111-8111-111111111111"]
    )
    assert str(args.profile_id) == "11111111-1111-4111-8111-111111111111"
