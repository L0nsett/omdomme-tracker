"use client";

import { useActionState, useState } from "react";
import { formatDate } from "@/lib/auth/format";
import { Alert, SubmitButton, inputClass, secondaryButtonClass } from "./ui";

export interface InviteLinkState {
  url?: string;
  expiresAt?: string;
  error?: string;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className={secondaryButtonClass}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied("copied");
        } catch {
          setCopied("failed");
        }
        setTimeout(() => setCopied("idle"), 2000);
      }}
    >
      {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** Creates a single-use invite link and shows it with a copy button. */
export function InvitePanel({ action }: { action: (prev: InviteLinkState) => Promise<InviteLinkState> }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <div className="space-y-3">
      <form action={formAction}>
        <SubmitButton pendingText="Creating link…">Create invite link</SubmitButton>
      </form>
      {state.error && <Alert kind="error">{state.error}</Alert>}
      {state.url && (
        <div className="space-y-2 rounded-md border border-neutral-200 bg-neutral-50 p-3">
          <label htmlFor="invite-url" className="block text-xs font-medium text-neutral-700">
            Share this link. It works once{state.expiresAt ? ` and expires ${formatDate(state.expiresAt)}` : ""}.
          </label>
          <div className="flex gap-2">
            <input
              id="invite-url"
              readOnly
              value={state.url}
              onFocus={(e) => e.currentTarget.select()}
              className={`${inputClass} font-mono text-xs`}
            />
            <CopyButton text={state.url} />
          </div>
        </div>
      )}
    </div>
  );
}
