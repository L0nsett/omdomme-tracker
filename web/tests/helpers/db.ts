/**
 * Helpers for tests against the local test Postgres (see scripts/reset-test-db.sh).
 * `asUser` switches to Supabase's `authenticated` role with the given user id, so
 * queries go through the same RLS policies as in production.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Client } from "pg";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/omdomme_test";

const ROOT = path.resolve(__dirname, "../../..");

/** Drops and recreates the schema from migrations, optionally with supabase/seed.sql. */
export function resetTestDb(opts: { seed?: boolean } = {}): void {
  execFileSync(path.join(ROOT, "scripts/reset-test-db.sh"), opts.seed ? ["--seed"] : [], {
    env: { ...process.env, TEST_DATABASE_URL },
    stdio: "pipe",
  });
}

export async function connect(): Promise<Client> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  return client;
}

export async function asUser(client: Client, userId: string): Promise<void> {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  await client.query("set role authenticated");
}

export async function asAdmin(client: Client): Promise<void> {
  await client.query("reset role");
}
