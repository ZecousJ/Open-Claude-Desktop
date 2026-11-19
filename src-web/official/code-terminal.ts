import {
  officialCodeTerminalInputMaxBytes,
  officialCodeTerminalPath,
  officialCodeTerminalRequest,
  type OfficialCodeTerminalCommand,
} from "../../shared/official-code-terminal";
import type { AppEvent } from "../../shared/types";
import type { OfficialFrameBindings } from "./frame-lifecycle";

type ShellEvent =
  | { type: "shell_pty_data"; sessionId: string; data: string }
  | {
      type: "shell_pty_close";
      sessionId: string;
      code?: number;
      reason?: string;
    };
type ShellExit = Extract<ShellEvent, { type: "shell_pty_close" }>;
type StartResult =
  { ok: true; buffered?: string } | { ok: false; error: string };
type ShellState =
  | { kind: "opening"; buffered: string; exit?: ShellExit }
  | { kind: "open" }
  | { kind: "closed"; error: string };
type Shell = {
  id: string;
  key: string;
  path: string;
  organization: string;
  state: ShellState;
  emit(event: ShellEvent): void;
  forget(): void;
  decoder: TextDecoder;
  sequence: number;
  tail: Promise<void>;
  capabilityLease?: string;
};
export type OfficialCodeShellAdapter = {
  startShellPty(key: string, cols: number, rows: number): Promise<StartResult>;
  stopShellPty(key: string): void;
  resizeShellPty(key: string, cols: number, rows: number): void;
  writeShellPty(key: string, data: string): void;
  onShellPtyEvent(listener: (event: ShellEvent) => void): () => void;
};
export type OfficialCodeTerminalHost = {
  forSession(
    sessionId: string,
    organization: string,
  ): OfficialCodeShellAdapter | undefined;
  stop(sessionId: string, key: string): void;
};
type InputCommand = Extract<
  OfficialCodeTerminalCommand,
  { type: "write" | "resize" }
>;

const encoder = new TextEncoder();
const connectionLost = "Terminal connection closed.";
const closed = "Terminal closed.";

function* inputChunks(data: string) {
  const bytes = encoder.encode(data);
  if (bytes.length <= officialCodeTerminalInputMaxBytes) {
    if (data) yield data;
    return;
  }
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + officialCodeTerminalInputMaxBytes, bytes.length);
    while ((bytes[end] & 0xc0) === 0x80) end--;
    yield decoder.decode(bytes.subarray(start, end));
    start = end;
  }
}

