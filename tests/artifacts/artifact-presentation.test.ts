import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPresentation } from "../../src/artifacts/artifact-presentation";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ProgressPanel, relativePath } from "../../src/cowork/ProgressPanel";
import type { Conversation, GeneratedFile } from "../../shared/types";
const file = (
  id = "f",
  state: GeneratedFile["state"] = "ready",
): GeneratedFile => ({
  id,
  path: "/test/card.html",
  name: "card.html",
  language: "html",
  operation: "create",
  state,
  content: state === "ready" ? "<h1>Test</h1>" : undefined,
  digest: id,
});
function conversation(
  status: "inProgress" | "completed" = "inProgress",
  files: GeneratedFile[] = [],
): Conversation {
  return {
    id: "c",
    threadId: "native",
    title: "Test",
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "t",
        prompt: "Test",
        attachments: [],
        status,
        createdAt: 1,
        items: files.length
          ? [
              {
                id: "patch",
                type: "fileChange",
                status: "completed",
                generatedFiles: files,
              },
            ]
          : [],
      },
    ],
  };
}
test("first successful live generated document opens once, including a coalesced final notification", () => {
  const p = new ArtifactPresentation();
  p.seed([]);
  p.observe(conversation(), true);
  assert.deepEqual(
    p.observe(conversation("completed", [file()]), true),
    file(),
  );
  assert.equal(p.observe(conversation("completed", [file()]), true), undefined);
});
test("snapshot, history navigation and inactive conversations never pop open an artifact", () => {
  const p = new ArtifactPresentation();
  p.seed([conversation("completed", [file()])]);
  assert.equal(p.observe(conversation("completed", [file()]), true), undefined);
  const branch = conversation("completed", [file("branch")]);
  branch.threadId = "old-native";
  branch.turns[0].id = "old-turn";
  assert.equal(p.observe(branch, true), undefined);
  p.observe(conversation(), false);
  assert.equal(
    p.observe(conversation("inProgress", [file("background")]), false),
    undefined,
  );
  assert.equal(
    p.observe(conversation("inProgress", [file("background")]), true),
    undefined,
  );
});
test("dismissal survives updates in this turn but the next turn can present a new document", () => {
  const p = new ArtifactPresentation();
  const c = conversation();
  p.observe(c, true);
  p.dismiss(c);
  assert.equal(
    p.observe(conversation("inProgress", [file()]), true),
    undefined,
  );
  const next = conversation("inProgress", [file("next")]);
  next.turns[0].id = "next";
  assert.deepEqual(p.observe(next, true), file("next"));
});
test("failed/binary files do not consume presentation and code sessions do not steal focus", () => {
  const p = new ArtifactPresentation();
  p.observe(conversation(), true);
  assert.equal(
    p.observe(conversation("inProgress", [file("bad", "unavailable")]), true),
    undefined,
  );
  const txt = { ...file("text"), language: "text" };
  assert.equal(p.observe(conversation("inProgress", [txt]), true), undefined);
  assert.deepEqual(
    p.observe(conversation("inProgress", [file("good")]), true),
    file("good"),
  );
  const code = conversation("inProgress", [file("code")]);
  code.id = "code";
  code.mode = "code";
  assert.equal(p.observe(code, true), undefined);
});

const cowork = (
  status: "inProgress" | "completed" = "inProgress",
  files: GeneratedFile[] = [],
) => ({ ...conversation(status, files), id: "w", mode: "cowork" as const });
const output = (
  id: string,
  path: string,
  extra: Partial<GeneratedFile> = {},
): GeneratedFile => ({
  id,
  path,
  name: path.split("/").pop()!,
  language: "markdown",
  operation: "create",
  state: "ready",
  content: "# Notes",
  digest: id,
  ...extra,
});

