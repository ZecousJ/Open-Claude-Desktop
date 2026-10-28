/**
 * Answers ssh's questions through the app (R9): the password for a host, the
 * passphrase of a key, whether to trust a new host key.
 *
 * Each ssh process Claudex starts gets SSH_ASKPASS pointing at a small
 * wrapper around `ssh-askpass.cjs` (askpass-helper.ts) plus a socket path
 * and a random per-attempt nonce. When ssh needs an answer it runs the
 * helper, the helper sends the question here, and the broker checks the
 * nonce, shows the question in the window (an "ssh-prompt" event) and sends
 * back what the person typed. Nothing is stored: an answer exists only
 * until it is written to the helper, and it never reaches a log, the
 * diagnostics or the host list.
 *
 * Attempts the person did not start (automatic reconnects) are not
 * interactive: a question is refused at once and the connection reports
 * "needs-auth", so the window shows a "Sign in" button instead of popping
 * dialogs up by itself.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { SshEvent, SshPrompt } from "../../shared/ssh-api";
import { ASKPASS_MAX_LINE } from "./askpass-helper";
import { shQuote } from "./remote-scripts";

/** A question left unanswered this long is cancelled. */
export const ASKPASS_TIMEOUT_MS = 120_000;
const MAX_PROMPT_TEXT = 2000;
const MAX_ANSWER = 4096;
/** How long a helper may take to send its question after connecting. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Open questions one ssh attempt may have at once. */
const MAX_OPEN_PER_SESSION = 4;

// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

type PromptShape = Pick<
  SshPrompt,
  "kind" | "fingerprint" | "confirm" | "notice"
>;

/**
 * What kind of question ssh asked, from its text and SSH_ASKPASS_PROMPT
 * ("confirm" for yes/no questions, "none" for a notice).
 */
export function classifyPrompt(text: string, mode = ""): PromptShape {
  const fingerprint =
    /\b(SHA256:[A-Za-z0-9+/]{43}=?|MD5(?::[0-9a-f]{2}){16})/.exec(text)?.[1];
  if (mode === "none") return { kind: "other", notice: true };
  if (/continue connecting/i.test(text))
    return {
      kind: "hostkey",
      confirm: true,
      ...(fingerprint ? { fingerprint } : {}),
    };
  if (mode === "confirm") return { kind: "other", confirm: true };
  if (/passphrase/i.test(text)) return { kind: "passphrase" };
  if (/password/i.test(text)) return { kind: "password" };
  return { kind: "other" };
}

/** ssh's text as the window may show it. */
export function cleanPromptText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_EXCEPT_NEWLINE, "")
    .trim()
    .slice(0, MAX_PROMPT_TEXT);
}

export interface AskpassSessionOptions {
  /** The saved host ("" while testing an unsaved one). */
  hostId: string;
  /** The person started this attempt: questions go to the window. */
  interactive: boolean;
  /** A question reached the window (interactive) or was refused (not). */
  onPrompt?: (prompt: SshPrompt) => void;
  /** A question closed; `answered` is false for cancel, timeout or refusal. */
  onPromptClosed?: (prompt: SshPrompt, answered: boolean) => void;
  /** The person cancelled a question: the attempt should stop. */
  onCancel?: () => void;
  /**
   * The host's saved password (password-store.ts): it answers the attempt's
   * first password question without asking, also when not interactive. A
   * second password question (the saved one was wrong) is asked as usual.
   */
  password?: string;
}

export interface AskpassSession {
  /** Environment for the ssh process of this attempt. */
  env: Record<string, string>;
  /** Stops answering for this attempt and cancels its open questions. */
  close(): void;
}

interface OpenPrompt {
  prompt: SshPrompt;
  socket: net.Socket;
  session: SessionState;
  timer: NodeJS.Timeout;
}

interface SessionState {
  options: AskpassSessionOptions;
  open: Set<string>;
  /** The saved password was given once. */
  passwordUsed?: boolean;
}

export interface AskpassBrokerOptions {
  /** A private folder (0700) for the socket and the wrapper. */
  dir: string;
  /** The bundled helper (dist-server/ssh-askpass.cjs). */
  helperScript: string;
  /** The program that runs it with ELECTRON_RUN_AS_NODE (the app itself). */
  execPath: string;
  emit: (event: SshEvent) => void;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

const digest = (nonce: string) =>
  createHash("sha256").update(nonce).digest("hex");

export class AskpassBroker {
  private server: net.Server | undefined;
  private starting: Promise<void> | undefined;
  private socketPath = "";
  private wrapperPath = "";
  /** sha256(nonce) → session; the nonce itself is never kept as a key. */
  private sessions = new Map<string, SessionState>();
  private prompts = new Map<string, OpenPrompt>();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: AskpassBrokerOptions) {
    this.platform = options.platform ?? process.platform;
  }

