/**
 * SP-3 (R11 Q1): does turn/start accept `sandboxPolicy.writableRoots` and does
 * the sandbox then let commands write there (and nowhere else)? Also checks the
 * fallbacks: `runtimeWorkspaceRoots` on turn/start and the
 * `sandbox_workspace_write.writable_roots` config on thread/resume.
 *
 * Run: npx tsx --test tests/spikes/sp3-writable-roots.spike.ts
 * Real bundled Codex and the platform sandbox; loopback fixtures only;
 * results/sp3-writable-roots.json.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  CodexHost,
  MODEL as GPT,
  MockResponses,
  flattenTools,
  functionCall,
  message,
  outputs,
  toolPlan,
  stopAllHosts,
  writeFinding,
  type Json,
} from "./harness";

const MODEL = "grok-4";
const findings: Json = { codexVersion: "0.144.1", platform: process.platform };
// Not under TMPDIR or /tmp: workspace-write always allows those.
fs.mkdirSync(path.join(import.meta.dirname, ".work"), { recursive: true });
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(import.meta.dirname, ".work", "sp3-")),
);
const ws = path.join(root, "workspace");
const extra = path.join(root, "extra-folder");
const outside = path.join(root, "outside");
let mock: MockResponses;
let codex: CodexHost;
const approvals: Json[] = [];

before(async () => {
  for (const d of [ws, extra, outside]) fs.mkdirSync(d, { recursive: true });
  mock = await new MockResponses().start();
  // CODEX_HOME stays in TMPDIR so it is not itself a writable-root question.
  codex = await new CodexHost(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-spike-sp3-home-")),
    mock,
  ).start();
  codex.onRequest = (r) => {
    approvals.push({ method: r.method, command: r.params?.command });
    return r.method === "item/commandExecution/requestApproval"
      ? { decision: "decline" }
      : undefined;
  };
});
after(async () => {
  await stopAllHosts();
  if (codex) fs.rmSync(codex.home, { recursive: true, force: true });
  await mock.close();
  writeFinding("sp3-writable-roots", findings);
  fs.rmSync(path.join(import.meta.dirname, ".work"), {
    recursive: true,
    force: true,
  });
});

const policy = (roots: string[]) => ({
  type: "workspaceWrite",
  writableRoots: roots,
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
});

/** Runs `touch <file>` through Codex's shell tool; reports whether it exists. */
async function write(threadId: string, file: string, extraTurn: Json = {}) {
  mock.script = toolPlan([
    {
      suffix: "exec_command",
      args: {
        cmd: `touch '${file}'`,
        login: false,
        yield_time_ms: 10000,
        max_output_tokens: 200,
      },
    },
  ]);
  const seen = mock.forThread(threadId).length;
  const approvalsBefore = approvals.length;
  let error: string | undefined;
  try {
    await codex.turn(threadId, `write ${path.basename(file)}`, extraTurn);
  } catch (e) {
    error = String(e);
  }
  const last = mock.forThread(threadId).slice(seen).at(-1);
  const out = last ? outputs(last).at(-1)?.output : undefined;
  return {
    file: path.relative(root, file),
    written: fs.existsSync(file),
    approvalRequests: approvals.length - approvalsBefore,
    toolOutput:
      typeof out === "string"
        ? out.split(root).join("<root>").slice(0, 300)
        : out,
    ...(error ? { error } : {}),
  };
}

const thread = () => codex.thread(MODEL, ws, { approvalPolicy: "on-request" });

test("baseline: workspace-write allows cwd only", async () => {
  const id = await thread();
  const inCwd = await write(id, path.join(ws, "base-cwd.txt"));
  const inExtra = await write(id, path.join(extra, "base-extra.txt"));
  findings.baseline = { inCwd, inExtra };
  assert.equal(inCwd.written, true, "sandboxed write to cwd must work");
  assert.equal(inExtra.written, false, "sandbox must block the extra folder");
});

