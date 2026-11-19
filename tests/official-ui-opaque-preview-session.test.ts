/** State-machine tests only. Inert strings are never executed or served. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpaquePreviewSession,
  type PreviewPort,
} from "../electron/official-ui/opaque-preview-session";
class Port implements PreviewPort {
  onmessage: PreviewPort["onmessage"] = null;
  sent: unknown[] = [];
  closed = 0;
  postMessage(v: unknown) {
    this.sent.push(v);
  }
  close() {
    this.closed++;
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}
function fixture() {
  const originalWindow = {},
    originalActivation = {};
  let currentWindow: unknown = originalWindow,
    connected = true,
    now = 0;
  let lease: any = {
    account: "synthetic",
    activation: originalActivation,
    window: "native-window",
  };
  let expire = () => {},
    bootstrapRace = () => {};
  const host = new Port(),
    shell = new Port(),
    boot: any[] = [],
    sizes: any[] = [];
  const session = createOpaquePreviewSession({
    lease,
    currentLease: () => lease,
    frame: {
      currentWindow: () => currentWindow,
      isConnected: () => connected,
      bootstrap: (target, message, port) => {
        boot.push({ target, message, port });
        bootstrapRace();
      },
    },
    ports: { host, shell },
    lifetimeMs: 100,
    clock: {
      now: () => now,
      schedule: (f) => {
        expire = f;
        return 1;
      },
      cancel() {},
    },
    onSize: (value) => sizes.push(value),
  });
  return {
    session,
    host,
    shell,
    boot,
    sizes,
    originalWindow,
    prove: () =>
      host.emit({ type: "claudex-preview-proof", nonce: session.shellProof }),
    expire: () => {
      now = 101;
      expire();
    },
    changeAccount: () => (lease = { ...lease, account: "other" }),
    reactivate: () => (lease = { ...lease, activation: {} }),
    changeNativeWindow: () => (lease = { ...lease, window: "other" }),
    replaceWindow: () => (currentWindow = {}),
    remove: () => (connected = false),
    race: (f: () => void) => (bootstrapRace = f),
  };
}
test("bootstrap transfers only empty proof challenge to captured window; content waits for private port proof", () => {
  const f = fixture();
  assert.equal(f.session.renderInertHtml("<p>Inert</p>"), false);
  assert.equal(f.session.bootstrap(), true);
  assert.equal(f.boot[0].target, f.originalWindow);
  assert.equal(f.boot[0].port, f.shell);
  assert.deepEqual(f.boot[0].message, {
    type: "claudex-preview-bootstrap",
    version: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(f.boot[0].message),
    new RegExp(f.session.shellProof),
  );
  assert.equal(f.session.renderInertHtml("<p>Inert</p>"), false);
  assert.equal(f.host.sent.length, 0);
  f.prove();
  assert.equal(f.session.state, "ready");
  assert.equal(f.session.renderInertHtml("<p>Inert</p>"), true);
  assert.equal(f.boot.length, 1);
  assert.deepEqual(f.host.sent[0], {
    type: "claudex-preview-inert-html",
    version: 1,
    sequence: 1,
    html: "<p>Inert</p>",
  });
  assert.equal(f.session.bootstrap(), false);
});
test("wrong/new-document/cross-session proof cannot establish content channel", () => {
  for (const proof of [
    null,
    {},
    { type: "claudex-preview-proof", nonce: "0".repeat(64) },
    { type: "claudex-preview-proof", nonce: "invalid" },
  ]) {
    const f = fixture();
    f.session.bootstrap();
    f.host.emit(proof);
    assert.equal(f.session.state, "revoked");
    assert.equal(f.session.renderInertHtml("<p>Inert</p>"), false);
    assert.equal(f.host.sent.length, 0);
  }
  const f = fixture(),
    g = fixture();
  f.session.bootstrap();
  f.host.emit({ type: "claudex-preview-proof", nonce: g.session.shellProof });
  assert.equal(f.session.state, "revoked");
});
test("same WindowProxy navigation/load revokes old proof and closes both ports, without rearming", () => {
  const f = fixture();
  f.session.bootstrap();
  const queued = f.host.onmessage;
  f.session.onDocumentChange();
  queued?.({
    data: { type: "claudex-preview-proof", nonce: f.session.shellProof },
  });
  assert.equal(f.session.state, "revoked");
  assert.equal(f.session.bootstrap(), false);
  assert.equal(f.session.renderInertHtml("<p>Inert</p>"), false);
  assert.equal(f.host.sent.length, 0);
  assert.equal(f.host.closed, 1);
  assert.equal(f.shell.closed, 1);
});
test("new WindowProxy and account/activation/native window retirement block even previously proven content", () => {
  for (const mutation of [
    "replaceWindow",
    "changeAccount",
    "reactivate",
    "changeNativeWindow",
    "remove",
    "expire",
  ] as const) {
    const f = fixture();
    f.session.bootstrap();
    f.prove();
    f[mutation]();
    assert.equal(f.session.renderInertHtml("<p>Inert</p>"), false, mutation);
    assert.equal(f.session.state, "revoked");
    assert.equal(f.host.sent.length, 0);
  }
});
test("navigation during bootstrap and duplicate proof fail closed", () => {
  const f = fixture();
  f.race(() => f.session.onDocumentChange());
  assert.equal(f.session.bootstrap(), false);
  f.prove();
  assert.equal(f.host.sent.length, 0);
  const g = fixture();
  g.session.bootstrap();
  g.prove();
  g.prove();
  assert.equal(g.session.state, "revoked");
});
test("all model/fetch/files/storage/host request shapes are explicit unsupported, only bounded size notification passes", () => {
  const f = fixture();
  f.session.bootstrap();
  f.prove();
  for (const method of [
    "ClaudeCompletion",
    "ProxyFetch",
    "GetFile",
    "StorageGet",
    "SendConversationMessage",
    "RunCode",
  ])
    f.host.emit({ method, requestId: "synthetic" });
  assert.deepEqual(
    f.host.sent,
    Array(6).fill({ type: "claudex-preview-unsupported" }),
  );
  f.host.emit({ type: "claudex-preview-size", width: 100, height: 200 });
  assert.deepEqual(f.sizes, [{ width: 100, height: 200 }]);
  f.host.emit({ type: "claudex-preview-size", width: Infinity, height: 200 });
  assert.equal(f.sizes.length, 1);
  assert.throws(
    () => f.session.renderInertHtml("x".repeat(1024 * 1024 + 1)),
    /bound/,
  );
});
test("message flood retires rather than opening unbounded unsupported reply work", () => {
  const f = fixture();
  f.session.bootstrap();
  f.prove();
  for (let i = 0; i < 200; i++) f.host.emit({ type: "unsupported" });
  assert.equal(f.session.state, "revoked");
  assert.equal(f.host.sent.length, 119);
});
