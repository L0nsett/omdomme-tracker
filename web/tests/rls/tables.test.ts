import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OTHER_PROFILE_ID as B, RELU_PROFILE_ID as A } from "@/lib/fixtures";
import { connect, resetTestDb } from "../helpers/db";
import { DENIED, LEON, MEMBER, OUTSIDER, as, expectError, inTx, newUser } from "./util";

// Profile A = ReLU NTNU (LEON owner, MEMBER member). Profile B = Other Org AS (OUTSIDER owner).
const B_RULE = "33333333-0000-4000-8000-000000000009";
const A_RULE = "33333333-0000-4000-8000-000000000001";
const B_MENTION = "44444444-0000-4000-8000-000000000999";
const B_RUN = "55555555-0000-4000-8000-000000000004";

const PROFILE_SCOPED: { table: string; column: string }[] = [
  { table: "profiles", column: "id" },
  { table: "profile_members", column: "profile_id" },
  { table: "keyword_rules", column: "profile_id" },
  { table: "invites", column: "profile_id" },
  { table: "mentions", column: "profile_id" },
  { table: "runs", column: "profile_id" },
];
const ALL_TABLES = [...PROFILE_SCOPED.map((t) => t.table), "quota_usage"];

let db: Client;
let bInviteToken: string;

beforeAll(async () => {
  resetTestDb({ seed: true });
  db = await connect();
  // Seed has no invite for profile B; add one so invite isolation is tested both ways.
  const { rows } = await db.query("insert into invites (profile_id, created_by) values ($1, $2) returning token", [B, OUTSIDER]);
  bInviteToken = rows[0].token;
});
afterAll(async () => db?.end());

describe("select isolation", () => {
  for (const { table, column } of PROFILE_SCOPED) {
    it(`${table}: a member of A sees none of B's rows`, async () => {
      await inTx(db, async () => {
        await as(db, LEON);
        const { rows } = await db.query(`select * from ${table} where ${column} = $1`, [B]);
        expect(rows).toEqual([]);
        const own = await db.query(`select * from ${table} where ${column} = $1`, [A]);
        expect(own.rowCount).toBeGreaterThan(0);
      });
    });

    it(`${table}: B's owner sees none of A's rows`, async () => {
      await inTx(db, async () => {
        await as(db, OUTSIDER);
        const { rows } = await db.query(`select * from ${table} where ${column} = $1`, [A]);
        expect(rows).toEqual([]);
      });
    });
  }

  it("a user without a profile sees no profile data at all", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      for (const { table, column } of PROFILE_SCOPED) {
        const { rows } = await db.query(`select * from ${table} where ${column} is not null`);
        expect(rows, table).toEqual([]);
      }
    });
  });

  it("runs: hourly runs (no profile) are visible to members, other profiles' backfills are not", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      const { rows } = await db.query("select id, profile_id from runs");
      expect(rows.some((r) => r.profile_id === null)).toBe(true);
      expect(rows.map((r) => r.id)).not.toContain(B_RUN);
    });
  });

  it("quota_usage is readable (global, no profile data)", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      const { rowCount } = await db.query("select * from quota_usage");
      expect(rowCount).toBe(3);
    });
  });
});

describe("anon", () => {
  for (const table of ALL_TABLES) {
    it(`cannot read ${table}`, async () => {
      await inTx(db, async () => {
        await as(db, "anon");
        await expectError(db, `select * from ${table}`, [], /permission denied/);
      });
    });
  }

  it("cannot call any RPC", async () => {
    await inTx(db, async () => {
      await as(db, "anon");
      for (const sql of [
        "select my_profile_id()",
        "select is_profile_member($1::uuid)",
        "select create_profile('X')",
        "select accept_invite('x')",
        "select leave_profile()",
        "select * from list_profile_members()",
      ]) {
        await expectError(db, sql, sql.includes("$1") ? [A] : [], /permission denied/);
      }
    });
  });
});

describe("profiles", () => {
  it("cannot update another profile", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      const res = await db.query("update profiles set name = 'hacked' where id = $1", [B]);
      expect(res.rowCount).toBe(0);
      await as(db, OUTSIDER);
      const { rows } = await db.query("select name from profiles where id = $1", [B]);
      expect(rows[0].name).toBe("Other Org AS");
    });
  });

  it("can update name, website and social links of the own profile", async () => {
    await inTx(db, async () => {
      await as(db, MEMBER);
      const res = await db.query(
        "update profiles set name = 'ReLU', website_url = 'https://relu.no', social_links = '{https://x.com/relu}' where id = $1",
        [A],
      );
      expect(res.rowCount).toBe(1);
    });
  });

  it("cannot update backfill_status, last_web_search_at, created_at or id", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      await expectError(db, "update profiles set backfill_status = 'pending' where id = $1", [A], /permission denied/);
      await expectError(db, "update profiles set last_web_search_at = null where id = $1", [A], /permission denied/);
      await expectError(db, "update profiles set created_at = now() where id = $1", [A], /permission denied/);
      await expectError(db, "update profiles set id = gen_random_uuid() where id = $1", [A], /permission denied/);
    });
  });

  it("cannot insert or delete profiles directly", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      await expectError(db, "insert into profiles (name) values ('Sneaky')", [], /permission denied/);
      await as(db, LEON);
      await expectError(db, "delete from profiles where id = $1", [B], /permission denied/);
      await expectError(db, "delete from profiles where id = $1", [A], /permission denied/);
    });
  });
});

