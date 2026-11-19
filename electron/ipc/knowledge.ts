import {
  HUANER_TECH,
  hiwonderKnowledgeAllowed,
  knowledgeBasesFrom,
  knowledgeMethods,
  knowledgePath,
  type KnowledgeBaseInfo,
} from "../../shared/knowledge-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { requestJson } from "../sub2api/http";
import { registerKnowledgeExtension } from "../connectors/knowledge-extension";
import { assertAccountOperationCurrent } from "../account/operation-lease";

type KnowledgeRemote = NonNullable<AppContext["remote"]>;
type KnowledgeCatalogContext = Partial<
  Pick<AppContext, "accountActivationIdentity" | "accountRetiring" | "policy">
> & {
  readonly activeAccount?: { id: string };
  readonly remote?: {
    readonly ready: boolean;
    readonly backend: {
      readonly accounts: Pick<KnowledgeRemote["accounts"], "baseUrl">;
      readonly session: Pick<KnowledgeRemote["session"], "authorized">;
    };
  };
};

export async function loadKnowledgeOffer(ctx: KnowledgeCatalogContext) {
  const remote = ctx.remote;
  const account = ctx.activeAccount?.id;
  const activation = ctx.accountActivationIdentity;
  if (!remote?.ready || !account || activation == null || ctx.accountRetiring)
    return undefined;
  const { accounts, session } = remote.backend;
  const baseUrl = accounts.baseUrl;
  const current = () =>
    !ctx.accountRetiring &&
    ctx.remote === remote &&
    remote.ready &&
    ctx.activeAccount?.id === account &&
    ctx.accountActivationIdentity === activation;
  const body = await session.authorized(
    (token) =>
      requestJson(fetch, `${baseUrl}/api/v1${knowledgePath}`, { token }),
    current,
  );
  assertAccountOperationCurrent(current);
  return { baseUrl, bases: knowledgeBasesFrom(body) };
}

export async function loadKnowledgeCatalog(
  ctx: KnowledgeCatalogContext,
): Promise<KnowledgeBaseInfo[]> {
  const offer = await loadKnowledgeOffer(ctx);
  if (!offer) return [];
  const policy = ctx.policy?.();
  return policy && !hiwonderKnowledgeAllowed(policy, offer.baseUrl)
    ? offer.bases.filter((base) => base.id !== HUANER_TECH)
    : offer.bases;
}

/**
 * The knowledge bases the service offers (shared/knowledge-api.ts), read in
 * the main process. An account without a Claudex service has none.
 */
export function registerKnowledgeHandlers(handle: IpcHandle, ctx: AppContext) {
  handle("knowledgeBases", () => loadKnowledgeCatalog(ctx));
  // The agent's side: each account's engine serves the bases a chat uses.
  registerKnowledgeExtension(ctx);
  // Keeps this list and the bridge's in step.
  void knowledgeMethods;
}
