import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OTHER_PROFILE_ID as B, RELU_PROFILE_ID as A, fixtureInvites } from "@/lib/fixtures";
import { connect, resetTestDb } from "../helpers/db";
import { LEON, MEMBER, OUTSIDER, as, expectError, inTx, newUser } from "./util";

// Same shape the onboarding form sends (KeywordRuleInput[]).
const RULES = JSON.stringify([
  { term: "Omega Verksted", context_terms: [], is_exclusion: false },
  { term: "Omega", context_terms: ["NTNU", "Gløshaugen"], is_exclusion: false },
  { term: "Omega watch", context_terms: [], is_exclusion: true },
]);
const A_TOKEN = fixtureInvites[0].token;

let db: Client;
beforeAll(async () => {
  resetTestDb({ seed: true });
  db = await connect();
});
afterAll(async () => db?.end());

async function createInvite(profileId: string, createdBy: string, expiresIn = "7 days"): Promise<string> {
  const { rows } = await db.query(
    `insert into invites (profile_id, created_by, expires_at) values ($1, $2, now() + $3::interval) returning token`,
    [profileId, createdBy, expiresIn],
  );
  return rows[0].token;
}

describe("my_profile_id / is_profile_member", () => {
  it("returns the caller's profile, or null without one", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, LEON);
      expect((await db.query("select my_profile_id() as id")).rows[0].id).toBe(A);
      expect((await db.query("select is_profile_member($1) as m", [B])).rows[0].m).toBe(false);
      await as(db, OUTSIDER);
      expect((await db.query("select my_profile_id() as id")).rows[0].id).toBe(B);
      await as(db, u);
      expect((await db.query("select my_profile_id() as id")).rows[0].id).toBeNull();
    });
  });
});

describe("create_profile", () => {
  it("creates a profile with the caller as owner and the given rules", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      const { rows } = await db.query("select create_profile($1, $2, $3, $4::jsonb) as id", [
        "Omega Verksted",
        "https://omega.example",
        ["https://instagram.com/omega"],
        RULES,
      ]);
      const pid = rows[0].id;
      expect((await db.query("select my_profile_id() as id")).rows[0].id).toBe(pid);
      const profile = (await db.query("select * from profiles where id = $1", [pid])).rows[0];
      expect(profile).toMatchObject({ name: "Omega Verksted", website_url: "https://omega.example", backfill_status: "pending" });
      const members = (await db.query("select user_id, role from profile_members where profile_id = $1", [pid])).rows;
      expect(members).toEqual([{ user_id: u, role: "owner" }]);
      const rules = (await db.query("select term, context_terms, is_exclusion from keyword_rules where profile_id = $1 order by term", [pid])).rows;
      expect(rules).toEqual([
        { term: "Omega", context_terms: ["NTNU", "Gløshaugen"], is_exclusion: false },
        { term: "Omega Verksted", context_terms: [], is_exclusion: false },
        { term: "Omega watch", context_terms: [], is_exclusion: true },
      ]);
      // The new owner still cannot see anyone else's data.
      expect((await db.query("select id from profiles")).rows.map((r) => r.id)).toEqual([pid]);
    });
  });

  it("a user cannot create a second profile", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, LEON);
      await expectError(db, "select create_profile('Second')", [], /already belongs to a profile/);
      await as(db, u);
      await db.query("select create_profile('First')");
      await expectError(db, "select create_profile('Second')", [], /already belongs to a profile/);
    });
  });

  it("rejects an empty name", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      await expectError(db, "select create_profile('   ')", [], /check constraint/);
    });
  });
});

