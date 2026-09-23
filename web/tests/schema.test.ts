import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OTHER_PROFILE_ID, RELU_PROFILE_ID, fixtureUsers } from "@/lib/fixtures";
import { asUser, connect, resetTestDb } from "./helpers/db";

// Smoke test: seeded data is only visible to the profile's own members.
describe("seeded database + RLS", () => {
  let db: Client;
  beforeAll(async () => {
    resetTestDb({ seed: true });
    db = await connect();
  });
  afterAll(async () => db?.end());

  it("a ReLU member sees only ReLU mentions", async () => {
    await asUser(db, fixtureUsers[0].id);
    const { rows } = await db.query("select distinct profile_id from mentions");
    expect(rows.map((r) => r.profile_id)).toEqual([RELU_PROFILE_ID]);
  });

  it("the outsider sees only their own profile", async () => {
    await asUser(db, fixtureUsers[2].id);
    const { rows } = await db.query("select id from profiles");
    expect(rows.map((r) => r.id)).toEqual([OTHER_PROFILE_ID]);
  });
});
