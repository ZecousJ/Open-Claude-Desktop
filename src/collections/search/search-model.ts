import type {
  Approval,
  Conversation,
  Mode,
  Project,
} from "../../../shared/types";
import type { Routine } from "../../../shared/routines";
import type { Artifact } from "../../ui/ArtifactTypes";
import type { HistorySearchHit } from "../../../shared/history-search";
import type { AppIconName } from "../../ui/app-icon";
import type { SearchEntrypoint } from "./palette-events";
import { actionGroups, rankPaletteActions } from "./action-ranking";
import { sessionPullRequest } from "../../../shared/pull-request";

/** Contextual input copy. */
export function palettePlaceholder(
  entrypoint: SearchEntrypoint,
  mode: Mode,
  filtered: boolean,
) {
  if (entrypoint === "search")
    return mode === "code"
      ? "Search sessions and projects"
      : "Search chats and projects";
  if (entrypoint === "actions") return "Search actions";
  // The bundle still words an unfiltered palette "Search or start a chat" / "…
  // a session" in one context, but the live web shows "Search" in Chat and Code
  // alike.
  void filtered;
  return "Search";
}

/** Screen-reader result announcement. */
export function paletteResultMessage(count: number) {
  return count === 0
    ? "No results found"
    : count === 1
      ? "1 result available"
      : "{count} results available";
}

/** The filter tabs of ⌘K search, in order. */
export const searchFilters = [
  ["all", "All"],
  ["artifacts", "Artifacts"],
  ["chats", "Sessions"],
  ["sessions", "Code"],
  ["projects", "Projects"],
  // Live claude.ai names the tab after the Scheduled page.
  ["routines", "Scheduled"],
] as const;
export type SearchFilter = (typeof searchFilters)[number][0] | "tasks";

export type SearchRow =
  | {
      key: string;
      kind: "conversation";
      title: string;
      conversation: Conversation;
      /**
       * With a query: the words it matched, and a quoted excerpt when a word
       * was found only in a prompt or reply.
       */
      terms?: string[];
      snippet?: string;
    }
  | { key: string; kind: "project"; title: string; project: Project }
  | { key: string; kind: "routine"; title: string; routine: Routine }
  | { key: string; kind: "artifact"; title: string; artifact: Artifact }
  | PaletteAction;

/** Commands carry their execution, availability is resolved before projection. */
export type PaletteAction = {
  key: string;
  kind: "action";
  title: string;
  mode?: Mode;
  icon?: AppIconName;
  group: "navigation" | "chat" | "project" | "settings" | "general";
  searchHints?: readonly string[];
  /** Keep the empty default palette compact; Actions still lists every command. */
  showInDefault?: boolean;
  command:
    | { type: "new-session"; mode: Mode }
    | { type: "execute"; execute: () => void | Promise<void> };
  keepsPaletteOpen?: boolean;
};

export interface SearchSection {
  title: string;
  rows: SearchRow[];
}

/**
 * The fitted empty palette's actual row budget, not a fixed result count. Trim
 * Actions first, then Recents, retaining at least one row in either group.
 */
export function paletteSectionsHeight(sections: SearchSection[]) {
  return sections.reduce(
    (height, section) =>
      height + (section.title ? 37 : 0) + section.rows.length * 36,
    20 + Math.max(0, sections.length - 1) * 4,
  );
}

export function fitPaletteSections(sections: SearchSection[], height = 440) {
  let fitted = sections;
  for (const title of ["Actions", "Recents"]) {
    const overflow = paletteSectionsHeight(fitted) - height;
    const section = fitted.find((section) => section.title === title);
    if (!section || overflow <= 0 || section.rows.length <= 1) continue;
    const count = Math.max(1, section.rows.length - Math.ceil(overflow / 36));
    fitted = fitted.map((item) =>
      item === section ? { ...item, rows: item.rows.slice(0, count) } : item,
    );
  }
  return fitted;
}

/**
 * Search ranks only timestamps the stored record actually supplies. A project
 * has no updatedAt in Claudex's API, so its known createdAt is the available
 * fallback; do not pretend it was just touched. Scheduled tasks rank by their
 * last run or creation.
 */
export function searchRowTime(row: SearchRow): number | undefined {
  const time =
    row.kind === "conversation"
      ? row.conversation.updatedAt
      : row.kind === "project"
        ? row.project.createdAt
        : row.kind === "artifact"
          ? row.artifact.updatedAt
          : row.kind === "routine"
            ? (row.routine.lastRunAt ?? row.routine.createdAt)
            : undefined;
  return typeof time === "number" && Number.isFinite(time) ? time : undefined;
}