test("turn/start sandboxPolicy.writableRoots", async () => {
  const id = await thread();
  let accepted = true;
  let rejection: string | undefined;
  const inExtra = await write(id, path.join(extra, "turn-extra.txt"), {
    sandboxPolicy: policy([ws, extra]),
  }).catch((e) => {
    accepted = false;
    rejection = String(e);
    return undefined;
  });
  const inOutside = await write(id, path.join(outside, "turn-outside.txt"));
  // "for this turn and subsequent turns": no sandboxPolicy this time.
  const nextTurn = await write(id, path.join(extra, "turn-extra-next.txt"));
  // Narrowing again removes the root.
  const narrowed = await write(id, path.join(extra, "turn-extra-narrow.txt"), {
    sandboxPolicy: policy([ws]),
  });
  findings.turnSandboxPolicy = {
    accepted,
    rejection,
    inExtra,
    inOutside,
    stickyForNextTurn: nextTurn,
    narrowedAgain: narrowed,
  };
  assert.equal(inExtra?.written, true);
  assert.equal(inOutside.written, false);
  assert.equal(nextTurn.written, true, "policy sticks for later turns");
  assert.equal(narrowed.written, false, "a narrower policy removes the root");
});

test("fallback: turn/start runtimeWorkspaceRoots", async () => {
  const id = await thread();
  const result = await write(id, path.join(extra, "runtime-roots.txt"), {
    runtimeWorkspaceRoots: [ws, extra],
  });
  findings.turnRuntimeWorkspaceRoots = result;
  assert.equal(result.written, true);
});

test("fallback: thread/resume config sandbox_workspace_write.writable_roots", async () => {
  const id = await thread();
  await write(id, path.join(ws, "warm.txt"));
  await codex.rpc.call("thread/unsubscribe", { threadId: id });
  await codex.rpc.call("thread/resume", {
    threadId: id,
    cwd: ws,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    config: { "sandbox_workspace_write.writable_roots": [extra] },
  });
  const result = await write(id, path.join(extra, "resume-config.txt"));
  findings.resumeConfigWritableRoots = result;
  assert.equal(result.written, true);
});

/** apply_patch (file edits) into the extra folder, with and without the root. */
async function patch(threadId: string, file: string, extraTurn: Json = {}) {
  const callId = `patch_${path.basename(file)}`;
  mock.script = (body) => {
    if (outputsOf(body, callId)) return [message("PATCH_DONE")];
    const tool = flattenTools(body.tools).find((t) => t.name === "apply_patch");
    if (!tool) return [message("NO_APPLY_PATCH")];
    const input = `*** Begin Patch\n*** Add File: ${file}\n+spike\n*** End Patch`;
    return [
      tool.type === "custom"
        ? {
            id: `ct_${callId}`,
            type: "custom_tool_call",
            call_id: callId,
            name: "apply_patch",
            input,
            status: "completed",
          }
        : functionCall(tool, callId, { input }),
    ];
  };
  const approvalsBefore = approvals.length;
  await codex.turn(threadId, `patch ${path.basename(file)}`, extraTurn);
  return {
    file: path.relative(root, file),
    written: fs.existsSync(file),
    approvalRequests: approvals
      .slice(approvalsBefore)
      .map((a) => a.method as string),
  };
}

function outputsOf(body: Json, callId: string) {
  return (body.input ?? []).some(
    (x: Json) => x.call_id === callId && /_output$/.test(x.type),
  );
}

test("apply_patch into an extra writable root (gpt-5.2-codex)", async () => {
  const id = await codex.thread(GPT, ws, { approvalPolicy: "on-request" });
  const without = await patch(id, path.join(extra, "patch-before.txt"));
  const withRoot = await patch(id, path.join(extra, "patch-after.txt"), {
    sandboxPolicy: policy([ws, extra]),
  });
  findings.applyPatch = { withoutRoot: without, withRoot };
  assert.equal(without.written, false);
  assert.deepEqual(without.approvalRequests, [
    "item/fileChange/requestApproval",
  ]);
  assert.equal(withRoot.written, true);
  assert.equal(withRoot.approvalRequests.length, 0);
});
