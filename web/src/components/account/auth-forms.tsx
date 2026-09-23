"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert, Field, SubmitButton, inputClass, secondaryButtonClass } from "./ui";

export interface AuthFormState {
  error?: string;
  message?: string;
  email?: string;
}

type Action = (prev: AuthFormState, fd: FormData) => Promise<AuthFormState>;

function withNext(path: string, next?: string) {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

export function GoogleButton({ action, next }: { action: (fd: FormData) => Promise<void>; next?: string }) {
  return (
    <form action={action}>
      <input type="hidden" name="next" value={next ?? ""} />
      <SubmitButton className={`${secondaryButtonClass} w-full gap-2`} pendingText="Redirecting to Google…">
        <GoogleIcon />
        Continue with Google
      </SubmitButton>
    </form>
  );
}

function Divider() {
  return (
    <div className="flex items-center gap-3 text-xs text-neutral-400">
      <span className="h-px flex-1 bg-neutral-200" />
      or
      <span className="h-px flex-1 bg-neutral-200" />
    </div>
  );
}

export function LoginForm({
  action,
  googleAction,
  next,
  initialError,
}: {
  action: Action;
  googleAction: (fd: FormData) => Promise<void>;
  next?: string;
  initialError?: string;
}) {
  const [state, formAction] = useActionState(action, { error: initialError });
  return (
    <div className="space-y-5">
      <GoogleButton action={googleAction} next={next} />
      <Divider />
      <form action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={next ?? ""} />
        {state.error && <Alert kind="error">{state.error}</Alert>}
        <Field label="Email" htmlFor="email">
          <input id="email" name="email" type="email" autoComplete="email" required defaultValue={state.email} className={inputClass} />
        </Field>
        <Field label="Password" htmlFor="password">
          <input id="password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
        </Field>
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-xs text-neutral-600 underline-offset-2 hover:underline">
            Forgot password?
          </Link>
        </div>
        <SubmitButton className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60" pendingText="Signing in…">
          Sign in
        </SubmitButton>
      </form>
      <p className="text-center text-sm text-neutral-600">
        No account yet?{" "}
        <Link href={withNext("/signup", next)} className="font-medium text-neutral-900 underline-offset-2 hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}

export function SignupForm({
  action,
  googleAction,
  next,
}: {
  action: Action;
  googleAction: (fd: FormData) => Promise<void>;
  next?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  if (state.message) {
    return (
      <div className="space-y-4">
        <Alert kind="success">{state.message}</Alert>
        <p className="text-sm text-neutral-600">
          Already confirmed?{" "}
          <Link href={withNext("/login", next)} className="font-medium text-neutral-900 hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <GoogleButton action={googleAction} next={next} />
      <Divider />
      <form action={formAction} className="space-y-4" noValidate>
        <input type="hidden" name="next" value={next ?? ""} />
        {state.error && <Alert kind="error">{state.error}</Alert>}
        <Field label="Email" htmlFor="email">
          <input id="email" name="email" type="email" autoComplete="email" required defaultValue={state.email} className={inputClass} />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} className={inputClass} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm">
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" required className={inputClass} />
        </Field>
        <SubmitButton className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60" pendingText="Creating account…">
          Create account
        </SubmitButton>
      </form>
      <p className="text-center text-sm text-neutral-600">
        Already have an account?{" "}
        <Link href={withNext("/login", next)} className="font-medium text-neutral-900 underline-offset-2 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

export function ForgotPasswordForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <div className="space-y-5">
      {state.message ? (
        <Alert kind="success">{state.message}</Alert>
      ) : (
        <form action={formAction} className="space-y-4" noValidate>
          {state.error && <Alert kind="error">{state.error}</Alert>}
          <Field label="Email" htmlFor="email">
            <input id="email" name="email" type="email" autoComplete="email" required defaultValue={state.email} className={inputClass} />
          </Field>
          <SubmitButton className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60" pendingText="Sending…">
            Send reset link
          </SubmitButton>
        </form>
      )}
      <p className="text-center text-sm text-neutral-600">
        <Link href="/login" className="font-medium text-neutral-900 underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export function ResetPasswordForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.error && <Alert kind="error">{state.error}</Alert>}
      <Field label="New password" htmlFor="password" hint="At least 8 characters.">
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} className={inputClass} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm">
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required className={inputClass} />
      </Field>
      <SubmitButton className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-60" pendingText="Saving…">
        Set new password
      </SubmitButton>
    </form>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-4 w-4">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
