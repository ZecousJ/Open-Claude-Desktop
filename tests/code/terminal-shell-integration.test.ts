import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CommandMarks,
  integrateLocalShell,
  integrateRemoteShell,
  shellKind,
  writeShellIntegration,
} from "../../electron/terminal/terminal-shell-integration";
import { TerminalSessions } from "../../electron/terminal/terminal-sessions";
import { TerminalController } from "../../electron/terminal/terminal-controller";
import { registerTerminalHandlers } from "../../electron/ipc/terminal";
import { Store } from "../../electron/store/store";
import type { CodexRPC } from "../../electron/engine/rpc";
import type { Engine } from "../../electron/engine/engine";
import type { AppEvent, Conversation } from "../../shared/types";

const bytes = (text: string) => Buffer.from(text, "latin1");
const COMMAND = "\x1b]133;C\x07";
const PROMPT = "\x1b]133;D;0\x07";

test("a shell is known by its program's file name", () => {
  assert.equal(shellKind("/bin/zsh"), "zsh");
  assert.equal(shellKind("/usr/local/bin/bash"), "bash");
  assert.equal(shellKind("/opt/homebrew/bin/fish"), "fish");
  assert.equal(shellKind("C:\\Windows\\System32\\cmd.exe"), "cmd");
  assert.equal(shellKind("cmd.exe"), "cmd");
  assert.equal(shellKind("/bin/sh"), undefined);
  assert.equal(shellKind("/usr/bin/nu"), undefined);
});

test("the marks tell a running command from a prompt, even split between pieces", () => {
  const marks = new CommandMarks();
  assert.equal(marks.busy, undefined);
  assert.equal(
    marks.feed(bytes("plain output with \x1b[31mcolour\x1b[0m")),
    false,
  );
  assert.equal(marks.busy, undefined, "no marks: nothing is known");
  assert.equal(marks.feed(bytes(`${PROMPT}% `)), true);
  assert.equal(marks.busy, false);
  // A command mark cut in two, with the ST terminator.
  assert.equal(marks.feed(bytes("ls\r\n\x1b]13")), false);
  assert.equal(marks.feed(bytes("3;C\x1b\\file.txt\r\n")), true);
  assert.equal(marks.busy, true);
  // Text and the next prompt in one piece: the last mark wins.
  assert.equal(marks.feed(bytes(`done${PROMPT}${COMMAND}`)), false);
  assert.equal(marks.busy, true);
  assert.equal(marks.feed(bytes(`\x1b]133;A\x07% `)), true);
  assert.equal(marks.busy, false);
  // Multibyte text around a mark reads the same.
  assert.equal(marks.feed(Buffer.from(`héllo ✓${COMMAND}`, "utf8")), true);
  assert.equal(marks.busy, true);
  // Typing never changes what a shell that marks its commands says.
  assert.equal(marks.input(bytes("\r")), false);
  assert.equal(marks.busy, true);
});

test("a shell that marks only its prompt runs a command from Enter to the next prompt", () => {
  const marks = new CommandMarks();
  assert.equal(marks.input(bytes("\r")), false, "before any prompt: unknown");
  marks.feed(bytes("\x1b]133;A\x1b\\C:\\work>"));
  assert.equal(marks.busy, false);
  assert.equal(marks.input(bytes("di")), false);
  assert.equal(marks.input(bytes("r\r")), true);
  assert.equal(marks.busy, true);
  assert.equal(marks.input(bytes("\r")), false);
  marks.feed(bytes("listing\r\n\x1b]133;A\x1b\\C:\\work>"));
  assert.equal(marks.busy, false);
});

test("this computer's shells get their hooks; others start as before", () => {
  const dir = "/data/shell-integration";
  const zsh = integrateLocalShell(
    { command: ["/bin/zsh", "-i"], title: "zsh" },
    dir,
    { ZDOTDIR: "/Users/me/.config/zsh" },
  );
  assert.deepEqual(zsh.command, ["/bin/zsh", "-i"]);
  assert.equal(zsh.env?.ZDOTDIR, path.join(dir, "zsh"));
  assert.equal(zsh.env?.CLAUDEX_USER_ZDOTDIR, "/Users/me/.config/zsh");
  assert.equal(
    integrateLocalShell({ command: ["/bin/zsh", "-i"], title: "zsh" }, dir, {})
      .env?.CLAUDEX_USER_ZDOTDIR,
    "",
  );
  assert.deepEqual(
    integrateLocalShell({ command: ["/bin/bash", "-i"], title: "bash" }, dir)
      .command,
    ["/bin/bash", "--rcfile", path.join(dir, "bash", "bashrc"), "-i"],
  );
  const fish = integrateLocalShell(
    { command: ["/usr/bin/fish", "-i"], title: "fish" },
    dir,
  );
  assert.equal(fish.command[2], "--init-command");
  assert.match(fish.command[3], /fish_preexec/);
  assert.equal(
    integrateLocalShell(
      { command: ["cmd.exe"], title: "Command Prompt" },
      dir,
      {},
    ).env?.PROMPT,
    "$E]133;A$E\\$P$G",
  );
  assert.equal(
    integrateLocalShell(
      { command: ["cmd.exe"], title: "Command Prompt" },
      dir,
      { PROMPT: "$T$G" },
    ).env?.PROMPT,
    "$E]133;A$E\\$T$G",
  );
  const sh = { command: ["/bin/sh", "-i"], title: "sh" };
  assert.equal(integrateLocalShell(sh, dir), sh);
  assert.equal(integrateRemoteShell(sh), sh);
});

