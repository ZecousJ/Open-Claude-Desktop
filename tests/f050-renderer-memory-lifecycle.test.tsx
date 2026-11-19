/** F050 renderer lifecycle tests: real React DOM and production memory components.
 * Presentation-only dependencies are inert fixtures; this is not original UI acceptance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";

function deferred() {
  let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const doc = (content: string) => ({
  content,
  updatedAt: 0,
  revision: 1,
  source: "edited",
  edits: [],
});
const status = {
  available: true,
  prefs: { generate: true, searchChats: true },
  allowed: { generate: true, searchChats: true },
  synthesizing: false,
};

async function fixture(t: any) {
  const directory = await mkdtemp(path.resolve(".f050-renderer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "components.mjs");
  await build({
    stdin: {
      contents: `export {ProjectMemory} from './src/memory/ProjectMemory'; export {ManageMemoryDialog} from './src/memory/ManageMemoryDialog'; export {useMemory} from './src/memory/useMemory';`,
      resolveDir: process.cwd(),
    },
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    plugins: [
      {
        name: "presentation-fixtures",
        setup(b) {
          b.onResolve(
            {
              filter:
                /(?:\/ui\/(?:glyphs|lazy-piece|RelativeTime|Skeleton|Markdown|toast-store)|\/i18n|\/settings\/controls)$/,
            },
            (args) => ({ path: args.path, namespace: "presentation" }),
          );
          b.onLoad({ filter: /.*/, namespace: "presentation" }, (args) => ({
            loader: "jsx",
            contents: args.path.endsWith("glyphs")
              ? `import React from 'react'; const Icon=()=>null; export {Icon as LockKeyhole, Icon as Pencil, Icon as ArrowRight, Icon as RotateCcw, Icon as ChevronLeft, Icon as ChevronRight, Icon as Trash2};`
              : args.path.endsWith("lazy-piece")
                ? `import {lazy} from 'react'; export const lazyPiece=(load,name)=>lazy(()=>load().then(m=>({default:m[name]})));`
                : args.path.endsWith("RelativeTime")
                  ? `export const relativeTime=()=> 'recently';`
                  : args.path.endsWith("Skeleton")
                    ? `export const Skeleton=()=>null;`
                    : args.path.endsWith("Markdown")
                      ? `export const Markdown=({text})=>text;`
                      : args.path.endsWith("toast-store")
                        ? `export const showToast=(message)=>globalThis.__f050Toasts.push(message);`
                        : args.path.endsWith("controls")
                          ? `import React from 'react'; export const SettingsModal=({children,title})=><div role="dialog"><h1>{title}</h1>{children}</div>;`
                          : `export const currentLocale=()=> 'en-US'; export const useT=()=>{}; export const formatText=(text)=>text; export const t=(text)=>text;`,
          }));
          b.onLoad({ filter: /\.css$/ }, () => ({
            contents: "",
            loader: "js",
          }));
        },
      },
    ],
  });
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    __f050Toasts: [],
  });
  const listeners = new Set<(event: any) => void>();
  const docs: (ReturnType<typeof deferred> & { scope: any })[] = [];
  const statuses: ReturnType<typeof deferred>[] = [];
  let deferStatus = false;
  (window as any).desktop = {
    memoryStatus() {
      if (!deferStatus) return Promise.resolve(status);
      const read = deferred();
      statuses.push(read);
      return read.promise;
    },
    memoryDoc(scope: any) {
      const read = { ...deferred(), scope };
      docs.push(read);
      return read.promise;
    },
    onEvent(listener: (event: any) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const components = await import(pathToFileURL(file).href);
  const root = createRoot(document.getElementById("root")!);
  let mounted = true;
  const unmount = async () => {
    if (mounted) {
      await act(async () => root.unmount());
      mounted = false;
    }
  };
  t.after(async () => {
    await unmount();
    Object.assign(globalThis, old);
    delete (globalThis as any).__f050Toasts;
    await rm(directory, { recursive: true, force: true });
  });
  return {
    components,
    docs,
    statuses,
    listeners,
    unmount,
    deferStatus: () => {
      deferStatus = true;
    },
    render: async (element: React.ReactNode) =>
      act(async () => root.render(element)),
    event: async () =>
      act(async () => {
        for (const listener of listeners) listener({ type: "memory-changed" });
      }),
    settle: async (
      read: ReturnType<typeof deferred>,
      value: any,
      fail = false,
    ) =>
      act(async () => {
        if (fail) read.reject(value);
        else read.resolve(value);
      }),
    text: () => document.body.textContent ?? "",
    toasts: () => (globalThis as any).__f050Toasts,
  };
}

test("project navigation clears old memory immediately and ignores the previous scope response", async (t) => {
  const f = await fixture(t);
  const Component = f.components.ProjectMemory;
  await f.render(<Component projectId="a" onError={() => {}} />);
  await f.settle(f.docs[0], doc("project A private memory"));
  assert.match(f.text(), /project A private memory/);
  await f.event();
  const late = f.docs.at(-1)!;
  await f.render(<Component projectId="b" onError={() => {}} />);
  assert.doesNotMatch(f.text(), /project A private memory/);
  assert.equal(f.docs.at(-1)!.scope.projectId, "b");
  await f.settle(late, doc("old project response"));
  assert.doesNotMatch(f.text(), /old project response/);
  await f.settle(f.docs.at(-1)!, doc("project B memory"));
  assert.match(f.text(), /project B memory/);
});

test("project overlapping refreshes are latest-wins and a failed refresh retains cached memory", async (t) => {
  const f = await fixture(t);
  const Component = f.components.ProjectMemory;
  await f.render(<Component projectId="a" onError={() => {}} />);
  await f.event();
  await f.settle(f.docs[1], doc("newest memory"));
  await f.settle(f.docs[0], doc("stale memory"));
  assert.match(f.text(), /newest memory/);
  assert.doesNotMatch(f.text(), /stale memory/);
  await f.event();
  await f.settle(f.docs[2], Error("offline"), true);
  assert.match(f.text(), /newest memory/);
  assert.doesNotMatch(f.text(), /Couldn’t load/);
});

test("dialog scope change retires cached content and prior failures without closing the new dialog", async (t) => {
  const f = await fixture(t);
  const Component = f.components.ManageMemoryDialog;
  let closes = 0;
  await f.render(
    <Component
      scope={{ kind: "global" }}
      initial={doc("cached global memory")}
      onClose={() => closes++}
    />,
  );
  assert.equal(f.docs.length, 0);
  assert.match(f.text(), /cached global memory/);
  await f.event();
  const old = f.docs[0];
  await f.render(
    <Component
      scope={{ kind: "project", projectId: "b" }}
      onClose={() => closes++}
    />,
  );
  assert.doesNotMatch(f.text(), /cached global memory/);
  await f.settle(old, Error("old failure"), true);
  assert.equal(closes, 0);
  assert.deepEqual(f.toasts(), []);
  await f.settle(f.docs[1], doc("project B memory"));
  assert.match(f.text(), /project B memory/);
});

test("dialog StrictMode replay and overlapping refreshes reject obsolete successes and errors", async (t) => {
  const f = await fixture(t);
  const Component = f.components.ManageMemoryDialog;
  let closes = 0;
  await f.render(
    <StrictMode>
      <Component scope={{ kind: "global" }} onClose={() => closes++} />
    </StrictMode>,
  );
  assert.equal(f.docs.length, 2);
  await f.settle(f.docs[1], doc("current memory"));
  await f.settle(f.docs[0], Error("StrictMode obsolete"), true);
  await f.event();
  await f.event();
  await f.settle(f.docs[3], doc("latest refresh"));
  await f.settle(f.docs[2], doc("stale refresh"));
  assert.match(f.text(), /latest refresh/);
  assert.doesNotMatch(f.text(), /stale refresh/);
  assert.equal(closes, 0);
  assert.deepEqual(f.toasts(), []);
  await f.event();
  const pending = f.docs[4];
  await f.unmount();
  await f.settle(pending, Error("unmounted"), true);
  assert.equal(closes, 0);
  assert.deepEqual(f.toasts(), []);
  assert.equal(f.listeners.size, 0);
});

test("useMemory invalidates pending status errors on unmount and StrictMode cleanup", async (t) => {
  const f = await fixture(t);
  f.deferStatus();
  const errors: unknown[] = [];
  function Probe() {
    const memory = f.components.useMemory((error: unknown) =>
      errors.push(error),
    );
    return <span>{memory.status?.reason ?? "loading"}</span>;
  }
  await f.render(
    <StrictMode>
      <Probe />
    </StrictMode>,
  );
  assert.equal(f.statuses.length, 2);
  await f.settle(f.statuses[1], { ...status, reason: "offline" });
  await f.settle(f.statuses[0], Error("obsolete"), true);
  assert.match(f.text(), /offline/);
  assert.deepEqual(errors, []);
  await f.event();
  await f.unmount();
  await f.settle(f.statuses[2], Error("after unmount"), true);
  assert.deepEqual(errors, []);
  assert.equal(f.listeners.size, 0);
});

test("project read failure offers retry, retires previous errors, and closes editor on navigation", async (t) => {
  const f = await fixture(t);
  const Component = f.components.ProjectMemory;
  await f.render(<Component projectId="a" onError={() => {}} />);
  await f.settle(f.docs[0], Error("read failed"), true);
  assert.match(f.text(), /Couldn’t load project memory/);
  await act(async () =>
    (document.querySelector(".prj-memory-retry") as HTMLButtonElement).click(),
  );
  await f.settle(f.docs[1], doc("retry succeeded"));
  assert.match(f.text(), /retry succeeded/);
  await act(async () =>
    (
      document.querySelector('[aria-label="Edit memory"]') as HTMLButtonElement
    ).click(),
  );
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  await f.render(<Component projectId="b" onError={() => {}} />);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 0);
  assert.doesNotMatch(f.text(), /retry succeeded|Couldn’t load/);
});

test("dialog keeps initial cache on same-scope rerenders and only current errors close it", async (t) => {
  const f = await fixture(t);
  const Component = f.components.ManageMemoryDialog;
  let closes = 0;
  const onClose = () => closes++;
  await f.render(
    <Component
      scope={{ kind: "project", projectId: "a" }}
      initial={doc("cached memory")}
      onClose={onClose}
    />,
  );
  await f.render(
    <Component
      scope={{ kind: "project", projectId: "a" }}
      initial={doc("new prop is not a read")}
      onClose={onClose}
    />,
  );
  assert.equal(f.docs.length, 0);
  assert.match(f.text(), /cached memory/);
  await f.event();
  await f.event();
  await f.settle(f.docs[1], doc("latest memory"));
  await f.settle(f.docs[0], Error("stale error"), true);
  assert.equal(closes, 0);
  assert.deepEqual(f.toasts(), []);
  assert.match(f.text(), /latest memory/);
  await f.event();
  await f.settle(f.docs[2], Error("current error"), true);
  assert.equal(closes, 1);
  assert.deepEqual(f.toasts(), ["current error"]);
});
