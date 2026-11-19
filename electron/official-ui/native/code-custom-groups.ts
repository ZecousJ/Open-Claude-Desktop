import { z } from "zod";
import { organizationUuid } from "../api/context";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";

const customGroupsSnapshot = z.object({
  accountUuid: z.string(),
  orgUuid: z.string(),
  groups: z.array(z.object({ id: z.string(), name: z.string() })),
  assignments: z.record(z.string(), z.string()),
});

type CustomGroups = {
  names: Map<string, string>;
  assignments: Map<string, string>;
};

export function registerCodeCustomGroups(host: NativeHost) {
  const { ctx } = host;
  let current: CustomGroups | undefined;
  const scope = sessionAccountScope(ctx, () => {
    current = undefined;
  });

  host.on("LocalSessions.setCustomGroups", (value: unknown) => {
    const { accountUuid, orgUuid, groups, assignments } =
      customGroupsSnapshot.parse(value);
    const { owner } = scope.sync();
    if (
      !owner ||
      ctx.isCurrent?.() === false ||
      accountUuid !== owner ||
      orgUuid !== organizationUuid(owner)
    )
      return;
    current = {
      names: new Map(
        groups
          .slice(0, 1_000)
          .filter(({ id }) => id.length <= 100)
          .map(({ id, name }) => [id, name.slice(0, 200)]),
      ),
      assignments: new Map(
        Object.entries(assignments)
          .slice(0, 10_000)
          .filter(
            ([sessionId, groupId]) =>
              sessionId.length <= 100 && groupId.length <= 100,
          ),
      ),
    };
  });

  const snapshot = () => {
    scope.sync();
    if (ctx.isCurrent?.() !== false) return current;
  };

  return {
    getSessionCustomGroup(sessionId: string) {
      const groups = snapshot();
      if (!groups) return;
      const id = groups.assignments.get(sessionId);
      const name = id === undefined ? undefined : groups.names.get(id);
      return id !== undefined && name !== undefined ? { id, name } : null;
    },
    listCustomGroups() {
      const groups = snapshot();
      if (!groups) return;
      const counts = new Map<string, number>();
      for (const id of groups.assignments.values())
        counts.set(id, (counts.get(id) ?? 0) + 1);
      return [...groups.names].map(([id, name], order) => ({
        id,
        name,
        order,
        sessionCount: counts.get(id) ?? 0,
      }));
    },
  };
}