describe("accept_invite", () => {
  it("joins the profile as member and marks the invite used", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      expect((await db.query("select accept_invite($1) as id", [A_TOKEN])).rows[0].id).toBe(A);
      expect((await db.query("select role from profile_members where user_id = $1", [u])).rows[0].role).toBe("member");
      const inv = (await db.query("select used_at, used_by from invites where token = $1", [A_TOKEN])).rows[0];
      expect(inv.used_by).toBe(u);
      expect(inv.used_at).not.toBeNull();
    });
  });

  it("is single use", async () => {
    await inTx(db, async () => {
      const first = await newUser(db);
      const second = await newUser(db);
      await as(db, first);
      await db.query("select accept_invite($1)", [A_TOKEN]);
      await as(db, second);
      await expectError(db, "select accept_invite($1)", [A_TOKEN], /invalid, used or expired/);
      expect((await db.query("select my_profile_id() as id")).rows[0].id).toBeNull();
    });
  });

  it("rejects expired invites", async () => {
    await inTx(db, async () => {
      const token = await createInvite(A, LEON, "-1 minute");
      const u = await newUser(db);
      await as(db, u);
      await expectError(db, "select accept_invite($1)", [token], /invalid, used or expired/);
    });
  });

  it("rejects unknown tokens", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      await expectError(db, "select accept_invite('doesnotexist')", [], /invalid, used or expired/);
    });
  });

  it("rejects users who already have a profile (including their own profile's invite)", async () => {
    await inTx(db, async () => {
      await as(db, MEMBER);
      await expectError(db, "select accept_invite($1)", [A_TOKEN], /already belongs to a profile/);
      await as(db, OUTSIDER);
      await expectError(db, "select accept_invite($1)", [A_TOKEN], /already belongs to a profile/);
      await db.query("reset role");
      expect((await db.query("select used_at from invites where token = $1", [A_TOKEN])).rows[0].used_at).toBeNull();
    });
  });
});

describe("list_profile_members", () => {
  it("returns only the caller's own profile members with emails", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      const { rows } = await db.query("select user_id, email, role from list_profile_members()");
      expect(rows).toEqual([
        { user_id: LEON, email: "leon@example.com", role: "owner" },
        { user_id: MEMBER, email: "member@example.com", role: "member" },
      ]);
      await as(db, OUTSIDER);
      const other = await db.query("select user_id, email from list_profile_members()");
      expect(other.rows).toEqual([{ user_id: OUTSIDER, email: "outsider@example.com" }]);
    });
  });

  it("returns nothing for a user without a profile", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      expect((await db.query("select * from list_profile_members()")).rows).toEqual([]);
    });
  });
});

describe("leave_profile", () => {
  it("owner leaving passes ownership to the longest-standing member", async () => {
    await inTx(db, async () => {
      const late = await newUser(db);
      await db.query("insert into profile_members (profile_id, user_id, role, joined_at) values ($1, $2, 'member', now())", [A, late]);
      await as(db, LEON);
      await db.query("select leave_profile()");
      expect((await db.query("select my_profile_id() as id")).rows[0].id).toBeNull();
      expect((await db.query("select * from mentions")).rows).toEqual([]);
      await as(db, MEMBER);
      const { rows } = await db.query("select user_id, role from list_profile_members()");
      expect(rows).toEqual([
        { user_id: MEMBER, role: "owner" },
        { user_id: late, role: "member" },
      ]);
    });
  });

  it("a non-owner leaving keeps the owner", async () => {
    await inTx(db, async () => {
      await as(db, MEMBER);
      await db.query("select leave_profile()");
      await as(db, LEON);
      const { rows } = await db.query("select user_id, role from list_profile_members()");
      expect(rows).toEqual([{ user_id: LEON, role: "owner" }]);
    });
  });

  it("the last member leaving deletes the profile and its data", async () => {
    await inTx(db, async () => {
      await as(db, OUTSIDER);
      await db.query("select leave_profile()");
      await db.query("reset role");
      for (const [table, col] of [
        ["profiles", "id"],
        ["profile_members", "profile_id"],
        ["keyword_rules", "profile_id"],
        ["mentions", "profile_id"],
        ["runs", "profile_id"],
      ]) {
        expect((await db.query(`select count(*)::int as n from ${table} where ${col} = $1`, [B])).rows[0].n, table).toBe(0);
      }
      // Profile A is untouched.
      expect((await db.query("select count(*)::int as n from profile_members where profile_id = $1", [A])).rows[0].n).toBe(2);
    });
  });

  it("is a no-op for a user without a profile", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      await db.query("select leave_profile()");
      await db.query("reset role");
      expect((await db.query("select count(*)::int as n from profile_members")).rows[0].n).toBe(3);
    });
  });

  it("after leaving, the user can create a new profile", async () => {
    await inTx(db, async () => {
      await as(db, MEMBER);
      await db.query("select leave_profile()");
      const { rows } = await db.query("select create_profile('Fresh start') as id");
      expect(rows[0].id).not.toBe(A);
    });
  });
});
