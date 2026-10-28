import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DevServerState } from "../../shared/browser";
import {
  formatCommandLine,
  launchPort,
  launchUrl,
  localUrlsIn,
} from "../../shared/launch-config";
import {
  LogBuffer,
  scrubEnv,
  mergePath,
  loginShellPath,
  windowsCommand,
  lower,
  errorText,
} from "./dev-server-support";
import type { DevServers } from "./dev-servers";
import type {
  DevServerStarter,
  DevServerStartOptions,
  ServerRecord,
} from "./dev-servers";

// ---- Starting and stopping ----

/**
 * Starts a configuration and waits until its port answers (or the address
 * it prints, when it has no port). Resolves with the server's state:
 * "running", or "failed" with the reason; throws when it may not start.
 */
export async function start(
  this: DevServers,
  conversationId: string,
  name: string,
  options: DevServerStartOptions = {},
): Promise<DevServerState> {
  if (this.disposed) throw new Error("Dev servers are closed.");
  const by = options.by ?? "person";
  // An address printed in the Terminal: already running, nothing to start.
  const detected = [...(this.detected.get(conversationId)?.values() ?? [])]
    .filter((item) => item.open)
    .find((item) => new URL(item.url).host === name);
  if (detected && !this.find(conversationId, name).entry)
    return {
      name,
      command: "",
      port: detected.port,
      url: detected.url,
      status: "running",
      source: "detected-output",
    };
  if (!this.deps.allowed())
    throw new Error("Your administrator doesn't allow dev servers.");
  if (by === "claude" && this.deps.unattended(conversationId))
    throw new Error("Dev servers can't be started from scheduled tasks.");
  const found = this.find(conversationId, name);
  if (!found.entry || !found.folder || !found.key) throw new Error(found.error);
  const { entry, folder, key } = found;
  let records = this.records.get(conversationId);
  if (!records) this.records.set(conversationId, (records = new Map()));
  const existing = records.get(lower(entry.name));
  if (existing?.starting) return existing.starting;
  if (existing && existing.status === "running" && existing.key === key)
    return this.state(existing);
  if (existing && existing.child && existing.status === "running")
    // launch.json changed while it ran: stop the old command first.
    await this.stop(conversationId, existing.name);
  const record: ServerRecord = {
    conversationId,
    name: entry.name,
    entry,
    key,
    status: "starting",
    logs: existing?.logs ?? new LogBuffer(),
  };
  records.set(lower(entry.name), record);
  const run = this.run(record, folder, by, options).finally(() => {
    record.starting = undefined;
  });
  record.starting = run;
  return run;
}

