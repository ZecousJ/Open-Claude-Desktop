import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateLegacyState } from "../electron/official-ui/api/migrate-state";
import { inAdapterScope, newAdapterScope } from "../electron/official-ui/api/scope";
import { readState, setStateDir, writeStateIfMissing } from "../electron/official-ui/api/state";

test("legacy state migrates only records proven to belong to each account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-legacy-migration-"));
  const legacy = path.join(root, "legacy"), a = path.join(root, "a"), b = path.join(root, "b");
  fs.mkdirSync(a); fs.mkdirSync(b);
  const fileA = path.join(a, "a.txt"), fileB = path.join(b, "b.txt");
  fs.writeFileSync(fileA, "a"); fs.writeFileSync(fileB, "b");
  try {
    setStateDir(legacy);
    const data = path.join(legacy, "official-ui");
    fs.writeFileSync(path.join(data, "aliases.json"), JSON.stringify([["page-a", "conversation-a"], ["page-b", "conversation-b"]]));
    fs.writeFileSync(path.join(data, "message-ids.json"), JSON.stringify({ turns: [["turn-a", { user: "ua", assistant: "aa" }], ["turn-b", { user: "ub", assistant: "ab" }]], prompts: [["turn-a", "ua"], ["turn-b", "ub"]] }));
    fs.writeFileSync(path.join(data, "files.json"), JSON.stringify({ files: [{ id: "fa", path: fileA }, { id: "fb", path: fileB }], aliases: [["cloud-a", "fa"], ["cloud-b", "fb"]] }));
    const makeCtx = (id: string, stateDirectory: string) => ({
      stateDirectory: () => stateDirectory, isCurrent: () => true,
      listConversations: async () => [{ id: `conversation-${id}`, turns: [{ id: `turn-${id}`, attachments: [] }] }],
    });
    const scopeA = newAdapterScope("a", a), scopeB = newAdapterScope("b", b);
    await Promise.all([
      inAdapterScope(scopeA, () => migrateLegacyState(makeCtx("a", a) as never)),
      inAdapterScope(scopeB, () => migrateLegacyState(makeCtx("b", b) as never)),
    ]);
    assert.deepEqual(inAdapterScope(scopeA, () => readState("aliases", [])), [["page-a", "conversation-a"]]);
    assert.deepEqual(inAdapterScope(scopeB, () => readState("aliases", [])), [["page-b", "conversation-b"]]);
    assert.deepEqual(inAdapterScope(scopeA, () => readState<any>("message-ids", {}).prompts), [["turn-a", "ua"]]);
    assert.deepEqual(inAdapterScope(scopeB, () => readState<any>("files", {}).files.map((f: { id: string }) => f.id)), ["fb"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, "aliases.json"), "utf8")).length, 2);
    assert.equal(inAdapterScope(scopeA, () => writeStateIfMissing("aliases", [])), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an account change aborts migration before any account state is written", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-legacy-migration-"));
  try {
    setStateDir(root);
    fs.writeFileSync(path.join(root, "official-ui", "aliases.json"), JSON.stringify([["page", "actual"]]));
    const scope = newAdapterScope("a", path.join(root, "account"));
    const ctx = { listConversations: async () => [], isCurrent: () => false };
    await assert.rejects(inAdapterScope(scope, () => migrateLegacyState(ctx as never)), /account changed/);
    assert.equal(inAdapterScope(scope, () => readState("migration-v1", null)), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
