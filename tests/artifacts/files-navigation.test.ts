import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useState } from "react";
import { routineDom } from "../support/routine-dom";
import { FileDocuments } from "../../src/files/file-documents";
import { useFileNavigation } from "../../src/files/useFileNavigation";
import { deferFileTransition } from "../../src/files/file-transitions";
import { useNavigationHistory } from "../../src/app/useNavigationHistory";
import { useToolPanels } from "../../src/app/useToolPanels";

const file = (content = "original") => ({
  path: "one.ts",
  content,
  bytes: content.length,
  revision: "a".repeat(64),
  writable: true,
});
async function environment() {
  const dom = await routineDom();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "CustomEvent");
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: dom.window.CustomEvent,
  });
  const clean = dom.clean;
  dom.clean = async () => {
    await clean();
    if (descriptor)
      Object.defineProperty(globalThis, "CustomEvent", descriptor);
    else Reflect.deleteProperty(globalThis, "CustomEvent");
  };
  return dom;
}
function Harness({
  docs,
  auto = false,
  onNavigate = () => {},
}: {
  docs: FileDocuments;
  auto?: boolean;
  onNavigate?: () => void;
}) {
  const navigation = useFileNavigation(docs, auto, () => {});
  return createElement(
    "section",
    null,
    createElement(
      "button",
      {
        id: "next",
        onClick: () => navigation.run(onNavigate, undefined, "session"),
      },
      "Next",
    ),
    navigation.prompt,
  );
}
const loaded = async (
  write?: NonNullable<
    ConstructorParameters<typeof FileDocuments>[1]["writeProjectFile"]
  >,
) => {
  const docs = new FileDocuments("one", {
    readProjectFile: async () => file(),
    writeProjectFile:
      write ??
      (async (_id, _path, content) => ({
        status: "saved",
        file: file(content),
      })),
  });
  docs.setAutoSave(false);
  await docs.open("one.ts");
  docs.edit("one.ts", "changed");
  return docs;
};
test("manual dirty navigation keeps its session until Keep editing or explicit Discard", async () => {
  const dom = await environment(),
    docs = await loaded();
  let navigated = 0;
  try {
    await dom.render(
      createElement(Harness, { docs, onNavigate: () => navigated++ }),
    );
    await dom.click("#next");
    assert.equal(navigated, 0);
    assert.match(dom.document.body.textContent!, /Discard unsaved changes/);
    assert.match(dom.document.body.textContent!, /Leaving this session/);
    const button = (label: string) =>
      [...dom.document.querySelectorAll("button")].find(
        (e) => e.textContent === label,
      )!;
    await dom.event(button("Keep editing"), "click");
    assert.deepEqual(docs.dirty(), ["one.ts"]);
    assert.equal(navigated, 0);
    await dom.click("#next");
    await dom.event(button("Discard"), "click");
    assert.equal(navigated, 1);
    assert.deepEqual(docs.dirty(), []);
    assert.equal(
      (docs.snapshot()["one.ts"] as { value: string }).value,
      "original",
    );
  } finally {
    docs.dispose();
    await dom.clean();
  }
});
test("autosave navigation waits for real save; failure preserves buffer and prompts", async () => {
  const dom = await environment();
  let release: ((value: unknown) => void) | undefined;
  const docs = await loaded(
    () =>
      new Promise((resolve) => {
        release = resolve as never;
      }),
  );
  let navigated = 0;
  try {
    await dom.render(
      createElement(Harness, {
        docs,
        auto: true,
        onNavigate: () => navigated++,
      }),
    );
    await dom.click("#next");
    assert.equal(navigated, 0);
    assert.equal(dom.document.querySelector('[role="alertdialog"]'), null);
    await act(async () =>
      release!({ status: "conflict", currentRevision: "b".repeat(64) }),
    );
    assert.match(dom.document.body.textContent!, /Discard unsaved changes/);
    assert.deepEqual(docs.dirty(), ["one.ts"]);
    assert.equal(navigated, 0);
  } finally {
    docs.dispose();
    await dom.clean();
  }
});
test("discard waits for in-flight writes rather than silently saving after closing", async () => {
  const dom = await environment();
  let release: ((value: unknown) => void) | undefined;
  const docs = await loaded(
    () =>
      new Promise((resolve) => {
        release = resolve as never;
      }),
  );
  let navigated = 0;
  try {
    const writing = docs.save("one.ts");
    await dom.render(
      createElement(Harness, { docs, onNavigate: () => navigated++ }),
    );
    await dom.click("#next");
    assert.equal(navigated, 0);
    assert.equal(dom.document.querySelector('[role="alertdialog"]'), null);
    await act(async () => release!({ status: "saved", file: file("changed") }));
    await writing;
    assert.equal(navigated, 1);
    assert.deepEqual(docs.dirty(), []);
  } finally {
    docs.dispose();
    await dom.clean();
  }
});
test("unmounted editor cannot apply a late navigation intent", async () => {
  const dom = await environment();
  let release: ((value: unknown) => void) | undefined;
  const docs = await loaded(
    () =>
      new Promise((resolve) => {
        release = resolve as never;
      }),
  );
  let navigated = 0;
  try {
    await dom.render(
      createElement(Harness, {
        docs,
        auto: true,
        onNavigate: () => navigated++,
      }),
    );
    await dom.click("#next");
    await dom.render(createElement("p", null, "Another account"));
    await act(async () => release!({ status: "saved", file: file("changed") }));
    assert.equal(navigated, 0);
    assert.equal(dom.document.body.textContent, "Another account");
  } finally {
    docs.dispose();
    await dom.clean();
  }
});
test("history cursor and dock state do not move before the dirty-file decision", async () => {
  const dom = await environment(),
    docs = await loaded();
  let allow = false;
  function App() {
    const [place, setPlace] = useState("a"),
      panels = useToolPanels();
    const history = useNavigationHistory({
      location: { page: place, surface: "code" },
      record: true,
      valid: () => true,
      apply: (entry) => setPlace(entry.page),
      beforeMove: (resume) => !allow && deferFileTransition(resume),
    });
    const navigation = useFileNavigation(docs, false, () => {});
    return createElement(
      "section",
      null,
      createElement("output", null, `${place}:${panels.dock.join(",")}`),
      createElement(
        "button",
        { id: "visit", onClick: () => setPlace("b") },
        "Visit",
      ),
      createElement("button", { id: "back", onClick: history.back }, "Back"),
      createElement(
        "button",
        { id: "files", onClick: () => panels.setPanel("files") },
        "Files",
      ),
      createElement(
        "button",
        { id: "close", onClick: () => panels.close("files") },
        "Close",
      ),
      navigation.prompt,
    );
  }
  try {
    await dom.render(createElement(App));
    await dom.click("#visit");
    await dom.click("#files");
    await dom.click("#close");
    assert.equal(dom.document.querySelector("output")!.textContent, "b:files");
    await dom.event(
      [...dom.document.querySelectorAll("button")].find(
        (e) => e.textContent === "Keep editing",
      )!,
      "click",
    );
    await dom.click("#back");
    assert.equal(dom.document.querySelector("output")!.textContent, "b:files");
    await dom.event(
      [...dom.document.querySelectorAll("button")].find(
        (e) => e.textContent === "Keep editing",
      )!,
      "click",
    );
    allow = true;
    docs.revert("one.ts");
    await dom.click("#back");
    assert.equal(dom.document.querySelector("output")!.textContent, "a:files");
    await dom.click("#close");
    assert.equal(dom.document.querySelector("output")!.textContent, "a:");
  } finally {
    docs.dispose();
    await dom.clean();
  }
});