export async function run(
  this: DevServers,
  record: ServerRecord,
  folder: string,
  by: DevServerStarter,
  options: DevServerStartOptions,
): Promise<DevServerState> {
  const { conversationId, entry, key } = record;
  const port = launchPort(entry);
  if (port) record.port = port;
  const url = launchUrl(entry);
  if (url) record.url = url;
  record.error = undefined;

  // A configuration with only a url opens a server started elsewhere.
  if (!entry.runtimeExecutable) {
    await this.deps.beforeStart?.(conversationId, record.name);
    const open = port ? await this.portOpen(port) : false;
    record.status = open ? "running" : "failed";
    if (!open) record.error = `Nothing is running at ${url}.`;
    this.emit(conversationId);
    return this.state(record);
  }

  let cwd: string;
  try {
    cwd = fs.realpathSync(path.resolve(folder, entry.cwd ?? "."));
    if (!this.inside(folder, cwd))
      throw new Error(`"cwd" must be a folder inside this session's folder.`);
    if (!fs.statSync(cwd).isDirectory())
      throw new Error(`"cwd" isn't a folder.`);
  } catch (error) {
    return this.fail(
      record,
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? `The folder "${entry.cwd}" doesn't exist.`
        : errorText(error),
    );
  }

  if (by === "person") this.approve(conversationId, key);
  else if (!this.approvals.get(conversationId)?.has(key)) {
    if (!options.approve) {
      this.removeRecord(record);
      throw new Error(
        `Starting "${entry.name}" needs your approval in the Browser panel.`,
      );
    }
    record.status = "awaiting-approval";
    this.emit(conversationId);
    let allowed = false;
    try {
      allowed = await options.approve({
        conversationId,
        name: entry.name,
        command: formatCommandLine(entry.runtimeExecutable, entry.runtimeArgs),
        executable: entry.runtimeExecutable,
        args: [...(entry.runtimeArgs ?? [])],
        folder: cwd,
        ...(port ? { port } : {}),
        ...(url ? { url } : {}),
        envNames: Object.keys(entry.env ?? {}),
      });
    } catch {
      allowed = false;
    }
    if (
      this.disposed ||
      this.current(record) !== record ||
      record.status !== "awaiting-approval"
    )
      throw new Error("The dev server was stopped.");
    if (!allowed) {
      this.removeRecord(record);
      throw new Error(`Starting "${entry.name}" wasn't approved.`);
    }
    this.approve(conversationId, key);
    record.status = "starting";
    this.emit(conversationId);
  }

  const portBusy = port ? await this.portOpen(port) : false;
  if (this.disposed || this.current(record) !== record)
    throw new Error("The dev server was stopped.");
  if (record.status !== "starting") return this.state(record);
  if (portBusy)
    return this.fail(
      record,
      `Port ${port} is already in use. Stop whatever is using it, or change the port in launch.json.`,
      false,
    );

  const baseEnv = scrubEnv(this.deps.env ?? process.env);
  const separator = this.platform === "win32" ? ";" : ":";
  const pathKey =
    Object.keys(baseEnv).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const shellPath = await (
    this.deps.shellPath ?? (() => loginShellPath(this.platform, this.deps.env))
  )().catch(() => undefined);
  const extras =
    this.platform === "darwin" ? "/opt/homebrew/bin:/usr/local/bin" : "";
  baseEnv[pathKey] = mergePath(
    shellPath,
    mergePath(baseEnv[pathKey], extras, separator),
    separator,
  );
  // Frameworks that open a browser tab by themselves (Create React App) don't.
  baseEnv.BROWSER = "none";
  const env = { ...baseEnv, ...(entry.env ?? {}) };
  if (this.disposed || this.current(record) !== record)
    throw new Error("The dev server was stopped.");
  if (record.status !== "starting") return this.state(record);

  await this.deps.beforeStart?.(conversationId, record.name);
  if (this.disposed || this.current(record) !== record)
    throw new Error("The dev server was stopped.");
  let command = entry.runtimeExecutable;
  let args = entry.runtimeArgs ?? [];
  let verbatim = false;
  if (this.platform === "win32")
    ({ command, args, verbatim } = windowsCommand(command, args, env, cwd));
  let child: ChildProcess;
  try {
    child = this.spawnProcess(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: this.platform !== "win32",
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      shell: false,
    });
  } catch (error) {
    return this.fail(
      record,
      `Couldn't start "${entry.name}": ${errorText(error)}`,
    );
  }
  record.child = child;
  record.pid = child.pid;
  record.startedAt = Date.now();
  record.stopping = false;
  record.logs.note(
    `$ ${formatCommandLine(entry.runtimeExecutable, entry.runtimeArgs)}`,
  );
  this.emit(conversationId);

  let printedUrl: string | undefined;
  const onData = (stream: string) => (chunk: Buffer) => {
    record.logs.write(stream, chunk);
    if (!port && !printedUrl) printedUrl = localUrlsIn(chunk.toString())[0];
  };
  child.stdout?.on("data", onData("stdout"));
  child.stderr?.on("data", onData("stderr"));
  let spawnError: string | undefined;
  record.exited = new Promise<void>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError =
        error.code === "ENOENT"
          ? `Couldn't find "${entry.runtimeExecutable}". Check that it's installed and on your PATH.`
          : `Couldn't start "${entry.name}": ${error.message}`;
      this.exited(record, child, null, null, spawnError);
      resolve();
    });
    child.once("close", (code, signal) => {
      this.exited(record, child, code, signal);
      resolve();
    });
  });

  const deadline = Date.now() + this.timing.portTimeoutMs;
  for (;;) {
    if (record.child !== child || record.status !== "starting")
      return this.state(record);
    if (port ? await this.portOpen(port) : printedUrl) break;
    if (Date.now() >= deadline) {
      const reason = port
        ? `Port ${port} didn't open within ${Math.round(this.timing.portTimeoutMs / 1000)} seconds.`
        : `The server didn't print a local address within ${Math.round(this.timing.portTimeoutMs / 1000)} seconds. Add "port" to launch.json.`;
      record.logs.note(reason);
      await this.stopRecord(record);
      return this.fail(record, reason);
    }
    await new Promise((resolve) => setTimeout(resolve, this.timing.pollMs));
  }
  if (record.child !== child || record.status !== "starting")
    return this.state(record);
  if (!port && printedUrl) {
    record.url = printedUrl;
    try {
      record.port = Number(new URL(printedUrl).port) || undefined;
    } catch {
      // Kept without a port.
    }
  }
  record.status = "running";
  this.emit(conversationId);
  return this.state(record);
}

