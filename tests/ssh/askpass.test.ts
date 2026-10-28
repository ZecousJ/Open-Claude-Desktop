/**
 * R9-S1: ssh's questions reach the window through askpass and nothing else
 * can ask: only an attempt's own nonce is heard, unasked attempts are
 * refused, answers are never kept, and the bundled helper really prints the
 * answer for ssh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import type { SshEvent, SshPrompt } from "../../shared/ssh-api";
import {
  AskpassBroker,
  classifyPrompt,
  cleanPromptText,
} from "../../electron/ssh/askpass";
import { runAskpass } from "../../electron/ssh/askpass-helper";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cxa-"));

const HOSTKEY = [
  "The authenticity of host 'box (10.0.0.5)' can't be established.",
  "ED25519 key fingerprint is SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU.",
  "This key is not known by any other names.",
  "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
].join("\n");

test("questions are told apart: host key, passphrase, password, confirm, notice", () => {
  assert.deepEqual(classifyPrompt(HOSTKEY), {
    kind: "hostkey",
    confirm: true,
    fingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU",
  });
  assert.deepEqual(
    classifyPrompt("Enter passphrase for key '/Users/me/.ssh/id_ed25519': "),
    { kind: "passphrase" },
  );
  assert.deepEqual(classifyPrompt("deploy@box's password: "), {
    kind: "password",
  });
  assert.deepEqual(classifyPrompt("(deploy@box) Password: "), {
    kind: "password",
  });
  assert.deepEqual(classifyPrompt("Verification code: "), { kind: "other" });
  assert.deepEqual(classifyPrompt("Allow use of key id_ed25519?", "confirm"), {
    kind: "other",
    confirm: true,
  });
  assert.deepEqual(
    classifyPrompt("Confirm user presence for key ED25519-SK SHA256:x", "none"),
    { kind: "other", notice: true },
  );
  assert.equal(
    cleanPromptText("a\u001b[31mb\r\nc\u0000 ".padEnd(3000, "x")).length,
    2000,
  );
  assert.equal(cleanPromptText("  pass\u0007word: \r\n"), "password:");
});

interface Harness {
  broker: AskpassBroker;
  events: SshEvent[];
  dir: string;
}

async function harness(timeoutMs?: number): Promise<Harness> {
  const dir = temp();
  const events: SshEvent[] = [];
  const broker = new AskpassBroker({
    dir,
    helperScript: path.join(dir, "helper.cjs"),
    execPath: process.execPath,
    emit: (event) => events.push(event),
    timeoutMs,
  });
  await broker.start();
  return { broker, events, dir };
}

/** The helper, in process, as ssh would run it. */
function ask(env: Record<string, string>, prompt: string, mode = "") {
  let output = "";
  const code = runAskpass({
    prompt,
    env: { ...env, ...(mode ? { SSH_ASKPASS_PROMPT: mode } : {}) },
    write: (text) => (output += text),
  });
  return code.then((exit) => ({ exit, output }));
}

