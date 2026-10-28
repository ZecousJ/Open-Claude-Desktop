import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { SessionRail } from "../../src/session-rail/SessionRail";
import { railFit, railVisible } from "../../src/session-rail/rail-store";
import type { Conversation } from "../../shared/types";

(globalThis as any).window ??= { desktop: {} };

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "Fix the rail",
    mode: "code",
    createdAt: 1000,
    updatedAt: 1000,
    pinned: false,
    archived: false,
    providerId: "p",
    model: "gpt-6.1",
    cwd: "/Users/ada/Developer/claudex",
    tokenUsage: {
      last: { totalTokens: 108_000 },
      modelContextWindow: 200_000,
    } as any,
    turns: [
      {
        id: "t1",
        prompt: "write the doc",
        attachments: [],
        createdAt: 1000,
        status: "completed",
        items: [
          {
            id: "i1",
            type: "fileChange",
            generatedFiles: [
              {
                id: "g1",
                name: "desktop-ui-hot-update.md",
                path: "/Users/ada/Developer/claudex/docs/desktop-ui-hot-update.md",
                language: "markdown",
                operation: "create",
                state: "ready",
                content: "# Plan",
                digest: "d1",
                capturedAt: 2000,
              },
            ],
          } as any,
        ],
      },
    ],
    ...patch,
  } as Conversation;
}

const app = (patch: Partial<AppController> = {}) =>
  ({
    snapshot: { settings: { remoteControl: true }, conversations: [] },
    activeTerminals: [
      {
        conversationId: "c1",
        itemId: "x",
        processId: "p1",
        command: "npm run dev",
        cwd: "/",
      },
    ],
    setPanel: () => {},
    report: () => {},
    panel: null,
    ...patch,
  }) as unknown as AppController;

const render = (c: Conversation, a = app()) =>
  renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      { value: a },
      createElement(SessionRail, { conversation: c }),
    ),
  );

test("the rail lists Environment, Context, Outputs and Background tasks in the original's order", () => {
  const html = render(conversation());
  const order = ["environment", "context", "outputs", "backgroundTasks"].map(
    (id) => html.indexOf(`data-rail-section="${id}"`),
  );
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    String(order),
  );
  assert.match(html, /aria-label="Session details"/);
  assert.match(html, />This computer</);
  assert.match(
    html,
    /class="rail-folder-name">claudex<\/span><\/button><span class="rail-detail"> · ~\/Developer</,
  );
  assert.match(html, /aria-label="Add folder"/);
  assert.match(
    html,
    /role="switch" aria-label="Remote Control" aria-checked="true"/,
  );
  // Folded by default: Context shows its percent and meter in the heading.
  assert.match(html, /rail-tabular">54%<\/span><span class="rail-meter"/);
  assert.match(html, /desktop-ui-hot-update\.md/);
  // Background tasks starts open, as every card but Connectors, Context and
  // Usage does, so it lists the task instead of counting it.
  assert.match(html, /class="rail-row-label">npm run dev</);
});

test("the session rail lists additional folders and uses recorded branch and worktree metadata before polling", () => {
  const html = render(
    conversation({
      additionalFolders: [
        "/Users/ada/Developer/docs",
        "/Users/ada/Developer/claudex",
      ],
      branch: "feature/rail",
    }),
  );
  assert.match(html, /Additional folder\n\/Users\/ada\/Developer\/docs/);
  assert.match(html, />docs<\/span>/);
  assert.match(html, /aria-haspopup="menu"[^>]*><span>feature\/rail<\/span>/);
  const worktree = render(
    conversation({
      cwd: "/repo/.claude/worktrees/session",
      worktree: {
        branch: "claudex/session",
        path: "/repo/.claude/worktrees/session",
        origin: "/repo",
      } as any,
    }),
  );
  assert.match(worktree, />claudex\/session<\/span>/);
  assert.match(worktree, /class="rail-folder-name">repo<\/span>/);
  assert.doesNotMatch(html, /hasn.t moved|is reading from/);
});

test("a session with no folder offers the folder picker", () => {
  assert.match(render(conversation({ cwd: undefined })), /Choose folder…/);
});

test("a session taken off Remote Control, or with phone control off, shows the switch off", () => {
  assert.match(
    render(conversation({ remoteControlOff: true })),
    /aria-checked="false"/,
  );
  const off = render(
    conversation(),
    app({
      snapshot: {
        settings: { remoteControl: false },
        conversations: [],
      } as any,
    }),
  );
  assert.match(
    off,
    /role="switch" aria-label="Remote Control" aria-checked="false" disabled=""/,
  );
});

test("the rail fits beside a pane from 771px, alone from 611px", () => {
  assert.equal(railFit(800), "beside-pane");
  assert.equal(railFit(700), "alone");
  assert.equal(railFit(600), "none");
  assert.equal(railVisible("alone", true), false);
  assert.equal(railVisible("alone", false), true);
  assert.equal(railVisible("beside-pane", true), true);
});

// A page to look at the rail in a browser: SESSION_RAIL_PREVIEW=<file>.
if (process.env.SESSION_RAIL_PREVIEW) {
  const css = readFileSync(
    new URL("../../src/session-rail/session-rail.css", import.meta.url),
    "utf8",
  );
  const page = (theme: string) =>
    `<div class="pane" data-theme-box="${theme}">${render(conversation())}</div>`;
  writeFileSync(
    process.env.SESSION_RAIL_PREVIEW,
    `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#262624;font:13px/19px -apple-system,system-ui,sans-serif;display:flex;gap:0}.pane{position:relative;width:340px;height:520px;background:#1f1e1d}${css}</style>${page("dark")}`,
  );
}

test("Progress shows the session's task list with done of total once the card is shown", () => {
  const store = new Map<string, string>([
    ["claudex.sessionRail.layout", JSON.stringify({ order: [], hidden: [] })],
  ]);
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  try {
    const html = render(
      conversation({
        turns: [
          {
            id: "t1",
            prompt: "go",
            attachments: [],
            createdAt: 1,
            status: "completed",
            items: [
              {
                id: "p1",
                type: "taskPlan",
                plan: [
                  { step: "Read the code", status: "completed" },
                  { step: "Write the fix", status: "inProgress" },
                ],
              } as any,
            ],
          },
        ],
      }),
    );
    assert.match(html, /data-rail-section="progress"/);
    assert.match(html, /Write the fix/);
  } finally {
    delete (globalThis as any).localStorage;
  }
});
