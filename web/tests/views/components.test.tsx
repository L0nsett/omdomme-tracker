import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsView } from "@/components/analytics/AnalyticsView";
import { FeedView } from "@/components/mentions/FeedView";
import { MentionCard } from "@/components/mentions/MentionCard";
import { StatusView } from "@/components/status/StatusView";
import { FIXTURE_NOW, fixtureQuotaUsage, fixtureRuns, reluMentions } from "@/lib/fixtures";
import { buildFeed, parseFeedParams, parseFilterParams } from "@/lib/queries/feed";

afterEach(cleanup);

const NOW = new Date(FIXTURE_NOW);
const hackathon = reluMentions.find((m) => m.id.endsWith("01"))!;
const hiddenOne = reluMentions.find((m) => m.hidden)!;

describe("MentionCard", () => {
  it("renders title link, source, date, sentiment slot and reach", () => {
    render(<MentionCard mention={hackathon} hiddenAction={vi.fn()} />);
    const link = screen.getByRole("link", { name: /ReLU NTNU arrangerer AI-hackathon/ });
    expect(link).toHaveProperty("href", hackathon.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("Google News")).toBeTruthy();
    expect(screen.getByText("universitetsavisa.no")).toBeTruthy();
    expect(screen.getByText("21 Sept 2026")).toBeTruthy();
    expect(screen.getByText("Not classified")).toBeTruthy();
    expect(screen.getByText(hackathon.snippet)).toBeTruthy();
    const reach = screen.getByRole("img", { name: /Reach: Medium \(3 of 5, score 0\.41\)/ });
    expect(reach.querySelectorAll('[data-filled="true"]')).toHaveLength(3);
    expect(screen.getByRole("button", { name: /not relevant/i })).toBeTruthy();
  });

  it("submits the Not relevant action with id and hidden=true", async () => {
    const action = vi.fn();
    render(<MentionCard mention={hackathon} hiddenAction={action} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /not relevant/i }));
    });
    expect(action).toHaveBeenCalledTimes(1);
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("id")).toBe(hackathon.id);
    expect(fd.get("hidden")).toBe("true");
  });

  it("offers Restore for a hidden mention", () => {
    render(<MentionCard mention={hiddenOne} hiddenAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: /restore/i })).toBeTruthy();
    expect(screen.getByText("Hidden")).toBeTruthy();
    expect((document.querySelector('input[name="hidden"]') as HTMLInputElement).value).toBe("false");
  });

  it("handles a missing snippet and publish date", () => {
    render(<MentionCard mention={{ ...hackathon, snippet: "", published_at: null }} />);
    expect(screen.getByText("No excerpt available.")).toBeTruthy();
    expect(screen.getByText(/^Found /)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("FeedView", () => {
  const render_ = (sp: Record<string, string>, status: "done" | "running" | "failed" = "done", mentions = reluMentions) => {
    const params = parseFeedParams(sp);
    return render(
      <FeedView params={params} feed={buildFeed(mentions, params)} backfillStatus={status} truncated={false} hiddenAction={vi.fn()} />,
    );
  };

  it("lists visible mentions and hints at hidden ones", () => {
    render_({});
    expect(within(screen.getByRole("list", { name: "Mentions" })).getAllByRole("article")).toHaveLength(21);
    expect(screen.getByText(/21 mentions, newest first/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /1 hidden as not relevant/ }).getAttribute("href")).toBe("/feed?hidden=1");
  });

  it("shows Load more when there are more items", () => {
    render_({ q: "relu", limit: "25" }, "done", [...reluMentions, ...reluMentions.map((m) => ({ ...m, id: `${m.id}-b` }))]);
    const more = screen.getByRole("link", { name: /Load more/ });
    expect(more.getAttribute("href")).toBe("/feed?q=relu&limit=50");
  });

  it('shows "Fetching history…" while the backfill runs', () => {
    render_({}, "running", []);
    expect(screen.getByText("Fetching history…")).toBeTruthy();
    expect(screen.getByText("No mentions yet")).toBeTruthy();
  });

  it("warns when the backfill failed, and shows the filtered empty state", () => {
    render_({ q: "nothing-matches-this" }, "failed");
    expect(screen.getByText("Fetching history failed")).toBeTruthy();
    expect(screen.getByText("No mentions match these filters")).toBeTruthy();
  });
});

describe("AnalyticsView", () => {
  it('renders charts, top mentions and "Coming with Jev" placeholders', () => {
    render(<AnalyticsView mentions={reluMentions} filters={parseFilterParams({})} now={NOW} />);
    expect(screen.getAllByText("Coming with Jev")).toHaveLength(3);
    expect(screen.getByRole("region", { name: /Sentiment over time \(coming with Jev\)/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Bar chart: 21 mentions/ })).toBeTruthy();
    const bySource = screen.getByRole("list", { name: "Mentions by source type" });
    expect(within(bySource).getByText("Google News")).toBeTruthy();
    // hidden r/MachineLearning post is not among the top mentions
    expect(screen.queryByText(/ReLU notes from NTNU/)).toBeNull();
    expect(screen.getByRole("link", { name: "ReLU NTNU holds workshop on responsible AI" })).toBeTruthy();
  });

  it("still shows the Jev placeholders when there is no data", () => {
    render(<AnalyticsView mentions={[]} filters={parseFilterParams({})} now={NOW} />);
    expect(screen.getByText("No mentions yet")).toBeTruthy();
    expect(screen.getAllByText("Coming with Jev")).toHaveLength(3);
  });
});

describe("StatusView", () => {
  it("shows a failed run's error and remaining quota", () => {
    render(<StatusView runs={fixtureRuns} quota={fixtureQuotaUsage} now={NOW} />);
    expect(screen.getByText("gdelt: HTTP 503 Service Unavailable")).toBeTruthy();
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(screen.getByTestId("quota-remaining-tavily").textContent).toContain("538");
    expect(screen.getByTestId("quota-remaining-exa").textContent).toContain("$9.50");
    expect(screen.getByTestId("quota-remaining-serper").textContent).toContain("2,337");
    expect(screen.getByText("credits / month")).toBeTruthy();
    expect(screen.getByText("queries (one-time)")).toBeTruthy();
    expect(screen.getByText(/412 of 1,000 used/)).toBeTruthy();
  });

  it("alerts when the latest run failed", () => {
    const failedLatest = fixtureRuns.map((r) => (r.status === "failed" ? { ...r, started_at: "2026-09-23T08:55:00Z" } : r));
    render(<StatusView runs={failedLatest} quota={[]} now={NOW} />);
    expect(screen.getByRole("alert").textContent).toContain("The latest run failed");
  });

  it("has an empty state", () => {
    render(<StatusView runs={[]} quota={[]} now={NOW} />);
    expect(screen.getByText("No runs yet")).toBeTruthy();
  });
});
