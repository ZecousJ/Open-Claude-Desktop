import test from "node:test";
import assert from "node:assert/strict";
import {
  installOfficialClipboardWritePermission,
  clipboardActivationWorld,
} from "../electron/official-ui/clipboard-write-permission";
function fixture(microphone = false) {
  let request: any,
    check: any,
    trusted = true,
    focused = true,
    destroyed = false,
    result: any = true;
  let settle: ((value: any) => void) | undefined;
  const probes: any[] = [];
  const frame = {
    url: "http://localhost:4567/chat/synthetic",
    processId: 1,
    routingId: 2,
  };
  const contents: any = {
    mainFrame: frame,
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    executeJavaScriptInIsolatedWorld: (...args: any[]) => {
      probes.push(args);
      return result === "pending"
        ? new Promise((resolve) => (settle = resolve))
        : result === "reject"
          ? Promise.reject(Error("unavailable"))
          : Promise.resolve(result);
    },
  };
  installOfficialClipboardWritePermission(
    {
      setPermissionCheckHandler: (f) => (check = f),
      setPermissionRequestHandler: (f) => (request = f),
    },
    (c) => (c === contents && trusted ? "http://localhost:4567" : undefined),
    15,
    microphone ? (candidate) => candidate === contents && trusted ? "http://localhost:4567" : undefined : undefined,
  );
  const answers: boolean[] = [];
  const run = (
    permission = "clipboard-sanitized-write",
    details: any = { isMainFrame: true, requestingUrl: frame.url },
    sender = contents,
  ) =>
    request(sender, permission, (yes: boolean) => answers.push(yes), details);
  return {
    run,
    check,
    answers,
    probes,
    contents,
    frame,
    set: (v: any) => {
      if (v.trusted !== undefined) trusted = v.trusted;
      if (v.focused !== undefined) focused = v.focused;
      if (v.destroyed !== undefined) destroyed = v.destroyed;
      if (v.result !== undefined) result = v.result;
    },
    settle: (v: any) => settle?.(v),
  };
}
test("dictation can request only audio from the active original top frame", () => {
  const f = fixture(true);
  const details = { isMainFrame: true, requestingUrl: f.frame.url };
  assert.equal(f.check(f.contents, "media", new URL(f.frame.url).origin, { ...details, mediaType: "audio" }), true);
  f.run("media", { ...details, mediaTypes: ["audio"] });
  f.run("media", { ...details, mediaTypes: ["audio", "video"] });
  f.run("media", { ...details, isMainFrame: false, mediaTypes: ["audio"] });
  f.set({ trusted: false });
  f.run("media", { ...details, mediaTypes: ["audio"] });
  assert.deepEqual(f.answers, [true, false, false, false]);
});
const tick = () => new Promise((r) => setTimeout(r, 0));
test("copy request uses isolated native activation probe without synthesizing gesture", async () => {
  const f = fixture();
  f.run();
  await tick();
  assert.deepEqual(f.answers, [true]);
  assert.equal(f.probes[0][0], clipboardActivationWorld);
  assert.equal(f.probes[0][2], false);
  assert.match(f.probes[0][1][0].code, /userActivation.isActive/);
  assert.equal(f.check(), false);
});
test("clipboard reads, other permissions, subframes, foreign documents and untrusted contents refuse", async () => {
  for (const permission of [
    "clipboard-read",
    "deprecated-sync-clipboard-read",
    "media",
    "notifications",
    "unknown",
  ]) {
    const f = fixture();
    f.run(permission);
    assert.deepEqual(f.answers, [false]);
    assert.equal(f.probes.length, 0);
  }
  for (const patch of [
    { isMainFrame: false },
    { requestingUrl: "https://evil.test/" },
    { requestingUrl: "http://localhost:4567/other" },
  ]) {
    const f = fixture();
    f.run(undefined, {
      isMainFrame: true,
      requestingUrl: f.frame.url,
      ...patch,
    });
    assert.deepEqual(f.answers, [false]);
    assert.equal(f.probes.length, 0);
  }
  for (const patch of [
    { trusted: false },
    { focused: false },
    { destroyed: true },
  ]) {
    const f = fixture();
    f.set(patch);
    f.run();
    assert.deepEqual(f.answers, [false]);
    assert.equal(f.probes.length, 0);
  }
});
test("missing activation, rejected or stalled probe fail closed and callback only once", async () => {
  for (const result of [false, "reject", undefined]) {
    const f = fixture();
    f.set({ result: result ?? null });
    f.run();
    await tick();
    assert.deepEqual(f.answers, [false]);
  }
  const f = fixture();
  f.set({ result: "pending" });
  f.run();
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(f.answers, [false]);
  f.settle(true);
  await tick();
  assert.deepEqual(f.answers, [false]);
});
test("retirement, lost focus, navigation and frame replacement during probe refuse", async () => {
  for (const kind of [
    "retired",
    "focus",
    "destroyed",
    "url",
    "process",
    "routing",
    "frame",
  ]) {
    const f = fixture();
    f.set({ result: "pending" });
    f.run();
    if (kind === "retired") f.set({ trusted: false });
    if (kind === "focus") f.set({ focused: false });
    if (kind === "destroyed") f.set({ destroyed: true });
    if (kind === "url") f.frame.url += "?new";
    if (kind === "process") f.frame.processId++;
    if (kind === "routing") f.frame.routingId++;
    if (kind === "frame") f.contents.mainFrame = { ...f.frame };
    f.settle(true);
    await tick();
    assert.deepEqual(f.answers, [false], kind);
  }
});
test("deceptive trusted-origin prefixes and foreign WebContents cannot obtain write grant", async () => {
  const f = fixture();
  f.frame.url = "http://localhost:4567.evil.test/chat/synthetic";
  f.run();
  assert.deepEqual(f.answers, [false]);
  assert.equal(f.probes.length, 0);
  const g = fixture();
  g.run(undefined, undefined, { ...g.contents });
  assert.deepEqual(g.answers, [false]);
  assert.equal(g.probes.length, 0);
});
