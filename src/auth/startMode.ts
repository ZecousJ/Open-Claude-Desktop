/*
 * The sign-in steps a web address opens on, read before the sign-in page's
 * chunk loads (src/AuthGate.tsx), so kept out of signInView.ts.
 */

/**
 * The step the web app's address asks for: `/register`, `/forgot-password`,
 * or `/reset-password?email=…&token=…` (the emailed link).
 */
export type StartMode = "create" | "forgot" | "reset";

/** The emailed reset link's email and token, when the address carries both. */
export function resetLinkOf(
  search: string,
): { email: string; token: string } | undefined {
  const query = new URLSearchParams(search);
  const email = query.get("email")?.trim() ?? "";
  const token = query.get("token")?.trim() ?? "";
  return email && token && token.length <= 512 && email.length <= 254
    ? { email, token }
    : undefined;
}

/** The start mode a web address asks for. */
export function startModeOf(
  pathname: string,
  search: string,
): StartMode | undefined {
  const path = pathname.replace(/\/$/, "");
  if (path === "/register") return "create";
  if (path === "/forgot-password") return "forgot";
  if (path === "/reset-password")
    return resetLinkOf(search) ? "reset" : "forgot";
  return undefined;
}
