import "server-only";
import { redirect } from "next/navigation";
import { currentAccount } from "@/lib/ctx";

/** True when this request comes from a signed-in account. */
export async function hasSession(): Promise<boolean> {
  return (await currentAccount()) !== null;
}

/**
 * Checked inside every server action and route handler, not only in proxy.ts:
 * server actions are POSTs to whatever page renders them.
 */
export async function requireSession(): Promise<void> {
  if (!(await hasSession())) redirect("/login");
}
