/** Explicit synthetic Code list states. No real conversations or service calls. */
import type { FixtureDomain } from "./index";
import type { ConversationGroups } from "../../../shared/collections-api";
import type { Conversation } from "../../../shared/types";
export const codeListFixture: FixtureDomain = {
  params: { codeList: "some: mixed Code states; error: section save rejects" },
  bridge: ({ params, state, origin }) => {
    let groups: ConversationGroups = { groups: [], members: {} };
    let serial = 0;
    if (params.get("codeList") === "some") {
      const rows: Conversation[] = Array.from({ length: 6 }, (_, i) => ({
        id: `code-list-${i}`,
        title: `Preview session ${i}`,
        mode: "code",
        pinned: false,
        archived: false,
        providerId: "fixture",
        model: "Opus 5.5",
        createdAt: origin - i * 1000,
        updatedAt: origin - i * 1000,
        cwd: `/preview/project-${i % 2}`,
        turns: [],
      }));
      state.conversations = state.conversations
        .filter((c) => c.mode !== "code" || c.pinned || c.archived)
        .concat(rows);
      const patches: Partial<Conversation>[] = [
        {
          title: "Running workspace",
          environment: { kind: "local" },
          turns: [
            {
              id: "code-list-running",
              prompt: "Synthetic preview",
              attachments: [],
              status: "inProgress",
              items: [],
              createdAt: origin,
            },
          ],
        },
        {
          title: "Review cloud work",
          sessionState: "ready_for_review",
          cloudEnvironmentId: "preview-cloud",
          environment: { kind: "space", spaceId: "preview-cloud" },
          branch: "feature/parity",
        },
        {
          title: "Offline computer",
          linkedToComputer: true,
          linkedComputerId: "preview-computer",
          linkedComputerName: "Preview computer",
          linkedComputerOnline: false,
        },
        {
          title: "SSH workspace",
          environment: { kind: "ssh", hostId: "preview-host" },
          branch: "main",
        },
        { title: "Blocked workspace", sessionState: "blocked" },
        { title: "Completed workspace", sessionState: "done" },
      ];
      rows.forEach((c, i) => Object.assign(c, patches[i]));
    }
    const snapshot = () => structuredClone(groups);
    return {
      listConversationGroups: async () => snapshot(),
      createConversationGroup: async (name, conversationId) => {
        if (params.get("codeList") === "error")
          throw new Error("Synthetic section save failed");
        name = name.replace(/\s+/g, " ").trim();
        if (!name || name.length > 60) throw new Error("Enter a group name");
        if (
          groups.groups.some((g) => g.name.toLowerCase() === name.toLowerCase())
        )
          throw new Error("A group with that name already exists");
        const id = `preview-section-${++serial}`;
        groups.groups.push({ id, name });
        if (conversationId) groups.members[conversationId] = id;
        return snapshot();
      },
      moveConversationToGroup: async (id, groupId) => {
        if (groupId && !groups.groups.some((g) => g.id === groupId))
          throw new Error("Group no longer exists");
        if (groupId) groups.members[id] = groupId;
        else delete groups.members[id];
        return snapshot();
      },
      renameConversationGroup: async (id, name) => {
        const group = groups.groups.find((g) => g.id === id);
        if (!group) throw new Error("Group no longer exists");
        group.name = name;
        return snapshot();
      },
      deleteConversationGroup: async (id) => {
        groups.groups = groups.groups.filter((g) => g.id !== id);
        for (const [conversationId, groupId] of Object.entries(groups.members))
          if (groupId === id) delete groups.members[conversationId];
        return snapshot();
      },
    };
  },
};
