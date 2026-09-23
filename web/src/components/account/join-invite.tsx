"use client";

import { useActionState } from "react";
import { Alert, Field, SubmitButton, inputClass, secondaryButtonClass } from "./ui";

export interface InviteFormState {
  error?: string;
  value?: string;
}

/** "Paste an invite link" form on the onboarding page. */
export function JoinWithInviteForm({ action }: { action: (prev: InviteFormState, fd: FormData) => Promise<InviteFormState> }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state.error && <Alert kind="error">{state.error}</Alert>}
      <Field label="Invite link" htmlFor="invite">
        <input
          id="invite"
          name="invite"
          defaultValue={state.value}
          placeholder="https://…/invite/…"
          autoComplete="off"
          className={inputClass}
        />
      </Field>
      <SubmitButton className={secondaryButtonClass} pendingText="Joining…">
        Join profile
      </SubmitButton>
    </form>
  );
}

/** Single "Join profile" button on /invite/[token]. */
export function AcceptInviteForm({
  action,
  token,
}: {
  action: (prev: InviteFormState, fd: FormData) => Promise<InviteFormState>;
  token: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="invite" value={token} />
      {state.error && <Alert kind="error">{state.error}</Alert>}
      <SubmitButton className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60" pendingText="Joining…">
        Join profile
      </SubmitButton>
    </form>
  );
}
