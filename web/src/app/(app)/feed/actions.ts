"use server";

import { revalidatePath } from "next/cache";
import { updateMentionHidden } from "@/lib/queries/db";
import { parseHiddenForm } from "@/lib/queries/feed";
import { createClient } from "@/lib/supabase/server";

/** "Not relevant" / "Restore" on a mention card. RLS only allows updating `hidden`. */
export async function setMentionHidden(formData: FormData): Promise<void> {
  const input = parseHiddenForm(formData);
  if (!input) throw new Error("Invalid request");
  const supabase = await createClient();
  await updateMentionHidden(supabase, input.id, input.hidden);
  revalidatePath("/feed");
  revalidatePath("/analytics");
}