  /** Opens the socket and writes the wrapper (once). */
  start(): Promise<void> {
    this.starting ??= this.open().catch((error) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private async open() {
    const { dir } = this.options;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tag = randomBytes(8).toString("hex");
    this.socketPath =
      this.platform === "win32"
        ? `\\\\.\\pipe\\claudex-askpass-${tag}`
        : path.join(dir, `a-${tag}.sock`);
    this.wrapperPath = this.writeWrapper();
    const server = net.createServer((socket) => this.accept(socket));
    server.maxConnections = 32;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (this.platform !== "win32") fs.chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  /** The wrapper ssh runs: the app as Node running the helper. */
  private writeWrapper() {
    const { dir, execPath, helperScript } = this.options;
    if (this.platform === "win32") {
      if (/["%\r\n]/.test(execPath + helperScript))
        throw new Error(
          "Claudex is installed in a folder SSH prompts can't use.",
        );
      const file = path.join(dir, "askpass.cmd");
      fs.writeFileSync(
        file,
        [
          "@echo off",
          "set ELECTRON_RUN_AS_NODE=1",
          `"${execPath}" "${helperScript}" %*`,
          "",
        ].join("\r\n"),
      );
      return file;
    }
    const file = path.join(dir, "askpass.sh");
    fs.writeFileSync(
      file,
      [
        "#!/bin/sh",
        `ELECTRON_RUN_AS_NODE=1 exec ${shQuote(execPath)} ${shQuote(helperScript)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    fs.chmodSync(file, 0o700);
    return file;
  }

  /** A new attempt: its own nonce, so only its ssh can ask. */
  session(options: AskpassSessionOptions): AskpassSession {
    if (!this.server) throw new Error("SSH prompts aren't ready yet.");
    const nonce = randomBytes(32).toString("hex");
    const key = digest(nonce);
    const state: SessionState = { options, open: new Set() };
    this.sessions.set(key, state);
    return {
      env: {
        SSH_ASKPASS: this.wrapperPath,
        // OpenSSH 8.4+: ask through the helper even with a terminal.
        SSH_ASKPASS_REQUIRE: "force",
        // Older OpenSSH only uses SSH_ASKPASS when DISPLAY is set.
        DISPLAY: process.env.DISPLAY || "claudex:0",
        CLAUDEX_ASKPASS_SOCKET: this.socketPath,
        CLAUDEX_ASKPASS_NONCE: nonce,
      },
      close: () => {
        this.sessions.delete(key);
        for (const id of [...state.open]) this.finish(id, null);
      },
    };
  }

  private accept(socket: net.Socket) {
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    // The helper sends its question at once; a connection that says
    // nothing is dropped instead of holding one of the few slots.
    const idle = setTimeout(() => {
      if (!handled) socket.destroy();
    }, REQUEST_TIMEOUT_MS);
    idle.unref?.();
    socket.once("close", () => clearTimeout(idle));
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > ASKPASS_MAX_LINE) return void socket.destroy();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      handled = true;
      clearTimeout(idle);
      let request: { nonce?: unknown; prompt?: unknown; mode?: unknown };
      try {
        request = JSON.parse(buffer.slice(0, end));
      } catch {
        return void socket.destroy();
      }
      buffer = "";
      this.ask(socket, request);
    });
  }

  private ask(
    socket: net.Socket,
    request: { nonce?: unknown; prompt?: unknown; mode?: unknown },
  ) {
    const refuse = () => socket.end(`${JSON.stringify({ cancel: true })}\n`);
    if (typeof request.nonce !== "string" || request.nonce.length !== 64)
      return refuse();
    const session = this.sessions.get(digest(request.nonce));
    if (!session || session.open.size >= MAX_OPEN_PER_SESSION) return refuse();
    const raw = typeof request.prompt === "string" ? request.prompt : "";
    const mode = typeof request.mode === "string" ? request.mode : "";
    const prompt: SshPrompt = {
      id: randomUUID(),
      hostId: session.options.hostId,
      text: cleanPromptText(raw),
      ...classifyPrompt(raw, mode),
    };
    if (
      prompt.kind === "password" &&
      session.options.password &&
      !session.passwordUsed
    ) {
      session.passwordUsed = true;
      socket.end(`${JSON.stringify({ answer: session.options.password })}\n`);
      return;
    }
    if (!session.options.interactive) {
      refuse();
      session.options.onPrompt?.(prompt);
      session.options.onPromptClosed?.(prompt, false);
      return;
    }
    const timer = setTimeout(
      () => this.finish(prompt.id, null),
      this.options.timeoutMs ?? ASKPASS_TIMEOUT_MS,
    );
    timer.unref?.();
    this.prompts.set(prompt.id, { prompt, socket, session, timer });
    session.open.add(prompt.id);
    // ssh ends the helper when it no longer needs the answer (a notice, or
    // the connection gave up): the question closes in the window too.
    socket.on("close", () => this.finish(prompt.id, null, false));
    session.options.onPrompt?.(prompt);
    this.options.emit({ type: "ssh-prompt", prompt });
  }

  /**
   * The person answered (text, or any string for yes) or cancelled (null).
   * Unknown or already closed questions are ignored.
   */
  answer(id: string, answer: string | null): void {
    const open = this.prompts.get(id);
    if (!open) return;
    if (answer !== null) {
      if (typeof answer !== "string" || answer.length > MAX_ANSWER)
        throw new Error("The answer is too long.");
      if (/[\r\n]/.test(answer))
        throw new Error("The answer can't contain a line break.");
    }
    if (answer === null) open.session.options.onCancel?.();
    this.finish(id, answer);
  }

  /** Open questions (the window asks again after a reload). */
  pending(): SshPrompt[] {
    return [...this.prompts.values()].map((open) => ({ ...open.prompt }));
  }

  private finish(id: string, answer: string | null, reply = true) {
    const open = this.prompts.get(id);
    if (!open) return;
    this.prompts.delete(id);
    open.session.open.delete(id);
    clearTimeout(open.timer);
    if (reply && !open.socket.destroyed) {
      const value =
        answer === null
          ? { cancel: true }
          : { answer: open.prompt.confirm ? "yes" : answer };
      open.socket.end(`${JSON.stringify(value)}\n`);
    }
    open.session.options.onPromptClosed?.(open.prompt, answer !== null);
    this.options.emit({ type: "ssh-prompt-closed", id });
  }

  close() {
    for (const id of [...this.prompts.keys()]) this.finish(id, null);
    this.sessions.clear();
    this.server?.close();
    this.server = undefined;
    this.starting = undefined;
    if (this.platform !== "win32" && this.socketPath)
      fs.rmSync(this.socketPath, { force: true });
  }
}
