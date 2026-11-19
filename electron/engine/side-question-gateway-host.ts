import type { Conversation } from "../../shared/types";
import type { Store } from "../store/store";
import type { Engine } from "./engine";
import type { SideQuestionGateway } from "../official-ui/api/side-question-gateway";

const sideInstruction =
  "This is a side chat about the supplied conversation. Answer the person's side question directly. Do not use tools, run commands, change files, or continue the main task. Nothing said here is added to the main conversation.";

/** Bind the isolated gateway and the engine's account-owned instructions. */
export async function ownedSideQuestionGateway(options: {
  engine: Engine;
  store: Store;
  conversation: Conversation;
  model: string;
  signal: AbortSignal;
  current: () => boolean;
}): Promise<SideQuestionGateway> {
  const { engine, store, conversation, model, signal, current } = options;
  signal.throwIfAborted();
  const provider = store.settings.providers.find(
    (candidate) => candidate.id === conversation.providerId,
  );
  if (
    !provider ||
    (provider.model !== model && !provider.models.includes(model)) ||
    !current() ||
    engine.policy().update?.state === "required"
  )
    throw Error("The side-question model is unavailable.");
  if (engine.gatewayEndpoint() && engine.providerId !== provider.id)
    throw Error("The conversation's model service is not active.");
  if (!engine.gatewayEndpoint())
    await engine.ensure(provider, {
      interactive: false,
      current: () => current() && !signal.aborted,
    });
  signal.throwIfAborted();
  const gateway = engine.gateway;
  const valid = () =>
    current() &&
    engine.gateway === gateway &&
    engine.providerId === provider.id &&
    engine.policy().update?.state !== "required";
  if (!gateway || !valid())
    throw Error("The side-question gateway is unavailable.");
  const fingerprint = (source: Conversation) =>
    JSON.stringify({
      mode: source.mode,
      providerId: source.providerId,
      projectId: source.projectId,
      sessionInstructions: source.sessionInstructions,
      incognito: source.incognito,
      memoryDisabled: source.memoryDisabled,
      knowledgeBases: source.knowledgeBases,
      webSearch: source.webSearch,
      research: source.research,
      cwd: source.cwd,
      environment: source.environment,
    });
  const expectedSource = fingerprint(conversation);
  const instructionsFor = (source: Conversation) => {
    const activeProvider = store.settings.providers.find(
      (item) => item.id === source.providerId,
    );
    if (
      !activeProvider ||
      (activeProvider.model !== model && !activeProvider.models.includes(model))
    )
      throw Error("The side-question model changed.");
    const project = source.projectId
      ? store.projects.find((item) => item.id === source.projectId)
      : undefined;
    if (source.projectId && !project)
      throw Error("The side-question project is unavailable.");
    const value = engine.threadOptions(
      source,
      activeProvider,
      model,
      "chat",
      project,
    ).developerInstructions;
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > 1024 * 1024
    )
      throw Error(
        "The side-question instructions are unavailable or too large.",
      );
    return `${value}\n\n${sideInstruction}`;
  };
  const instructions = instructionsFor(conversation);
  return {
    current: valid,
    instructions,
    verifyContext: (source: Conversation) => {
      if (
        !valid() ||
        fingerprint(source) !== expectedSource ||
        instructionsFor(source) !== instructions
      )
        throw Error("The side-question instructions changed. Try again.");
    },
    open: async () => {
      if (!valid()) throw Error("The side-question gateway changed.");
      const path = await gateway.openSidePath();
      if (!valid()) {
        await gateway.closeSidePath(path).catch(() => {});
        throw Error("The side-question gateway changed.");
      }
      return { url: gateway.url, token: gateway.token, path };
    },
    close: (path: string) => gateway.closeSidePath(path),
  };
}
