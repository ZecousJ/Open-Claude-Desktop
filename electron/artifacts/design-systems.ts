import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  designGuidelinesLimit,
  designSourceCount,
  designSourceLimit,
  designSourcesTotal,
  maxDesignSystems,
  type DesignSource,
  type DesignSystem,
  type DesignSystemInput,
} from "../../shared/collections-api";
import { preference } from "../../shared/settings-extras";
import type { Settings } from "../../shared/types";
import type { Prompt } from "../memory/prompts";

export const designSystemsName = "design-systems.json";
const nameLimit = 80;
const textLimit = 4_000;
const sourceNameLimit = 200;
/** How much of the guidelines a turn is told (characters). */
const instructionLimit = 14_000;

const unreadable =
  "Your design systems couldn't be read. The file has not been overwritten.";

function text(value: unknown, limit: number, field: string) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  if (value.length > limit)
    throw new Error(`${field} can be up to ${limit} characters.`);
  return value;
}

/** The person's example files, checked and cut to what a design system keeps. */
export function designSources(value: unknown): DesignSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("The example files are invalid.");
  if (value.length > designSourceCount)
    throw new Error(`Add up to ${designSourceCount} example files.`);
  let total = 0;
  const sources = value.map((item): DesignSource => {
    const name =
      typeof item?.name === "string"
        ? item.name.replace(/\s+/g, " ").trim().slice(0, sourceNameLimit)
        : "";
    if (!name || typeof item?.text !== "string")
      throw new Error("An example file is invalid.");
    const body = item.text.slice(0, designSourceLimit);
    total += body.length;
    return { name, text: body };
  });
  if (total > designSourcesTotal)
    throw new Error("The example files are too large together.");
  return sources;
}

function validSystem(value: unknown): value is DesignSystem {
  const item = value as Partial<DesignSystem> | null;
  return (
    !!item &&
    typeof item.id === "string" &&
    !!item.id &&
    typeof item.name === "string" &&
    typeof item.blurb === "string" &&
    typeof item.notes === "string" &&
    Array.isArray(item.sources) &&
    typeof item.guidelines === "string" &&
    typeof item.createdAt === "number" &&
    typeof item.updatedAt === "number"
  );
}

/**
 * The account's design systems, in `design-systems.json` in its profile.
 * Every call reads the file again, so a handler never keeps one account's
 * systems across a sign-out; writes go through a temporary file and a rename.
 */
