import Fuse from "fuse.js";
import type { CustomizeSkillProvenance } from "../../../shared/customize-search";
import { currentLocale } from "../../i18n";
import type { CustomizeSkill } from "../../../shared/collections-api";
import type { HostCapabilities } from "../../../shared/host";

/** 1016 Ll/Fl: two letters/digits, 200 code points. */
export function searchableLength(query: string) {
  return Array.from(query).filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
}
export const minimumCatalogQuery = 2;
export const searchDelay = 250;
export function catalogQuery(query: string) {
  const trimmed = query.trim();
  return searchableLength(trimmed) < minimumCatalogQuery
    ? ""
    : Array.from(trimmed).slice(0, 200).join("");
}

/** 1016 b, used by ccea1f474 Jl for local names. */
export function normalizeSearchText(text: string) {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\s\-_]+/g, " ")
    .trim();
}

/**
 * What Customize offers on this host (shared/host.ts). On the desktop all
 * of it; the web app has no folders, no local Code and no MCP
 * configuration file, so it lists the service's skills and connectors,
 * creates and turns skills on and off, and leaves out the rest.
 */
export interface CustomizeOffers {
  /** Add → Upload skill: a folder chosen on this computer. */
  upload: boolean;
  /** Show in folder, on a skill's menu and in its details. */
  reveal: boolean;
  /** Add → Create with Claudex: a local Code chat saves the skill. */
  createWithCode: boolean;
  /** Connectors → Add, and Open Developer settings: the local config. */
  addConnectors: boolean;
  /** The type of a connector that is not a web address. */
  programLabel: "Local" | "Service";
}

export function customizeOffers(can: HostCapabilities): CustomizeOffers {
  return {
    // The Upload page reads the files itself and sends their bytes: the web
    // runner unpacks them into the user's own skills folder.
    upload: true,
    reveal: can.localFolders,
    createWithCode: can.localCode,
    addConnectors: can.localMcp || can.customConnectors,
    programLabel: can.localMcp ? "Local" : "Service",
  };
}

/** Filter menu "Created by"; Built in = bundled with the agent. */
export type SkillOrigin = "all" | "you" | "organization" | "builtin";
export type SkillSort = "edited" | "name";

export const originOf = (
  skill: Pick<CustomizeSkill, "scope" | "own">,
): Exclude<SkillOrigin, "all"> =>
  skill.own || skill.scope === "user"
    ? "you"
    : skill.scope === "admin"
      ? "organization"
      : "builtin";

type SourcedSkill = CustomizeSkill & { provenance?: CustomizeSkillProvenance };
const sourceOf = (skill: CustomizeSkill) => {
  const source = (skill as SourcedSkill).provenance?.source;
  return source &&
    [
      "you",
      "organization",
      "project",
      "shared",
      "publisher",
      "marketplace",
    ].includes(source)
    ? source
    : undefined;
};

/**
 * Yours groups only sources the runtime reports. Official 1016 Pt supplies
 * Created by you / organization / project. Explicit host provenance selects
 * shared/publisher/marketplace sections; a system scope alone does not
 * establish a publisher.
 */
export const sections: {
  id: string;
  title: string;
  /** Rows say who they come from ("from Claudex · …"). */
  from?: string;
  test: (s: CustomizeSkill) => boolean;
}[] = [
  // The live order: In this project, Created by you, From your organization,
  // Shared with you, From … & Partners, marketplaces.
  {
    id: "project",
    title: "In this project",
    test: (s) =>
      sourceOf(s)
        ? sourceOf(s) === "project"
        : originOf(s) === "builtin" && s.scope === "repo",
  },
  {
    id: "you",
    title: "Created by you",
    test: (s) => (sourceOf(s) ? sourceOf(s) === "you" : originOf(s) === "you"),
  },
  {
    id: "organization",
    title: "From your organization",
    test: (s) =>
      sourceOf(s)
        ? sourceOf(s) === "organization"
        : originOf(s) === "organization",
  },
  {
    id: "shared",
    title: "Shared with you",
    test: (s) => sourceOf(s) === "shared",
  },
  {
    // The skills Claudex ships are its "Anthropic & Partners" section.
    id: "publisher",
    title: "From Claudex & Partners",
    from: "Claudex",
    test: (s) =>
      sourceOf(s) === "publisher" ||
      (!sourceOf(s) && originOf(s) === "builtin" && s.scope !== "repo"),
  },
  {
    id: "marketplace",
    title: "From marketplaces you added",
    test: (s) => sourceOf(s) === "marketplace",
  },
];

const matches = (text: string, query: string) => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
};

/**
 * Official name-only Fuse matching, .25 threshold, independent word
 * intersection, with source order retained.
 */
export function matchingNames<T>(
  items: readonly T[],
  query: string,
  name: (item: T) => string,
): T[] {
  const words = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  const index = items.map((item) => ({
    item,
    name: normalizeSearchText(name(item)),
    description: [],
  }));
  const fuse = new Fuse(index, {
    isCaseSensitive: false,
    ignoreLocation: true,
    threshold: 0.25,
    keys: [
      { name: "name", weight: 0.7 },
      { name: "description", weight: 0.3 },
    ],
  });
  const hits = words.map(
    (word) => new Set(fuse.search(word).map((hit) => hit.item.item)),
  );
  return items.filter((item) => hits.every((set) => set.has(item)));
}

/** Yours after search, the Created by filter and sort. */
export function visibleSkills(
  skills: CustomizeSkill[],
  query: string,
  origin: SkillOrigin,
  sort: SkillSort,
): CustomizeSkill[] {
  const byName = (a: CustomizeSkill, b: CustomizeSkill) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return matchingNames(skills, query, (skill) => skill.name)
    .filter((skill) => {
      if (origin === "all") return true;
      // Installed location/ownership is not publisher provenance. Match the
      // same explicit source used by Yours sections before legacy fallback.
      const source = sourceOf(skill);
      return source ? source === origin : originOf(skill) === origin;
    })
    .sort((a, b) =>
      sort === "name"
        ? byName(a, b)
        : (b.editedAt ?? 0) - (a.editedAt ?? 0) || byName(a, b),
    );
}

export function searchable<T extends { name: string; description: string }>(
  items: T[],
  query: string,
): T[] {
  return items.filter((item) =>
    matches(`${item.name} ${item.description}`, query),
  );
}

/** "Sep 16", or "Sep 16, 2025" outside the current year. */
export function editedLabel(timestamp: number, now = Date.now()) {
  const date = new Date(timestamp);
  return date.toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}

/**
 * The folder name a skill's name is saved under: lowercase letters, numbers and
 * hyphens, starting with a letter, at most 64 characters.
 */
export function skillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "";
  return (/^[a-z]/.test(slug) ? slug : `skill-${slug}`)
    .slice(0, 64)
    .replace(/-+$/, "");
}