export function removeRecord(this: DevServers, record: ServerRecord) {
  const records = this.records.get(record.conversationId);
  if (records?.get(lower(record.name)) === record) {
    if (record.logs.tail(1).length) {
      record.status = "stopped";
      record.child = undefined;
    } else records.delete(lower(record.name));
  }
  this.emit(record.conversationId);
}

export function fail(
  this: DevServers,
  record: ServerRecord,
  reason: string,
  forget = true,
) {
  record.status = "failed";
  record.error = reason;
  record.child = undefined;
  if (forget) this.forgetApproval(record.conversationId, record.key);
  this.emit(record.conversationId);
  return this.state(record);
}

export function exited(
  this: DevServers,
  record: ServerRecord,
  child: ChildProcess,
  code: number | null,
  signal: NodeJS.Signals | null,
  error?: string,
) {
  if (record.child !== child) return;
  record.child = undefined;
  record.logs.flush();
  if (error) record.logs.note(error);
  else
    record.logs.note(
      signal ? `Stopped (${signal}).` : `Exited with code ${code ?? 0}.`,
    );
  if (record.stopping) {
    record.status = "stopped";
    record.error = undefined;
  } else if (error) {
    record.status = "failed";
    record.error = error;
    this.forgetApproval(record.conversationId, record.key);
  } else if (record.status === "starting") {
    record.status = "failed";
    record.error = `The server exited${code !== null ? ` with code ${code}` : ""} before it was ready. See its logs.`;
    this.forgetApproval(record.conversationId, record.key);
  } else if (code === 0 && !signal) {
    record.status = "stopped";
  } else {
    // A crash asks for approval again before the next start.
    record.status = "crashed";
    record.error = `The server stopped unexpectedly${code !== null ? ` (exit code ${code})` : signal ? ` (${signal})` : ""}.`;
    this.forgetApproval(record.conversationId, record.key);
  }
  this.emit(record.conversationId);
}

export async function stopRecord(this: DevServers, record: ServerRecord) {
  const child = record.child;
  if (!child) return;
  record.stopping = true;
  const pid = child.pid;
  if (pid) this.kill(pid, "SIGTERM");
  else child.kill("SIGTERM");
  const exited = record.exited ?? Promise.resolve();
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), this.timing.killGraceMs).unref?.(),
    ),
  ]);
  if (!graceful) {
    if (pid) this.kill(pid, "SIGKILL");
    else child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 1_000).unref?.()),
    ]);
  }
}

export async function stop(
  this: DevServers,
  conversationId: string,
  name: string,
) {
  const record = this.records.get(conversationId)?.get(lower(name));
  if (!record) {
    const printed = [
      ...(this.detected.get(conversationId)?.values() ?? []),
    ].find((item) => new URL(item.url).host === name);
    if (printed)
      throw new Error(
        "This server was started in the terminal. Stop it there.",
      );
    return;
  }
  if (record.status === "awaiting-approval") {
    this.removeRecord(record);
    return;
  }
  if (!record.child) {
    if (record.status === "running" || record.status === "starting") {
      // Opened from a url only, or not spawned yet: nothing of ours runs.
      record.status = "stopped";
      this.emit(conversationId);
    }
    return;
  }
  record.logs.note("Stopping…");
  await this.stopRecord(record);
  record.status = "stopped";
  record.error = undefined;
  this.emit(conversationId);
}