test("the integration's files are written once and keep their content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-si-files-"));
  try {
    const dir = writeShellIntegration(path.join(root, "si"));
    const rc = path.join(dir, "zsh", ".zshrc");
    const before = fs.statSync(rc).mtimeMs;
    assert.match(fs.readFileSync(rc, "utf8"), /add-zsh-hook preexec/);
    assert.ok(fs.existsSync(path.join(dir, "zsh", ".zshenv")));
    assert.ok(fs.existsSync(path.join(dir, "bash", "bashrc")));
    writeShellIntegration(dir);
    assert.equal(fs.statSync(rc).mtimeMs, before);
    fs.writeFileSync(rc, "stale");
    writeShellIntegration(dir);
    assert.match(fs.readFileSync(rc, "utf8"), /add-zsh-hook/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Runs a shell with the hooks the way a tab would, reading commands from
 * stdin, in a home of its own; answers what it printed.
 */
function runShell(
  command: string[],
  env: Record<string, string> | undefined,
  home: string,
  input: string,
) {
  const result = spawnSync(command[0], command.slice(1), {
    input,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, ...env },
    encoding: "latin1",
    timeout: 20_000,
  });
  return result.stdout + result.stderr;
}

for (const program of ["/bin/zsh", "/bin/bash"]) {
  const name = path.basename(program);
  test(
    `${name} reads the user's own startup files and marks every command`,
    { skip: !fs.existsSync(program) && `${program} is not installed` },
    () => {
      const home = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), `claudex-si-${name}-`)),
      );
      try {
        fs.writeFileSync(path.join(home, ".zshenv"), "echo USER_ZSHENV\n");
        fs.writeFileSync(path.join(home, ".zshrc"), "echo USER_ZSHRC\n");
        fs.writeFileSync(path.join(home, ".bashrc"), "echo USER_BASHRC\n");
        const dir = writeShellIntegration(path.join(home, "si"));
        const input = 'true\nsleep 0.1\necho "[$ZDOTDIR][$HISTFILE]"\nexit\n';
        for (const shell of [
          integrateLocalShell(
            { command: [program, "-i"], title: name },
            dir,
            {},
          ),
          integrateRemoteShell({ command: [program, "-i"], title: name }),
        ]) {
          const output = runShell(shell.command, shell.env, home, input);
          if (name === "zsh") {
            assert.match(output, /USER_ZSHENV\nUSER_ZSHRC/);
            // ZDOTDIR is the user's again (unset here), with their history.
            assert.ok(
              output.includes(`[][${home}/.zsh_history]`),
              JSON.stringify(output),
            );
          } else assert.match(output, /USER_BASHRC/);
          // A prompt, then each of the four commands starts and ends.
          const marks = output.match(/\x1b\]133;[CD][^\x07]*\x07/g) ?? [];
          assert.deepEqual(
            marks.map((mark) => mark[6]),
            ["D", "C", "D", "C", "D", "C", "D", "C"],
            JSON.stringify(output),
          );
          const reader = new CommandMarks();
          reader.feed(
            Buffer.from(
              output.slice(0, output.indexOf("\x1b]133;C") + 9),
              "latin1",
            ),
          );
          assert.equal(reader.busy, true);
        }
        // The remote script's temporary folder is gone once read.
        assert.deepEqual(
          fs
            .readdirSync(home)
            .filter((item) => item.startsWith("claudex-shell")),
          [],
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
}

class FakeRPC extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  private resolveExec?: (result: any) => void;
  call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "command/exec")
      return new Promise<any>((resolve) => {
        this.resolveExec = resolve;
      });
    return Promise.resolve({});
  }
  finish(code: number) {
    this.resolveExec?.({ exitCode: code });
  }
  output(id: string, text: string) {
    this.emit("notification", {
      method: "command/exec/outputDelta",
      params: {
        processId: id,
        deltaBase64: Buffer.from(text, "latin1").toString("base64"),
      },
    });
  }
}

