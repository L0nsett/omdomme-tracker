"use client";

import { RouteError } from "@/components/ui/RouteError";

export default function StatusError({ reset }: { error: Error; reset: () => void }) {
  return <RouteError what="the status page" reset={reset} />;
}
