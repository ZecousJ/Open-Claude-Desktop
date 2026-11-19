import fs from "node:fs";
import path from "node:path";
import { codeSessionLifecyclePending } from "../../electron/conversations/code-lifecycle-guard";
import type { Engine } from "../../electron/engine/engine";
import type { CodexRPC } from "../../electron/engine/rpc";
import {
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { TerminalSessions } from "../../electron/terminal/terminal-sessions";
import {
  officialCodeTerminalCommand,
  officialCodeTerminalInputMaxBytes,
  officialCodeTerminalMaxBytes,
  type OfficialCodeTerminalCommand,
} from "../../shared/official-code-terminal";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import type { AppEvent, Conversation } from "../../shared/types";
import { isWebTabId } from "../../shared/web-protocol";
import { inCodeWorkspace } from "./code-workspace";
import type { CallFrame, Dispatcher } from "./dispatcher";
import type { WebAppContext } from "./web-app-context";

type TerminalConnection = {
  engine: Engine;
  sessions: TerminalSessions;
  processId: string;
};

type Terminal = {
  id: string;
  key: string;
  tabId: string;
  conversation: Conversation;
  activationCurrent: () => boolean;
  current: () => boolean;
  connection?: TerminalConnection;
};

const active = new WeakMap<WebAppContext, OfficialCodeTerminals>();
const maxTerminals = 12;

function json(status: number, body: object): OfficialUiReadResponse {
  return {
    status,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(body)),
  };
}

const fail = (status: number, error: string) => json(status, { error });
const unavailable = () =>
  fail(409, "The Cloud Code terminal is no longer available.");

function ownedSession(conversation: Conversation, owner: string) {
  return (
    isOwnedCloudCodeSession(conversation, owner) &&
    conversation.environment?.kind === "space" &&
    !conversation.linkedToComputer &&
    !conversation.chatDeviceBinding &&
    (!conversation.sessionAuthors ||
      conversation.sessionAuthors.viewerAccountUuid === owner)
  );
}

function workingDirectory(ctx: WebAppContext, spaceId: string, cwd: string) {
  try {
    const workspace = path.join(ctx.spaceRoot(spaceId), "workspace");
    if (!path.isAbsolute(cwd) || !inCodeWorkspace(workspace, cwd)) return false;
    const realRoot = fs.realpathSync(ctx.store.root);
    return (
      fs.realpathSync(cwd) ===
        path.join(realRoot, path.relative(ctx.store.root, cwd)) &&
      fs.statSync(cwd).isDirectory()
    );
  } catch {
    return false;
  }
}

class OfficialCodeTerminals {
  private readonly tabs = new Map<string, Terminal>();
  private readonly managers = new Map<CodexRPC, TerminalSessions>();

  constructor(private readonly ctx: WebAppContext) {}

  private resetUnused(manager: TerminalSessions) {
    if (
      [...this.tabs.values()].some(
        (tab) => tab.connection?.sessions === manager,
      )
    )
      return;
    if (this.managers.get(manager.rpc) === manager) {
      this.managers.delete(manager.rpc);
      manager.reset();
    }
  }

  hasSession(conversationId: string) {
    return [...this.tabs.values()].some(tab => tab.conversation.id === conversationId);
  }

  private publish(rpc: CodexRPC, event: AppEvent) {
    if (event.type !== "terminal-output" && event.type !== "terminal-exit")
      return;
    const tab = [...this.tabs.values()].find(
      ({ connection }) =>
        connection?.sessions.rpc === rpc && connection.processId === event.id,
    );
    if (!tab?.connection) return;
    if (event.type === "terminal-output") {
      if (tab.current()) this.ctx.push({ ...event, id: tab.id });
      else void this.close(tab, false);
      return;
    }
    this.tabs.delete(tab.id);
    this.resetUnused(tab.connection.sessions);
    if (tab.activationCurrent())
      this.ctx.push({
        type: "terminal-exit",
        id: tab.id,
        conversationId: tab.conversation.id,
        ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        ...(event.error
          ? { error: "The Cloud Code terminal connection ended." }
          : {}),
      });
  }

