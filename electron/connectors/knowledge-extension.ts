/**
 * Hiwonder tools run through the engine's gateway. The session's connector
 * choice controls the thread's tools and their instructions.
 */
import type { AppContext } from "../app/app-context";
import type {
  BuiltinMcpServer,
  EngineExtension,
  EngineTurnContext,
} from "../engine/engine-extensions";
import { instructionOrder } from "../engine/engine-extensions";
import {
  HIWONDER_KNOWLEDGE_SERVER,
  HIWONDER_KNOWLEDGE_TOOLS,
  HUANER_TECH,
  hiwonderKnowledgeAllowed,
  hiwonderKnowledgeEnabled,
  knowledgeInstructions,
  knowledgeRoute,
} from "../../shared/knowledge-api";

export const knowledgeExtensionId = "knowledge";

/** The token Codex already holds for the local gateway (electron/engine.ts). */
const gatewayTokenEnv = "CLAUDEX_GATEWAY_TOKEN";

function activeTools(ctx: EngineTurnContext) {
  if (
    !ctx.gatewayUrl ||
    ctx.provider.backend !== "sub2api" ||
    !hiwonderKnowledgeEnabled(ctx.conversation) ||
    !hiwonderKnowledgeAllowed(
      ctx.policy,
      ctx.provider.baseUrl.replace(/\/v1\/?$/, ""),
    )
  )
    return [];
  const choices =
    ctx.conversation.connectorToolOverrides?.[HIWONDER_KNOWLEDGE_SERVER];
  return HIWONDER_KNOWLEDGE_TOOLS.filter((tool) => choices?.[tool] !== false);
}

export function knowledgeExtension(): EngineExtension {
  return {
    id: knowledgeExtensionId,
    order: instructionOrder.feature,
    incognito: true,
    reservedMcpServerNames: [HIWONDER_KNOWLEDGE_SERVER],
    builtinMcpServers(ctx): BuiltinMcpServer[] | undefined {
      if (!ctx.gatewayUrl) return undefined;
      const tools = activeTools(ctx);
      const server = {
        name: HIWONDER_KNOWLEDGE_SERVER,
        url: new URL(knowledgeRoute(HUANER_TECH), ctx.gatewayUrl).href,
      };
      if (!tools.length) return [{ ...server, enabled: false }];
      return [
        {
          ...server,
          enabled: true,
          enabledTools: tools,
          required: true,
          bearerTokenEnvVar: gatewayTokenEnv,
          startupTimeoutSec: 20,
          toolTimeoutSec: 120,
          defaultToolsApprovalMode:
            ctx.policy.approvalsAlwaysAllow === false ? "prompt" : "approve",
        },
      ];
    },
    turnContext(ctx) {
      const workflow = knowledgeInstructions(
        ["幻尔科技知识库 (Hiwonder)"],
        activeTools(ctx),
      );
      return workflow ? { workflow } : undefined;
    },
  };
}

/**
 * Adds the extension to each signed-in account's engine and to the engines
 * of its spaces (the web runner runs each chat in one).
 */
export function registerKnowledgeExtension(
  ctx: Pick<
    AppContext,
    "engine" | "onAccountActivated" | "onAccountDeactivating"
  >,
) {
  let cleanup: (() => void) | undefined;
  ctx.onAccountActivated?.(() => {
    cleanup?.();
    const engine = ctx.engine;
    const extension = knowledgeExtension();
    const remove = engine.extensions.has(knowledgeExtensionId)
      ? undefined
      : engine.extensions.add(extension);
    const peers = engine.peerExtensions;
    const shared = !peers.some((e) => e.id === knowledgeExtensionId);
    if (shared) peers.push(extension);
    cleanup = () => {
      remove?.();
      if (shared) {
        const at = peers.indexOf(extension);
        if (at >= 0) peers.splice(at, 1);
      }
      cleanup = undefined;
    };
  });
  ctx.onAccountDeactivating?.(() => cleanup?.());
}
