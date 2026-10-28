/**
 * Relaunch to update (src/updates/RelaunchToUpdate.tsx): the label, and the
 * dialog that asks first while a task runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import type { Conversation } from "../../shared/types";

// The component imports its stylesheet, which Node cannot load.
registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});
const { RelaunchToUpdate, runningConversations } =
  await import("../../src/updates/RelaunchToUpdate");
const { RelaunchBusyDialog } =
  await import("../../src/updates/RelaunchBusyDialog");

const conversation = (id: string, status: string): Conversation =>
  ({ id, title: `Chat ${id}`, turns: [{ status }] }) as unknown as Conversation;

test("only conversations with a task in progress count as working", () => {
  const all = [
    conversation("a", "completed"),
    conversation("b", "inProgress"),
    conversation("c", "failed"),
  ];
  assert.deepEqual(
    runningConversations(all).map((c) => c.id),
    ["b"],
  );
  assert.deepEqual(runningConversations([]), []);
});

test("the sidebar button says Relaunch to update, or to retry one that did not complete", () => {
  const html = (retry: boolean) =>
    renderToStaticMarkup(
      createElement(RelaunchToUpdate, {
        version: "1.2.0",
        retry,
        onError: () => {},
      }),
    );
  assert.match(html(false), /Relaunch to update/);
  assert.match(html(false), /Install Claudex 1\.2\.0 and relaunch/);
  assert.match(html(true), /Relaunch to retry update/);
  assert.match(html(true), /The last update didn&#x27;t complete\./);
});

test("the dialog offers Cancel, Wait for Claudex and Update anyway, then only Cancel while waiting", () => {
  const dialog = (waiting: boolean, count = 1) =>
    renderToStaticMarkup(
      createElement(RelaunchBusyDialog, {
        count,
        firstTitle: "Fix the build",
        waiting,
        onWait: () => {},
        onUpdateAnyway: () => {},
        onClose: () => {},
      }),
    );
  const asking = dialog(false);
  assert.match(asking, /Claudex is still working/);
  assert.match(
    asking,
    /Claudex is working in <button[^>]*>Fix the build<\/button>\./,
  );
  assert.match(asking, /Relaunching now will interrupt that work\./);
  for (const label of ["Cancel", "Wait for Claudex", "Update anyway"])
    assert.match(asking, new RegExp(label));
  assert.match(dialog(false, 3), /working in 3 sessions/);
  const waiting = dialog(true);
  assert.match(waiting, /Waiting for Claudex to finish/);
  assert.doesNotMatch(waiting, /Update anyway/);
  assert.doesNotMatch(waiting, /Wait for Claudex</);
});

test("the update strip says it is checking or downloading", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { UpdateStatusStrip } =
    await import("../../src/updates/RelaunchToUpdate");
  assert.match(
    renderToStaticMarkup(
      createElement(UpdateStatusStrip, { phase: "checking" }),
    ),
    /role="status"[^]*Checking for updates\.\.\./,
  );
  assert.match(
    renderToStaticMarkup(
      createElement(UpdateStatusStrip, { phase: "downloading" }),
    ),
    /Downloading update\.\.\./,
  );
});

test("the notice above the composer relaunches through the same question as the sidebar", () => {
  const notice = readFileSync("src/policy/ComposerNotice.tsx", "utf8");
  assert.match(notice, /useRelaunchFlow\(onError\)/);
  assert.match(notice, /relaunchFlow\.relaunch/);
  assert.ok(!/relaunchToUpdate\(/.test(notice));
  const sidebar = readFileSync("src/updates/RelaunchToUpdate.tsx", "utf8");
  assert.match(sidebar, /useRelaunchFlow\(onError\)/);
});
