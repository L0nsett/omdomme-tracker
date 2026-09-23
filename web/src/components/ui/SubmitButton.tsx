"use client";

import { useFormStatus } from "react-dom";

/** Submit button that disables itself while its form's Server Action runs. */
export function SubmitButton({
  children,
  pendingLabel,
  className = "",
  ...rest
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type" | "children" | "className">) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={className} {...rest}>
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
