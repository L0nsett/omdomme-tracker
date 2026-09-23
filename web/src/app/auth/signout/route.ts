import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Signs the user out. POST only (the app header posts a form here). */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // 303 so the browser follows with GET.
  return NextResponse.redirect(new URL("/login", request.nextUrl.origin), { status: 303 });
}