export function createOfficialCodeTerminals(input: {
  current(): boolean;
  activationCurrent(): boolean;
  connected(): boolean;
  lease(): Promise<string>;
  action: OfficialFrameBindings["action"];
  releaseOnExit: (
    request: Parameters<OfficialFrameBindings["action"]>[0],
  ) => void;
  events: OfficialFrameBindings["events"];
}): OfficialCodeTerminalHost & { dispose(): void } {
  const shells = new Map<string, Shell>();
  const sessions = new Map<string, OfficialCodeShellAdapter>();
  let disposed = false;

  function request(
    shell: Shell,
    command: OfficialCodeTerminalCommand,
    capabilityLease: string,
  ): Parameters<OfficialFrameBindings["action"]>[0] {
    return {
      method: "POST",
      path: shell.path,
      contentType: "application/json",
      body: encoder.encode(JSON.stringify(command)),
      codeOrganizationId: shell.organization,
      capabilityLease,
    };
  }

  async function send(
    shell: Shell,
    command: OfficialCodeTerminalCommand,
    capabilityLease: string,
  ) {
    const answer = await input.action(request(shell, command, capabilityLease));
    if (answer.status !== 200)
      throw Error("The Cloud Code terminal request failed.");
    if (command.type === "open") {
      const value: unknown = JSON.parse(new TextDecoder().decode(answer.body));
      if (
        !value ||
        typeof value !== "object" ||
        !("terminalId" in value) ||
        value.terminalId !== shell.id
      )
        throw Error("The Cloud Code terminal could not be opened.");
    }
  }

  function finish(shell: Shell, release: boolean, event?: ShellExit) {
    const state = shell.state;
    if (state.kind === "closed") return;
    shell.state = { kind: "closed", error: event?.reason ?? closed };
    shells.delete(shell.id);
    const lease = shell.capabilityLease;
    if (release && lease) {
      const close = {
        type: "close",
        terminalId: shell.id,
      } satisfies OfficialCodeTerminalCommand;
      if (disposed && state.kind === "open") {
        if (input.activationCurrent())
          input.releaseOnExit(request(shell, close, lease));
      } else {
        shell.tail = shell.tail
          .then(async () => {
            if (input.activationCurrent()) await send(shell, close, lease);
          })
          .catch(() => {});
      }
    }
    void shell.tail.then(shell.forget);
    if (state.kind === "open" && event) shell.emit(event);
  }

  function stop(shell: Shell, notify: boolean, reason?: string) {
    finish(
      shell,
      true,
      notify
        ? { type: "shell_pty_close", sessionId: shell.key, reason }
        : undefined,
    );
  }

  function receive(event: AppEvent) {
    if (event.type === "stream-connection" && !event.connected) {
      for (const shell of shells.values()) stop(shell, true, connectionLost);
      return;
    }
    if (event.type !== "terminal-output" && event.type !== "terminal-exit")
      return;
    const shell = shells.get(event.id);
    if (!shell || !input.current() || shell.state.kind === "closed") return;
    const state = shell.state;
    if (state.kind === "opening" && state.exit) return;
    let data: string;
    if (event.type === "terminal-output") {
      if (event.sequence <= shell.sequence) return;
      if (event.sequence !== shell.sequence + 1) {
        stop(shell, true, connectionLost);
        return;
      }
      shell.sequence = event.sequence;
      try {
        data = shell.decoder.decode(
          Uint8Array.from(atob(event.deltaBase64), (byte) =>
            byte.charCodeAt(0),
          ),
          { stream: true },
        );
      } catch {
        stop(shell, true, connectionLost);
        return;
      }
    } else {
      data = shell.decoder.decode();
    }
    if (data) {
      if (state.kind === "opening") state.buffered += data;
      else shell.emit({ type: "shell_pty_data", sessionId: shell.key, data });
    }
    if (event.type === "terminal-exit") {
      const exit: ShellExit = {
        type: "shell_pty_close",
        sessionId: shell.key,
        code: event.exitCode,
        reason: event.error,
      };
      if (state.kind === "opening") state.exit = exit;
      else finish(shell, false, exit);
    }
  }

  const unsubscribe = input.events(receive);
  function forSession(
    sessionId: string,
    organization: string,
  ): OfficialCodeShellAdapter | undefined {
    const session = officialCodeTerminalRequest(
      "POST",
      officialCodeTerminalPath(sessionId),
    );
    if (disposed || !input.current() || !session) return;
    const found = sessions.get(session.key);
    if (found) return found;
    const path = officialCodeTerminalPath(`session_${session.key}`);
    const slots = new Map<string, Shell>();
    const listeners = new Set<(event: ShellEvent) => void>();
    const enqueue = (shell: Shell, command: InputCommand) => {
      shell.tail = shell.tail
        .then(async () => {
          if (
            shell.state.kind === "open" &&
            shell.capabilityLease &&
            input.current()
          )
            await send(shell, command, shell.capabilityLease);
        })
        .catch(() => {
          stop(shell, true, connectionLost);
        });
    };
    const adapter: OfficialCodeShellAdapter = Object.freeze({
      async startShellPty(
        key: string,
        cols: number,
        rows: number,
      ): Promise<StartResult> {
        if (!input.current() || disposed || !input.connected())
          return {
            ok: false,
            error: "The Cloud Code terminal is unavailable.",
          };
        const previous = slots.get(key);
        if (previous) stop(previous, false);
        const shell: Shell = {
          id: crypto.randomUUID(),
          key,
          path,
          organization,
          state: { kind: "opening", buffered: "" },
          emit: (event) => {
            if (slots.get(key) !== shell || disposed || !input.current())
              return;
            for (const listener of listeners) listener(event);
          },
          forget: () => {
            if (slots.get(key) === shell) slots.delete(key);
          },
          decoder: new TextDecoder("utf-8", { ignoreBOM: true }),
          sequence: 0,
          tail: Promise.resolve(),
        };
        slots.set(key, shell);
        shells.set(shell.id, shell);
        const opening = (async () => {
          await previous?.tail;
          if (shell.state.kind !== "opening") return;
          const lease = await input.lease();
          if (
            shell.state.kind !== "opening" ||
            !input.current() ||
            !input.connected()
          )
            return;
          shell.capabilityLease = lease;
          await send(
            shell,
            { type: "open", terminalId: shell.id, cols, rows },
            lease,
          );
        })();
        shell.tail = opening.catch(() => {});
        try {
          await opening;
        } catch {
          const state = shell.state;
          stop(shell, false);
          return {
            ok: false,
            error:
              (state.kind === "opening" && state.exit?.reason) ||
              "The Cloud Code terminal could not be opened.",
          };
        }
        const state = shell.state;
        if (state.kind === "closed") return { ok: false, error: state.error };
        if (!shell.capabilityLease || !input.current()) {
          stop(shell, false);
          return {
            ok: false,
            error: "The Cloud Code terminal is unavailable.",
          };
        }
        if (state.kind === "opening" && state.exit) {
          const exit = state.exit;
          // Let the original terminal mount the buffered text before it handles the exit.
          setTimeout(() => {
            if (shell.state.kind !== "opening") return;
            shell.state = { kind: "open" };
            finish(shell, false, exit);
          }, 0);
        } else shell.state = { kind: "open" };
        return {
          ok: true,
          ...(state.kind === "opening" && state.buffered
            ? { buffered: state.buffered }
            : {}),
        };
      },
      stopShellPty(key: string) {
        const shell = slots.get(key);
        if (shell) stop(shell, true);
      },
      resizeShellPty(key: string, cols: number, rows: number) {
        const shell = slots.get(key);
        if (shell?.state.kind === "open")
          enqueue(shell, { type: "resize", terminalId: shell.id, cols, rows });
      },
      writeShellPty(key: string, data: string) {
        const shell = slots.get(key);
        if (shell?.state.kind !== "open") return;
        for (const chunk of inputChunks(data))
          enqueue(shell, { type: "write", terminalId: shell.id, data: chunk });
      },
      onShellPtyEvent(listener: (event: ShellEvent) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    sessions.set(session.key, adapter);
    return adapter;
  }

  return {
    forSession,
    stop(sessionId: string, key: string) {
      const session = officialCodeTerminalRequest(
        "POST",
        officialCodeTerminalPath(sessionId),
      );
      if (session) sessions.get(session.key)?.stopShellPty(key);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const shell of shells.values()) stop(shell, false);
      sessions.clear();
    },
  };
}
