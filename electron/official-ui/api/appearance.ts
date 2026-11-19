/** Exact response-font setting; not a general account-settings write permit. */
import type { ChatFont } from "../../../shared/types";
import type { AdapterContext } from "./context";

export const supportedOfficialChatFonts = [
  "serif",
  "sans",
  "system",
  "dyslexia",
] as const;
export function officialChatFont(value: unknown): ChatFont | undefined {
  return typeof value === "string" &&
    (supportedOfficialChatFonts as readonly string[]).includes(value)
    ? (value as ChatFont)
    : undefined;
}

type Result = {
  status: number;
  body:
    | { chat_font: ChatFont }
    | {
        type: "error";
        error: { type: "invalid_request_error"; message: string };
      };
};
const refused = (status: number, message: string): Result => ({
  status,
  body: { type: "error", error: { type: "invalid_request_error", message } },
});

export async function saveOfficialChatFont(
  ctx: AdapterContext,
  body: unknown,
): Promise<Result> {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "chat_font")
  )
    return refused(
      400,
      "Only the response font may be changed by this action.",
    );
  const raw = (body as { chat_font: unknown }).chat_font;
  // 'default' is platform-relative in the official consumer; Atkinson has no
  // corresponding Claudex setting. Never silently substitute a different font.
  if (raw === "default" || raw === "atkinson")
    return refused(
      501,
      "This response font is not supported by this host. Your saved font was not changed.",
    );
  const font = officialChatFont(raw);
  if (!font) return refused(400, "Invalid response font.");
  let owner: string | undefined, activation: unknown;
  const current = () => {
    try {
      return (
        !!owner &&
        activation !== undefined &&
        activation !== null &&
        activation !== "" &&
        ctx.account()?.id === owner &&
        ctx.sessionIdentity?.() === activation &&
        ctx.isCurrent?.() !== false
      );
    } catch {
      return false;
    }
  };
  try {
    owner = ctx.account()?.id;
    activation = ctx.sessionIdentity?.();
  } catch {
    return refused(409, "The account activation changed. Reopen settings.");
  }
  if (!owner) return refused(401, "Sign in to change the response font.");
  if (!current())
    return refused(409, "The account activation changed. Reopen settings.");
  if (
    ctx.readOnly &&
    (!ctx.authorizeAppearanceSettings || !ctx.saveAppearanceFont)
  )
    return refused(
      403,
      "Response font changes are unavailable in this read-only host.",
    );
  if (ctx.authorizeAppearanceSettings) {
    try {
      await ctx.authorizeAppearanceSettings();
    } catch {
      return current()
        ? refused(
            403,
            "Response font changes are not authorized for this account session.",
          )
        : refused(409, "The account activation changed. Reopen settings.");
    }
    if (!current())
      return refused(409, "The account activation changed. Reopen settings.");
  }
  try {
    if (ctx.saveAppearanceFont) await ctx.saveAppearanceFont(font);
    else {
      const settings = ctx.settings();
      if (!current())
        return refused(409, "The account activation changed. Reopen settings.");
      await ctx.call("saveSettings", { ...settings, chatFont: font });
    }
    if (!current())
      return refused(
        409,
        "The account changed while saving. Reload settings to confirm the result; no retry was started.",
      );
    return { status: 200, body: { chat_font: font } };
  } catch {
    return current()
      ? refused(
          503,
          "The response font could not be saved. Reload settings to confirm its value before retrying.",
        )
      : refused(
          409,
          "The account changed while saving. Reload settings to confirm the result; no retry was started.",
        );
  }
}
