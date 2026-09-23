import { Notice } from "@/components/ui";
import type { BackfillStatus } from "@/lib/types";

/** Tells the user that history is still being collected (or that it failed). */
export function BackfillNotice({ status }: { status: BackfillStatus }) {
  if (status === "pending" || status === "running") {
    return (
      <Notice title="Fetching history…">
        We are collecting older mentions from all sources. This usually takes a couple of minutes; reload the page to
        see new results.
      </Notice>
    );
  }
  if (status === "failed") {
    return (
      <Notice tone="warning" title="Fetching history failed">
        Older mentions could not be collected. New mentions still arrive every hour. See the Status page for details.
      </Notice>
    );
  }
  return null;
}
