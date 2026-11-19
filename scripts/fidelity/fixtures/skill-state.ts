import type { Snapshot } from "../../../shared/types";
import type { CustomizeSkill, SkillContents, SkillFile } from "../../../shared/collections-api";

interface SkillStore {
  get(): CustomizeSkill[];
  set(skills: CustomizeSkill[]): void;
}

/** Only the explicit Customize inventory for this individual offline bridge. */
export interface CustomizeSkillFixture {
  has(path: string): boolean;
  read(path: string): SkillContents;
  readFile(path: string, file: string): SkillFile;
  setEnabled(path: string, enabled: boolean): void;
  remove(path: string): void;
}

const inventories = new WeakMap<Snapshot, CustomizeSkillFixture>();

export function customizeSkillFixture(state: Snapshot) {
  return inventories.get(state);
}

export function registerCustomizeSkillFixture(state: Snapshot, store: SkillStore) {
  const entry = (path: string) => {
    const skill = store.get().find((item) => item.path === path);
    if (!skill) throw new Error("This skill is not in the offline fixture.");
    return skill;
  };
  const bundle = (path: string) => {
    const skill = entry(path);
    const markdown = `# ${skill.name}\n\nSynthetic offline preview for the listed skill.\n\n${skill.description}`;
    const files: Record<string, string> = {
      "SKILL.md": `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${markdown}`,
      ...(skill.own ? {
        "references/guide.md": "# Offline guide\n\nSynthetic reference file for the preview.",
        "examples/input.txt": "Synthetic sample input.\n",
      } : {}),
    };
    return { markdown, files };
  };
  inventories.set(state, {
    has: (path) => store.get().some((skill) => skill.path === path),
    read: (path) => {
      const current = bundle(path);
      return { markdown: current.markdown, files: Object.entries(current.files).map(([path, text]) => ({ path, bytes: new TextEncoder().encode(text).length })), truncated: false };
    },
    readFile: (path, file) => {
      const current = bundle(path);
      if (!Object.prototype.hasOwnProperty.call(current.files, file)) throw new Error("This file is not in the offline skill bundle.");
      return { text: current.files[file], binary: false, truncated: false };
    },
    setEnabled: (path, enabled) => {
      entry(path);
      store.set(store.get().map((skill) => skill.path === path ? { ...skill, enabled } : skill));
    },
    remove: (path) => {
      if (!entry(path).own) throw new Error("This skill cannot be removed from the offline fixture.");
      store.set(store.get().filter((skill) => skill.path !== path));
    },
  });
}