  async close(tab: Terminal, notify: boolean) {
    this.tabs.delete(tab.id);
    const connection = tab.connection;
    if (!connection) return;
    const { sessions, processId } = connection;
    const conversationId = tab.conversation.id;
    if (notify && tab.activationCurrent())
      this.ctx.push({ type: "terminal-exit", id: tab.id, conversationId });
    try {
      await sessions.close(conversationId, processId);
    } finally {
      this.resetUnused(sessions);
    }
  }

  async closeMatching(conversationId?: string) {
    await Promise.allSettled(
      [...this.tabs.values()]
        .filter(
          (tab) =>
            conversationId === undefined ||
            tab.conversation.id === conversationId,
        )
        .map((tab) => this.close(tab, conversationId !== undefined)),
    );
  }

  async closeTab(tabId: string) {
    await Promise.allSettled(
      [...this.tabs.values()]
        .filter((tab) => tab.tabId === tabId)
        .map((tab) => this.close(tab, false)),
    );
  }

  async closeUnavailable() {
    await Promise.allSettled(
      [...this.tabs.values()]
        .filter((tab) => !tab.current())
        .map((tab) => this.close(tab, true)),
    );
  }

  async run(
    dispatcher: Dispatcher,
    frame: CallFrame,
    command: OfficialCodeTerminalCommand,
    key: string,
    owner: string,
    tabId: string,
    activationCurrent: () => boolean,
  ): Promise<OfficialUiReadResponse> {
    const { terminalId } = command;
    const tab = this.tabs.get(terminalId);
    if (tab && (tab.tabId !== tabId || tab.key !== key))
      return fail(404, "Cloud Code terminal not found.");
    if (command.type === "close") {
      if (tab) await this.close(tab, true);
      return json(200, {});
    }
    if (command.type !== "open") {
      const connection = tab?.connection;
      if (
        !tab ||
        !connection ||
        !tab.current() ||
        codeSessionLifecyclePending(tab.conversation) ||
        connection.engine.rpc !== connection.sessions.rpc
      )
        return unavailable();
      const { sessions, processId } = connection;
      const conversationId = tab.conversation.id;
      try {
        if (command.type === "resize")
          await sessions.resize(
            conversationId,
            processId,
            command.rows,
            command.cols,
          );
        else {
          const bytes = Buffer.from(command.data, "utf8");
          if (bytes.length > officialCodeTerminalInputMaxBytes)
            return fail(413, "Terminal input is too large.");
          await sessions.write(
            conversationId,
            processId,
            bytes.toString("base64"),
          );
        }
        return activationCurrent() ? json(200, {}) : unavailable();
      } catch {
        return unavailable();
      }
    }
    if (tab)
      return tab.connection && tab.current()
        ? json(200, { terminalId })
        : unavailable();
    if (this.tabs.size >= maxTerminals)
      return fail(409, "Close a Cloud Code terminal before opening another.");
    const store = this.ctx.store;
    const matches = store.conversations.filter(
      (row) =>
        ownedSession(row, owner) && cloudCodeSessionKey(row, owner) === key,
    );
    const [conversation] = matches;
    if (
      matches.length !== 1 ||
      conversation.environment?.kind !== "space" ||
      !conversation.cwd
    )
      return fail(404, "Cloud Code session not found.");
    const {
      cwd,
      createdAt,
      environment: { spaceId },
    } = conversation;
    const current = () =>
      activationCurrent() &&
      this.ctx.store === store &&
      this.ctx.activeAccount?.id === owner &&
      store.conversations.includes(conversation) &&
      conversation.createdAt === createdAt &&
      !conversation.archived &&
      conversation.worktree?.state !== "deleted" &&
      ownedSession(conversation, owner) &&
      conversation.environment?.kind === "space" &&
      conversation.environment.spaceId === spaceId &&
      conversation.cwd === cwd;
    if (codeSessionLifecyclePending(conversation) || !current())
      return unavailable();
    if (!workingDirectory(this.ctx, spaceId, cwd))
      return fail(404, "The Cloud Code workspace is no longer available.");
    const entry: Terminal = {
      id: terminalId,
      key,
      tabId,
      conversation,
      activationCurrent,
      current,
    };
    this.tabs.set(terminalId, entry);
    const opening = () =>
      current() &&
      !codeSessionLifecyclePending(conversation) &&
      this.tabs.get(terminalId) === entry &&
      !dispatcher.isCallCancelled(frame.id);
    let releaseEngine: (() => void) | undefined;
    try {
      if (!this.ctx.engineRunning()) releaseEngine = await dispatcher.engineSlot(this.ctx);
      if (!opening()) return unavailable();
      const engine = this.ctx.engineFor(conversation.id);
      if (
        engine.environment?.kind !== "space" ||
        engine.environment.spaceId !== spaceId
      )
        return unavailable();
      if (!engine.rpc || engine.state.state !== "ready") {
        const { providers, activeProviderId } = this.ctx.store.settings;
        const provider =
          providers.find(({ id }) => id === conversation.providerId) ??
          providers.find(({ id }) => id === activeProviderId);
        if (!provider) return fail(409, "No model connection is available.");
        await engine.ensure(provider, { current: opening });
      }
      const rpc = engine.rpc;
      if (!opening() || !rpc || engine.state.state !== "ready")
        return unavailable();
      if (!workingDirectory(this.ctx, spaceId, cwd))
        return fail(404, "The Cloud Code workspace is no longer available.");
      let sessions = this.managers.get(rpc);
      if (!sessions) {
        sessions = new TerminalSessions(
          rpc,
          (event) => this.publish(rpc, event),
          "linux",
        );
        this.managers.set(rpc, sessions);
      }
      const process = sessions.start(
        conversation.id,
        cwd,
        false,
        {
          command: ["/bin/sh", "-i"],
          title: "Terminal",
          env: { TERM: "xterm-256color" },
        },
        {
          size: { rows: command.rows, cols: command.cols },
          discardOnExit: true,
        },
      );
      entry.connection = { engine, sessions, processId: process.id };
      return json(200, { terminalId });
    } catch {
      return unavailable();
    } finally {
      releaseEngine?.();
      if (this.tabs.get(terminalId) === entry && !entry.connection)
        this.tabs.delete(terminalId);
    }
  }
}

