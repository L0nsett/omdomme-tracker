/**
 * Helpers for RLS tests. Each test runs inside a transaction that is rolled back,
 * so tests in a file don't affect each other (role/claim changes roll back too).
 */
import type { Client } from "pg";
import { expect } from "vitest";
import { fixtureUsers } from "@/lib/fixtures";
import { asAdmin, asUser } from "../helpers/db";

/** Seeded users (supabase/seed.sql). */
export const LEON = fixtureUsers[0].id; // owner of ReLU NTNU (profile A)
export const MEMBER = fixtureUsers[1].id; // member of ReLU NTNU
export const OUTSIDER = fixtureUsers[2].id; // owner of Other Org AS (profile B)

/** Creates a user with no profile. Call as admin (before switching role). */
let counter = 0;
export async function newUser(db: Client): Promise<string> {
  counter += 1;
  const { rows } = await db.query("insert into auth.users (email) values ($1) returning id", [`new${counter}-${Date.now()}@example.com`]);
  return rows[0].id as string;
}

export async function inTx(db: Client, fn: () => Promise<void>): Promise<void> {
  await db.query("begin");
  try {
    await asAdmin(db);
    await fn();
  } finally {
    await db.query("rollback");
    await asAdmin(db);
  }
}

export async function as(db: Client, userId: string | "anon"): Promise<void> {
  if (userId === "anon") {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "anon" })]);
    await db.query("set role anon");
  } else {
    await asUser(db, userId);
  }
}

/** Runs `sql` in a savepoint and expects it to fail; returns the error message. */
export async function expectError(db: Client, sql: string, params: unknown[] = [], pattern?: RegExp): Promise<string> {
  await db.query("savepoint expect_error");
  let message: string | null = null;
  try {
    await db.query(sql, params);
  } catch (err) {
    message = (err as Error).message;
  }
  await db.query("rollback to savepoint expect_error");
  expect(message, `expected to fail: ${sql}`).not.toBeNull();
  if (pattern) expect(message).toMatch(pattern);
  return message!;
}

export const DENIED = /permission denied|row-level security/;
