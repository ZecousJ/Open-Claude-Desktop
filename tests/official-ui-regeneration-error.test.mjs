import { beforeF014Stop } from "./support/f014-resource-chain.mjs";
/** Pinned original flush/prune/settlement and notice branch. No DOM or provider execution. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
import {
  deriveOfficialRegenerationErrorModule,
  applyOfficialRegenerationError,
  verifyOfficialRegenerationErrorManifest,
  regenerationErrorRevision,
  regenerationErrorTarget,
  regenerationErrorInput,
  regenerationErrorBefore,
  regenerationErrorAfter,
} from "../scripts/official-ui-regeneration-error.mjs";
const assets = path.resolve(
  process.env.CLAUDEX_F006_ORIGINAL_RESOURCES ??
    "build/official-ui/ui/assets/v1",
);
const sha = (s) => createHash("sha256").update(s).digest("hex");
let source = fs.readFileSync(
  path.join(assets, regenerationErrorTarget),
  "utf8",
);
source = beforeF014Stop(regenerationErrorTarget, source);
// Final assembled input is accepted only after the exact inverse and full hash check.
const finalHash =
  "87194090ced9e671d94d8b6dece3bf02e344e23b4f970447ec172c0a6e3ed781";
if (sha(source) === finalHash) {
  const final = source;
  assert.equal(final.split(regenerationErrorAfter).length, 2);
  source = final.replace(regenerationErrorAfter, regenerationErrorBefore);
  assert.equal(sha(source), regenerationErrorInput);
  assert.equal(
    deriveOfficialRegenerationErrorModule(regenerationErrorTarget, source),
    final,
  );
}
assert.equal(sha(source), regenerationErrorInput);
const candidate = deriveOfficialRegenerationErrorModule(
  regenerationErrorTarget,
  source,
);
function extract(code) {
  const ast = ts.createSourceFile(
    "pinned-hub.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let cls, notice;
  function visit(n) {
    if (ts.isVariableDeclaration(n) && n.name.getText(ast) === "U$")
      cls = n.initializer;
    if (
      ts.isIfStatement(n) &&
      n.expression.getText(ast).includes('trigger: T ? "reap"') &&
      n.thenStatement.getText(ast).includes('kind: "regeneration"')
    )
      notice = n;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(cls && notice);
  const names = [
    "ownsSession",
    "ownsMark",
    "foreignSeenOnce",
    "settleError",
    "disposeFailures",
    "isSuperseded",
    "drainFailureNotices",
    "keepOptimisticSendsLast",
    "repointLeafAtWaitingSends",
    "deepestWaitingSendRow",
    "waitingTailSendIds",
    "tailLinkSendIds",
    "pendingStubOfServedLeafSend",
    "isOptimisticSendRow",
    "pruneConfirmed",
    "awaitingServerVerdict",
    "heldAsQueued",
    "heldRowFor",
    "residualSendIdOf",
    "announcedAheadOfShadow",
    "forwardedPendingSend",
    "unvouchedPendingSend",
    "acceptedPendingSend",
    "pendingSendAcceptedAt",
    "pendingSendAccepted",
    "recordedPendingSend",
    "awaitsReread",
    "snapshotCoversPending",
    "flush",
    "processPendingFailures",
    "retireDisplacedStubs",
  ];
  const methods = names.map((name) => {
    const m = cls.members.find(
      (m) => ts.isMethodDeclaration(m) && m.name.getText(ast) === name,
    );
    assert.ok(m, name);
    return m.getText(ast);
  });
  const defs = ["cv", "eA", "Q$"]
    .map((name) => {
      const n = ast.statements.find(
        (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
      );
      assert.ok(n, name);
      return n.getText(ast);
    })
    .join("\n");
  return {
    methods: vm.runInNewContext(`${defs};({${methods.join(",")}})`, {
      tu: { NOT_SENT: 3, QUEUED: 2 },
      e: { FOREIGN_SEEN_CAP: 100 },
      Y: { USER: 1, ASSISTANT: 2 },
      pv: new Set(),
      fb() {},
    }),
    notice: notice.getText(ast),
  };
}
function gate(methods) {
  return {
    ...methods,
    session: { ownedSessionIds: new Set(["self"]) },
    floorVersion: 0n,
    latestVersion: 1n,
    ackedVersion: 1n,
    foreignSeen: new Set(),
    pendingFailures: [],
    failedVersions: new Map(),
    retryStubByVersion: new Map([[1n, "new-assistant"]]),
    sentByVersion: new Map(),
    markedByVersion: new Map(),
    noticeQueue: [],
    queuedSendIds: [],
    leafComposedSendIds: new Set(),
    residualJoinedAt: new Map(),
    overlay: {
      messages: new Map([
        [
          "new-assistant",
          {
            id: "new-assistant",
            role: 2,
            isComplete: false,
            parentMessageId: "first:user",
          },
        ],
      ]),
      displayGroups: new Map(),
      contentBlocks: new Map(),
    },
    shadow: {
      authoritativeReady: true,
      messages: new Map([["first:user", { id: "first:user", role: 1 }]]),
      hasRowFor: (id) => id === "first:user",
      canonicalRowFor: (id) =>
        id === "first:user" ? { id, role: 1 } : undefined,
      ownSendOfStub: () => undefined,
      conversation: {},
      heldSendFor: () => undefined,
    },
    outcomeAcks: true,
    announcedHeld: new Map(),
    lastHeldRow: new Map(),
    deferredHandBacks: new Map(),
    rowsByVersion: new Map(),
    acceptedVersions: new Map(),
    awaitingReread: new Map(),
    pendingRideThrough: false,
    bufferedDials: [],
    uncoveredSnapshots: new Set(),
    buffer: [],
    // Only unrelated notifications/held-card bookkeeping are inert. All snapshot
    // eligibility, retirement, error deduplication and notice decisions are original.
    absorbServerEvent() {},
    promoteSnapshotHeldSends() {},
    settleEchoedRecords() {},
    settleDeferredHandBacks() {},
    stampSettledResiduals() {},
    judgeAcceptedBehindTurn() {},
    answersKeptAcrossSnapshot: () => new Map(),
    rowEditsKeptAcrossSnapshot: () => new Map(),
    reportFieldsLeftAtBase() {},
    sweepAnnouncements() {},
  };
}
const error = {
  action: "send_message",
  messageId: "",
  error: {
    type: "api_error",
    retryable: false,
    displayMessage: "Self-authored rejected request",
  },
};
function noticesFor(
  which,
  { snapshot = true, foreign = false, applied = false, repeat = false } = {},
) {
  const x = extract(which),
    g = gate(x.methods),
    mark = { sessionId: foreign ? "foreign" : "self", version: 1n };
  if (snapshot)
    g.buffer = [
      {
        event: {
          case: "update",
          value: { replaceAllState: true, mutationAcks: [], messages: [] },
        },
      },
    ];
  if (!applied) g.settleError(mark, error);
  g.flush(1);
  let notices = g.drainFailureNotices();
  if (repeat) {
    g.settleError(mark, error);
    g.flush(2);
    notices.push(...g.drainFailureNotices());
  }
  return { x, g, notices };
}
function notify(x, notices) {
  const result = [];
  vm.runInNewContext(
    `for(const o of notices){const O=o.rejectedRetry??o.droppedRetry,T=false,h=o.failure.error?.type,f=o.failure.error?.type,p=o.failure.error?.retryable,g=o.failure.error?.displayMessage;${x.notice}}`,
    {
      notices,
      R: { cadence: {} },
      vW() {},
      gy() {
        return {};
      },
      an: (entry) => result.push(entry),
    },
  );
  return result;
}
test("original full flush retires the stub before failure disposal and loses the regeneration notice", () => {
  const { x, g, notices } = noticesFor(source);
  assert.equal(g.overlay.messages.size, 0);
  assert.equal(g.retryStubByVersion.size, 0);
  assert.equal(notices[0].droppedRetry, undefined);
  assert.equal(notices[0].rejectedRetry.id, "new-assistant");
  assert.equal(notify(x, notices).length, 0);
});
test("derived notice branch preserves the original error entry after that exact full flush", () => {
  const { x, g, notices } = noticesFor(
    process.env.F006_RED_ORIGINAL === "1" ? source : candidate,
  );
  const entries = notify(x, notices);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "new-assistant");
  assert.equal(entries[0].kind, "regeneration");
  assert.equal(entries[0].displayMessage, error.error.displayMessage);
  assert.equal(entries[0].retryable, false);
  assert.equal(g.overlay.messages.size, 0);
});
test("no buffered snapshot retains the existing droppedRetry notice exactly once", () => {
  for (const code of [source, candidate]) {
    const { x, notices } = noticesFor(code, { snapshot: false, repeat: true });
    assert.equal(notices.length, 1);
    assert.equal(notices[0].droppedRetry.id, "new-assistant");
    assert.equal(notify(x, notices).length, 1);
  }
});
test("duplicate error ACK after a buffered snapshot produces one notice and no replay", () => {
  const { x, notices } = noticesFor(candidate, { repeat: true });
  assert.equal(notices.length, 1);
  assert.equal(notify(x, notices).length, 1);
});
test("successful flush and foreign errors produce no regeneration error entry", () => {
  for (const options of [{ applied: true }, { foreign: true }]) {
    const { x, notices } = noticesFor(candidate, options);
    assert.equal(notify(x, notices).length, 0);
  }
});
test("rejected fallback excludes superseded, foreign, missing-error and unrelated actions", () => {
  const { x, notices } = noticesFor(candidate);
  for (const change of [
    { superseded: true },
    { foreign: true },
    { failure: { ...error, error: undefined } },
    { failure: { ...error, action: "star_conversation" } },
  ])
    assert.equal(notify(x, [{ ...notices[0], ...change }]).length, 0);
});
test("derivation is exact and unrelated inputs remain byte-identical", () => {
  assert.equal(sha(candidate), finalHash);
  assert.equal(
    deriveOfficialRegenerationErrorModule("unrelated.js", "unchanged"),
    "unchanged",
  );
  assert.throws(() =>
    deriveOfficialRegenerationErrorModule(
      regenerationErrorTarget,
      source + " ",
    ),
  );
  assert.throws(() =>
    deriveOfficialRegenerationErrorModule(regenerationErrorTarget, candidate),
  );
  assert.equal(
    candidate.replace(regenerationErrorAfter, regenerationErrorBefore),
    source,
  );
  assert.equal(
    candidate.split("id: (o.droppedRetry ?? o.rejectedRetry).id,").length,
    2,
  );
});
test("assembly and manifest checks are bounded and reject links, malformed or duplicate outputs", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "f006-regeneration-"));
  try {
    fs.writeFileSync(path.join(dir, regenerationErrorTarget), source);
    const manifest = applyOfficialRegenerationError(dir),
      files = [
        {
          path: "assets/v1/" + regenerationErrorTarget,
          sha256: sha(candidate),
        },
      ];
    assert.equal(manifest.revision, regenerationErrorRevision);
    assert.equal(
      fs.readFileSync(path.join(dir, regenerationErrorTarget), "utf8"),
      candidate,
    );
    verifyOfficialRegenerationErrorManifest(manifest, files, sha(candidate));
    for (const bad of [null, false, {}, { ...manifest, revision: "unknown" }])
      assert.throws(() =>
        verifyOfficialRegenerationErrorManifest(bad, files, sha(candidate)),
      );
    assert.throws(() =>
      verifyOfficialRegenerationErrorManifest(
        manifest,
        [...files, ...files],
        sha(candidate),
      ),
    );
    assert.throws(() =>
      verifyOfficialRegenerationErrorManifest(manifest, files, "0".repeat(64)),
    );
    const link = path.join(dir, "link");
    fs.symlinkSync(dir, link);
    assert.throws(() => applyOfficialRegenerationError(link));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("existing droppedRetry keeps its ID when both retry identifiers are present", () => {
  const { x, notices } = noticesFor(candidate);
  const entries = notify(x, [
    {
      ...notices[0],
      droppedRetry: { id: "original-dropped" },
      rejectedRetry: { id: "different-rejected" },
    },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "original-dropped");
});
