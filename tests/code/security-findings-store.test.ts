import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RoutineRun } from "../../shared/routine-labels";
import {
  SecurityFindingsStore,
  runMessages,
  securityFindingsName,
} from "../../electron/git/security-findings";

const report = (title: string, extra = "") => `# Security review
Branch: main
Commit: abc1234

## Findings

### [High] ${title}
- File: src/app.ts:10-12
- Category: ${title}

**Description:** Something is wrong.
**Recommended fix:** Fix it.
${extra}`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "findings-"));
  const runs: Record<string, RoutineRun[]> = { r1: [] };
  const messages: Record<string, string[]> = {};
  const routines = new Set(["r1"]);
  const store = new SecurityFindingsStore(root, {
    runs: (id) => runs[id] ?? [],
    messages: (id) => messages[id],
    routines: () => routines,
  });
  const addRun = (
    id: string,
    startedAt: number,
    text: string[] | undefined,
    status: RoutineRun["status"] = "completed",
  ) => {
    runs.r1.unshift({
      id,
      startedAt,
      finishedAt: startedAt + 10,
      status,
      trigger: "schedule",
      conversationId: `c-${id}`,
    });
    if (text) messages[`c-${id}`] = text;
  };
  return { root, store, addRun, routines };
}

test("a completed run's report becomes the routine's findings", () => {
  const { store, addRun } = setup();
  assert.deepEqual(store.list("r1").findings, []);
  addRun("a", 1000, ["Looking...", report("SQL injection")]);
  const view = store.list("r1");
  assert.equal(view.findings.length, 1);
  assert.equal(view.findings[0].status, "open");
  assert.equal(view.findings[0].firstSeenAt, 1010);
  assert.equal(view.scans.length, 1);
});

test("runs still going or failed are not read, and a run is read once", () => {
  const { store, addRun } = setup();
  addRun("a", 1000, [report("XSS")], "running");
  addRun("b", 2000, [report("XSS")], "failed");
  assert.equal(store.list("r1").findings.length, 0);
  addRun("c", 3000, [report("XSS")]);
  const view = store.list("r1");
  assert.equal(view.findings.length, 1);
  assert.equal(store.list("r1").scans.length, 1);
});

test("a run whose conversation is gone, or whose answer is no report, changes nothing", () => {
  const { store, addRun } = setup();
  addRun("a", 1000, [report("XSS")]);
  store.list("r1");
  addRun("b", 2000, undefined);
  addRun("c", 3000, ["I could not finish."]);
  const view = store.list("r1");
  assert.equal(view.findings[0].status, "open");
  assert.equal(view.scans.filter((scan) => !scan.readable).length, 2);
});

test("triage is kept, and survives the next run", () => {
  const { store, addRun } = setup();
  addRun("a", 1000, [report("XSS")]);
  const id = store.list("r1").findings[0].id;
  const view = store.triage("r1", id, {
    status: "dismissed",
    reason: "false_finding",
  });
  assert.equal(view.findings[0].status, "dismissed");
  addRun("b", 2000, [report("XSS")]);
  assert.equal(store.list("r1").findings[0].status, "dismissed");
  assert.throws(
    () =>
      store.triage("r1", id, { status: "dismissed", reason: "accepted_risk" }),
    /note is required/,
  );
});

test("the findings of a deleted routine are dropped", () => {
  const { store, addRun, routines, root } = setup();
  addRun("a", 1000, [report("XSS")]);
  store.list("r1");
  routines.delete("r1");
  routines.add("r2");
  store.list("r2");
  const saved = JSON.parse(
    fs.readFileSync(path.join(root, securityFindingsName), "utf8"),
  );
  assert.deepEqual(Object.keys(saved.routines), ["r2"]);
  assert.throws(() => store.list("r1"), /no longer exists/);
});

test("an unreadable file is not overwritten", () => {
  const { store, root } = setup();
  fs.writeFileSync(path.join(root, securityFindingsName), "{not json");
  assert.throws(() => store.list("r1"), /couldn't be read/);
  assert.equal(
    fs.readFileSync(path.join(root, securityFindingsName), "utf8"),
    "{not json",
  );
});

test("damaged findings in the file are dropped, the rest kept", () => {
  const { store, addRun, root } = setup();
  addRun("a", 1000, [report("XSS")]);
  store.list("r1");
  const file = path.join(root, securityFindingsName);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.routines.r1.findings.push({ id: 5, title: "bad" });
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(store.list("r1").findings.length, 1);
});

test("a run's messages are the assistant text of its first turn", () => {
  assert.deepEqual(
    runMessages([
      {
        items: [
          { type: "userMessage", text: "go" },
          { type: "agentMessage", text: "one" },
          { type: "commandExecution" },
          { type: "agentMessage", text: "two" },
        ],
      },
      { items: [{ type: "agentMessage", text: "later" }] },
    ]),
    ["one", "two"],
  );
  assert.deepEqual(runMessages([]), []);
});