export class DesignSystemStore {
  private readonly filename: string;
  constructor(
    root: string,
    private now: () => number = Date.now,
  ) {
    this.filename = path.join(root, designSystemsName);
  }
  private read(): DesignSystem[] {
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(unreadable);
    }
    if (!Array.isArray(data) || !data.every(validSystem))
      throw new Error(unreadable);
    return data;
  }
  private write(list: DesignSystem[]) {
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
  }
  list(): DesignSystem[] {
    return this.read().sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): DesignSystem | undefined {
    return this.read().find((item) => item.id === id);
  }
  save(input: DesignSystemInput): DesignSystem {
    const list = this.read();
    const name = text(input.name, nameLimit, "The name")
      .replace(/\s+/g, " ")
      .trim();
    if (!name) throw new Error("Enter a name for the design system.");
    const blurb = text(input.blurb, textLimit, "The description");
    const notes = text(input.notes, textLimit, "The notes");
    const sources = designSources(input.sources);
    const guidelines = text(
      input.guidelines,
      designGuidelinesLimit,
      "The guidelines",
    );
    const at = this.now();
    const existing = input.id
      ? list.find((item) => item.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error("That design system is gone.");
    if (
      list.some(
        (item) =>
          item.id !== existing?.id &&
          item.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Error(`A design system named “${name}” already exists.`);
    if (!existing && list.length >= maxDesignSystems)
      throw new Error(`You can have up to ${maxDesignSystems} design systems.`);
    const saved: DesignSystem = existing
      ? {
          ...existing,
          name,
          blurb: input.blurb === undefined ? existing.blurb : blurb,
          notes: input.notes === undefined ? existing.notes : notes,
          sources: input.sources === undefined ? existing.sources : sources,
          guidelines:
            input.guidelines === undefined ? existing.guidelines : guidelines,
          updatedAt: at,
        }
      : {
          id: randomUUID(),
          name,
          blurb,
          notes,
          sources,
          guidelines,
          createdAt: at,
          updatedAt: at,
          ...(guidelines ? { generatedAt: at } : {}),
        };
    // Writing the guidelines by hand counts as writing them.
    if (existing && input.guidelines !== undefined && guidelines)
      saved.generatedAt = existing.generatedAt ?? at;
    this.write(
      existing
        ? list.map((i) => (i === existing ? saved : i))
        : [...list, saved],
    );
    return structuredClone(saved);
  }
  /** Stores what the model wrote. */
  setGenerated(id: string, guidelines: string): DesignSystem {
    const list = this.read();
    const existing = list.find((item) => item.id === id);
    if (!existing) throw new Error("That design system is gone.");
    const at = this.now();
    const saved: DesignSystem = {
      ...existing,
      guidelines: guidelines.slice(0, designGuidelinesLimit),
      generatedAt: at,
      updatedAt: at,
    };
    this.write(list.map((i) => (i === existing ? saved : i)));
    return structuredClone(saved);
  }
  delete(id: string) {
    const list = this.read();
    const kept = list.filter((item) => item.id !== id);
    if (kept.length !== list.length) this.write(kept);
  }
}

const generateInstructions = [
  "You write a design system that an AI assistant will follow when it makes designs for the person: web pages and apps, slides, documents, charts, icons and UI mockups.",
  "Work from the description, the notes and the example files below. Take colours, type, spacing, radii, shadows and component details from the example files where they show them, and quote the real values. Where the material says nothing, choose values that fit the description and mark them “(suggested)”. Never invent facts about the company.",
  "Write Markdown with these sections, in this order: # <name> (one paragraph on the brand and the feel of its designs); ## Voice and tone; ## Colour (a table of tokens with hex values and where each is used, for light and dark if both exist); ## Typography (families with fallbacks, a type scale with sizes, weights and line heights); ## Spacing and layout (the spacing scale, grid, page widths, radii, borders, shadows); ## Components (buttons, inputs, cards, navigation, tables, dialogs: each with its states and the values that define it); ## Imagery and icons; ## Do and don't (six short bullets each); ## CSS variables (one fenced ```css block with every token as a custom property on :root).",
  "Be concrete and compact: values, not adjectives. At most 1,400 words. Reply with the Markdown only, in the language the description uses.",
].join("\n\n");

/** The request that has the model write a design system's guidelines. */
export function designSystemPrompt(system: DesignSystem): Prompt {
  const parts = [
    `Name: ${system.name}`,
    system.blurb && `Description:\n${system.blurb}`,
    system.notes && `Notes:\n${system.notes}`,
    ...system.sources.map(
      (source) => `Example file ${source.name}:\n${source.text}`,
    ),
  ];
  return {
    instructions: generateInstructions,
    input: parts.filter(Boolean).join("\n\n---\n\n"),
  };
}

/**
 * What Chat and Cowork are told about the design system in use: which one,
 * and its guidelines (cut at 14,000 characters). Nothing when none is chosen
 * or the chosen one is gone or has no guidelines yet.
 */
export function designSystemInstructions(
  root: string,
  settings: Settings,
): string | undefined {
  const id = preference(settings, "designSystem");
  if (!id) return undefined;
  let system: DesignSystem | undefined;
  try {
    system = new DesignSystemStore(root).get(id);
  } catch {
    return undefined;
  }
  const guidelines = system?.guidelines.trim();
  if (!system || !guidelines) return undefined;
  const cut =
    guidelines.length > instructionLimit
      ? `${guidelines.slice(0, instructionLimit)}\n…`
      : guidelines;
  return [
    `The user's design system “${system.name}” is in use. Whenever you make something with a visual design (a web page or app, slides, a document, an SVG or chart, a UI mockup), follow it: its colours, type, spacing, radii and component styles, and its voice for any text you write. Do not mention it unless asked. Its guidelines:`,
    cut,
  ].join("\n\n");
}
