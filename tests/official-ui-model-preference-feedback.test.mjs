import { hostMemoryControlsRules } from "../scripts/official-ui-host-memory-controls.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import ts from "typescript";
import {
  modelPreferenceFeedbackTarget as target,
  modelPreferenceFeedbackInput as input,
  modelPreferenceFeedbackOutput as output,
  modelPreferenceFeedbackRules as rules,
  deriveOfficialModelPreferenceFeedbackModule as derive,
  applyOfficialModelPreferenceFeedback as apply,
  verifyOfficialModelPreferenceFeedbackManifest as verify,
} from "../scripts/official-ui-model-preference-feedback.mjs";
const sha = (x) => createHash("sha256").update(x).digest("hex");
const root = path.resolve(
  process.env.CLAUDEX_F012_ORIGINAL_RESOURCES ??
    "build/official-ui/ui/assets/v1",
);
const dependencies = {
  "shared-l-p-m-w-1-O9prfPUL.js":
    "0d020fb34017fdd0b57526e6dba0a57ec3826209a4f35b4ba026c4d435aad5dc",
  "shared-l-p-m-w-0-C_nAiu5o.js":
    "e715632eecebd51dbb739ec04e49ab87648d3a2aaeb31fc543ed0d58e0b8fded",
};
const raw = fs.readFileSync(path.join(root, target), "utf8");
let original = raw;
for (const rule of hostMemoryControlsRules.filter((rule) => rule.file === target).reverse())
  original = original.replace(rule.after, () => rule.before);
if (sha(original) === output) {
  for (const r of [...rules].reverse()) {
    assert.equal(original.split(r.after).length, 2);
    original = original.replace(r.after, r.before);
  }
  assert.equal(sha(original), input);
} else assert.equal(sha(original), input);
const candidate = derive(target, original),
  active =
    process.env.CLAUDEX_F012_FEEDBACK_BASELINE === "1" ? original : candidate;