const nextEvent = async (events: SshEvent[], type: SshEvent["type"]) => {
  for (let i = 0; i < 200; i++) {
    const found = events.find((event) => event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no ${type} event`);
};

test("a password question goes to the window and the answer back to ssh", async () => {
  const { broker, events, dir } = await harness();
  try {
    const prompts: SshPrompt[] = [];
    const closed: boolean[] = [];
    const session = broker.session({
      hostId: "host-1",
      interactive: true,
      onPrompt: (prompt) => prompts.push(prompt),
      onPromptClosed: (_prompt, answered) => closed.push(answered),
    });
    // The wrapper runs the app as Node, and the socket is private.
    const wrapper = fs.readFileSync(session.env.SSH_ASKPASS, "utf8");
    assert.match(wrapper, /ELECTRON_RUN_AS_NODE=1 exec '/);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(session.env.SSH_ASKPASS).mode & 0o777, 0o700);
      assert.equal(
        fs.statSync(session.env.CLAUDEX_ASKPASS_SOCKET).mode & 0o777,
        0o600,
      );
      assert.ok(session.env.CLAUDEX_ASKPASS_SOCKET.startsWith(dir));
    }
    assert.equal(session.env.SSH_ASKPASS_REQUIRE, "force");
    assert.match(session.env.CLAUDEX_ASKPASS_NONCE, /^[0-9a-f]{64}$/);

    const pending = ask(session.env, "deploy@box's password: ");
    const shown = (await nextEvent(events, "ssh-prompt")) as Extract<
      SshEvent,
      { type: "ssh-prompt" }
    >;
    assert.equal(shown.prompt.kind, "password");
    assert.equal(shown.prompt.hostId, "host-1");
    assert.equal(shown.prompt.text, "deploy@box's password:");
    assert.deepEqual(broker.pending(), [shown.prompt]);
    assert.throws(() => broker.answer(shown.prompt.id, "two\nlines"));
    broker.answer(shown.prompt.id, "s3cret pass");
    assert.deepEqual(await pending, { exit: 0, output: "s3cret pass\n" });
    assert.deepEqual(
      events.find((event) => event.type === "ssh-prompt-closed"),
      { type: "ssh-prompt-closed", id: shown.prompt.id },
    );
    assert.equal(prompts.length, 1);
    assert.deepEqual(closed, [true]);
    assert.deepEqual(broker.pending(), []);
    // Answering again does nothing.
    broker.answer(shown.prompt.id, "again");
    // The answer is not kept anywhere the window could read it back.
    assert.doesNotMatch(JSON.stringify(events), /s3cret/);
    session.close();
  } finally {
    broker.close();
  }
});

test("a host key question answers yes, and cancel means no", async () => {
  const { broker, events } = await harness();
  try {
    let cancelled = 0;
    const session = broker.session({
      hostId: "h",
      interactive: true,
      onCancel: () => cancelled++,
    });
    const first = ask(session.env, HOSTKEY);
    const prompt = (
      (await nextEvent(events, "ssh-prompt")) as { prompt: SshPrompt }
    ).prompt;
    assert.equal(prompt.kind, "hostkey");
    assert.equal(prompt.confirm, true);
    broker.answer(prompt.id, "anything");
    assert.deepEqual(await first, { exit: 0, output: "yes\n" });

    events.length = 0;
    const second = ask(session.env, HOSTKEY);
    const again = (
      (await nextEvent(events, "ssh-prompt")) as { prompt: SshPrompt }
    ).prompt;
    broker.answer(again.id, null);
    assert.deepEqual(await second, { exit: 1, output: "" });
    assert.equal(cancelled, 1);
    session.close();
  } finally {
    broker.close();
  }
});

test("a wrong nonce, a closed attempt or an unasked attempt gets no answer", async () => {
  const { broker, events } = await harness();
  try {
    const session = broker.session({ hostId: "h", interactive: true });
    assert.deepEqual(
      await ask(
        { ...session.env, CLAUDEX_ASKPASS_NONCE: "0".repeat(64) },
        "password: ",
      ),
      { exit: 1, output: "" },
    );
    assert.deepEqual(
      await ask({ ...session.env, CLAUDEX_ASKPASS_NONCE: "short" }, "p: "),
      { exit: 1, output: "" },
    );
    assert.deepEqual(await ask({}, "password: "), { exit: 1, output: "" });
    session.close();
    assert.deepEqual(await ask(session.env, "password: "), {
      exit: 1,
      output: "",
    });
    assert.deepEqual(events, []);

    // Automatic reconnects never pop a question up: refused, reported.
    const refused: SshPrompt[] = [];
    const quiet = broker.session({
      hostId: "h",
      interactive: false,
      onPrompt: (prompt) => refused.push(prompt),
    });
    assert.deepEqual(await ask(quiet.env, "password: "), {
      exit: 1,
      output: "",
    });
    assert.equal(refused.length, 1);
    assert.deepEqual(events, []);
    quiet.close();

    // Garbage on the socket is dropped without an answer.
    const garbage = await new Promise<string>((resolve) => {
      const socket = net.createConnection(session.env.CLAUDEX_ASKPASS_SOCKET);
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
      socket.write("not json\n");
    });
    assert.equal(garbage, "");
  } finally {
    broker.close();
  }
});

test("an unanswered question is cancelled after the time limit", async () => {
  const { broker, events } = await harness(50);
  try {
    const session = broker.session({ hostId: "h", interactive: true });
    assert.deepEqual(await ask(session.env, "password: "), {
      exit: 1,
      output: "",
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ["ssh-prompt", "ssh-prompt-closed"],
    );
    session.close();
  } finally {
    broker.close();
  }
});

test("a notice closes by itself when ssh ends the helper", async () => {
  const { broker, events } = await harness();
  try {
    const session = broker.session({ hostId: "h", interactive: true });
    const socket = net.createConnection(session.env.CLAUDEX_ASKPASS_SOCKET);
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(
      `${JSON.stringify({
        nonce: session.env.CLAUDEX_ASKPASS_NONCE,
        prompt: "Confirm user presence for key ED25519-SK",
        mode: "none",
      })}\n`,
    );
    const shown = (
      (await nextEvent(events, "ssh-prompt")) as { prompt: SshPrompt }
    ).prompt;
    assert.equal(shown.notice, true);
    socket.destroy();
    const closed = await nextEvent(events, "ssh-prompt-closed");
    assert.deepEqual(closed, { type: "ssh-prompt-closed", id: shown.id });
    session.close();
  } finally {
    broker.close();
  }
});

test("the bundled helper, run through the wrapper, prints the answer for ssh", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX wrapper");
  const dir = temp();
  const helper = path.join(dir, "ssh-askpass.cjs");
  await build({
    entryPoints: [
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../electron/ssh/askpass-helper.ts",
      ),
    ],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: helper,
    logLevel: "silent",
  });
  const events: SshEvent[] = [];
  const broker = new AskpassBroker({
    dir: path.join(dir, "a"),
    helperScript: helper,
    execPath: process.execPath,
    emit: (event) => {
      events.push(event);
      if (event.type === "ssh-prompt")
        broker.answer(event.prompt.id, "it's $HOME `x`");
    },
  });
  await broker.start();
  try {
    const session = broker.session({ hostId: "h", interactive: true });
    const result = await new Promise<{ code: number | null; stdout: string }>(
      (resolve) => {
        execFile(
          session.env.SSH_ASKPASS,
          ["Enter passphrase for key '/k': "],
          { env: { ...process.env, ...session.env } },
          (error, stdout) =>
            resolve({ code: error ? (error.code as number) : 0, stdout }),
        );
      },
    );
    assert.deepEqual(result, { code: 0, stdout: "it's $HOME `x`\n" });
    assert.equal(
      (events[0] as { prompt: SshPrompt }).prompt.kind,
      "passphrase",
    );
    session.close();
  } finally {
    broker.close();
  }
});