test("Cowork waits for computer access without treating cloud-only tasks as local", () => {
  const render = (task: Conversation, computerAccess: boolean) =>
    renderToStaticMarkup(
      createElement(
        AppContext.Provider,
        {
          value: {
            snapshot: { settings: { computerAccess } },
            artifactPresentation: { current: new ArtifactPresentation() },
          } as unknown as AppController,
        },
        createElement(ProgressPanel, { conversation: task, onArtifact() {} }),
      ),
    );
  const task = cowork("completed");
  assert.match(render(task, true), /Requires your computer/);
  const waiting = render({ ...task, scheduledTaskId: "schedule" }, false);
  assert.match(waiting, /Waiting for your computer/);
  assert.match(waiting, /Computer access is off/);
  assert.match(
    waiting,
    /This task will run on schedule once Computer access is on/,
  );
  const cloud = render(
    { ...task, environment: { kind: "space", spaceId: "cloud" } },
    false,
  );
  assert.doesNotMatch(
    cloud,
    /Waiting for your computer|Computer access is off/,
  );
  const linked = {
    ...task,
    linkedToComputer: true,
    linkedComputerId: "pc-computer1",
    linkedComputerName: "My Mac",
    linkedComputerOnline: true,
    linkedComputerAccess: true,
    environment: { kind: "space" as const, spaceId: "cloud" },
  };
  const connected = render(linked, false);
  assert.match(connected, /Requires My Mac/);
  assert.match(connected, /title="View your devices"/);
  assert.doesNotMatch(
    connected,
    /Computer access is off|Waiting for your computer/,
  );
  const disconnected = render({ ...linked, linkedComputerOnline: false }, true);
  assert.match(disconnected, /Waiting for your computer/);
  assert.match(disconnected, /title="View your devices"/);
});

test("Cowork presents previewable outputs: text, images and PDF, not Office files", () => {
  const presents = (file: GeneratedFile) => {
    const p = new ArtifactPresentation();
    p.observe(cowork(), true);
    return p.observe(cowork("inProgress", [file]), true);
  };
  assert.ok(presents(output("md", "/w/notes.md")));
  assert.ok(presents(output("csv", "/w/data.csv", { language: "csv" })));
  const binary = (mime: string, path: string) =>
    output(path, path, { content: undefined, blob: true, mime });
  assert.ok(presents(binary("image/png", "/w/chart.png")));
  assert.ok(presents(binary("application/pdf", "/w/report.pdf")));
  assert.equal(
    presents(
      binary(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "/w/report.docx",
      ),
    ),
    undefined,
  );
  // A binary snapshot without a digest cannot be read, so it does not open.
  assert.equal(
    presents({ ...binary("image/png", "/w/x.png"), digest: undefined }),
    undefined,
  );
});

test("Cowork outputs open once per turn, as files at half width, and dismissal holds", () => {
  const p = new ArtifactPresentation();
  p.observe(cowork(), true);
  const first = cowork("inProgress", [output("a", "/w/a.md")]);
  assert.ok(p.observe(first, true));
  assert.deepEqual(p.presentationFor(first, undefined), {
    surface: "file",
    width: 50,
    keepPanel: false,
  });
  assert.equal(
    p.observe(
      cowork("inProgress", [output("a", "/w/a.md"), output("b", "/w/b.md")]),
      true,
    ),
    undefined,
  );
  const other = new ArtifactPresentation();
  other.observe(cowork(), true);
  other.dismiss(cowork());
  assert.equal(other.observe(first, true), undefined);
  // Reopening a saved Cowork conversation never opens a pane.
  const history = new ArtifactPresentation();
  history.seed([cowork("completed", [output("a", "/w/a.md")])]);
  assert.equal(
    history.observe(cowork("completed", [output("a", "/w/a.md")]), true),
    undefined,
  );
});

test("Cowork never replaces a file the person is viewing from elsewhere; Chat keeps its placement", () => {
  const p = new ArtifactPresentation();
  const c = cowork("inProgress", [output("a", "/w/a.md")]);
  const base = { id: "x", name: "x", language: "text", content: "" };
  assert.equal(
    p.presentationFor(c, { ...base, conversationId: "elsewhere" }),
    null,
  );
  assert.equal(p.presentationFor(c, { ...base, conversationId: "w" }), null);
  assert.equal(
    p.presentationFor(c, { ...base, conversationId: "w", sourcePath: "/w/b" })
      ?.surface,
    "file",
  );
  assert.deepEqual(
    p.presentationFor(conversation(), { ...base, conversationId: "other" }),
    { surface: "artifact", width: 68, keepPanel: false },
  );
});

test("an open Progress card comes back once when the presented viewer closes", () => {
  const p = new ArtifactPresentation();
  const c = cowork("inProgress", [output("a", "/w/a.md")]);
  p.progressVisible("w", true);
  p.presentationFor(c, undefined);
  p.progressVisible("w", false);
  assert.equal(p.takeRestore("w"), true);
  assert.equal(p.takeRestore("w"), false);
  // Without the card on screen nothing comes back.
  p.presentationFor(c, undefined);
  assert.equal(p.takeRestore("w"), false);
  p.restoreProgressAfterClose("w");
  assert.equal(p.takeRestore("w"), true);
  // A viewer opened over another panel forgets a wish left by a viewer that
  // closed some other way (for example by opening the Plan panel).
  p.restoreProgressAfterClose("w");
  p.restoreProgressAfterClose("w", false);
  assert.equal(p.takeRestore("w"), false);
});

