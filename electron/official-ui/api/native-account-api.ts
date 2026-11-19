/** The candidate native HTTP surface uses the same per-activation registry for
 * upload, PerformAction and timeline. Legacy global state is never guessed into
 * the currently signed-in account. Native domain IPC retains its own scopes. */
import { createApiAdapter } from "./index";
import { reply, type AdapterContext } from "./context";
import { codeFilePreviewRoute } from "./code-file-preview";
import { nativePrivacyRoute } from "./native-privacy";
import type http from "node:http";
export function createNativeAccountApi(ctx: AdapterContext) {
  const api = createApiAdapter(ctx, {
    scoped: true,
    migrateLegacy: false,
    restCompletion: "native",
  });
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!ctx.account())
      return reply(res, { error: "Sign in to continue." }, 401);
    const identity = ctx.sessionIdentity?.();
    if (ctx.isCurrent?.() !== true || identity == null || identity === "")
      return reply(
        res,
        { error: "The account session is changing. Reopen the window." },
        409,
      );
    return await nativePrivacyRoute(req, res, ctx) ||
      await codeFilePreviewRoute(req, res, ctx) || api(req, res);
  };
}
