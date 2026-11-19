import { createDocumentPreviewTokens } from "../../electron/official-ui/document-preview";
import type { LinkWebSession } from "../../shared/web-protocol";
import type { Dispatcher } from "./dispatcher";
import type { WebAppContext } from "./web-app-context";

const tokensByContext = new WeakMap<
  WebAppContext,
  ReturnType<typeof createDocumentPreviewTokens<LinkWebSession>>
>();

export function issueOfficialDocumentPreviewToken(
  dispatcher: Dispatcher,
  ctx: WebAppContext,
  session: LinkWebSession,
) {
  let tokens = tokensByContext.get(ctx);
  if (!tokens) {
    tokens = createDocumentPreviewTokens<LinkWebSession>(() =>
      !ctx.closedFlag &&
      !ctx.signedOut &&
      ctx.activeAccount &&
      dispatcher.context(ctx.userId) === ctx
        ? ctx.officialSessionIdentity()
        : undefined,
    );
    tokensByContext.set(ctx, tokens);
  }
  return `${ctx.userId}.${tokens.issueToken(session)}`;
}

export function verifyOfficialDocumentPreviewToken(
  dispatcher: Dispatcher,
  userId: number,
  token: unknown,
) {
  const ctx = dispatcher.context(userId);
  return ctx && typeof token === "string"
    ? tokensByContext.get(ctx)?.value(token)
    : undefined;
}
