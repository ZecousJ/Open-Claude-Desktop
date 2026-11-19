/** Actual AuthGate React state transitions; leaf UI/profile/policy rendering is isolated. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
const stub = `import React from 'react';export const surface='web',productName='Claudex';export const configureHelpOrigin=()=>{},signedOutNotice=()=>({}),resetLinkOf=()=>undefined,startModeOf=()=>undefined,parseWebRoute=(path)=>({kind:path.startsWith('/chat/')?'chat':'other'}),writeBootHints=()=>{},forgetAccountDrafts=()=>{},forgetAccountLocalData=()=>{};export const App=p=>React.createElement('div',{id:'default-app'},p.accountId);export const PolicyProvider=({children})=>children,AnnouncementsProvider=PolicyProvider,ProfileStepGate=PolicyProvider;export const WebBoot=()=>React.createElement('div',{id:'loading'},'Loading');export const BootShell=()=>React.createElement('div',{id:'native-loading'});export const BootErrorPage=()=>React.createElement('div',{id:'auth-error'},'Auth failed');export const FramelessControls=()=>null,PageErrorBanner=()=>null,Toaster=()=>null;export const lazyPiece=()=>()=>React.createElement('div',{id:'sign-in'},'Sign in');`;
test("same AuthGate preserves default/opt-in branches and immediately unmounts prior account before delayed failed restore", async (t) => {
  const file = path.resolve(
    ".runtime/auth-gate-isolated-" + process.pid + ".mjs",
  );
  t.after(() => fs.rmSync(file, { force: true }));
  await build({
    entryPoints: [path.resolve("src/app/AuthGate.tsx")],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["react"],
    plugins: [
      {
        name: "isolate-leaf-ui",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            args.importer.endsWith("/AuthGate.tsx") && !args.path.startsWith("react")
              ? { path: args.path, namespace: "leaf" }
              : undefined,
          );
          b.onLoad({ filter: /.*/, namespace: "leaf" }, () => ({
            contents: stub,
            loader: "js",
          }));
        },
      },
    ],
  });
  const { AuthGate } = await import(pathToFileURL(file).href);
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://fixture.invalid/new",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    history: globalThis.history,
    location: globalThis.location,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    history: dom.window.history,
    location: dom.window.location,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  t.after(() => {
    Object.assign(globalThis, previous);
    dom.window.close();
  });
  let listeners = new Set<(e: any) => void>();
  let status: () => Promise<any> = async () => ({
    account: { id: "a", name: "A" },
  });
  (dom.window as any).desktop = {
    authStatus: () => status(),
    onEvent: (fn: any) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  let root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(React.createElement(AuthGate, {
      renderApp: (props: { accountId: string }) =>
        React.createElement("div", { id: "default-app" }, props.accountId),
    }));
  });
  assert.equal(document.getElementById("default-app")?.textContent, "a");
  await act(async () => root.unmount());
  root = createRoot(document.getElementById("root")!);
  let onSwitch: (() => void) | undefined;
  await act(async () => {
    root.render(
      React.createElement(AuthGate, {
        subscribeAccountSwitch: (listener: () => void) => {
          onSwitch = listener;
          return () => { onSwitch = undefined; };
        },
        renderApp: (props: any) =>
          React.createElement("div", { id: "optin-app" }, props.accountId),
      }),
    );
  });
  assert.equal(document.getElementById("optin-app")?.textContent, "a");
  assert.equal(document.getElementById("default-app"), null);
  history.replaceState(null, "", "/chat/alice");
  status = async () => ({ account: { id: "b", name: "B" } });
  await act(async () => onSwitch?.());
  assert.equal(document.getElementById("optin-app")?.textContent, "b");
  assert.equal(location.pathname, "/new");
  let reject!: (e: Error) => void;
  status = () => new Promise((_, r) => (reject = r));
  await act(async () => {
    for (const fn of listeners)
      fn({ type: "signed-out", reason: "session-expired" });
  });
  assert.equal(document.getElementById("optin-app"), null);
  assert.ok(document.getElementById("loading"));
  await act(async () => reject(Error("Offline")));
  assert.ok(document.getElementById("auth-error"));
  assert.equal(document.getElementById("optin-app"), null);
  await act(async () => root.unmount());
  assert.equal(onSwitch, undefined);
});

test("desktop sign-in hands off to the native window without loading the workspace", async (t) => {
  const file = path.resolve(".runtime/auth-gate-desktop-" + process.pid + ".mjs");
  t.after(() => fs.rmSync(file, { force: true }));
  await build({
    entryPoints: [path.resolve("src/app/AuthGate.tsx")],
    outfile: file,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["react"],
    plugins: [{
      name: "isolate-desktop-leaves",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) =>
          args.importer.endsWith("/AuthGate.tsx") && !args.path.startsWith("react")
            ? { path: args.path, namespace: "leaf" } : undefined);
        b.onLoad({ filter: /.*/, namespace: "leaf" }, () => ({
          contents: stub
            .replace("surface='web'", "surface='desktop'")
            .replace("signedOutNotice=()=>({})", "signedOutNotice=({reason})=>({reason})")
            .replace("lazyPiece=()=>()=>React.createElement('div',{id:'sign-in'},'Sign in')",
              "lazyPiece=()=>props=>React.createElement('button',{id:'sign-in',onClick:()=>props.onSignedIn({id:'a',email:'a@example.test'})},props.notice?.reason ?? 'Sign in')"),
          loader: "js",
        }));
      },
    }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/?official-sign-in=1" });
  const previous = { window: globalThis.window, document: globalThis.document,
    history: globalThis.history, location: globalThis.location };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    history: dom.window.history, location: dom.window.location, IS_REACT_ACT_ENVIRONMENT: true });
  t.after(() => { Object.assign(globalThis, previous); dom.window.close(); });
  const { AuthGate } = await import(pathToFileURL(file).href);
  let resolve!: (status: unknown) => void;
  (dom.window as any).desktop = {
    authStatus: () => new Promise((done) => { resolve = done; }),
    onEvent: () => () => {},
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(React.createElement(AuthGate, {
    renderApp: () => React.createElement("div", { id: "workspace" }),
  })));
  assert.ok(dom.window.document.getElementById("native-loading"));
  assert.equal(dom.window.document.getElementById("sign-in"), null);
  await act(async () => resolve({ signedOutReason: "session-expired" }));
  assert.equal(dom.window.document.getElementById("sign-in")?.textContent, "session-expired");
  await act(async () => dom.window.document.getElementById("sign-in")?.click());
  assert.ok(dom.window.document.getElementById("native-loading"));
  assert.equal(dom.window.document.getElementById("workspace"), null);
  assert.equal(dom.window.document.getElementById("auth-error"), null);
  await act(async () => root.unmount());
});
