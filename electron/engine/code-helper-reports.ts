import type { Conversation, Item, Turn } from "../../shared/types";

const reportPrefix = "code-helper-report:";

export function codeHelperReportId(childId: string, turnId: string) {
  return `${reportPrefix}${childId}:${turnId}`;
}

function finalAssistant(turn: Turn) {
  return [...turn.items]
    .reverse()
    .find(
      (item) =>
        item.type === "agentMessage" &&
        (item.phase === "final_answer" || item.phase == null) &&
        typeof item.text === "string" &&
        item.text.trim(),
    )?.text;
}

function linkedChild(parent: Conversation, child: Conversation) {
  const place = child.environment?.kind ?? "local";
  return child !== parent && child.mode === "code" && child.parentSessionId === parent.id &&
    !!child.codeHelperParentTurnId && !!child.nativeSideSession && !child.incognito &&
    !child.cloudHosted && !child.cloudEnvironmentId && !child.linkedToComputer &&
    !child.chatDeviceBinding && !child.remoteControlStarted && !child.projectOrganizationId &&
    (place === "local" || place === "ssh") &&
    parent.mode === "code" && !parent.incognito && !parent.cloudHosted && !parent.cloudEnvironmentId &&
    (parent.environment?.kind ?? "local") === "local" &&
    JSON.stringify(child.sessionAuthors ?? null) === JSON.stringify(parent.sessionAuthors ?? null);
}

function textForPlace(child: Conversation, text: string) {
  return child.environment?.kind === "ssh" ? text.replaceAll("@", "＠") : text;
}

function terminalResult(child: Conversation, turn: Turn) {
  if (turn.status === "inProgress") return;
  if (turn.status === "interrupted") return "The linked Code session was interrupted.";
  if (turn.status === "failed") return "The linked Code session ended with an error.";
  const final = finalAssistant(turn);
  return final ? textForPlace(child, final) : "The linked Code session completed without a final reply.";
}

export function pendingCodeHelperReports(
  conversations: Conversation[],
  parent: Conversation,
) {
  const delivered = new Set(
    parent.turns.flatMap((turn) => turn.codeHelperReportIds ?? []),
  );
  return parent.turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      if (
        item.type !== "peerMessage" ||
        !item.id.startsWith(reportPrefix) ||
        delivered.has(item.id)
      )
        return [];
      const child = conversations.find(
        (row) =>
          row.id === item.agentThreadId &&
          row.codeHelperParentTurnId === turn.id &&
          linkedChild(parent, row),
      );
      if (!child) return [];
      const result = child.turns.find(
        (row) =>
          codeHelperReportId(child.id, row.id) === item.id,
      );
      const text = result && terminalResult(child, result);
      return text && text.slice(0, 12000) === item.text
        ? [
            {
              id: item.id,
              child,
              title: textForPlace(child, child.title).slice(0, 200),
              text: text.slice(0, 1000),
              wakeable: result?.status !== "interrupted" && !result?.userStopped,
            },
          ]
        : [];
    }),
  );
}

export function recordCodeHelperReport(
  conversations: Conversation[],
  child: Conversation,
  turn: Turn,
): Conversation | undefined {
  if (
    !child.parentSessionId ||
    !child.codeHelperParentTurnId ||
    !conversations.includes(child) ||
    turn.status === "inProgress" ||
    child.turns.filter((row) => row.id === turn.id).length !== 1 ||
    !child.turns.includes(turn)
  )
    return;
  const parents = conversations.filter(
    (row) => row.id === child.parentSessionId,
  );
  if (parents.length !== 1) return;
  const parent = parents[0];
  if (!linkedChild(parent, child)) return;
  const turns = parent.turns.filter(
    (row) => row.id === child.codeHelperParentTurnId,
  );
  if (turns.length !== 1) return;
  const target = turns[0];
  const id = codeHelperReportId(child.id, turn.id);
  if (parent.turns.some((row) => row.items.some((item) => item.id === id)))
    return;
  const final = terminalResult(child, turn);
  if (!final) return;
  const item: Item = {
    id,
    type: "peerMessage",
    text: final.slice(0, 12000),
    agentThreadId: child.id,
    origin: {
      kind: "peer",
      name: textForPlace(child, child.title).slice(0, 200),
      subagent: true,
      handback: true,
    },
  };
  target.items.push(item);
  const reports = parent.turns.flatMap((row) =>
    row.items.filter((entry) => entry.id.startsWith(reportPrefix)),
  );
  if (reports.length > 32) {
    const remove = new Set(reports.slice(0, reports.length - 32));
    for (const row of parent.turns)
      row.items = row.items.filter((entry) => !remove.has(entry));
  }
  return parent;
}
