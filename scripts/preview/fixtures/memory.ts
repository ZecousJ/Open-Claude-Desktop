/**
 * Memory (R3) for the preview. Nothing leaves the page: the memory text is made
 * up and the Learn more link points at example.com.
 *
 * `memory=unsupported` (the default) is a service without memory: the page says
 * so and shows no switches. `off`: memory is available and both switches are
 * off. `generated`: both on, a summary the service wrote plus two "remember
 * this" edits. `edited`: the person's own text, no edits. `empty`: Generate on,
 * nothing written yet. `updating`: `generated` while a summary runs. `offline`:
 * `generated` read from the cache, switches read-only. `policy`: the
 * administrator turned memory off. Only Generate is forbidden. `server`: the
 * service has no key to store memory. `conflict`: like `generated`, but saving
 * reports another device's change. `learnmore=on` adds an administrator Learn
 * more link for memory.
 *
 * Dialogs open through the page: click View and manage memory, Import or Reset.
 * Import is refused as the main process refuses it today.
 */
import {
  unavailableMemory,
  type MemoryDocView,
  type MemoryPrefs,
  type MemoryScopeRef,
  type MemoryStatus,
} from "../../../shared/memory-api";
import type { FixtureDomain } from "./index";
import { fixturePolicy, type FixturePolicy } from "./policy";

const hour = 60 * 60 * 1000;
const unavailable = async (): Promise<never> => {
  throw new Error("Memory isn't available on this server yet.");
};

const generatedText = [
  "Works as a product designer at a small studio building a desktop app for AI chat. Prefers concise answers with the reasoning first and code second.",
  "",
  "Is learning Rust in the evenings and asks for comparisons with TypeScript. Writes documentation in English and Chinese.",
  "",
  "Current projects: a settings page redesign and a fidelity test suite that compares screenshots with reference captures.",
].join("\n");
const editedText =
  "I'm a product designer. Keep answers short and show the reasoning before any code. I write in English and Chinese.";

const modes = [
  "unsupported",
  "off",
  "generated",
  "edited",
  "empty",
  "updating",
  "offline",
  "policy",
  "policy-generate",
  "server",
  "conflict",
];