export async function closeOfficialCodeTerminals(
  ctx: WebAppContext,
  conversationId?: string,
) {
  await active.get(ctx)?.closeMatching(conversationId);
}

export function hasOfficialCodeTerminal(ctx: WebAppContext, conversationId: string) {
  return active.get(ctx)?.hasSession(conversationId) === true;
}

export function closeOfficialCodeTerminalsForTab(
  ctx: WebAppContext,
  tabId: string,
) {
  return active.get(ctx)?.closeTab(tabId);
}

export function reconcileOfficialCodeTerminals(ctx: WebAppContext) {
  return active.get(ctx)?.closeUnavailable();
}

export function runOfficialCodeTerminal(
  dispatcher: Dispatcher,
  frame: CallFrame,
  ctx: WebAppContext,
  key: string,
  request: Record<string, unknown>,
  activationCurrent: () => boolean,
) {
  const owner = ctx.activeAccount?.id;
  if (!owner || !activationCurrent())
    return fail(409, "A current authenticated capability lease is required.");
  const tabId = frame.user.tabId;
  if (!isWebTabId(tabId))
    return fail(400, "A browser tab is required for Cloud Code terminals.");
  if (
    typeof request.codeOrganizationId !== "string" ||
    request.codeOrganizationId.toLowerCase() !== organizationUuid(owner)
  )
    return fail(404, "Organization not found.");
  if (!ctx.runtime.sandboxDriver)
    return fail(501, "Cloud Code terminals require a sandboxed Runner.");

  const { body, contentType } = request;
  if (
    !(body instanceof Uint8Array) ||
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  )
    return fail(400, "Invalid Cloud Code terminal command.");
  if (body.byteLength > officialCodeTerminalMaxBytes)
    return fail(413, "Terminal command is too large.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return fail(400, "Invalid Cloud Code terminal command.");
  }
  const command = officialCodeTerminalCommand.safeParse(value);
  if (!command.success)
    return fail(400, "Invalid Cloud Code terminal command.");

  let terminals = active.get(ctx);
  if (!terminals) {
    terminals = new OfficialCodeTerminals(ctx);
    active.set(ctx, terminals);
  }
  return terminals.run(
    dispatcher,
    frame,
    command.data,
    key,
    owner,
    tabId,
    activationCurrent,
  );
}
