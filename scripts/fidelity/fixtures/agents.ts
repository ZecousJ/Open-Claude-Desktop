/**
 * Sub-agent transcripts for the preview (R13-B): `readWorkflowAgent` answers
 * for the sub-agents of the `states=1` conversations (the Code run states'
 * "Check greet against README" agent), in the shape the panels preview
 * uses, so opening that agent's transcript shows it instead of an error.
 * Nothing here reaches a network.
 */
import type { AgentTranscript, Conversation } from "../../../shared/types";
import type { FixtureDomain } from "./index";

/** Transcripts by agent thread id, for the agents the fixture conversations spawn. */
const transcripts: Record<string, (agentId: string) => AgentTranscript> = {
  "agent-state-1": (agentId) => ({
    model: "Opus 5.5",
    context:
      "You are working in the repository at /Users/fixture/claudex.\n\nTask: Check greet against README.",
    status: "completed",
    items: [
      {
        id: `${agentId}-read`,
        type: "commandExecution",
        command: "cat README.md",
        cwd: "/Users/fixture/claudex",
        status: "completed",
        lifecycleStatus: "completed",
        exitCode: 0,
        aggregatedOutput: "",
        commandActions: [
          {
            type: "read",
            command: "cat README.md",
            name: "README.md",
            path: "/Users/fixture/claudex/README.md",
          },
        ],
      },
      {
        id: `${agentId}-reply`,
        type: "agentMessage",
        text: "greet trims the name and falls back to “friend”, as README.md says.",
      },
    ],
    toolUses: 1,
  }),
};

/** Whether a conversation of the preview spawned this agent. */
function spawnedIn(conversation: Conversation | undefined, agentId: string) {
  return !!conversation?.turns.some((turn) =>
    turn.items.some(
      (item) =>
        item.type === "collabAgentToolCall" &&
        Array.isArray(item.receiverThreadIds) &&
        item.receiverThreadIds.includes(agentId),
    ),
  );
}

export const agentsFixture: FixtureDomain = {
  params: {
    states: "1 adds the conversations whose sub-agent transcripts open here",
  },
  bridge: ({ state }) => ({
    readWorkflowAgent: async (conversationId, agentId) => {
      const conversation = state.conversations.find(
        (item) => item.id === conversationId,
      );
      const transcript = transcripts[agentId];
      if (!transcript || !spawnedIn(conversation, agentId))
        throw new Error("This agent’s transcript is not available.");
      return transcript(agentId);
    },
  }),
};