const parse = (s, name = "source.js") =>
  ts.createSourceFile(name, s, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const walk = (node, pred) => {
  const out = [];
  function visit(n) {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  }
  visit(node);
  return out;
};
const one = (xs, label) => {
  assert.equal(xs.length, 1, label);
  return xs[0];
};
const fn = (tree, name) =>
  one(
    walk(tree, (n) => ts.isFunctionDeclaration(n) && n.name?.text === name),
    name,
  ).getText(tree);
const src = { q: parse(original), wrapper: null, base: null };
for (const [file, pin] of Object.entries(dependencies)) {
  const s = fs.readFileSync(path.join(root, file), "utf8");
  assert.equal(sha(s), pin);
  src[file.startsWith("shared-l-p-m-w-1") ? "wrapper" : "base"] = parse(
    s,
    file,
  );
}
const vendorText = fs.readFileSync(
  path.join(root, "vendor-query-CdfkcLg6.js"),
  "utf8",
);
// The vendor source is shared with the original F009 consumer contract; do not import a replacement query library.
const vendorPin =
  "ed628c805205ec48fedc2fb9169aba2649c4022e9abeacff3b838635b0abd764";
assert.equal(sha(vendorText), vendorPin);
function runtime() {
  const tree = parse(vendorText);
  const body = tree.statements
    .filter((n) => !ts.isImportDeclaration(n) && !ts.isExportDeclaration(n))
    .map((n) => n.getText(tree))
    .join("\n");
  const c = {
    i: () => ({}),
    t: { createContext: () => ({}) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    console,
  };
  vm.runInNewContext(
    body + "\nthis.QueryClient=Ue;this.QueryObserver=V;this.CancelledError=z;",
    c,
  );
  return c;
}
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => {
  for (let i = 0; i < 5; i++) await tick();
};
const base = () => ({
  account: { uuid: "synthetic-owner" },
  unrelated: { keep: true },
  model_selector_state: [
    {
      id: "chat",
      model: "a",
      selection_source: "default",
      thinking: { type: "effort", effort: "low" },
      thinking_by_model: [
        { id: "a", thinking: { type: "effort", effort: "low" } },
        { id: "b", thinking: { type: "disabled" } },
        { id: "c", thinking: { type: "disabled" } },
      ],
    },
    { id: "code", model: "unchanged" },
  ],
});
function harness(source = active, reader = async () => base()) {
  const real = runtime(),
    client = new real.QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      },
    }),
    key = ["current_account", "synthetic-org"];
  let reads = 0,
    epoch = 1,
    noticeVersion = "current";
  const notices = [],
    telemetry = [];
  const observer = new real.QueryObserver(client, {
    queryKey: key,
    queryFn: async ({ signal }) => {
      reads++;
      return reader(signal);
    },
    initialData: base(),
    retry: false,
    gcTime: Infinity,
    staleTime: Infinity,
  });
  const unsubscribe = observer ? observer.subscribe(() => {}) : () => {};
  const h$ = new WeakMap(),
    Kk = new Map(),
    g = {
      current: {
        scope: "synthetic-org/chat",
        send() {
          throw Error("Unexpected write retry");
        },
      },
    },
    rf = new WeakMap();
  const tree = parse(source),
    q = one(
      walk(tree, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "qO"),
      "qO",
    );
  const variable = (name) =>
    one(
      walk(
        q,
        (n) => ts.isVariableDeclaration(n) && n.name.getText(tree) === name,
      ),
      name,
    );
  const arrow = (name) =>
    one(
      walk(
        variable(name),
        (n) =>
          ts.isArrowFunction(n) &&
          n.parameters.length === (name === "y" ? 4 : 2),
      ),
      name + " arrow",
    ).getText(tree);
  const method = (name) =>
    one(
      walk(
        q,
        (n) => ts.isMethodDeclaration(n) && n.name.getText(tree) === name,
      ),
      name,
    ).getText(tree);
  const J = () => true,
    K = (...x) => x.at(-1);
  const c = {
    Map,
    Set,
    WeakMap,
    Error,
    Promise,
    DOMException,
    console,
    J9: () => [],
    J0: J,
    J1: J,
    J2: J,
    J5: J,
    K0: K,
    K1: K,
    K2: K,
    K5: K,
    tS: () => client,
    xa: () => false,
    VE: () => epoch,
    p$: () => 1,
    fS: () => false,
    ij: () => false,
    op: () => [],
    TB: JSON.stringify,
    fc: new Map(),
    ss: (e) => e?.account?.uuid,
    s6: () => {},
    s4: (_url, _method, o) => o,
    rf,
    t: "chat",
    n: client,
    r: key,
    h: "synthetic-org/chat",
    h$,
    Kk,
    g,
    _3: Error,
    Ub: (e) => e,
    rZ: (...x) => telemetry.push(x),
    o: (options) => {
      assert.equal(options.ambient, true);
      assert.equal(options.cancelRefetch, true);
      return observer
        .refetch({ cancelRefetch: options.cancelRefetch, throwOnError: true })
        .then((row) => row.data?.account);
    },
    JR: new Map(),
    NQ: () => false,
    B4: () => false,
    Lj: class extends Error {},
    kn: class extends Error {},
    vI: real.CancelledError,
    jC: () => false,
    vo: () => false,
    uX: class extends Error {},
    claudexModelPreferenceNoticeRef: {
      current: {
        active: true,
        waiting: new Set(),
        notify: (error, options) =>
          notices.push({ error, options, noticeVersion }),
      },
    },
  };
  vm.createContext(c);
  vm.runInContext(
    ["tz", "lL", "s1", "qGJ", "mM", "mH", "V6", "BO", "U9", "$n", "Vl", "qt"]
      .map((name) => fn(src.q, name))
      .join("\n") +
      "\n" +
      fn(src.base, "fC") +
      "\n" +
      fn(src.wrapper, "LH") +
      "\n" +
      fn(src.wrapper, "V9"),
    c,
  );
  c.BJ = c.LH;
  c._ = vm.runInContext("(" + arrow("_") + ")", c);
  c.y = vm.runInContext("(" + arrow("y") + ")", c);
  const updater = vm.runInContext("(" + arrow("v") + ")", c),
    onError = vm.runInContext("({" + method("onError") + "}).onError", c),
    onSuccess = vm.runInContext("({" + method("onSuccess") + "}).onSuccess", c);
  const lifecycleNode = walk(
    q,
    (node) =>
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === "OW" &&
      ts.isArrowFunction(node.arguments[0]) &&
      node.arguments[0]
        .getText(tree)
        .includes("claudexModelPreferenceNoticeRef"),
  );
  const cleanup = lifecycleNode.length
    ? vm.runInContext(
        "(" +
          one(lifecycleNode, "feedback lifecycle").arguments[0].getText(tree) +
          ")",
        c,
      )()
    : () => {};
  const opts = c.V9("/synthetic/model_selector_state/chat", "PATCH", updater, {
    queryKey: key,
    meta: { noToast: true },
    onError,
    onSuccess,
    reaskCancelledAccountRead: {
      reassert: () => {
        throw Error("No canceled bootstrap queue in this fixture");
      },
    },
  });
  async function begin(vars) {
    const seq = (Kk.get(c.h) ?? 0) + 1;
    Kk.set(c.h, seq);
    h$.set(vars, { scope: c.h, n: seq });
    const mutation = {};
    rf.set(mutation, epoch);
    return { vars, mutation, context: await opts.onMutate(vars) };
  }
  async function fail(
    operation,
    error = Object.assign(new Error("Synthetic save failure"), {
      statusCode: 503,
    }),
  ) {
    opts.onError(error, operation.vars, operation.context, operation.mutation);
    opts.onSettled(
      undefined,
      error,
      operation.vars,
      operation.context,
      operation.mutation,
    );
    await flush();
  }
  function succeed(operation, row) {
    opts.onSuccess(row, operation.vars, operation.context, operation.mutation);
    opts.onSettled(
      row,
      null,
      operation.vars,
      operation.context,
      operation.mutation,
    );
  }
  return {
    client,
    key,
    opts,
    begin,
    fail,
    succeed,
    notices,
    telemetry,
    get reads() {
      return reads;
    },
    get value() {
      return structuredClone(client.getQueryData(key));
    },
    get waiting() {
      return c.claudexModelPreferenceNoticeRef.current.waiting.size;
    },
    unmount() {
      cleanup();
    },
    scope(v) {
      cleanup();
      g.current.scope = v;
    },
    move() {
      epoch++;
    },
    notice(v) {
      noticeVersion = v;
    },
    cancel: () => new real.CancelledError({ silent: true }),
    close() {
      cleanup();
      unsubscribe();
      client.clear();
    },
  };
}
test("exact derivation and inverse final-resource input; unchanged memo slots and no global mutation change", () => {
  assert.equal(sha(candidate), output);
  assert.equal(
    candidate,
    rules.reduce((s, r) => s.replace(r.before, r.after), original),
  );
  assert.equal(
    candidate.split("J9(98)").length,
    original.split("J9(98)").length,
  );
  assert(candidate.includes("x = J0($, 12) ? K0($, 12, { noToast: !0 })"));
  const q = one(
    walk(
      parse(candidate),
      (n) => ts.isFunctionDeclaration(n) && n.name?.text === "qO",
    ),
    "qO",
  );
  assert.equal(q.body.statements[0].kind, ts.SyntaxKind.VariableStatement);
  for (const name of [
    "claudexModelPreferenceNotices",
    "claudexModelPreferenceNoticeRef",
  ])
    assert(!original.includes(name));
  assert.throws(() => derive(target, original + " "), /input mismatch/);
  assert.throws(() => derive(target, candidate), /input mismatch/);
});
test("current model save failure emits one original notice and rereads actual authority, including committed-but-unacknowledged", async () => {
  for (const committed of [false, true]) {
    const authority = base();
    if (committed) authority.model_selector_state[0].model = "b";
    const h = harness(active, async () => authority);
    try {
      const op = await h.begin({ model: "b" });
      assert.equal(h.value.model_selector_state[0].model, "b");
      await h.fail(op);
      assert.equal(h.notices.length, 1);
      assert.equal(h.notices[0].options.genericIfHidden, true);
      assert.equal(h.reads, 1);
      assert.equal(
        h.value.model_selector_state[0].model,
        committed ? "b" : "a",
      );
      assert.equal(h.value.model_selector_state[1].model, "unchanged");
    } finally {
      h.close();
    }
  }
});
test("thinking-only failure reconciles effort without writing or swallowing the error", async () => {
  const h = harness();
  try {
    const op = await h.begin({ thinking: { type: "effort", effort: "high" } });
    await h.fail(op);
    assert.equal(h.notices.length, 1);
    assert.equal(h.reads, 1);
    assert.equal(h.value.model_selector_state[0].thinking.effort, "low");
  } finally {
    h.close();
  }
});
test("original failure contract red evidence leaves optimistic model and no notice before the transform", async () => {
  const h = harness(original);
  try {
    await h.fail(await h.begin({ model: "b" }));
    assert.equal(h.value.model_selector_state[0].model, "b");
    assert.equal(h.notices.length, 0);
    assert.equal(h.reads, 0);
  } finally {
    h.close();
  }
});
test("read failure never fabricates rollback or success and never retries the preference write", async () => {
  const h = harness(active, async () => {
    throw Error("Synthetic authority unavailable");
  });
  try {
    await h.fail(await h.begin({ model: "b" }));
    assert.equal(h.notices.length, 1);
    assert.equal(h.reads, 1);
    assert.equal(h.value.model_selector_state[0].model, "b");
    assert.equal(h.client.getQueryState(h.key).status, "error");
  } finally {
    h.close();
  }
});
test("superseded write, switched scope, document ABA and cancellation do not notify or refetch", async () => {
  for (const mode of ["newer", "scope", "aba", "abort", "query-cancel"]) {
    const h = harness();
    try {
      const old = await h.begin({ model: "b" });
      if (mode === "newer") await h.begin({ model: "c" });
      if (mode === "scope") h.scope("other/chat");
      if (mode === "aba") h.move();
      const error =
        mode === "abort"
          ? new DOMException("Synthetic canceled", "AbortError")
          : mode === "query-cancel"
            ? h.cancel()
            : undefined;
      await h.fail(old, error);
      assert.equal(h.notices.length, 0, mode);
      assert.equal(h.reads, 0, mode);
      if (mode === "newer")
        assert.equal(h.value.model_selector_state[0].model, "c");
    } finally {
      h.close();
    }
  }
});
test("original QueryClient cancels a failure refetch before a newer choice; late read cannot overwrite the new success", async () => {
  let resolveRead;
  const pending = new Promise((r) => (resolveRead = r));
  const h = harness(active, () => pending);
  try {
    const first = await h.begin({ model: "b" });
    await h.fail(first);
    assert.equal(h.reads, 1);
    const second = await h.begin({ model: "c" });
    h.succeed(second, {
      id: "chat",
      model: "c",
      thinking: { type: "disabled" },
      selection_source: "user_setting",
    });
    resolveRead(base());
    await flush();
    assert.equal(h.value.model_selector_state[0].model, "c");
    assert.equal(h.notices.length, 1);
    assert.equal(h.reads, 1);
  } finally {
    h.close();
  }
});
test("failure cancels a pre-existing stale account read and starts a post-failure authoritative read", async () => {
  let releaseOld,
    calls = 0;
  const oldRead = new Promise((r) => (releaseOld = r)),
    authority = base();
  authority.model_selector_state[0].model = "b";
  const h = harness(active, () =>
    ++calls === 1 ? oldRead : Promise.resolve(authority),
  );
  try {
    const op = await h.begin({ model: "b" });
    const oldTask = h.client.refetchQueries({ queryKey: h.key, exact: true });
    await tick();
    assert.equal(h.reads, 1);
    await h.fail(op);
    assert.equal(h.notices.length, 1);
    assert.equal(h.reads, 2);
    assert.equal(h.value.model_selector_state[0].model, "b");
    releaseOld(base());
    await oldTask;
    await flush();
    assert.equal(h.value.model_selector_state[0].model, "b");
  } finally {
    h.close();
  }
});
test("success and existing extra-option failure keep the original callbacks without new notice or read", async () => {
  const h = harness();
  try {
    const op = await h.begin({ model: "b" });
    h.succeed(op, {
      id: "chat",
      model: "b",
      thinking: { type: "disabled" },
      selection_source: "user_setting",
    });
    assert.equal(h.value.model_selector_state[0].model, "b");
    assert.equal(h.notices.length, 0);
    assert.equal(h.reads, 0);
    await h.fail(
      await h.begin({ model: "b", extra_option: "existing-special" }),
    );
    assert.equal(h.notices.length, 0);
    assert.equal(h.reads, 0);
  } finally {
    h.close();
  }
});
test("scoped assembly and manifest are pinned, reject tampering, and cannot reapply", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-feedback-"));
  try {
    fs.writeFileSync(path.join(dir, target), original);
    const meta = apply(dir),
      files = [{ path: "assets/v1/" + target, sha256: output }];
    verify(meta, files, output);
    assert.throws(
      () => verify({ ...meta, revision: "unknown" }, files, output),
      /manifest mismatch/,
    );
    assert.throws(
      () => verify(meta, files, "a".repeat(64)),
      /manifest mismatch/,
    );
    assert.throws(() => apply(dir), /input mismatch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same Chat rapid choices wait for the older pending save before reconciling the newer failure", async () => {
  let releaseWrite,
    releaseRead,
    authority = base();
  const pendingWrite = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const h = harness(active, () => {
    const captured = structuredClone(authority);
    return new Promise((resolve) => {
      releaseRead = () => resolve(captured);
    });
  });
  let writeTask;
  try {
    const first = await h.begin({ model: "b" });
    const mutation = h.client.getMutationCache().build(h.client, {
      mutationFn: () => pendingWrite,
      onSuccess: () => {
        authority.model_selector_state[0] = {
          id: "chat",
          model: "b",
          thinking: { type: "disabled" },
          selection_source: "user_setting",
        };
        h.succeed(first, authority.model_selector_state[0]);
      },
    });
    writeTask = mutation.execute({ model: "b" });
    await tick();
    const second = await h.begin({ model: "c" });
    await h.fail(second);
    assert.equal(h.notices.length, 1);
    releaseWrite();
    await writeTask;
    await flush();
    assert.equal(h.reads, 1);
    releaseRead();
    await flush();
    assert.equal(h.value.model_selector_state[0].model, "b");
    assert.equal(h.value.model_selector_state[1].model, "unchanged");
  } finally {
    releaseWrite?.();
    await writeTask;
    releaseRead?.();
    await flush();
    h.close();
  }
});

test("a waiting reconciliation unsubscribes on scope retirement or unmount and never reads later", async () => {
  for (const mode of ["scope", "unmount"]) {
    let finish;
    const h = harness();
    const task = h.client
      .getMutationCache()
      .build(h.client, {
        mutationFn: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      })
      .execute({ synthetic: true });
    try {
      await tick();
      const op = await h.begin({ model: "b" });
      await h.fail(op);
      assert.equal(h.notices.length, 1);
      assert.equal(h.waiting, 1);
      assert.equal(h.reads, 0);
      if (mode === "scope") h.scope("other/chat");
      else h.unmount();
      assert.equal(h.waiting, 0);
      finish();
      await task;
      await flush();
      assert.equal(h.reads, 0);
      assert.equal(h.notices.length, 1);
      await h.fail(op);
      assert.equal(h.notices.length, 1);
    } finally {
      finish?.();
      await task;
      h.close();
    }
  }
});

test("original Chat draft selection remains separate from recovered account preference and clears on remount or scope change", async () => {
  const consumerFiles = {
    "shared-28-CcQ2xpO-.js":
      "7546473cea295ce6b8f8dd7910333c71de988a2c53bad6bb96cc45f508727544",
    "shared-3-f8anTwq9.js":
      "9b9d6471a82ab5a1a2869a91312451de9be029c6ec95b15157484e54128f14f6",
  };
  const trees = Object.entries(consumerFiles).map(([file, pin]) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(sha(source), pin);
    return parse(source, file);
  });
  const [composer, draft] = trees;
  const declaration = (name, condition = () => true) =>
    one(
      walk(
        composer,
        (node) =>
          ts.isVariableDeclaration(node) &&
          node.name.getText(composer) === name &&
          condition(node),
      ),
      name,
    );
  const arrowFor = (name) =>
    one(
      walk(
        declaration(
          name,
          (node) =>
            ts.isCallExpression(node.initializer) &&
            node.initializer.expression.getText(composer) === "pd",
        ),
        ts.isArrowFunction,
      ),
      name + " callback",
    ).getText(composer);
  const draftChoice = declaration("zi", (node) =>
    node.initializer?.getText(composer).includes("Ri ? void 0 : ei"),
  ).initializer.getText(composer);
  const sendModel = one(
    walk(
      composer,
      (node) =>
        ts.isPropertyAssignment(node) &&
        node.name.getText(composer) === "modelOverride" &&
        node.initializer.getText(composer) === "$i",
    ),
    "actual send model override",
  ).getText(composer);
  const h = harness();
  let operation,
    slots = [],
    slot = 0;
  const c = {
    J9: () => [],
    J1: () => true,
    K1: (...values) => values.at(-1),
    bw(initial) {
      const index = slot++;
      if (!(index in slots))
        slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (value) => {
          slots[index] =
            typeof value === "function" ? value(slots[index]) : value;
        },
      ];
    },
    $r: undefined,
    P: undefined,
    ni() {},
    li: false,
    oi() {},
    zn() {},
    M: false,
    Tt: false,
    C$: () => false,
    wt: undefined,
    dt: { push() {} },
    xy: "unused",
    Es() {},
    _c: undefined,
    hi: (model) => {
      operation = h.begin({ model });
    },
    Ri: false,
    ji: () => false,
  };
  vm.createContext(c);
  vm.runInContext(fn(draft, "AT"), c);
  const renderDraft = (scope) => {
    slot = 0;
    return c.AT(scope, undefined);
  };
  try {
    let [value, setter] = renderDraft(undefined);
    assert.equal(value, undefined);
    c.Qr = setter;
    for (const name of ["hc", "gc", "vc"])
      c[name] = vm.runInContext("(" + arrowFor(name) + ")", c);
    await c.vc("b");
    await h.fail(await operation);
    assert.equal(h.notices.length, 1);
    assert.equal(h.reads, 1);
    assert.equal(h.value.model_selector_state[0].model, "a");
    [c.ei] = renderDraft(undefined);
    assert.equal(
      c.ei,
      "b",
      "account failure does not discard the user's current draft selection",
    );
    c.pi = c.mi = h.value.model_selector_state[0].model;
    c.$i = vm.runInContext(draftChoice, c);
    assert.equal(c.$i, "b");
    assert.equal(
      vm.runInContext("({" + sendModel + "})", c).modelOverride,
      "b",
    );
    [c.ei] = renderDraft("different-conversation");
    assert.equal(c.ei, undefined);
    assert.equal(vm.runInContext(draftChoice, c), "a");
    slots = [];
    [c.ei] = renderDraft(undefined);
    assert.equal(c.ei, undefined);
    assert.equal(
      vm.runInContext(draftChoice, c),
      "a",
      "new mounted composer uses the recovered default",
    );
  } finally {
    h.close();
  }
});