describe("profile_members", () => {
  it("cannot add yourself to another profile, change roles or remove members", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      await expectError(db, "insert into profile_members (profile_id, user_id) values ($1, $2)", [B, u], /permission denied/);
      await as(db, MEMBER);
      await expectError(db, "update profile_members set role = 'owner' where user_id = $1", [MEMBER], /permission denied/);
      await expectError(db, "delete from profile_members where user_id = $1", [OUTSIDER], /permission denied/);
    });
  });
});

describe("keyword_rules", () => {
  it("cannot insert rules for another profile", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      await expectError(db, "insert into keyword_rules (profile_id, term) values ($1, 'x')", [B], /row-level security/);
    });
  });

  it("cannot update or delete another profile's rules", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      expect((await db.query("update keyword_rules set term = 'x' where id = $1", [B_RULE])).rowCount).toBe(0);
      expect((await db.query("delete from keyword_rules where id = $1", [B_RULE])).rowCount).toBe(0);
      await as(db, OUTSIDER);
      expect((await db.query("select term from keyword_rules where id = $1", [B_RULE])).rows[0].term).toBe("Other Org");
    });
  });

  it("cannot move an own rule to another profile", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      await expectError(db, "update keyword_rules set profile_id = $1 where id = $2", [B, A_RULE], /row-level security/);
    });
  });

  it("members can manage their own profile's rules", async () => {
    await inTx(db, async () => {
      await as(db, MEMBER);
      const ins = await db.query(
        "insert into keyword_rules (profile_id, term, context_terms) values ($1, 'Omega', '{NTNU}') returning id",
        [A],
      );
      const id = ins.rows[0].id;
      expect((await db.query("update keyword_rules set term = 'Omega Verksted' where id = $1", [id])).rowCount).toBe(1);
      expect((await db.query("delete from keyword_rules where id = $1", [id])).rowCount).toBe(1);
    });
  });
});

describe("invites", () => {
  it("cannot create an invite for another profile", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      await expectError(db, "insert into invites (profile_id, created_by) values ($1, $2)", [B, LEON], /row-level security/);
    });
  });

  it("cannot create an invite in someone else's name", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      await expectError(db, "insert into invites (profile_id, created_by) values ($1, $2)", [A, MEMBER], /row-level security/);
    });
  });

  it("a user without a profile cannot create invites", async () => {
    await inTx(db, async () => {
      const u = await newUser(db);
      await as(db, u);
      await expectError(db, "insert into invites (profile_id, created_by) values ($1, $2)", [A, u], /row-level security/);
    });
  });

  it("members can create invites for their own profile", async () => {
    await inTx(db, async () => {
      await as(db, MEMBER);
      const { rows } = await db.query(
        "insert into invites (profile_id, created_by) values ($1, $2) returning token, expires_at, used_at",
        [A, MEMBER],
      );
      expect(rows[0].token).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].used_at).toBeNull();
    });
  });

  it("cannot update or delete invites (no one can mark them used or extend them directly)", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      await expectError(db, "update invites set expires_at = now() + interval '1 year' where profile_id = $1", [A], /permission denied/);
      await expectError(db, "update invites set used_at = null", [], /permission denied/);
      await expectError(db, "delete from invites where profile_id = $1", [A], /permission denied/);
    });
  });

  it("cannot read another profile's invite tokens", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      const { rows } = await db.query("select * from invites where token = $1", [bInviteToken]);
      expect(rows).toEqual([]);
    });
  });
});

describe("mentions", () => {
  it("can only change `hidden` on own mentions", async () => {
    await inTx(db, async () => {
      await as(db, MEMBER);
      const res = await db.query("update mentions set hidden = true where profile_id = $1", [A]);
      expect(res.rowCount).toBeGreaterThan(0);
      for (const col of ["title = 'x'", "reach_score = 1", "sentiment = 'positive'", "profile_id = profile_id", "url = 'https://x.com'"]) {
        await expectError(db, `update mentions set ${col} where profile_id = $1`, [A], /permission denied/);
      }
    });
  });

  it("cannot hide another profile's mentions", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      expect((await db.query("update mentions set hidden = true where id = $1", [B_MENTION])).rowCount).toBe(0);
      await as(db, OUTSIDER);
      expect((await db.query("select hidden from mentions where id = $1", [B_MENTION])).rows[0].hidden).toBe(false);
    });
  });

  it("cannot insert or delete mentions", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      await expectError(
        db,
        "insert into mentions (profile_id, url, title, source_type, source_name) values ($1, 'https://x.no', 't', 'reddit', 'r/x')",
        [A],
        /permission denied/,
      );
      await expectError(db, "delete from mentions where profile_id = $1", [A], /permission denied/);
      await expectError(db, "delete from mentions where id = $1", [B_MENTION], /permission denied/);
    });
  });
});

describe("worker-only tables", () => {
  it("runs and quota_usage are read-only for users", async () => {
    await inTx(db, async () => {
      await as(db, LEON);
      await expectError(db, "insert into runs (kind, profile_id) values ('backfill', $1)", [A], DENIED);
      await expectError(db, "update runs set status = 'failed'", [], DENIED);
      await expectError(db, "delete from runs", [], DENIED);
      await expectError(db, "insert into quota_usage (provider, month) values ('tavily', '2026-10-01')", [], DENIED);
      await expectError(db, "update quota_usage set credits_used = 0", [], DENIED);
      await expectError(db, "delete from quota_usage", [], DENIED);
    });
  });
});
