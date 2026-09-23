"use client";

import { useActionState, useState } from "react";
import type { ProfileFieldErrors, ProfileFormState } from "@/lib/auth/profile-form";
import { Alert, Field, SubmitButton, inputClass } from "./ui";

export interface ProfileFormResult {
  errors?: ProfileFieldErrors;
  error?: string;
  message?: string;
}

type Action = (prev: ProfileFormResult, fd: FormData) => Promise<ProfileFormResult>;

/**
 * Profile editor shared by onboarding and settings. The whole form state is sent as
 * JSON in one hidden field and validated on the server (lib/auth/profile-form.ts).
 */
export function ProfileForm({
  action,
  initial,
  submitLabel,
  pendingLabel,
  note,
}: {
  action: Action;
  initial: ProfileFormState;
  submitLabel: string;
  pendingLabel: string;
  note?: React.ReactNode;
}) {
  const [state, setState] = useState<ProfileFormState>(initial);
  const [result, formAction] = useActionState(action, {});
  const errors = result.errors ?? {};

  const set = <K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) =>
    setState((s) => ({ ...s, [key]: value }));
  const setRow = (i: number, patch: Partial<ProfileFormState["ambiguous"][number]>) =>
    set(
      "ambiguous",
      state.ambiguous.map((row, j) => (j === i ? { ...row, ...patch } : row)),
    );

  return (
    <form action={formAction} className="space-y-6" noValidate>
      <input type="hidden" name="profile" value={JSON.stringify(state)} />
      {result.error && <Alert kind="error">{result.error}</Alert>}
      {result.errors && <Alert kind="error">Please fix the highlighted fields.</Alert>}
      {result.message && <Alert kind="success">{result.message}</Alert>}

      <section className="space-y-4">
        <Field label="Organization name" htmlFor="pf-name" error={errors.name}>
          <input
            id="pf-name"
            value={state.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="ReLU NTNU"
            aria-invalid={Boolean(errors.name)}
            className={inputClass}
            maxLength={200}
          />
        </Field>
        <Field label="Website" htmlFor="pf-website" hint="Optional. Mentions that link here count as matches." error={errors.website}>
          <input
            id="pf-website"
            value={state.website}
            onChange={(e) => set("website", e.target.value)}
            placeholder="https://www.example.com"
            inputMode="url"
            aria-invalid={Boolean(errors.website)}
            className={inputClass}
          />
        </Field>
        <Field
          label="Social media links"
          htmlFor="pf-social"
          hint="Optional. One link per line, e.g. your Instagram or LinkedIn page."
          error={errors.socialLinks}
        >
          <textarea
            id="pf-social"
            rows={3}
            value={state.socialLinks}
            onChange={(e) => set("socialLinks", e.target.value)}
            placeholder={"https://www.instagram.com/example\nhttps://www.linkedin.com/company/example"}
            aria-invalid={Boolean(errors.socialLinks)}
            className={inputClass}
          />
        </Field>
      </section>

      <section className="space-y-4 border-t border-neutral-200 pt-5">
        <div>
          <h2 className="text-sm font-semibold">Search terms</h2>
          <p className="mt-1 text-xs text-neutral-500">
            A mention matches when it contains an exact term, or an ambiguous term together with one of its context words,
            and none of the exclusion words.
          </p>
          {errors.terms && <p className="mt-2 text-xs text-red-600">{errors.terms}</p>}
        </div>

        <Field label="Exact terms" htmlFor="pf-exact" hint="One per line. Names that are unique to you, e.g. “ReLU NTNU”.">
          <textarea
            id="pf-exact"
            rows={3}
            value={state.exactTerms}
            onChange={(e) => set("exactTerms", e.target.value)}
            placeholder="ReLU NTNU"
            aria-invalid={Boolean(errors.terms)}
            className={inputClass}
          />
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-neutral-800">Ambiguous terms</legend>
          <p className="text-xs text-neutral-500">
            Short names that also mean other things. They only count when a context word appears too (comma-separated).
          </p>
          {state.ambiguous.map((row, i) => (
            <div key={i} className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
              <input
                aria-label={`Ambiguous term ${i + 1}`}
                value={row.term}
                onChange={(e) => setRow(i, { term: e.target.value })}
                placeholder="ReLU"
                className={`${inputClass} sm:w-40`}
              />
              <input
                aria-label={`Context words for ambiguous term ${i + 1}`}
                value={row.context}
                onChange={(e) => setRow(i, { context: e.target.value })}
                placeholder="NTNU, Trondheim, student organization"
                className={`${inputClass} flex-1`}
              />
              <button
                type="button"
                onClick={() => set("ambiguous", state.ambiguous.filter((_, j) => j !== i))}
                className="rounded-md px-2 py-2 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                aria-label={`Remove ambiguous term ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          {errors.ambiguous && <p className="text-xs text-red-600">{errors.ambiguous}</p>}
          <button
            type="button"
            onClick={() => set("ambiguous", [...state.ambiguous, { term: "", context: "" }])}
            className="text-sm font-medium text-neutral-700 hover:text-neutral-900"
          >
            + Add ambiguous term
          </button>
        </fieldset>

        <Field
          label="Exclusion words"
          htmlFor="pf-exclusions"
          hint="Optional. One per line. Mentions containing any of these are ignored."
          error={errors.exclusions}
        >
          <textarea
            id="pf-exclusions"
            rows={3}
            value={state.exclusions}
            onChange={(e) => set("exclusions", e.target.value)}
            placeholder={"activation function\nleaky ReLU"}
            aria-invalid={Boolean(errors.exclusions)}
            className={inputClass}
          />
        </Field>
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-5">
        <SubmitButton pendingText={pendingLabel}>{submitLabel}</SubmitButton>
        {note && <p className="text-xs text-neutral-500">{note}</p>}
      </div>
    </form>
  );
}
