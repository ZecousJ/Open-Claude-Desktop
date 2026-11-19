/** Exact recovered pager helpers in a VM; this is not a mounted UI/screenshot test. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
import {
  convertCodeTranscript,
  pageCodeTranscript,
} from "../electron/official-ui/native/code-transcript";
const root = process.env.CLAUDEX_ORIGINAL_CODE_ASSETS;
const builds = [
  {
    name: "renderer",
    files: [
      {
        file: "cef1e6037-DgIj2SyO.js",
        names: ["Vr", "Hr", "Ur", "Wr", "Gr", "Qr", "X"],
        hash: "808f5c5f94962eb7efda306e8027ba7cf215a6ea3e62acea44bd6c9005cc5f89",
      },
      {
        file: "shared-18-BuAf9MDW.js",
        names: ["ZV", "aH", "LU", "RU", "zU", "BU"],
        hash: "4e06d6d475a729c05ba4c6dab9fa66083e5c4147019285927304cb852bfafb5d",
      },
      {
        file: "shared-87-DKzE6iss.js",
        names: ["VR", "HR"],
        hash: "4c43bbb0e1b4b12d34fdec732782de2151b349937895496cd95aab73527871a6",
      },
      {
        file: "shared-9--cRmmHEE.js",
        names: ["UE"],
        hash: "dd18da63900a7823c3f1add491f7eb2f6fee60c33819867397c98e2813ed4b25",
      },
    ],
    setup:
      'const XV="client-", IU=flags, E=cursors; const w_=UE, Ve=BU; const cursor=Wr, adopt=Gr, merge=HR, normalize=Qr;',
  },
  {
    name: "cloud",
    files: [
      {
        file: "cef1e6037-DIC2zPYg.js",
        names: ["ei", "ti", "ni", "ri", "ii", "di", "X"],
        hash: "892b640c3293b908fcade9ee420fe1ccf879c826e1ed720458d54ec021371408",
      },
      {
        file: "shared-18-BX5JXrGK.js",
        names: ["eB", "yR", "Rq", "Dh", "BT", "z8"],
        hash: "78a8ec06bff8644e050066f8205999d6983bc2182d43fb59681212694bd24da6",
      },
      {
        file: "shared-m-4-CbJwwS_m.js",
        names: ["IV", "MX"],
        hash: "8030f304f03f4687571c251cb4239fea916b6c5665318bf84e27d7685c1dc6a9",
      },
      {
        file: "shared-38-ChyOhHlY.js",
        names: ["Xv"],
        hash: "f8747f95aa2bdd9984f01f907ea5c80fca9d1c626ccf966dd46a061aabf12b2e",
      },
    ],
    setup:
      'const en="client-", Mn=flags, D=cursors; const oH=Xv, pe=z8; const cursor=ri, adopt=ii, merge=MX, normalize=di;',
  },
];
function original(build: (typeof builds)[number]) {
  const declarations = build.files.flatMap(({ file, names, hash }) => {
    const source = fs.readFileSync(
      path.join(root!, build.name, "assets/v1", file),
      "utf8",
    );
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      hash,
      "Reverify changed original asset",
    );
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    return names.map((name) => {
      const matches = ast.statements.filter(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
      assert.equal(matches.length, 1, `${file}: ${name}`);
      return matches[0].getText(ast);
    });
  });
  const context = vm.createContext({
    cursors: new Map(),
    flags: [
      "isReplay",
      "isOptimisticEcho",
      "isSyntheticEcho",
      "isSyntheticReply",
      "isCompactSummary",
      "isVisibleInTranscriptOnly",
    ],
  });
  // Signature-decoding dependencies are intentionally not stubbed: fixtures use unsigned thinking.
  vm.runInContext(
    declarations.join("\n") +
      "\n" +
      build.setup +
      "\n globalThis.api={cursor,adopt,merge,cursors,normalize};",
    context,
  );
  return (context as any).api;
}
function fixture() {
  return {
    id: "history",
    mode: "code",
    turns: Array.from({ length: 180 }, (_, i) => ({
      id: `turn-${i}`,
      prompt: `Prompt ${i}`,
      attachments: [],
      createdAt: 1000 + i,
      status: "completed",
      items: [
        { id: "reason", type: "reasoning", summary: [`Visible summary ${i}`] },
        {
          id: "command",
          type: "commandExecution",
          command: `echo ${i}`,
          aggregatedOutput: `Output ${i}`,
          status: "completed",
        },
        ...(i % 7 === 0
          ? [
              {
                id: "compact",
                type: "contextCompaction",
                lifecycleStatus: "completed",
              },
            ]
          : []),
        ...(i === 90
          ? [
              {
                id: "unknown",
                type: "future-kind",
                privateReasoning: "DO_NOT_EXPOSE",
              },
            ]
          : []),
        { id: "answer", type: "agentMessage", text: `Answer ${i}` },
      ],
    })),
  } as any;
}
for (const build of builds) {
  test(
    `${build.name}: exact cursor/merge reconstruct mixed paginated history and live append`,
    { skip: !root },
    () => {
      const api = original(build),
        conversation = fixture();
      const rows = convertCodeTranscript(conversation).rows;
      assert.ok(rows.length > 500);
      assert.ok(!JSON.stringify(rows).includes("DO_NOT_EXPOSE"));
      assert.ok(
        rows.some((row) => row.uuid.includes("unknown")),
        "unknown record remains visibly represented",
      );
      const latest = pageCodeTranscript(rows, "", 37);
      let combined = latest.messages;
      api.adopt("history", combined, latest.hasMore);
      let reads = 0;
      while (api.cursors.has("history")) {
        assert.ok(++reads < rows.length, "cursor must advance");
        const cursor = api.cursors.get("history");
        const older = pageCodeTranscript(rows, cursor, 37);
        assert.equal(older.found, true);
        combined = api.merge(older.messages, combined);
        api.adopt("history", older.messages, older.hasMore, cursor);
      }
      assert.deepEqual(
        Array.from(combined, (r: any) => r.uuid),
        rows.map((r) => r.uuid),
      );
      assert.equal(new Set(combined.map((r: any) => r.uuid)).size, rows.length);
      assert.strictEqual(
        api.merge(latest.messages, combined),
        combined,
        "repeat does not duplicate or replace current history",
      );
      conversation.turns.push({
        id: "live",
        prompt: "Next",
        attachments: [],
        createdAt: 2000,
        status: "completed",
        items: [{ id: "answer", type: "agentMessage", text: "Live answer" }],
      });
      const appended = convertCodeTranscript(conversation).rows;
      const tail = pageCodeTranscript(appended, "", 37);
      const refreshed = api.merge(combined, tail.messages);
      assert.deepEqual(
        Array.from(refreshed, (r: any) => r.uuid),
        appended.map((r) => r.uuid),
      );
      assert.deepEqual(pageCodeTranscript(appended, "missing", 37), {
        messages: [],
        hasMore: false,
        found: false,
        totalRows: appended.length,
      });
    },
  );
  test(
    `${build.name}: noneligible prefix overlap and tool boundary preserve identity`,
    { skip: !root },
    () => {
      const api = original(build),
        rows = convertCodeTranscript(fixture()).rows;
      const boundary = rows.findIndex((r) => r.type === "system");
      const compact = rows[boundary],
        answer = rows[boundary + 1];
      const thinking = rows.find(
        (r) =>
          Array.isArray(r.message.content) &&
          r.message.content[0]?.type === "thinking",
      )!;
      assert.equal(api.cursor([compact, thinking, answer]), answer.uuid);
      api.adopt("history", [compact, thinking, answer], true);
      assert.equal(api.cursors.get("history"), answer.uuid);
      const useIndex = rows.findIndex(
        (r) =>
          Array.isArray(r.message.content) &&
          r.message.content[0]?.type === "tool_use",
      );
      const use = rows[useIndex],
        result = rows[useIndex + 1];
      assert.equal(
        api.cursor([result]),
        result.uuid,
        "tool result is a valid original cursor",
      );
      const older = pageCodeTranscript(rows, result.uuid, 1);
      assert.equal(older.messages[0].uuid, use.uuid);
      const joined = api.merge(older.messages, [result]);
      assert.equal(
        joined[0].message.content[0].id,
        joined[1].message.content[0].tool_use_id,
      );
      assert.deepEqual(
        Array.from(api.merge([compact], [compact, answer]), (r: any) => r.uuid),
        [compact.uuid, answer.uuid],
      );
    },
  );
}

for (const build of builds) {
  test(
    `${build.name}: exact event normalizer separates transcript snapshots from completion`,
    { skip: !root },
    () => {
      const { normalize } = original(build);
      // X is extracted unchanged, but an empty snapshot never invokes its sanitizer dependencies.
      const snapshot = normalize({
        type: "transcript_loaded",
        sessionId: "history",
        messages: [],
      });
      assert.equal(snapshot.sessionId, "history");
      assert.equal(snapshot.event.kind, "transcript");
      assert.equal(snapshot.event.messages.length, 0);
      assert.notEqual(snapshot.event.kind, "done");
      assert.equal(snapshot.event.dropUnconfirmedEchoes, undefined);
      const session = { id: "history", isRunning: false };
      const close = normalize({ type: "close", sessionId: "history", session });
      assert.equal(close.event.kind, "done");
      assert.equal(close.event.dropUnconfirmedEchoes, true);
      assert.strictEqual(close.session, session);
      assert.equal(
        normalize({ type: "transcript_loaded", sessionId: "history" }),
        null,
      );
      assert.equal(normalize({ type: "close" }), null);
    },
  );
}