/**
 * O16: full query prefix, complete lexical title/PR/snippet, then other
 * matches. Actions lead organic rows in the same tier without changing Fuse
 * order.
 */
export function paletteQueryRank(row: SearchRow, query: string): 0 | 1 | 2 {
  const needle = query.trim().toLowerCase();
  const title = row.title.trim().toLowerCase();
  if (title.startsWith(needle)) return 0;
  const terms = needle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!terms.length) terms.push(needle);
  const pr =
    row.kind === "conversation" && row.conversation.mode === "code"
      ? sessionPullRequest(row.conversation)?.number
      : undefined;
  const number = pr === undefined ? undefined : String(pr);
  const prMentioned = number !== undefined && terms.includes(number);
  if (
    terms.every(
      (term) =>
        title.includes(term) ||
        term === number ||
        (term === "pr" && prMentioned),
    )
  )
    return 1;
  const snippet =
    row.kind === "conversation" ? row.snippet?.toLowerCase() : undefined;
  if (snippet && terms.every((term) => snippet.includes(term))) return 1;
  return 2;
}

function mergePaletteQueryRows(
  actions: PaletteAction[],
  organic: SearchRow[],
  query: string,
) {
  const ranks = new Map(
    [...actions, ...organic].map((row) => [row, paletteQueryRank(row, query)]),
  );
  return (
    [0, 1, 2]
      .flatMap((rank) => [
        ...actions.filter((row) => ranks.get(row) === rank),
        ...newestRows(organic.filter((row) => ranks.get(row) === rank)),
      ])
      // Gf's maxOrganicItems default is 7; filter suggestion rows are projected
      // separately and do not consume this budget.
      .slice(0, 7)
  );
}

const newestRows = (rows: SearchRow[]) =>
  rows.sort((a, b) => {
    // Unknown dates remain available at the tail; they are never promoted
    // with Date.now() or silently removed from a filtered result list.
    const before = searchRowTime(a),
      after = searchRowTime(b);
    return before === undefined
      ? after === undefined
        ? 0
        : 1
      : after === undefined
        ? -1
        : after - before;
  });

export interface SearchSources {
  approvals?: readonly Approval[];
  conversations: Conversation[];
  projects: Project[];
  routines: Routine[];
  artifacts: Artifact[];
}

/** New chat / New task / New session: the modes Claudex can start. */
export const newActions: Extract<SearchRow, { kind: "action" }>[] = [
  {
    key: "new-session",
    kind: "action",
    title: "New session",
    mode: "chat",
    group: "chat",
    showInDefault: true,
    searchHints: ["New chat"],
    command: { type: "new-session", mode: "chat" },
  },
];

/** Send-message entries shown in the live palette's Quick actions group. */
export const quickActions: Extract<SearchRow, { kind: "action" }>[] = [
  {
    key: "new-code-session",
    kind: "action",
    title: "New Code session",
    mode: "code",
    group: "chat",
    command: { type: "new-session", mode: "code" },
  },
];

/**
 * What Compose can send to: a new session in the current mode, and from Chat a
 * new Code session.
 */
export function composeTargets(mode: Mode) {
  return mode === "code"
    ? newActions.map((action) => ({ ...action, mode: "code" as const }))
    : [...newActions, ...quickActions];
}

const words = (query: string) =>
  query.trim().toLowerCase().split(/\s+/).filter(Boolean);
const matches = (text: string, terms: string[]) => {
  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term));
};

const conversationTexts = (c: Conversation) => [
  ...c.turns.map((t) => t.prompt),
  ...c.turns.flatMap((t) => t.items.map((i) => i.text ?? "")),
];

/** Every word in the title, a prompt or a reply. */
export function conversationMatches(c: Conversation, terms: string[]) {
  return matches([c.title, ...conversationTexts(c)].join("\n"), terms);
}

/**
 * A conversation is found by any of the words; the more words it holds the
 * higher it ranks. When the title lacks a found word, the row quotes about 32
 * characters of the prompt or reply around it.
 */
export function conversationHit(c: Conversation, terms: string[]) {
  const texts = conversationTexts(c);
  const all = [c.title, ...texts].join("\n").toLowerCase();
  const found = terms.filter((term) => all.includes(term));
  if (!found.length) return undefined;
  const title = c.title.toLowerCase();
  const missing = found.find((term) => !title.includes(term));
  let snippet: string | undefined;
  if (missing)
    for (const text of texts) {
      const at = text.toLowerCase().indexOf(missing);
      if (at < 0) continue;
      const start = Math.max(0, at - 12);
      snippet = text
        .slice(start, start + 32)
        .replace(/\s+/g, " ")
        .trim();
      break;
    }
  return { terms: found, snippet };
}