test("the live turn's unopened outputs are marked, and Outputs opens itself once per turn", () => {
  const p = new ArtifactPresentation();
  p.seed([cowork("completed", [output("old", "/w/old.md")])]);
  const saved = cowork("completed", [output("old", "/w/old.md")]);
  assert.equal(p.newOutputs(saved).size, 0);
  assert.equal(p.expandOutputs(saved), false);
  const next = (files: GeneratedFile[], status: "inProgress" | "completed") => {
    const c = cowork(status, files);
    c.turns[0].id = "t2";
    return c;
  };
  p.observe(next([], "inProgress"), false);
  const running = next(
    [output("a", "/w/a.md"), output("b", "/w/b.md")],
    "inProgress",
  );
  p.observe(running, false);
  assert.deepEqual([...p.newOutputs(running)], ["/w/a.md", "/w/b.md"]);
  assert.equal(p.expandOutputs(running), true);
  assert.equal(p.expandOutputs(running), false);
  p.opened("w", "/w/a.md");
  const done = next(
    [output("a", "/w/a.md"), output("b", "/w/b.md")],
    "completed",
  );
  p.observe(done, false);
  assert.deepEqual([...p.newOutputs(done)], ["/w/b.md"]);
  // A Chat conversation's files are not tracked for the Progress card.
  const chat = conversation("inProgress", [file("chat")]);
  p.observe(chat, false);
  assert.equal(p.newOutputs(chat).size, 0);
});

test("Activity disclosure booleans are session-only, pruned on deletion and cleared by account seed", () => {
  const p = new ArtifactPresentation();
  const state = { outputs: true, progress: false, context: false };
  p.rememberActivitySections("c", state);
  p.rememberActivitySections("deleted", { outputs: true });
  state.outputs = false;
  assert.deepEqual(p.activitySectionsFor("c"), {
    outputs: true,
    progress: false,
    context: false,
  });
  p.retainActivitySections([{ id: "c" }]);
  assert.equal(p.activitySectionsFor("deleted"), undefined);
  assert.equal(p.activitySectionsFor("c")?.outputs, true);
  p.seed([conversation("completed")]);
  assert.equal(p.activitySectionsFor("c"), undefined);
  p.rememberActivitySections("c", { outputs: true });
  p.retainActivitySections([]);
  assert.equal(p.activitySectionsFor("c"), undefined);
});

test("the Progress card marks new outputs and titles each row with its path in the folder", () => {
  const p = new ArtifactPresentation();
  p.observe(cowork(), false);
  const c = {
    ...cowork("inProgress", [
      output("a", "/w/out/a.md"),
      output("b", "/w/b.md"),
    ]),
    cwd: "/w",
  };
  p.observe(c, false);
  p.opened("w", "/w/b.md");
  const html = renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      {
        value: {
          artifactPresentation: { current: p },
        } as unknown as AppController,
      },
      createElement(ProgressPanel, { conversation: c, onArtifact() {} }),
    ),
  );
  // Outputs opens itself for the turn's new files; only the unopened one is marked.
  assert.match(html, /title="out\/a\.md" data-new="true"/);
  assert.match(
    html,
    /a<\/span><span class="progress-file-kind" data-no-translate="true">MD<\/span>/,
  );
  assert.match(html, /title="b\.md">/);
  assert.equal((html.match(/class="progress-new"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Download all"/);
  assert.match(html, /Requires your computer/);
  // Once every new output was opened the card has nothing to mark.
  p.opened("w", "/w/out/a.md");
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(
        AppContext.Provider,
        {
          value: {
            artifactPresentation: { current: p },
          } as unknown as AppController,
        },
        createElement(ProgressPanel, { conversation: c, onArtifact() {} }),
      ),
    ),
    /progress-new/,
  );
  assert.equal(relativePath("/w/out/a.md", "/w"), "out/a.md");
  assert.equal(relativePath("/w2/a.md", "/w"), "/w2/a.md");
  assert.equal(relativePath("/w/a.md", "/w/"), "a.md");
  // Without the app (tests, fixtures) the card renders without marks.
  assert.match(
    renderToStaticMarkup(
      createElement(ProgressPanel, { conversation: c, onArtifact() {} }),
    ),
    /Show w|>w</,
  );
});
