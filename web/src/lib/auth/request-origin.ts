import { headers } from "next/headers";
import { originFromHeaders } from "./origin";

/** Origin of the current request (Server Components / Server Actions only). */
export async function requestOrigin(): Promise<string> {
  return originFromHeaders(await headers());
}
