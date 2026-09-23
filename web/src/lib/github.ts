/**
 * Starts a backfill run in GitHub Actions via workflow_dispatch of backfill.yml.
 * Server-only: uses GITHUB_DISPATCH_TOKEN, which must never be exposed to the browser.
 * The token only needs "Actions: read and write" on this repository (not Contents).
 */

export interface GithubDispatchConfig {
  /** "owner/repo" */
  repo: string;
  token: string;
}

export type DispatchResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "github_error" | "network_error"; status?: number; message: string };

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Reads the dispatch config from env; null when it is missing or malformed. */
export function githubConfigFromEnv(env: Record<string, string | undefined> = process.env): GithubDispatchConfig | null {
  const token = env.GITHUB_DISPATCH_TOKEN?.trim();
  const repo = env.GITHUB_REPO?.trim();
  if (!token || !repo || !REPO_PATTERN.test(repo)) return null;
  return { token, repo };
}

export const BACKFILL_WORKFLOW = "backfill.yml";
export const BACKFILL_REF = "main";

export function dispatchUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/actions/workflows/${BACKFILL_WORKFLOW}/dispatches`;
}

/**
 * POST /repos/{repo}/actions/workflows/backfill.yml/dispatches. GitHub answers 204 on success.
 */
export async function dispatchBackfill(
  profileId: string,
  config: GithubDispatchConfig | null,
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchResult> {
  if (!config) {
    return {
      ok: false,
      reason: "not_configured",
      message: "GITHUB_DISPATCH_TOKEN or GITHUB_REPO is not set; cannot start the backfill run.",
    };
  }
  let res: Response;
  try {
    res = await fetchImpl(dispatchUrl(config.repo), {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "omdomme-tracker",
      },
      body: JSON.stringify({ ref: BACKFILL_REF, inputs: { profile_id: profileId } }),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, reason: "network_error", message: `Could not reach GitHub: ${String(err)}` };
  }
  if (res.status === 204 || res.ok) return { ok: true };
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string };
    detail = body?.message ?? "";
  } catch {
    // Body was not JSON; the status is enough.
  }
  return {
    ok: false,
    reason: "github_error",
    status: res.status,
    message: `GitHub returned ${res.status}${detail ? `: ${detail}` : ""}`,
  };
}