export const memoryFixture: FixtureDomain = {
  params: {
    memory:
      "unsupported (default) | off | generated | edited | empty | updating | offline | policy | policy-generate | server | conflict",
    learnmore: "on: the administrator's links include one for memory",
  },
  bridge: ({ params, origin, emit }) => {
    const mode = params.get("memory") ?? "unsupported";
    if (!modes.includes(mode) || mode === "unsupported")
      return {
        memoryStatus: async () => structuredClone(unavailableMemory),
        memoryDoc: async () => null,
        setMemoryPrefs: unavailable,
        saveMemoryDoc: unavailable,
        removeMemoryEdit: unavailable,
        updateMemoryEdits: unavailable,
        previewMemoryImport: unavailable,
        resetMemory: unavailable,
        memoryReflection: async () => ({ state: "off" as const }),
      };
    const doc = (content: string, source: MemoryDocView["source"]) => ({
      content,
      updatedAt: origin - 3 * hour,
      ...(source === "generated" ? { generatedAt: origin - 3 * hour } : {}),
      source,
      revision: 4,
      edits: [] as MemoryDocView["edits"],
    });
    const on = { searchChats: true, generate: true };
    const allowed: MemoryPrefs =
      mode === "policy"
        ? { searchChats: false, generate: false }
        : mode === "policy-generate"
          ? { searchChats: true, generate: false }
          : { ...on };
    const reason: MemoryStatus["reason"] =
      mode === "policy"
        ? "policy"
        : mode === "server"
          ? "server"
          : mode === "offline"
            ? "offline"
            : undefined;
    let global: MemoryDocView | undefined =
      mode === "edited"
        ? doc(editedText, "edited")
        : ["generated", "updating", "offline", "conflict"].includes(mode)
          ? {
              ...doc(generatedText, "generated"),
              edits: [
                {
                  id: "e-1",
                  text: "Call me Sam.",
                  createdAt: origin - 26 * hour,
                },
                {
                  id: "e-2",
                  text: "Use metric units.",
                  createdAt: origin - 50 * hour,
                },
              ],
            }
          : undefined;
    const projects = new Map<string, MemoryDocView>();
    if (global)
      projects.set("p-site", {
        ...doc(
          "The marketing site uses Astro and deploys from the main branch. Keep copy under 80 characters per line.",
          "generated",
        ),
      });
    let prefs: MemoryPrefs =
      mode === "off"
        ? { searchChats: false, generate: false }
        : mode === "policy-generate"
          ? { searchChats: true, generate: false }
          : mode === "server"
            ? { searchChats: false, generate: false }
            : { ...on };
    const status = (): MemoryStatus => ({
      available: !reason,
      ...(reason ? { reason } : {}),
      allowed: { ...allowed },
      prefs: { ...prefs },
      ...(global ? { global: structuredClone(global) } : {}),
      synthesizing: mode === "updating",
    });
    const refuse = () => {
      if (reason === "offline")
        throw new Error(
          "You're offline. Changes will be available when you reconnect.",
        );
      if (reason) throw new Error("Memory is turned off by your administrator.");
    };
    const changed = () => emit({ type: "memory-changed" });
    // Replaces the policy domain's answer, so it keeps that domain's preset.
    const learnMore: ReturnType<FixtureDomain["bridge"]> =
      params.get("learnmore") === "on"
        ? {
            clientPolicy: async () => {
              const policy = fixturePolicy(
                (params.get("policy") ?? undefined) as
                  FixturePolicy | undefined,
              );
              policy.links = {
                ...policy.links,
                learnMore: [
                  ...policy.links.learnMore,
                  {
                    label: "About memory",
                    url: "https://example.com/memory",
                  },
                ],
              };
              return policy;
            },
          }
        : {};
    const find = (scope: MemoryScopeRef) =>
      scope.kind === "global" ? global : projects.get(scope.projectId);
    return {
      ...learnMore,
      memoryStatus: async () => status(),
      // Reflect: written from the global memory (a fixed sample here).
      memoryReflection: async () =>
        !prefs.generate
          ? { state: "off" as const }
          : !global?.content.trim()
            ? { state: "empty" as const }
            : {
                state: "ready" as const,
                text: "Lately you've been **building Claudex**: aligning its interface with the original and making its features real.\n\n- You work in short loops: capture, compare, fix.\n- You care about exact spacing and motion.\n\nA suggestion: keep a running list of what is left, so each session starts from it.",
                generatedAt: origin - 2 * hour,
              },
      setMemoryPrefs: async (change) => {
        refuse();
        for (const key of ["searchChats", "generate"] as const)
          if (change[key] && !allowed[key])
            throw new Error("Turned off by your administrator.");
        prefs = { ...prefs, ...change };
        changed();
        return status();
      },
      memoryDoc: async (scope) => structuredClone(find(scope) ?? null),
      saveMemoryDoc: async (scope, content, revision) => {
        refuse();
        if (mode === "conflict")
          throw new Error(
            "Memory changed on another device. Reload it and try again.",
          );
        const before = find(scope);
        if (before && before.revision !== revision)
          throw new Error(
            "Memory changed on another device. Reload it and try again.",
          );
        const saved: MemoryDocView = {
          content,
          updatedAt: Date.now(),
          source: "edited",
          revision: (before?.revision ?? 0) + 1,
          edits: before?.edits ?? [],
        };
        if (scope.kind === "global") global = saved;
        else projects.set(scope.projectId, saved);
        changed();
        return structuredClone(saved);
      },
      removeMemoryEdit: async (id) => {
        refuse();
        if (global)
          global = {
            ...global,
            edits: global.edits.filter((edit) => edit.id !== id),
          };
        changed();
        return status();
      },
      // Manage memory: adds an edit, removes some (the service's limits).
      updateMemoryEdits: async (scope, change) => {
        if (change.add !== undefined) refuse();
        const before = find(scope);
        const kept = (before?.edits ?? []).filter(
          (edit) => !change.remove?.includes(edit.id),
        );
        const add = change.add?.replace(/\s+/g, " ").trim();
        const edits = add
          ? [
              ...kept,
              { id: `e-${Date.now()}`, text: add, createdAt: Date.now() },
            ]
          : kept;
        const next: MemoryDocView | undefined =
          before || edits.length
            ? {
                ...(before ?? doc("", "edited")),
                edits,
                limits: { edits: 50, editChars: 500 },
              }
            : undefined;
        if (scope.kind === "global") global = next;
        else if (next) projects.set(scope.projectId, next);
        else projects.delete(scope.projectId);
        changed();
        const removed = (before?.edits ?? [])
          .filter((edit) => change.remove?.includes(edit.id))
          .map((edit) => edit.text);
        return {
          ...structuredClone(next ?? doc("", "edited")),
          outcome: add
            ? removed.length
              ? { kind: "added_removed", removed }
              : { kind: "added" }
            : removed.length
              ? { kind: "removed", removed }
              : { kind: "noop" },
        };
      },
      // As electron/ipc/memory.ts today: the service cannot merge yet.
      previewMemoryImport: async () => {
        refuse();
        throw new Error("Importing memory isn't available yet.");
      },
      resetMemory: async (scope) => {
        refuse();
        if (!scope) {
          global = undefined;
          projects.clear();
        } else if (scope.kind === "global") global = undefined;
        else projects.delete(scope.projectId);
        changed();
        return status();
      },
    };
  },
};