test("a tab tells the window when a command starts and ends, and lists busy tabs", async () => {
  const rpc = new FakeRPC(),
    events: AppEvent[] = [];
  const manager = new TerminalSessions(
    rpc as unknown as CodexRPC,
    (event) => events.push(event),
    "darwin",
  );
  const tab = manager.start("chat", "/tmp", false, {
    command: ["/bin/zsh", "-i"],
    title: "zsh",
    env: { ZDOTDIR: "/data/si/zsh" },
  });
  const other = manager.start("chat", "/tmp", false);
  assert.equal(rpc.calls[0].params.env.ZDOTDIR, "/data/si/zsh");
  assert.equal(rpc.calls[0].params.env.CLAUDEX_GATEWAY_TOKEN, null);
  const busyEvents = () =>
    events.filter((event) => event.type === "terminal-busy");
  rpc.output(tab.id, "plain");
  assert.equal(busyEvents().length, 0);
  assert.equal(manager.list("chat")[0].busy, undefined);
  rpc.output(tab.id, `${PROMPT}% `);
  assert.deepEqual(busyEvents().at(-1), {
    type: "terminal-busy",
    id: tab.id,
    conversationId: "chat",
    busy: false,
  });
  assert.deepEqual(manager.busy("chat"), []);
  rpc.output(tab.id, `sleep 10\r\n${COMMAND}`);
  assert.equal(busyEvents().at(-1)?.type, "terminal-busy");
  assert.equal((busyEvents().at(-1) as { busy: boolean }).busy, true);
  assert.deepEqual(manager.busy("chat"), [tab.id]);
  assert.deepEqual(manager.busy("other"), []);
  const listed = manager.list("chat").find((item) => item.id === tab.id)!;
  assert.equal(listed.busy, true);
  assert.equal("marks" in listed, false);
  // The marks stay in the output the window draws (xterm ignores them).
  assert.match(
    Buffer.from(listed.outputBase64, "base64").toString("latin1"),
    /133;C/,
  );
  // Output without marks changes nothing; the other tab is unknown.
  const count = busyEvents().length;
  rpc.output(tab.id, "still going");
  assert.equal(busyEvents().length, count);
  assert.equal(
    manager.list("chat").find((item) => item.id === other.id)!.busy,
    undefined,
  );
  rpc.output(tab.id, PROMPT);
  assert.deepEqual(manager.busy("chat"), []);
  rpc.output(tab.id, COMMAND);
  assert.deepEqual(manager.busy("chat"), [tab.id]);
  await manager.close("chat", tab.id);
  assert.deepEqual(manager.busy("chat"), []);
  manager.reset();
});

test("a tab whose shell ended is never busy", async () => {
  const rpc = new FakeRPC();
  const manager = new TerminalSessions(
    rpc as unknown as CodexRPC,
    () => {},
    "darwin",
  );
  const tab = manager.start("chat", "/tmp", false);
  rpc.output(tab.id, COMMAND);
  assert.deepEqual(manager.busy("chat"), [tab.id]);
  rpc.finish(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(manager.busy("chat"), []);
  assert.equal(manager.list("chat")[0].busy, undefined);
  manager.reset();
});

test("Command Prompt's line entered at the prompt is busy until the next prompt", async () => {
  const rpc = new FakeRPC(),
    events: AppEvent[] = [];
  const manager = new TerminalSessions(
    rpc as unknown as CodexRPC,
    (event) => events.push(event),
    "win32",
  );
  const tab = manager.start("chat", "C:\\work", true);
  rpc.output(tab.id, "\x1b]133;A\x1b\\C:\\work>");
  await manager.write(
    "chat",
    tab.id,
    Buffer.from("ping host\r").toString("base64"),
  );
  assert.deepEqual(manager.busy("chat"), [tab.id]);
  rpc.output(tab.id, "Reply\r\n\x1b]133;A\x1b\\C:\\work>");
  assert.deepEqual(manager.busy("chat"), []);
  manager.reset();
});

test("the controller starts this computer's shell with its hooks and answers which tabs are busy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-si-controller-"));
  const shell = process.env.SHELL;
  process.env.SHELL = "/bin/zsh";
  try {
    const store = new Store(root);
    const conversation: Conversation = {
      id: "chat",
      title: "Fixture",
      mode: "code",
      providerId: "default",
      model: "fixture",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    };
    store.conversations.push(conversation);
    const rpc = new FakeRPC();
    const engine = {
      rpc: rpc as unknown as CodexRPC,
      state: { state: "ready" },
    } as Engine;
    const controller = new TerminalController(
      store,
      engine,
      () => {},
      "darwin",
    );
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerTerminalHandlers(
      (name, fn) => handlers.set(name, fn),
      () => controller,
    );
    // No tab yet: nothing is busy, and asking starts nothing.
    assert.deepEqual(await handlers.get("terminalBusy")!("chat"), []);
    assert.equal(rpc.calls.length, 0);
    const [tab] = await controller.ensure("chat");
    const exec = rpc.calls.find((call) => call.method === "command/exec")!;
    const zdotdir = path.join(root, "shell-integration", "zsh");
    assert.deepEqual(exec.params.command, ["/bin/zsh", "-i"]);
    assert.equal(exec.params.env.ZDOTDIR, zdotdir);
    assert.ok(fs.existsSync(path.join(zdotdir, ".zshrc")));
    rpc.output(tab.id, COMMAND);
    assert.deepEqual(await handlers.get("terminalBusy")!("chat"), [tab.id]);
    assert.throws(
      () => handlers.get("terminalBusy")!(""),
      /too_small|at least/i,
    );
    controller.reset();
  } finally {
    if (shell === undefined) delete process.env.SHELL;
    else process.env.SHELL = shell;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
