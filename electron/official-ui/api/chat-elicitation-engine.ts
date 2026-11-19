import type { Approval, Conversation } from "../../../shared/types";
import { linkOpens } from "../../../shared/external-links";
import { mcpElicitation } from "../../../shared/mcp-elicitation";
import type { Engine } from "../../engine/engine";
import { ChatElicitationHost } from "./chat-elicitation";

interface ChatApprovalScope {
  current(): boolean;
  conversation(id: string): Conversation | undefined;
  engine(id: string): Engine | undefined;
  canRespond(): boolean;
}

export function engineChatElicitation(scope: ChatApprovalScope) {
  const owned = (id: string) => {
    if (!scope.current()) return;
    const conversation = scope.conversation(id);
    if (!conversation || conversation.mode !== "chat" || conversation.archived ||
        conversation.linkedToComputer || conversation.chatDeviceBinding || conversation.deviceChatOrigin?.active || !conversation.threadId) return;
    const engine = scope.engine(id);
    if (!engine || !engine.owns(conversation) ||
        engine.routes.get(conversation.threadId) !== conversation.id) return;
    return { conversation, engine };
  };
  const live = (engine: Engine, approval: Approval) =>
    engine.appApprovals.has(approval.id) || engine.rpc?.connected === true;
  return new ChatElicitationHost({
    urlAllowed(approval) {
      const engine = owned(approval.conversationId)?.engine;
      const elicitation = mcpElicitation(approval);
      return !!engine && elicitation?.mode === "url" && linkOpens(elicitation.url, engine.policy());
    },
    isCurrent: scope.current,
    async load(id) {
      const target = owned(id);
      if (target) return {
        conversation: target.conversation,
        approvals: target.engine.ownApprovals.filter(approval => live(target.engine, approval)),
      };
    },
    dispatch(approval, response) {
      const target = owned(approval.conversationId);
      const turn = target?.conversation.turns.at(-1);
      if (!scope.canRespond() || !target || !live(target.engine, approval) ||
          !target.engine.ownApprovals.includes(approval) ||
          target.engine.ownApprovals.filter(candidate => candidate.id === approval.id).length !== 1 ||
          approval.params?.threadId !== target.conversation.threadId ||
          turn?.status !== "inProgress" || turn.id !== approval.params?.turnId)
        throw Error("The interaction request is no longer current.");
      target.engine.approve(approval.id, response);
      if (!scope.current() || target.engine.ownApprovals.includes(approval))
        throw Error("The interaction response was not confirmed.");
    },
  });
}
