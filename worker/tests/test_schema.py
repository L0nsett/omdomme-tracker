"""Phase 0: migrations apply, RPCs work and RLS isolates profiles."""

from __future__ import annotations

import json
import uuid

import psycopg
import pytest

pytestmark = pytest.mark.db


def new_user(db: psycopg.Connection, email: str) -> str:
    uid = str(uuid.uuid4())
    db.execute("insert into auth.users (id, email) values (%s, %s)", (uid, email))
    return uid


def as_user(db: psycopg.Connection, uid: str) -> None:
    """Switch the session to Supabase's `authenticated` role for user `uid`."""
    db.execute("reset role")
    db.execute(
        "select set_config('request.jwt.claims', %s, false)",
        (json.dumps({"sub": uid, "role": "authenticated"}),),
    )
    db.execute("set role authenticated")


def create_profile(db: psycopg.Connection, uid: str, name: str) -> str:
    as_user(db, uid)
    rules = json.dumps([{"term": name, "context_terms": [], "is_exclusion": False}])
    pid = db.execute("select public.create_profile(%s, null, '{}', %s)", (name, rules)).fetchone()
    db.execute("reset role")
    return str(pid[0])


def test_rls_isolates_profiles(db: psycopg.Connection) -> None:
    alice = new_user(db, "alice@example.com")
    bob = new_user(db, "bob@example.com")
    pa = create_profile(db, alice, "Alice AS")
    pb = create_profile(db, bob, "Bob AS")
    for pid in (pa, pb):
        db.execute(
            "insert into mentions (profile_id, url, title, source_type, source_name)"
            " values (%s, 'https://x.no/' || %s, 't', 'gdelt', 'x.no')",
            (pid, pid),
        )

    as_user(db, alice)
    assert [r[0] for r in db.execute("select id::text from profiles")] == [pa]
    assert db.execute("select count(*) from mentions").fetchone()[0] == 1
    assert db.execute("select count(*) from keyword_rules").fetchone()[0] == 1
    # Writes to another profile silently affect nothing.
    db.execute("update mentions set hidden = true where profile_id = %s", (pb,))
    db.execute("reset role")
    assert not db.execute("select hidden from mentions where profile_id=%s", (pb,)).fetchone()[0]


def test_user_can_only_hide_mentions_not_edit_them(db: psycopg.Connection) -> None:
    alice = new_user(db, "alice@example.com")
    pa = create_profile(db, alice, "Alice AS")
    db.execute(
        "insert into mentions (profile_id, url, title, source_type, source_name)"
        " values (%s, 'https://x.no/1', 't', 'reddit', 'r/x')",
        (pa,),
    )
    as_user(db, alice)
    db.execute("update mentions set hidden = true")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        db.execute("update mentions set title = 'hacked'")
    db.execute("reset role")


def test_one_profile_per_user_and_invites(db: psycopg.Connection) -> None:
    alice = new_user(db, "alice@example.com")
    carol = new_user(db, "carol@example.com")
    pa = create_profile(db, alice, "Alice AS")

    as_user(db, alice)
    with pytest.raises(psycopg.errors.UniqueViolation):
        db.execute("select public.create_profile('Second', null, '{}', '[]')")
    token = db.execute(
        "insert into invites (profile_id, created_by) values (%s, %s) returning token",
        (pa, alice),
    ).fetchone()[0]

    as_user(db, carol)
    assert str(db.execute("select public.accept_invite(%s)", (token,)).fetchone()[0]) == pa
    assert db.execute("select count(*) from profile_members").fetchone()[0] == 2

    # Invite is single-use.
    db.execute("reset role")
    dave = new_user(db, "dave@example.com")
    as_user(db, dave)
    with pytest.raises(psycopg.errors.NoDataFound):
        db.execute("select public.accept_invite(%s)", (token,))
    db.execute("reset role")


def test_anon_sees_nothing(db: psycopg.Connection) -> None:
    alice = new_user(db, "alice@example.com")
    create_profile(db, alice, "Alice AS")
    db.execute("set role anon")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        db.execute("select * from profiles")
    db.execute("reset role")


def test_leave_profile_transfers_ownership_then_deletes(db: psycopg.Connection) -> None:
    alice = new_user(db, "alice@example.com")
    bob = new_user(db, "bob@example.com")
    pa = create_profile(db, alice, "Alice AS")
    token = db.execute(
        "insert into invites (profile_id, created_by) values (%s, %s) returning token", (pa, alice)
    ).fetchone()[0]
    as_user(db, bob)
    db.execute("select public.accept_invite(%s)", (token,))

    as_user(db, alice)
    db.execute("select public.leave_profile()")
    db.execute("reset role")
    role = db.execute("select role from profile_members where user_id=%s", (bob,)).fetchone()[0]
    assert role == "owner"

    as_user(db, bob)
    db.execute("select public.leave_profile()")
    db.execute("reset role")
    assert db.execute("select count(*) from profiles").fetchone()[0] == 0