/** Splits text into plain and matched parts for bold search words. */
export function markTerms(text: string, terms: string[]) {
  const parts: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  while (at < text.length) {
    let next = -1,
      length = 0;
    for (const term of terms) {
      const found = lower.indexOf(term, at);
      if (found >= 0 && (next < 0 || found < next)) {
        next = found;
        length = term.length;
      }
    }
    if (next < 0 || !length) break;
    if (next > at) parts.push({ text: text.slice(at, next), match: false });
    parts.push({ text: text.slice(next, next + length), match: true });
    at = next + length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

/**
 * Just now under 5 minutes, Past hour under an hour, Today, Yesterday, Past
 * week, Past month, Past year; older than a year has no label at all.
 */
export function relativeBucket(time: number, now = Date.now()) {
  if (Number.isNaN(time)) return null;
  if (now - time < 300_000) return "Just now";
  if (now - time < 3_600_000) return "Past hour";
  const day = 86_400_000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (time >= today) return "Today";
  if (time >= today - day) return "Yesterday";
  if (time >= today - 7 * day) return "Past week";
  if (time >= today - 30 * day) return "Past month";
  if (time >= today - 365 * day) return "Past year";
  return null;
}

const modeFilter: Record<Mode, "chats" | "tasks" | "sessions"> = {
  chat: "chats",
  cowork: "chats",
  code: "sessions",
};
const sectionTitles: Record<Exclude<SearchFilter, "all">, string> = {
  chats: "Sessions",
  tasks: "Tasks",
  sessions: "Code",
  projects: "Projects",
  routines: "Scheduled",
  artifacts: "Artifacts",
};

/**
 * The palette's sections. Without a query, All mixes the actual source
 * types by recency and fits them with Active and Actions in the empty
 * palette. A filter shows its most recent items.
 * With a query, each kind is its own section (8 rows each under All).
 */
export function searchSections(
  sources: SearchSources,
  query: string,
  filter: SearchFilter,
  hits?: HistorySearchHit[],
  titlesOnly = false,
  mode: Mode = "chat",
  filtered = false,
  entrypoint: SearchEntrypoint = "default",
  availableActions?: readonly PaletteAction[],
): SearchSection[] {
  const terms = words(query);
  const actionsForSurface =
    availableActions ??
    newActions.map((action): PaletteAction => ({
      ...action,
      mode: mode === "code" ? "code" : "chat",
      command: { type: "new-session", mode: mode === "code" ? "code" : "chat" },
    }));
  const actions = rankPaletteActions(actionsForSurface, query);
  if (entrypoint === "actions") {
    // Actions bypasses organic type filters. Each group retains the query's
    // Fuse rank in the source group order.
    return actionGroups.flatMap(([group, title]) => {
      const rows = actions.filter((action) => action.group === group);
      return rows.length ? [{ title, rows }] : [];
    });
  }
  const recent = [...sources.conversations].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const conversationRow = (c: Conversation): SearchRow => ({
    key: `c:${c.id}`,
    kind: "conversation",
    title: c.title || "Untitled",
    conversation: c,
  });
  const lists: Record<Exclude<SearchFilter, "all">, SearchRow[]> = {
    chats: [],
    tasks: [],
    sessions: [],
    projects: sources.projects
      .filter((p) => matches(`${p.name} ${p.description}`, terms))
      .map((project) => ({
        key: `p:${project.id}`,
        kind: "project" as const,
        title: project.name,
        project,
      })),
    routines: sources.routines
      .filter((r) =>
        matches(`${r.name} ${r.description ?? ""} ${r.prompt}`, terms),
      )
      .map((routine) => ({
        key: `r:${routine.id}`,
        kind: "routine" as const,
        title: routine.name,
        routine,
      })),
    artifacts: sources.artifacts
      .filter((a) => matches(`${a.name} ${a.filename ?? ""}`, terms))
      .map((artifact) => ({
        key: `a:${artifact.libraryId ?? artifact.conversationId ?? ""}:${artifact.id}`,
        kind: "artifact" as const,
        title: artifact.name,
        artifact,
      })),
  };
  if (!terms.length)
    for (const c of recent) lists[modeFilter[c.mode]].push(conversationRow(c));
  else
    recent
      .flatMap((c) => {
        const stored = hits?.find((hit) => hit.conversationId === c.id);
        const hit = titlesOnly
          ? matches(c.title, terms)
            ? { terms, snippet: undefined }
            : undefined
          : stored
            ? { terms, snippet: stored.snippet }
            : conversationHit(c, terms);
        return hit ? [{ c, hit }] : [];
      })
      // Stable: equal counts keep the most recent first.
      .sort((a, b) => b.hit.terms.length - a.hit.terms.length)
      .forEach(({ c, hit }) =>
        lists[modeFilter[c.mode]].push({ ...conversationRow(c), ...hit }),
      );

  if (filter !== "all")
    return [{ title: sectionTitles[filter], rows: lists[filter].slice(0, 50) }];
  if (!terms.length && filtered) {
    return [
      {
        title: "",
        rows: newestRows(Object.values(lists).flat()).slice(0, 50),
      },
    ];
  }
  if (!terms.length) {
    const rows = newestRows(Object.values(lists).flat());
    // Search's dedicated entrypoint lists 25 recent rows without the default
    // palette's Active/Actions projection.
    if (entrypoint === "search")
      return rows.length ? [{ title: "", rows: rows.slice(0, 25) }] : [];
    const active = recent.filter((c) =>
      c.turns.some((turn) => turn.status === "inProgress"),
    );
    const recentRows = rows.slice(0, 9);
    // The official fit tries up to five marked leads, reducing that count only
    // if keeping one Recent and one Action still exceeds the budget. Claudex
    // currently has a real Running mark only.
    let sections: SearchSection[] = [];
    for (let count = Math.min(active.length, 5); count >= 0; count--) {
      const leads = active.slice(0, count).map(conversationRow);
      const leadIds = new Set(leads.map((row) => row.key));
      sections = fitPaletteSections(
        [
          { title: "Active", rows: leads },
          {
            title: "Recents",
            rows: recentRows.filter((row) => !leadIds.has(row.key)),
          },
          {
            title: "Actions",
            rows: actionsForSurface.filter((action) => action.showInDefault),
          },
        ].filter((section) => section.rows.length),
      );
      if (paletteSectionsHeight(sections) <= 440) break;
    }
    return sections;
  }
  if (entrypoint === "default" && !filtered && actions.length) {
    const organic = Object.values(lists).flat();
    if (organic.length)
      return [
        {
          title: "Search results",
          rows: mergePaletteQueryRows(actions, organic, query),
        },
      ];
  }
  return [
    ...(
      ["chats", "sessions", "projects", "routines", "artifacts"] as const
    ).map((kind) => ({
      title: sectionTitles[kind],
      rows: lists[kind].slice(0, 8),
    })),
    { title: "Actions", rows: actions },
  ].filter((section) => section.rows.length);
}

export type PaletteCommand =
  | { type: "move"; to: number }
  | { type: "activate" }
  | { type: "compose" }
  | { type: "filter"; to: SearchFilter }
  | { type: "filter-menu" }
  | { type: "actions" };

/**
 * What a key pressed in the search field does: ↑↓ move through the rows
 * (wrapping), Enter opens the highlighted one, Tab switches to Compose,
 * `/` in an empty field steps to the next filter and → at the end of the
 * text opens a conversation's actions. Anything else types.
 */
export function paletteKey(
  input: {
    key: string;
    shift?: boolean;
    alt?: boolean;
    query: string;
    caretAtEnd: boolean;
  },
  state: { active: number; rows: SearchRow[]; filter: SearchFilter },
): PaletteCommand | undefined {
  const count = state.rows.length;
  switch (input.key) {
    case "ArrowDown":
    case "ArrowUp": {
      if (!count) return undefined;
      const step = input.key === "ArrowDown" ? 1 : -1;
      return { type: "move", to: (state.active + step + count) % count };
    }
    case "Enter":
      if (input.alt && state.rows[state.active]?.kind === "conversation")
        return { type: "actions" };
      return count ? { type: "activate" } : undefined;
    case "Tab":
      return input.shift ? undefined : { type: "compose" };
    case "/": {
      if (input.query) return undefined;
      return { type: "filter-menu" };
    }
    case "ArrowLeft":
    case "ArrowRight":
      if (!input.query) {
        const at = searchFilters.findIndex(([value]) => value === state.filter);
        const step = input.key === "ArrowRight" ? 1 : -1;
        return {
          type: "filter",
          to: searchFilters[
            (at + step + searchFilters.length) % searchFilters.length
          ][0],
        };
      }
      return input.caretAtEnd &&
        state.rows[state.active]?.kind === "conversation"
        ? { type: "actions" }
        : undefined;
    default:
      return undefined;
  }
}
