import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import {
  applyOfficialChatSearchReadiness,
  deriveOfficialChatSearchReadinessModule,
  verifyOfficialChatSearchReadinessManifest,
  chatSearchReadinessRevision,
  chatSearchReadinessTarget,
  chatSearchReadinessInput,
  chatSearchReadinessOutput,
  chatSearchReadinessRule,
} from "../scripts/official-ui-chat-search-readiness.mjs";

const resources = path.resolve(
  process.env.F020_OFFICIAL_ASSETS ?? "build/official-ui/ui/assets/v1",
);
const files = {
  palette: [chatSearchReadinessTarget, chatSearchReadinessInput],
  classifier: [
    "c74dd5c13-Bl8_Yxcy.js",
    "3074b1fd3017dc59810a11ef08a5c0e8d530e5f4484322a56faef07fae03ed80",
  ],
  labels: [
    "c4694c322-Bbsc_Scp.js",
    "d81df96777145559ce46a28e303abf5057a03420f054552acb3e6ee7b3c766c6",
  ],
};
const available = Object.values(files).every(([name]) =>
  fs.existsSync(path.join(resources, name)),
);
const resourceOptions = {
  skip: available
    ? false
    : "Pinned official resources are required; set F020_OFFICIAL_ASSETS after official assembly.",
};
const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
function source(key: keyof typeof files) {
  const [name, hash] = files[key];
  let value = fs.readFileSync(path.join(resources, name), "utf8");
  if (key === "palette" && sha(value) === chatSearchReadinessOutput) {
    assert.equal(value.split(chatSearchReadinessRule.after).length, 2);
    value = value.replace(
      chatSearchReadinessRule.after,
      chatSearchReadinessRule.before,
    );
  }
  assert.equal(sha(value), hash, `Unknown official resource: ${name}`);
  return value;
}
function ast(s: string) {
  return ts.createSourceFile(
    "official.js",
    s,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}
function one(root: ts.Node, predicate: (node: ts.Node) => boolean) {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.equal(matches.length, 1);
  return matches[0];
}
function fn(root: ts.SourceFile, name: string) {
  return one(
    root,
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  ).getText(root);
}
function declaration(
  root: ts.SourceFile,
  name: string,
  within: ts.Node = root,
): ts.VariableDeclaration {
  return one(
    within,
    (n) => ts.isVariableDeclaration(n) && n.name.getText(root) === name,
  ) as ts.VariableDeclaration;
}
function evaluate(expression: string, env: Record<string, unknown>) {
  return vm.runInNewContext(`(${expression})`, env, { timeout: 1000 });
}
const gateNames = [
  "we",
  "kt",
  "Pt",
  "ze",
  "vt",
  "ut",
  "Vt",
  "Xe",
  "et",
  "Gt",
  "Tt",
];
function contract(useOriginal = process.env.F020_READINESS_BASELINE === "1") {
  const original = source("palette");
  const root = ast(
    useOriginal
      ? original
      : deriveOfficialChatSearchReadinessModule(
          chatSearchReadinessTarget,
          original,
        ),
  );
  const sf = one(
    root,
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "Sf",
  );
  const expr = (name: string) =>
    declaration(root, name, sf).initializer!.getText(root);
  const empty = one(
    sf,
    (n) =>
      ts.isVariableDeclaration(n) &&
      n.name.getText(root) === "n" &&
      n.initializer?.getText(root).includes("nn?.listingsFailed === !0") === true,
  ) as ts.VariableDeclaration;
  return (overrides: Record<string, unknown> = {}, count = 0) => {
    const env: Record<string, unknown> = {
      ...Object.fromEntries(gateNames.map((name) => [name, true])),
      D: { type: "chat" },
      Gt: false,
      Se: true,
      tn: true,
      _n: true,
      mn: false,
      Ce: false,
      nn: { listingsPending: false, listingsFailed: false },
      k: true,
      yt: false,
      Ft: false,
      hn: false,
      Sn: "same-query",
      bn: "same-query",
      Ge: false,
      gn: false,
      e: Array(count).fill({}),
      ...overrides,
    };
    for (const name of ["vn", "yn", "xn", "En"])
      env[name] = evaluate(expr(name), env);
    env.t = count === 0 && env.yn;
    const filteredEmpty = evaluate(empty.initializer!.getText(root), env);
    const visible = evaluate(
      `(${fn(root, "Hp")})({nothingListed: true, typedRowless: false, noResults: true, searchFailed: false, filteredEmpty})`,
      { filteredEmpty },
    );
    return { ready: env.yn, filteredEmpty, visible };
  };
}

test(
  "Original labels and item classifier bind displayed Sessions to Chat, not Code",
  resourceOptions,
  () => {
    const labels = ast(source("labels"));
    const labelFn = one(
      labels,
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === "L",
    );
    const labelMap = one(
      labelFn,
      (n) =>
        ts.isVariableDeclaration(n) &&
        n.name.getText(labels) === "g" &&
        !!n.initializer &&
        ts.isObjectLiteralExpression(n.initializer) &&
        n.initializer.getText(labels).includes("chat: n ? o"),
    ) as ts.VariableDeclaration;
    const expr = labelMap.initializer!.getText(labels);
    const format = {
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    };
    const current = evaluate(expr, { n: true, o: "Sessions", r: format });
    const legacy = evaluate(expr, { n: false, o: "Sessions", r: format });
    assert.equal(current.chat, "Sessions");
    assert.equal(current.session, "Code");
    assert.equal(legacy.chat, "Chats");
    assert.equal(legacy.session, "Sessions");
    const root = ast(source("classifier"));
    const classify = evaluate(
      `(function(){${fn(root, "Le")} return ${fn(root, "ze")}})()`,
      {},
    );
    const filter = evaluate(
      `(function(){${fn(root, "Y")} ${fn(root, "He")} return ${fn(root, "Ue")}})()`,
      { W: "artifact:", U: "person:", Be: 3600000, Ve: 86400000 },
    );
    const filters = {
      owner: null,
      active: null,
      type: "chat",
      repo: null,
      project: null,
      archived: null,
    };
    assert.equal(
      filter(
        classify({ type: "conversation", data: {} }, undefined),
        0,
        filters,
        0,
      ),
      true,
    );
    assert.equal(
      filter(classify({ type: "scheduled_task" }, undefined), 0, filters, 0),
      false,
    );
    assert.equal(
      filter(
        classify({ type: "thread", projectId: "synthetic" }, undefined),
        0,
        filters,
        0,
      ),
      false,
    );
  },
);

test(
  "Chat empty results settle without a scheduled inventory, before and after original timeout",
  resourceOptions,
  () => {
    const run = contract();
    for (const Sn of [null, "same-query"])
      assert.equal(run({ Sn }).visible, "nothing");
    assert.equal(contract(true)().visible, "failed");
  },
);

test(
  "All, Code/session, Scheduled and other filter types retain original readiness",
  resourceOptions,
  () => {
    for (const D of [
      null,
      {},
      { type: null },
      { type: "session" },
      { type: "scheduled" },
      { type: "project" },
      { type: "task" },
      { type: "artifact" },
    ]) {
      assert.deepEqual(contract()({ D }), contract(true)({ D }));
      assert.equal(contract()({ D }).ready, false);
    }
  },
);

test(
  "Actual Chat errors and every other required provider remain errors or pending",
  resourceOptions,
  () => {
    const run = contract();
    assert.equal(run({ Ce: true }).visible, "failed");
    assert.equal(
      run({ nn: { listingsPending: false, listingsFailed: true }, Se: false })
        .visible,
      "failed",
    );
    for (const name of gateNames.filter((name) => name !== "Gt")) {
      assert.equal(run({ [name]: false }).visible, "failed", name);
      assert.equal(
        run({ [name]: false, Sn: null }).filteredEmpty,
        "waiting",
        name,
      );
    }
    assert.equal(run({ tn: false, gn: true }).filteredEmpty, "waiting");
  },
);

test(
  "Existing rows, suspended queries and settled inventories keep original empty decisions",
  resourceOptions,
  () => {
    const run = contract(),
      original = contract(true);
    assert.equal(run({}, 2).visible, null);
    assert.equal(
      run({ Ge: true }).filteredEmpty,
      original({ Ge: true }).filteredEmpty,
    );
    assert.equal(run({ Ge: true }).visible, original({ Ge: true }).visible);
    assert.deepEqual(run({ Gt: true }), original({ Gt: true }));
    // No query/timer is forced: the original k/xn gating and query-specific timer remain intact.
    assert.equal(run({ k: false, D: null, Sn: null }).filteredEmpty, "waiting");
  },
);

test(
  "Derivation is one pinned replacement and does not rewrite unknown modules",
  resourceOptions,
  () => {
    const input = source("palette"),
      output = deriveOfficialChatSearchReadinessModule(
        chatSearchReadinessTarget,
        input,
      );
    assert.equal(sha(output), chatSearchReadinessOutput);
    assert.equal(
      output.replace(
        chatSearchReadinessRule.after,
        chatSearchReadinessRule.before,
      ),
      input,
    );
    assert.equal(
      deriveOfficialChatSearchReadinessModule("unrelated.js", input),
      input,
    );
    assert.throws(
      () =>
        deriveOfficialChatSearchReadinessModule(
          chatSearchReadinessTarget,
          input + "\n",
        ),
      /pinned input/,
    );
    assert.throws(
      () =>
        deriveOfficialChatSearchReadinessModule(
          chatSearchReadinessTarget,
          output,
        ),
      /pinned input/,
    );
    assert.equal(output.includes("SYNTHETIC_F020_PALETTE_STATE="), false);
  },
);

test(
  "Assembly writes a separate target and strict manifest rejects forged output and extra fields",
  resourceOptions,
  () => {
    const dir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "f020-ready-"),
    );
    try {
      fs.writeFileSync(
        path.join(dir, chatSearchReadinessTarget),
        source("palette"),
      );
      const manifest = applyOfficialChatSearchReadiness(dir);
      const rows = [
        {
          path: "assets/v1/" + chatSearchReadinessTarget,
          sha256: chatSearchReadinessOutput,
        },
      ];
      verifyOfficialChatSearchReadinessManifest(
        manifest,
        rows,
        chatSearchReadinessOutput,
      );
      for (const bad of [
        null,
        false,
        [],
        { ...manifest, extra: true },
        { ...manifest, revision: "unknown" },
      ])
        assert.throws(() =>
          verifyOfficialChatSearchReadinessManifest(
            bad,
            rows,
            chatSearchReadinessOutput,
          ),
        );
      const forged = "0".repeat(64);
      assert.throws(() =>
        verifyOfficialChatSearchReadinessManifest(
          {
            ...manifest,
            modules: [{ ...manifest.modules[0], outputSha256: forged }],
          },
          [{ ...rows[0], sha256: forged }],
          forged,
        ),
      );
      assert.throws(() =>
        verifyOfficialChatSearchReadinessManifest(
          manifest,
          [...rows, ...rows],
          chatSearchReadinessOutput,
        ),
      );
      assert.throws(
        () => applyOfficialChatSearchReadiness(dir),
        /pinned input/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("Exact release assembly wiring applies after existing transforms and validates final bytes", () => {
  const base = path.resolve(import.meta.dirname, "../scripts");
  const build = fs.readFileSync(
    path.join(base, "build-official-ui.mjs"),
    "utf8",
  );
  const verifier = fs.readFileSync(
    path.join(base, "official-web-assets.mjs"),
    "utf8",
  );
  assert.ok(
    build.indexOf("applyOfficialChatSearchReadiness(modulesDir)") >
      build.indexOf("applyOfficialStopFeedback(modulesDir)"),
  );
  assert.match(build, /hostChatSearchReadiness,/);
  assert.match(verifier, /meta\.hostChatSearchReadiness != null/);
  assert.match(
    verifier,
    /deriveOfficialChatSearchReadinessModule\(name, stopAware\)/,
  );
  assert.match(
    verifier,
    /deriveOfficialModelPreferenceFeedbackModule\(name, chatSearchReady\)/,
  );
  assert.match(
    verifier,
    /verifyOfficialChatSearchReadinessManifest\(meta\.hostChatSearchReadiness, files, expectedChatSearchReadinessOutput\)/,
  );
  assert.match(
    verifier,
    /hostChatSearchReadiness: meta\.hostChatSearchReadiness \?\? null/,
  );
  assert.equal(
    chatSearchReadinessRevision,
    "original-chat-search-readiness-v1",
  );
});
