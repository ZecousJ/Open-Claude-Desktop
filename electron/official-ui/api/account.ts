import {localeSaveStage,withLocaleSaveDiagnostics} from './locale-save-diagnostics';
import { validLocaleBody } from "../../../shared/official-appearance-capability";
/**
 * Settings › Account (official consumers: c71860c77 profile rows and
 * Active sessions, shared-0 Nz/nk account_profile, vZ avatar upload,
 * c496f801f session list and logout/session, shared-l-p-m-w-3 logout and
 * logout/all-sessions, c632c9594 DELETE /api/account), on Claudex's own
 * settings and account calls:
 * - Full name: the Claudex account name ("setFullName").
 * - What should Claudex call you / What best describes your work /
 *   Instructions for Claudex / Global instructions / the profile photo:
 *   the Claudex settings name, workType, instructions, coworkInstructions
 *   and avatarPhoto (a ≤256px PNG data URL), saved with "saveSettings".
 * - Active sessions: "activeSessions" / "endActiveSession".
 * - Log out, Log out of all devices, Delete account: "logoutAccount",
 *   "revokeAllSessions", "deleteAccount".
 */
import {
  officialActiveSessionsPage,
  officialActiveSessionsPath,
  officialEndActiveSessionBody,
  officialEndActiveSessionPath,
  sessionPage,
} from "../../../shared/official-active-sessions";
import { createHash } from "node:crypto";
import type http from "node:http";
import type { AccountProfile } from "../../../shared/settings-api";
import type { Settings } from "../../../shared/types";
import { normalizeWorkType } from "../../../shared/settings-extras";
import {
  officialAccountActivation,
  officialActivateAccountPath,
  officialAddAccountPath,
  officialBrowserAccounts,
  officialBrowserAccountsPath,
} from "../../../shared/official-account-menu";
import { needsSignInAgain, type BrowserAccounts } from "../../../shared/sign-in-api";
import { empty, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";
import { filePart } from "./files";
import {
  avatarUploadLimit,
  avatarUploadTypes,
  avatarPhotoLimit,
} from "../../../shared/avatar";
import {
  officialLocale,
  officialLocaleMessages,
  requireOfficialLocale,
} from "../locale";

type ProfileSettings = Settings & {
  name?: string;
  coworkInstructions?: string;
  avatarPhoto?: string;
  profilePhotoEnabled?: boolean;
};

const settingsOf = (ctx: AdapterContext) => ctx.settings() as ProfileSettings;
const save = (ctx: AdapterContext, patch: Partial<ProfileSettings>) =>
  ctx.call("saveSettings", { ...settingsOf(ctx), ...patch });

/** The profile photo's address on this origin (versioned so a new photo is fetched). */
export function avatarUrl(ctx: AdapterContext) {
  const photo = settingsOf(ctx).avatarPhoto;
  if (!photo) return null;
  return `/api/__claudex/avatar?v=${createHash("sha256").update(photo).digest("hex").slice(0, 12)}`;
}

/** Account fields the page reads beside /api/account (bootstrap.ts accountOf). */
export function accountProfileFields(ctx: AdapterContext) {
  const s = settingsOf(ctx);
  const account = ctx.account();
  return {
    full_name: account?.name || account?.email || "",
    display_name: s.name || account?.name || "",
    avatar_image_url: avatarUrl(ctx),
    work_function: normalizeWorkType(s.workType) ?? null,
  };
}

function profile(ctx: AdapterContext) {
  const s = settingsOf(ctx);
  return {
    ...accountProfileFields(ctx),
    conversation_preferences: s.instructions ?? "",
    cowork_global_instructions: s.coworkInstructions ?? "",
    cowork_instructions_union: false,
    avatar: null,
    locale: officialLocale(ctx),
  };
}

/** Applies a profile or account change; answers what was kept. */
async function applyProfile(
  ctx: AdapterContext,
  body: Record<string, unknown>,
  check: () => void,
) {
  check();
  // Validate before applying any fields; an unavailable catalog must not be
  // acknowledged as a successful language change.
  localeSaveStage("catalog-validation");
  const locale =
    body.locale === undefined
      ? undefined
      : requireOfficialLocale(ctx.root, body.locale);
  if (locale !== undefined && ctx.readOnly && (!validLocaleBody(body) || !ctx.authorizeAppearanceSettings || !ctx.saveAppearanceLocale))
    throw Error("Language changes are not available on this host.");
  if (locale !== undefined) {
    officialLocaleMessages(ctx.root, locale);
    if (!ctx.account()?.id || ctx.sessionIdentity?.() == null) throw Error("The account changed during this request.");
    if (ctx.authorizeAppearanceSettings) await ctx.authorizeAppearanceSettings();
    check();
  }
  const patch: Partial<ProfileSettings> = {};
  if (typeof body.conversation_preferences === "string")
    patch.instructions = body.conversation_preferences;
  if (typeof body.cowork_global_instructions === "string")
    patch.coworkInstructions = body.cowork_global_instructions;
  if (typeof body.display_name === "string")
    patch.name = body.display_name.trim().slice(0, 100);
  if ("work_function" in body)
    patch.workType = normalizeWorkType(body.work_function);
  if (Object.keys(patch).length) await save(ctx, patch);
  check();
  if (locale !== undefined) {
    localeSaveStage("save-dispatch");
    if (ctx.saveAppearanceLocale) await ctx.saveAppearanceLocale(locale);
    else {
      // The native saveSettings handler flushes its local Store synchronously
      // before resolving. Never replace this with a queued renderer save.
      await (ctx.localCall ?? ctx.call)("saveSettings", { ...settingsOf(ctx), locale });
    }
    check();
    localeSaveStage("readback");
    if (officialLocale(ctx) !== locale) throw Error("The account or settings changed.");
  }
  check();
  if (
    typeof body.full_name === "string" &&
    body.full_name.trim() &&
    body.full_name.trim() !== ctx.account()?.name
  )
    (await ctx.call("setFullName", body.full_name.trim())) as AccountProfile;
  check();
}

function accountMenuError(res: http.ServerResponse, type: string, message: string, status: number) {
  return reply(res, { type: "error", error: { type, message } }, status);
}

export async function accountRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  ctx: AdapterContext,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const owner = ctx.account()?.id,
    identity = ctx.sessionIdentity?.();
  const check = () => {
    if (
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== identity
    )
      throw Error("The account changed during this request.");
  };
  const refused = (error: unknown, status = 400) =>
    reply(
      res,
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      status,
    );
  try {
    check();
    const activation = method === "POST" ? officialActivateAccountPath.exec(p) : null;
    const add = method === "POST" && p === officialAddAccountPath;
    const list = method === "GET" && p === officialBrowserAccountsPath;
    if (activation || add || list) {
      if (ctx.readOnly || ctx.browserAccountsAvailable?.() !== true)
        return refused("Account switching is unavailable on this host.", 501);
      if (new URL(req.url ?? p, "http://localhost").search)
        return refused("Unsupported account request.");
      const source = await ctx.call("browserAccounts") as BrowserAccounts;
      check();
      const accounts = officialBrowserAccounts(source);
      if (list) return reply(res, accounts);
      const body = await readBoundedJson(req, 4096);
      check();
      if (activation) {
        const handle = decodeURIComponent(activation[1]);
        if (Object.keys(body).some((key) => key !== "handle") ||
            (body.handle !== undefined && body.handle !== handle))
          return refused("Choose a valid account.");
        const target = accounts.accounts.find((account) => account.handle === handle);
        if (!target)
          return accountMenuError(res, "account_not_in_browser", "This account is no longer on this computer.", 404);
        if (target.state === "sign_in_again")
          return accountMenuError(res, "reauth_required", "Sign in again.", 401);
        try {
          const opened = await ctx.call("switchAccount", target.handle);
          if (!opened || typeof opened !== "object" || !("id" in opened) || opened.id !== target.handle)
            return refused("The account operation could not be confirmed.");
          return reply(res, officialAccountActivation({ id: target.handle }));
        } catch (error) {
          if (needsSignInAgain(error))
            return accountMenuError(res, "reauth_required", "Sign in again.", 401);
          return refused("The account operation could not be confirmed.");
        }
      }
      if (Object.keys(body).length) return refused("Unsupported account request.");
      if (accounts.accounts.length >= accounts.max_accounts)
        return accountMenuError(res, "account_limit_reached", "This computer has reached its account limit.", 409);
      await ctx.call("addAccount");
      return empty(res);
    }
    if (p === "/api/account_profile") {
      if (method === "GET") return reply(res, profile(ctx));
      if (method === "PUT" || method === "PATCH") {
        const body = await readBoundedJson(req, 1024 * 1024);
        if (body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 1 && typeof body.locale === "string")
          await withLocaleSaveDiagnostics((...args) => ctx.log(...args), async () => {
            await applyProfile(ctx, body, check);
            localeSaveStage("complete");
          });
        else await applyProfile(ctx, body, check);
        return reply(res, profile(ctx));
      }
    }
    // Name changes the page saves on the account itself (shared-l-p-m-w-3 HG).
    if (p === "/api/account" && (method === "PUT" || method === "PATCH")) {
      const body = await readBoundedJson(req, 1024 * 1024);
      await applyProfile(ctx, body, check);
      return false; // bootstrap.ts answers with the account as it is now
    }
    if (p === "/api/account" && method === "DELETE") {
      await ctx.call("deleteAccount");
      return empty(res);
    }
    // The profile photo.
    if (p === "/api/__claudex/avatar" && method === "GET") {
      const photo = settingsOf(ctx).avatarPhoto;
      const match = photo ? /^data:([^;,]+);base64,(.*)$/.exec(photo) : null;
      if (!match)
        return reply(
          res,
          {
            type: "error",
            error: { type: "not_found_error", message: "No profile photo" },
          },
          404,
        );
      res.writeHead(200, {
        "Content-Type": match[1],
        "Cache-Control": "private, max-age=31536000, immutable",
      });
      res.end(Buffer.from(match[2], "base64"));
      return true;
    }
    if (p === "/api/account_avatar_image") {
      if (ctx.readOnly && (method === "POST" || method === "DELETE"))
        return refused("Profile photo changes are unavailable on this host.", 501);
      if (method === "DELETE") {
        await save(ctx, { avatarPhoto: undefined, profilePhotoEnabled: false });
        check();
        return empty(res);
      }
      if (method === "POST") {
        const file = await filePart(req, avatarUploadLimit + 64 * 1024);
        check();
        if (!file || !avatarUploadTypes.includes(file.type))
          return refused("Choose a PNG, JPEG or WebP image.");
        if (file.data.byteLength > avatarUploadLimit)
          return refused("The image is too large.", 413);
        const png = ctx.image?.thumbnail?.(Buffer.from(file.data), 256);
        if (!png || !png.length)
          return refused("That file isn't an image Claudex can read.");
        if (png.length > avatarPhotoLimit)
          return refused("The processed profile image is too large.", 413);
        check();
        await save(ctx, {
          avatarPhoto: `data:image/png;base64,${png.toString("base64")}`,
          profilePhotoEnabled: true,
        });
        check();
        return reply(res, { avatar_image_url: avatarUrl(ctx) });
      }
    }
    // Active sessions.
    if (p === officialActiveSessionsPath && method === "GET") {
      const page = sessionPage(new URL(req.url ?? p, "http://localhost").searchParams);
      let source: unknown;
      try {
        source = await ctx.call("activeSessions");
      } catch {
        check();
        return refused("Active sessions could not be read. Try again.", 503);
      }
      check();
      const result = officialActiveSessionsPage(source, page);
      return result
        ? reply(res, result)
        : refused("Active sessions are unavailable for this account.", 503);
    }
    if (p === officialEndActiveSessionPath && method === "POST") {
      const body = await readBoundedJson(req, 1024 * 1024);
      check();
      const target = officialEndActiveSessionBody.safeParse(body);
      if (!target.success)
        return refused("Choose a valid active session.");
      const { ended } = (await ctx.call(
        "endActiveSession",
        target.data.session_uuid,
      )) as { ended: boolean };
      return ended
        ? empty(res)
        : reply(
            res,
            {
              type: "error",
              error: {
                type: "not_found_error",
                message: "This session has already ended or changed.",
              },
            },
            404,
          );
    }
    if (p === "/api/auth/logout" && method === "POST") {
      if (ctx.readOnly)
        return reply(res, { error: { type: "unimplemented", message: "Logout is unavailable on this host." } }, 501);
      try {
        await ctx.call("logoutAccount");
        return empty(res);
      } catch {
        return reply(res, { error: { type: "account_transition_error", message: "The account operation could not be confirmed." } }, 400);
      }
    }
    if (p === "/api/auth/logout/all-sessions" && method === "POST") {
      await ctx.call("revokeAllSessions");
      return empty(res);
    }
  } catch (error) {
    return refused(
      error,
      error instanceof RequestBodyError ? error.status : 400,
    );
  }
  return false;
}
