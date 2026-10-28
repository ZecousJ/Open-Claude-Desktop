/**
 * The dot on the Chat | Code switch: the surface that is not shown says whether
 * one of its conversations runs (grey), waits for approval (amber) or finished
 * unread (blue), in that order of weight.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation, Mode, Turn } from "../../shared/types";

registerHooks({
  load(url, context, next) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  },
});

const { SurfaceSwitch } = await import("../../src/sidebar/SurfaceSwitch");

const turn = (status: Turn["status"]): Turn => ({
  id: "t",
  prompt: "",
  attachments: [],
  items: [],
  status,
  createdAt: 0,
});
const row = (
  id: string,
  mode: Mode,
  patch: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: id,
  mode,
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  turns: [],
  ...patch,
});

/** The class of the segment whose accessible name is `name`. */
function segmentClass(
  html: string,
  name: "Claudex" | "Code",
): string | undefined {
  return new RegExp(
    `class="([^"]*)"[^>]*aria-label="${name}(?:,[^"]*)?"|aria-label="${name}(?:,[^"]*)?"[^>]*class="([^"]*)"`,
  )
    .exec(html)
    ?.slice(1)
    .find(Boolean);
}

const render = (
  mode: Mode,
  conversations: Conversation[],
  approvalIds: string[] = [],
) =>
  renderToStaticMarkup(
    createElement(SurfaceSwitch, {
      mode,
      conversations,
      approvalIds: new Set(approvalIds),
      onSwitch: () => {},
    }),
  );

test("the other surface's segment gets a grey dot while a conversation runs", () => {
  const html = render("chat", [
    row("code-run", "code", { turns: [turn("inProgress")] }),
  ]);
  assert.match(segmentClass(html, "Code") ?? "", /\bbusy\b/);
  assert.doesNotMatch(segmentClass(html, "Claudex") ?? "", /busy/);
});

test("a waiting request is amber and outweighs running; unread is blue", () => {
  const running = row("a", "code", { turns: [turn("inProgress")] });
  const waiting = row("b", "code");
  assert.match(
    segmentClass(render("chat", [running, waiting], ["b"]), "Code") ?? "",
    /\battention\b/,
  );
  assert.match(
    segmentClass(
      render("chat", [row("c", "code", { unread: true })]),
      "Code",
    ) ?? "",
    /\bunread\b/,
  );
  assert.equal(
    /\b(busy|attention|unread)\b/.test(
      segmentClass(render("chat", [row("d", "code")]), "Code") ?? "",
    ),
    false,
  );
});

test("the surface on screen and archived or incognito rows carry no dot", () => {
  const shown = render("code", [
    row("e", "code", { unread: true }),
    row("f", "chat", { archived: true, unread: true }),
    row("g", "chat", { incognito: true, unread: true }),
  ]);
  assert.doesNotMatch(segmentClass(shown, "Code") ?? "", /unread/);
  assert.doesNotMatch(segmentClass(shown, "Claudex") ?? "", /unread/);
});
