import { createContext, useSyncExternalStore } from "react";
import type { AppEvent } from "../../shared/types";

/**
 * Run in terminal on a Code transcript's shell code block: the command runs in
 * a terminal tab of the session's own (opened in the background), its output
 * shows under the block while it runs, Cancel interrupts it, and Open in
 * terminal shows that tab. The output is what the shell printed between its
 * command marks (electron/terminal-shell-integration.ts: OSC 133 C … D).
 */

export interface CodeRun {
  sessionId?: string;
  output: string;
  running: boolean;
  error?: string;
}

/** What a Code transcript gives its code blocks. */
export interface CodeRunHost {
  conversationId: string;
  /** Windows: shell blocks of PowerShell run as "Run in PowerShell". */
  windows: boolean;
  /** Opens the terminal panel on a tab. */
  openTerminal: (sessionId: string) => void;
}
export const CodeRunContext = createContext<CodeRunHost | null>(null);

const runs = new Map<string, CodeRun>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const set = (key: string, run: CodeRun) => {
  runs.set(key, run);
  emit();
};

export const runKey = (conversationId: string, code: string) =>
  `${conversationId}\0${code}`;

export function useCodeRun(key: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => runs.get(key),
    () => undefined,
  );
}

const shellLanguages = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "console",
  "shellscript",
  "fish",
]);
const powerShellLanguages = new Set(["powershell", "ps1", "pwsh", "ps"]);

/** Whether a code block of this language runs, and how its button reads. */
export function runKind(
  language: string,
  windows: boolean,
): "terminal" | "powershell" | undefined {
  const lang = language.toLowerCase();
  if (windows && powerShellLanguages.has(lang)) return "powershell";
  if (shellLanguages.has(lang)) return "terminal";
  return undefined;
}

/** A console block's commands without their "$ " prompts. */
export function runnableCommand(code: string) {
  const lines = code.split("\n");
  const prompted = lines.filter((line) => /^\s*\$ /.test(line));
  return (
    prompted.length
      ? prompted.map((line) => line.replace(/^\s*\$ /, ""))
      : lines
  )
    .join("\n")
    .trim();
}

const ESC = "\u001b";
const BEL = "\u0007";
/** The text between the last command mark and its end mark, without escapes. */
export function commandOutput(raw: string) {
  const start = raw.lastIndexOf(`${ESC}]133;C`);
  let text = raw;
  if (start >= 0) {
    const after = raw.indexOf(BEL, start);
    text = raw.slice(after >= 0 ? after + 1 : start);
    const end = text.indexOf(`${ESC}]133;D`);
    if (end >= 0) text = text.slice(0, end);
  }
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
}

const decode = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};
const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Runs the command in a new background tab of the session. */
export async function runCommand(
  key: string,
  conversationId: string,
  command: string,
) {
  const api = window.desktop;
  set(key, { output: "", running: true });
  let raw = "";
  let started = false;
  try {
    const session = await api.terminalStart(conversationId);
    const unsubscribe = api.onEvent((event: AppEvent) => {
      if (
        !("conversationId" in event) ||
        event.conversationId !== conversationId
      )
        return;
      if (!("id" in event) || event.id !== session.id) return;
      if (event.type === "terminal-output") {
        raw += decode(event.deltaBase64);
        if (raw.includes(`${ESC}]133;C`)) started = true;
        set(key, {
          ...runs.get(key)!,
          sessionId: session.id,
          output: commandOutput(raw),
        });
      } else if (event.type === "terminal-busy") {
        if (event.busy) started = true;
        else if (started) {
          set(key, { ...runs.get(key)!, running: false });
          unsubscribe();
        }
      } else if (event.type === "terminal-exit") {
        set(key, { ...runs.get(key)!, running: false });
        unsubscribe();
      }
    });
    set(key, { ...runs.get(key)!, sessionId: session.id });
    // The shell reads its startup files first; the line waits in its input.
    await api.terminalWrite(conversationId, session.id, encode(`${command}\r`));
  } catch (error) {
    set(key, {
      output: "",
      running: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Cancel: an interrupt to the running command. */
export function cancelRun(key: string, conversationId: string) {
  const run = runs.get(key);
  if (!run?.sessionId) return;
  void window.desktop
    .terminalWrite(conversationId, run.sessionId, encode("\u0003"))
    .catch(() => {});
}

/* Open in terminal: the tab the terminal panel shows next. */
let wantedTab: { conversationId: string; sessionId: string } | null = null;
const tabListeners = new Set<() => void>();
export function requestTerminalTab(conversationId: string, sessionId: string) {
  wantedTab = { conversationId, sessionId };
  tabListeners.forEach((listener) => listener());
}
/** The tab asked for, once (taking it clears it). */
export function takeTerminalTab(conversationId: string) {
  if (wantedTab?.conversationId !== conversationId) return undefined;
  const id = wantedTab.sessionId;
  wantedTab = null;
  return id;
}
export function onTerminalTabRequest(listener: () => void) {
  tabListeners.add(listener);
  return () => {
    tabListeners.delete(listener);
  };
}
