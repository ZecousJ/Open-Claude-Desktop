import type { StarterIntegration } from "../../shared/starter-integrations";
import type { WorkType } from "../../shared/settings-extras";
import { starterWorkCategories } from "./starter-work-categories";
import { starterCategories } from "./starter-catalog";

export { starterCategories };
export type StarterIcon =
  | "binoculars"
  | "pencil"
  | "graduationCap"
  | "code"
  | "palette"
  | "chartLine"
  | "coffee"
  | "briefcase"
  | "lightbulb"
  | "drive"
  | "calendar"
  | "gmail";
export type StarterTime = "morning" | "afternoon" | "evening";

export interface StarterPrompt {
  id: string;
  label: string;
  requiredIntegrations?: StarterIntegration[];
  timeOfDay?: StarterTime;
}

export interface StarterCategory {
  id: string;
  title: string;
  icon: StarterIcon;
  prompts: StarterPrompt[];
  validAccountTiers?: string[];
  isHidden?: boolean;
}

// The three templates a starter idea is sent in; its label goes in
// lowercased.
export const starterPromptTemplates = {
  connector:
    "Hey Claudex, could you {prompt}? Use the connectors that help, and start once you have what you need.\n\nWhere it helps, make something we can look at together, such as a chart, a checklist or a small interactive page.",
  research:
    "Hey Claudex, could you help me {prompt}? Start researching straight away with any tools that help, and tell me if you need more context.\n\nWhere it helps, make something we can look at together, such as a chart, a checklist or a small interactive page.",
  default:
    "Hi Claudex! Could you {prompt}? If something important is missing, ask me one or two questions first, and tell me if a file or more context would help. Use any tools you have, such as web search or connected files, when they help.\n\nWhere it helps, make something we can look at together, such as a chart, a checklist or a small interactive page. Thanks!",
};

export function starterPromptTemplate(category: StarterCategory) {
  if (["calendar", "gmail", "drive"].includes(category.id))
    return starterPromptTemplates.connector;
  return category.id === "research_analysis"
    ? starterPromptTemplates.research
    : starterPromptTemplates.default;
}

export function starterTimeOfDay(hour: number): StarterTime {
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

// Seeded Fisher–Yates.
function starterRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 1831565813) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

export interface StarterOptions {
  integrations?: readonly StarterIntegration[];
  hour?: number;
  seed?: number;
  workType?: WorkType;
}

export function availableStarterCategories(
  categories: readonly StarterCategory[] = starterCategories,
  options: StarterOptions = {},
): StarterCategory[] {
  const random = starterRandom(options.seed ?? 0);
  const integrations = options.integrations ?? [];
  const time = starterTimeOfDay(options.hour ?? new Date().getHours());
  return shuffle(categories, random).flatMap((category) => {
    const prompts = shuffle(
      category.prompts,
      starterRandom(random() * 4294967296),
    );
    // Claudex accounts are consumer accounts, not Anthropic Raven seats.
    if (
      category.validAccountTiers &&
      !category.validAccountTiers.some((tier) =>
        ["free", "claude_pro", "claude_max"].includes(tier),
      )
    )
      return [];
    const available = prompts.filter(
      (prompt) =>
        (!prompt.timeOfDay || prompt.timeOfDay === time) &&
        (!prompt.requiredIntegrations?.length ||
          prompt.requiredIntegrations.every((integration) =>
            integrations.includes(integration),
          )),
    );
    return available.length ? [{ ...category, prompts: available }] : [];
  });
}

export const homeChipOrder = [
  "writing_content_creation",
  "learning_studying",
  "coding_development",
] as const;
const homeChipFill = ["career_chat", "life_stuff", "claudes_choice"] as const;

// Keep the selector's five-chip arithmetic, deduplicating Research rather than
// truncating the result.
export function homeStarterCategories(
  categories: readonly StarterCategory[] = starterCategories,
  options: StarterOptions = {},
): StarterCategory[] {
  const available = availableStarterCategories(categories, options);
  const byId = (id: string) => available.find((category) => category.id === id);
  const present = (
    category: StarterCategory | undefined,
  ): category is StarterCategory => !!category;
  const lead = (
    starterWorkCategories[options.workType ?? "Other"] ?? homeChipOrder
  )
    .map(byId)
    .filter(present);
  const fill = homeChipFill
    .map(byId)
    .filter(present)
    .slice(0, 5 - Math.min(lead.length, 3));
  const research = byId("research_analysis");
  const connectors = ["calendar", "gmail", "drive"].map(byId).filter(present);
  return [
    ...new Set([
      ...(research ? [research] : []),
      ...lead,
      ...fill,
      ...connectors,
    ]),
  ];
}

// The home removes Research before rendering; its connector renderer orders
// Drive, Calendar, Gmail and reserves their slots before fill chips.
export function visibleStarterCategories(
  categories: readonly StarterCategory[],
) {
  const visible = categories.filter(
    (category) => category.id !== "research_analysis",
  );
  const connectors = ["drive", "calendar", "gmail"].flatMap((id) =>
    visible.filter((category) => category.id === id),
  );
  const ordinary = visible.filter(
    (category) => !connectors.includes(category) && !category.isHidden,
  );
  if (ordinary.length + connectors.length <= 5)
    return [...ordinary, ...connectors];
  const fill = ordinary.filter((category) =>
    homeChipFill.some((id) => id === category.id),
  );
  const lead = ordinary.filter((category) => !fill.includes(category));
  const space = 5 - connectors.length;
  return space <= 0
    ? connectors.slice(0, 5)
    : [
        ...lead.slice(0, space),
        ...fill.slice(0, Math.max(0, space - lead.length)),
        ...connectors,
      ];
}

export function moveChipFocus(
  key: string,
  index: number,
  count: number,
): number | undefined {
  if (!count) return undefined;
  if (key === "ArrowRight" || key === "ArrowDown")
    return index === -1 || index === count - 1 ? 0 : index + 1;
  if (key === "ArrowLeft" || key === "ArrowUp")
    return index <= 0 ? count - 1 : index - 1;
  return undefined;
}

export function moveStarterFocus(
  key: string,
  index: number,
  count: number,
): number | undefined {
  if (key === "ArrowDown") return Math.min(index + 1, count - 1);
  if (key === "ArrowUp") return Math.max(index - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}
