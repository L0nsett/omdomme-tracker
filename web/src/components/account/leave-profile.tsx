"use client";

import { useActionState, useState } from "react";
import { Alert, SubmitButton, dangerButtonClass, secondaryButtonClass } from "./ui";

export interface LeaveState {
  error?: string;
}

/** "Leave profile" with an in-page confirmation step. */
export function LeaveProfile({
  action,
  isLastMember,
  isOwner,
}: {
  action: (prev: LeaveState) => Promise<LeaveState>;
  isLastMember: boolean;
  isOwner: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useActionState(action, {});

  if (!confirming) {
    return (
      <button type="button" className={secondaryButtonClass} onClick={() => setConfirming(true)}>
        Leave profile
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-medium text-red-900">Are you sure you want to leave this profile?</p>
      <p className="text-sm text-red-800">
        {isLastMember
          ? "You are the only member. The profile and all its collected mentions will be deleted permanently."
          : isOwner
            ? "You will lose access to its feed. Ownership passes to the longest-standing member."
            : "You will lose access to its feed. You can rejoin later with a new invite link."}
      </p>
      {state.error && <Alert kind="error">{state.error}</Alert>}
      <form action={formAction} className="flex flex-wrap gap-2">
        <SubmitButton className={dangerButtonClass} pendingText="Leaving…">
          {isLastMember ? "Yes, leave and delete profile" : "Yes, leave profile"}
        </SubmitButton>
        <button type="button" className={secondaryButtonClass} onClick={() => setConfirming(false)}>
          Cancel
        </button>
      </form>
    </div>
  );
}
