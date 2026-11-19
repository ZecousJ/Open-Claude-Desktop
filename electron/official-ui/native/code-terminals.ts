/** Translate official shell PTYs to Claudex's account-scoped terminal controller. */
import { StringDecoder } from "node:string_decoder";
import type { NativeHost } from "./host";
import type { TerminalSessionInfo } from "../../../shared/types";
import { localShells } from "../../terminal/terminal-sessions";
import { sessionAccountScope } from "./session-account-scope";

export function registerCodeTerminals(host: NativeHost) {
  const { ctx } = host;
  type Terminal = {
    conversation: string;
    terminal: string;
    key: string;
    window?: typeof host.window;
    onWindowClosed?: () => void;
    decoder: StringDecoder;
    tab: { cwd: string; title: string; openedBy: "user" | "claude" };
  };
  const terminals = new Map<string, Terminal>();
  const starting = new Map<string, Promise<any>>();
  const stopping = new Map<string, Promise<void>>();
  let epoch = 0;
  const retireTerminal = (target: string, terminal: Terminal) => {
    if (terminals.get(target) !== terminal) return false;
    terminals.delete(target);
    if (terminal.onWindowClosed)
      terminal.window?.off("closed", terminal.onWindowClosed);
    return true;
  };
  const resetTerminals = () => {
    epoch++;
    for (const [target, terminal] of terminals) retireTerminal(target, terminal);
  };
  const scope = sessionAccountScope(ctx, () => {
    resetTerminals();
    starting.clear();
    stopping.clear();
  });
  const landing = (key: string) => /^landing(?:$|::[A-Za-z0-9_-]+$)/.test(key);
  const slot = (key: string) =>
    landing(key) ? `${host.caller?.id ?? host.window?.id ?? 0}:${key}` : key;
  const call = (name: string, ...args: unknown[]) =>
    scope.guard(() => ctx.localCall!(name, ...args));
  const on = (name: string, fn: (...args: any[]) => unknown) =>
    host.on(`LocalSessions.${name}`, (...args) =>
      scope.run(() => {
        if (name !== "startShellPty") return fn(...args);
        if (typeof args[0] !== "string" || args[0].length > 512)
          return Promise.resolve({ ok: false, error: "Invalid terminal key." });
        const target = slot(args[0]);
        if (stopping.has(target))
          return Promise.resolve({
            ok: false,
            error: "The terminal is closing. Try again.",
          });
        const prior = starting.get(target);
        if (prior) return prior;
        const pending = Promise.resolve(fn(...args));
        starting.set(target, pending);
        return pending.finally(() => {
          if (starting.get(target) === pending) starting.delete(target);
        });
      }),
    );
  const dimensions = (cols: unknown, rows: unknown) =>
    typeof cols === "number" && typeof rows === "number";
  const known = (key: string) => {
    scope.sync();
    const entry = terminals.get(slot(key));
    if (!entry) throw Error("This terminal is no longer connected.");
    return entry;
  };
  on("getTerminalShells", () =>
    localShells(process.platform).map(({ id, name }) => ({ id, name })),
  );
  on(
    "startShellPty",
    async (
      key: string,
      cols: number,
      rows: number,
      reason?: string,
      cwd?: string,
      _linkAware?: boolean,
      options?: { shell?: string },
    ) => {
      if (!dimensions(cols, rows))
        return { ok: false, error: "Invalid terminal dimensions." };
      if (
        options?.shell &&
        !localShells(process.platform).some((s) => s.id === options.shell)
      )
        return { ok: false, error: "That terminal shell is unavailable." };
      const target = slot(key),
        window = host.caller ?? host.window,
        startedEpoch = epoch;
      if (landing(key)) {
        const existing = terminals.get(target);
        if (existing) {
          const list = (await call(
            "terminalList",
            existing.conversation,
          )) as TerminalSessionInfo[];
          const current = list.find((t) => t.id === existing.terminal);
          if (current) {
            existing.decoder = new StringDecoder("utf8");
            const buffered = existing.decoder.write(
              Buffer.from(current.outputBase64, "base64"),
            );
            await call(
              "terminalResize",
              existing.conversation,
              existing.terminal,
              rows,
              cols,
            );
            if (terminals.get(target) !== existing)
              return { ok: false, error: "The terminal connection was closed." };
            return {
              ok: true,
              shell: current.shell,
              buffered,
              ...current.size,
            };
          }
          retireTerminal(target, existing);
        }
        const pending = (async () => {
          const result = (await call(
            "officialDraftTerminalStart",
            cwd,
            options?.shell,
            { rows, cols },
          )) as { ownerId: string; terminal: TerminalSessionInfo };
          if (epoch !== startedEpoch)
            return { ok: false, error: "The terminal service was reset." };
          if (window?.isDestroyed()) {
            await call("terminalClose", result.ownerId, result.terminal.id);
            return { ok: false, error: "The terminal window closed." };
          }
          const entry: Terminal = {
            conversation: result.ownerId,
            terminal: result.terminal.id,
            key,
            window,
            decoder: new StringDecoder("utf8"),
            tab: { cwd: result.terminal.cwd, title: result.terminal.title, openedBy: "user" as const },
          };
          terminals.set(target, entry);
          if (window) {
            entry.onWindowClosed = () => {
              scope.sync();
              if (retireTerminal(target, entry))
                void call("terminalClose", entry.conversation, entry.terminal).catch(() => {});
            };
            window.once("closed", entry.onWindowClosed);
          }
          const buffered = entry.decoder.write(
            Buffer.from(result.terminal.outputBase64, "base64"),
          );
          try {
            await call("terminalResize", result.ownerId, result.terminal.id, rows, cols);
          } catch (error) {
            if (retireTerminal(target, entry))
              await call("terminalClose", entry.conversation, entry.terminal).catch(() => {});
            throw error;
          }
          if (terminals.get(target) !== entry)
            return { ok: false, error: "The terminal connection was closed." };
          return {
            ok: true,
            shell: result.terminal.shell,
            fresh: true,
            buffered,
            ...result.terminal.size,
          };
        })();
        return pending;
      }
      const match =
        typeof key === "string" &&
        /^local_([0-9a-f-]{36})(?:$|[^0-9a-f-])/i.exec(key);
      const c =
        match &&
        (await scope.guard(() => ctx.localLoadConversation!(match[1])));
      const environment = c ? (c.environment?.kind ?? "local") : undefined;
      if (
        !c ||
        c.cloudHosted ||
        c.cloudEnvironmentId ||
        c.mode !== "code" ||
        (c.sessionAuthors?.ownerAccountUuid &&
          c.sessionAuthors.ownerAccountUuid !== ctx.account()?.id) ||
        (environment !== "local" && environment !== "ssh") ||
        (cwd && cwd !== c.cwd)
      )
        return {
          ok: false,
          error: "Open a saved Code session before starting its terminal.",
        };
      const existing = terminals.get(key);
      const terminal = existing
        ? ((await call("terminalList", c.id)) as TerminalSessionInfo[]).find(
            (t) => t.id === existing.terminal,
          )
        : ((await call(
            "terminalStart",
            c.id,
            environment === "local" ? options?.shell : undefined,
            { size: { rows, cols }, discardOnExit: true },
          )) as TerminalSessionInfo);
      if (!terminal || epoch !== startedEpoch)
        return { ok: false, error: "The terminal connection was closed." };
      const entry = {
        conversation: c.id,
        terminal: terminal.id,
        key,
        decoder: new StringDecoder("utf8"),
        tab: {
          cwd: terminal.cwd,
          title: existing?.tab.title ?? terminal.title,
          openedBy: reason === "mcp" ? "claude" as const : "user" as const,
        },
      };
      terminals.set(key, entry);
      const buffered = entry.decoder.write(
        Buffer.from(terminal.outputBase64, "base64"),
      );
      await call("terminalResize", c.id, terminal.id, rows, cols);
      if (terminals.get(key) !== entry)
        return { ok: false, error: "The terminal connection was closed." };
      return {
        ok: true,
        shell:
          terminal.shell ??
          (environment === "local"
            ? localShells(process.platform)[0]?.id
            : undefined),
        fresh: !existing,
        buffered,
        ...terminal.size,
      };
    },
  );
  on("writeShellPty", (key: string, data: string) => {
    const t = known(key);
    if (typeof data !== "string" || data.length > 60_000)
      throw Error("Invalid terminal input.");
    return call(
      "terminalWrite",
      t.conversation,
      t.terminal,
      Buffer.from(data).toString("base64"),
    );
  });
  on("resizeShellPty", (key: string, cols: number, rows: number) => {
    const t = terminals.get(slot(key));
    if (!t) return;
    if (!dimensions(cols, rows)) throw Error("Invalid terminal dimensions.");
    return call("terminalResize", t.conversation, t.terminal, rows, cols);
  });
  on("stopShellPty", (key: string) => {
    const target = slot(key);
    const prior = stopping.get(target);
    if (prior) return prior;
    const pending = (async () => {
      const startingNow = starting.get(target);
      if (startingNow) {
        try {
          await startingNow;
        } catch {
          /* A failed resize can still leave a live mapped PTY to close. */
        }
      }
      scope.sync();
      const t = terminals.get(target);
      if (!t) return;
      await call("terminalClose", t.conversation, t.terminal);
      retireTerminal(target, t);
    })();
    stopping.set(target, pending);
    return pending.finally(() => {
      if (stopping.get(target) === pending) stopping.delete(target);
    });
  });
  on("whenShellPtyReads", (key: string) => terminals.has(slot(key)));
  on("setShellPtyTitle", (key: string, title: unknown) => {
    scope.sync();
    const entry = terminals.get(slot(key));
    if (entry && typeof title === "string") entry.tab.title = title;
  });
  on("getBusyShellPtyKeys", async (sessionId?: string, tabsOnly?: boolean) => {
    const caller = host.caller ?? host.window;
    const visible = [...terminals.values()].filter(
      (t) => (!t.window || t.window === caller) &&
        (sessionId === undefined || sessionId === "local_" + t.conversation ||
          t.key === sessionId || t.key.startsWith(sessionId + "::")),
    );
    const busy = new Set<string>();
    if (!tabsOnly)
      for (const conversation of new Set(visible.map((t) => t.conversation)))
        for (const id of (await call("terminalBusy", conversation)) as string[])
          busy.add(id);
    return {
      live: visible.map((t) => t.key),
      busy: visible.filter((t) => busy.has(t.terminal)).map((t) => t.key),
      unknown: [],
      probed: !tabsOnly,
      tabs: visible.map(({ key, tab }) => ({
        ...tab,
        ptyKey: key,
        tabId: key.split("::")[1] ?? "0",
      })),
    };
  });
  return ctx.onEvent((event) =>
    scope.run(() => {
      scope.sync();
      if (event.type === "terminal-reset") {
        resetTerminals();
        return;
      }
      if (event.type !== "terminal-output" && event.type !== "terminal-exit")
        return;
      for (const [key, t] of terminals) {
        if (event.id !== t.terminal || event.conversationId !== t.conversation)
          continue;
        if (event.type === "terminal-exit") {
          retireTerminal(key, t);
          const tail = t.decoder.end();
          if (tail) {
            const data = {
              type: "shell_pty_data",
              sessionId: t.key,
              data: tail,
            };
            if (t.window)
              host.emitTo(t.window, "LocalSessions", "onEvent", data);
            else host.emit("LocalSessions", "onEvent", data);
          }
        }
        const message =
          event.type === "terminal-output"
            ? {
                type: "shell_pty_data",
                sessionId: t.key,
                data: t.decoder.write(Buffer.from(event.deltaBase64, "base64")),
              }
            : {
                type: "shell_pty_close",
                sessionId: t.key,
                code: event.exitCode,
                error: event.error,
              };
        if (t.window)
          host.emitTo(t.window, "LocalSessions", "onEvent", message);
        else host.emit("LocalSessions", "onEvent", message);
        if (event.type === "terminal-exit" && !stopping.has(key))
          void call("terminalClose", t.conversation, t.terminal).catch(() => {});
      }
    }),
  );
}
