import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import type { Project } from "../../shared/types";
import { HostContext } from "../../src/host/HostContext";
import { ProjectOverview } from "../../src/collections/projects/ProjectOverview";

const project: Project = {
  id: "p1",
  kind: "local",
  name: "Garden",
  description: "",
  instructions: "",
  cwd: "/Users/ada/Garden",
  createdAt: 0,
};

const page = (host: HostInfo, value: Project) =>
  renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: host },
      createElement(ProjectOverview, {
        project: value,
        chats: [],
        composer: null,
        menuOpen: false,
        onBack: () => {},
        onMenu: () => {},
        onSave: async () => {},
        onChooseFolder: async () => null,
        onScheduled: () => {},
        onOpenConversation: () => {},
      }),
    ),
  );

test("the folder block shows the folder with Choose a different folder and a one-click remove", () => {
  const html = page(desktopHost, project);
  assert.match(html, /<h2>Folders<\/h2>/);
  assert.match(html, /aria-label="Choose a different folder"/);
  assert.match(
    html,
    /<span class="prj-path">Garden<\/span><button type="button" aria-label="Remove folder Garden">/,
  );
  // No confirmation dialog waits behind the X (live removes a project's
  // only folder on this computer at once).
  assert.doesNotMatch(html, /alertdialog|stops using this folder/);
  // The device line waits for the host's report (an effect), so the first
  // paint has none.
  assert.doesNotMatch(html, /prj-folder-where/);
});

test("without a folder the block offers Choose a folder; the web has no folder block", () => {
  const html = page(desktopHost, { ...project, cwd: undefined });
  assert.match(html, /aria-label="Choose a folder"/);
  assert.match(html, /Add a folder on this computer for Claudex to work in\./);
  assert.doesNotMatch(html, /Remove folder/);
  assert.doesNotMatch(page(webHost, project), /<h2>Folders<\/h2>/);
});

test("Chat and Code projects never show Cowork's folder section", () => {
  assert.doesNotMatch(
    page(desktopHost, { ...project, kind: "chat" }),
    /<h2>Folders<\/h2>/,
  );
  assert.doesNotMatch(
    page(desktopHost, { ...project, kind: "code" }),
    /<h2>Folders<\/h2>/,
  );
});

test("several folders: a row each, only Add in the header, off at 16", async () => {
  const { projectFolderLimit } = await import("../../shared/project-folders");
  const two = page(desktopHost, {
    ...project,
    additionalFolders: ["/Users/ada/Notes"],
  });
  assert.match(two, /aria-label="Remove folder Garden"/);
  assert.match(two, /aria-label="Remove folder Notes"/);
  // Edit is for a project's only folder (live).
  assert.doesNotMatch(two, /aria-label="Choose a different folder"/);
  assert.match(two, /aria-label="Add a folder" aria-haspopup="menu"/);
  const full = page(desktopHost, {
    ...project,
    additionalFolders: Array.from(
      { length: projectFolderLimit - 1 },
      (_, i) => `/Users/ada/f${i}`,
    ),
  });
  assert.match(full, /aria-label="Add a folder" aria-disabled="true"/);
});

test("adding folders skips ones already there and stops at 16", async () => {
  const { foldersToAdd, folderPickerRows } =
    await import("../../src/collections/projects/ProjectFolders");
  assert.deepEqual(foldersToAdd(["/a"], ["/a", "/b", "/b", ""]), {
    add: ["/b"],
    already: ["/a"],
    overLimit: 0,
  });
  const fifteen = Array.from({ length: 15 }, (_, i) => `/f${i}`);
  assert.deepEqual(foldersToAdd(fifteen, ["/x", "/y", "/z"]), {
    add: ["/x"],
    already: [],
    overLimit: 2,
  });
  // The picker lists recent folders not in the project, by name or path.
  assert.deepEqual(
    folderPickerRows(
      ["/w/Garden", "/w/Notes", "/x/garden-old"],
      ["/w/Notes"],
      "gard",
    ),
    ["/w/Garden", "/x/garden-old"],
  );
});

test("the project's folders: the first works, the rest follow, 16 at most", async () => {
  const folders = await import("../../shared/project-folders");
  const added = folders.addProjectFolder(project, "/Users/ada/Notes");
  assert.deepEqual(added.additionalFolders, ["/Users/ada/Notes"]);
  assert.equal(folders.addProjectFolder(added, "/Users/ada/Notes"), added);
  const removed = folders.removeProjectFolder(added, "/Users/ada/Garden");
  assert.equal(removed.cwd, "/Users/ada/Notes");
  assert.equal(removed.additionalFolders, undefined);
  // Edit replaces only a project's single folder.
  assert.equal(folders.replaceProjectFolder(added, "/z"), added);
  assert.equal(folders.replaceProjectFolder(project, "/z").cwd, "/z");
  const many = folders.withProjectFolders(
    project,
    Array.from({ length: 20 }, (_, i) => `/f${i}`),
  );
  assert.equal(folders.projectFolders(many).length, folders.projectFolderLimit);
});
