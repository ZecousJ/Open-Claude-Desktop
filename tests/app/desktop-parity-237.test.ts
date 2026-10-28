import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileLineVersions } from "../../src/artifacts/file-history";
import { FileHistory } from "../../src/artifacts/FileHistory";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import type { Provider } from "../../shared/types";
import { unsupportedModel } from "../../src/composer/unsupported-model";
import { UnsupportedModel } from "../../src/composer/UnsupportedModel";
import { skillImportNotice } from "../../shared/skill-import";
import {
  importSkillFiles,
  skillImportNotification,
} from "../../electron/skills/skill-import";
import { relativeTime } from "../../src/ui/RelativeTime";
import {
  skillSourceFiles,
  type SkillSourceFile,
} from "../../src/settings/skill-import-files";
import { unzipSkill } from "../../electron/skills/skill-folder";
import { MenuValue } from "../../src/ui/menu-rows";
import { formatText } from "../../src/i18n";
import { tabAvailable } from "../../src/settings/nav";
import { hostFor } from "../../shared/host";

const version = (content: string, index = 1): Artifact => ({
  id: String(index),
  sourceDigest: String(index),
  name: "notes.txt",
  content,
  language: "text",
  updatedAt: 1_000_000,
});
const provider: Provider = {
  id: "p",
  name: "Service",
  model: "new",
  models: ["new"],
  baseUrl: "https://example.test",
  protocol: "openai-responses" as Provider["protocol"],
};
const source = (
  relative: string,
  text: string,
  size?: number,
): SkillSourceFile => ({
  name: relative.split("/").at(-1)!,
  webkitRelativePath: relative,
  size: size ?? Buffer.byteLength(text),
  async arrayBuffer() {
    return Uint8Array.from(Buffer.from(text)).buffer;
  },
});

test("skill import system notifications use the selected language and retain partial results", async () => {
  assert.deepEqual(await skillImportNotification(1, 2, "en-US"), {
    title: "1 of 3 skills uploaded from Claudex (third-party)",
    body: "See it in Customize › Skills.\nFind the rest in Settings › Import.",
  });
  for (const locale of [
    "zh-CN",
    "ja-JP",
    "ko-KR",
    "de-DE",
    "fr-FR",
    "es-ES",
    "es-419",
    "it-IT",
    "pt-BR",
    "id-ID",
    "hi-IN",
  ]) {
    const notice = await skillImportNotification(2, 0, locale);
    assert.ok(notice.title.includes("2"));
    assert.ok(!notice.title.includes("{n}"));
    assert.notEqual(notice.body, "See them in Customize › Skills.");
  }
});

test("file blame keeps relative dates alongside absolute dates even after a week", () => {
  const now = Date.now();
  assert.equal(
    relativeTime(now - 10 * 86400_000, now, Infinity),
    "10 days ago",
  );
});

test("file blame retains earlier writes through insertion, deletion and CRLF", () => {
  assert.deepEqual(
    fileLineVersions([
      version("one\r\ntwo\r\nthree\r\n"),
      version("one\nnew\ntwo\nthree\n", 2),
      version("new\ntwo\nchanged\n", 3),
    ]),
    [2, 1, 3],
  );
  assert.deepEqual(
    fileLineVersions([version("a\n"), version("", 2), version("a\n", 3)]),
    [3],
  );
  assert.deepEqual(fileLineVersions([]), []);
});

test("large rewrites retain unique interior anchors beyond the Myers edit cap", () => {
  const old = [
    ...Array.from({ length: 600 }, (_, index) => `old-${index}`),
    "anchor",
    "shared",
    ...Array.from({ length: 600 }, (_, index) => `end-old-${index}`),
  ];
  const next = [
    ...Array.from({ length: 600 }, (_, index) => `new-${index}`),
    "anchor",
    "shared",
    ...Array.from({ length: 600 }, (_, index) => `end-new-${index}`),
  ];
  const blame = fileLineVersions([
    version(old.join("\n")),
    version(next.join("\n"), 2),
  ]);
  assert.equal(blame[599], 2);
  assert.equal(blame[600], 1);
  assert.equal(blame[601], 1);
  assert.equal(blame[602], 2);
});

test("blame's back control returns to history rather than closing the viewer", () => {
  const props = {
    path: "notes.txt",
    versions: [version("a"), version("b", 2)],
    activeVersion: 2,
    author: "Claudex",
    onSelect() {},
    onClearBlame() {},
  };
  const blame = renderToStaticMarkup(
    createElement(FileHistory, { ...props, line: 0, lineVersion: 1 }),
  );
  assert.match(blame, /aria-label="Back to file history"/);
  assert.match(blame, /Last modified in/);
  assert.match(blame, /notes.txt:1/);
  const history = renderToStaticMarkup(createElement(FileHistory, props));
  assert.doesNotMatch(history, /Back to file history/);
  assert.match(history, /aria-current="true"/);
  assert.ok(history.indexOf("v2") < history.indexOf("v1"));
});

test("unsupported model waits for providers, accepts offered models and offers a real fallback", () => {
  assert.equal(unsupportedModel([], "p", "old", null), undefined);
  assert.equal(unsupportedModel([provider], "p", "new", null), undefined);
  const notice = unsupportedModel([provider], "p", "old", null)!;
  assert.equal(notice.fallback?.name, "new");
  const html = renderToStaticMarkup(
    createElement(UnsupportedModel, { notice, onSwitch() {} }),
  );
  assert.match(html, /This deployment doesn’t support this model\./);
  assert.match(html, /You can continue using new instead\./);
  assert.match(html, /Switch to new/);
});

test("empty deployments distinguish service admin from inference configuration", () => {
  const empty = { ...provider, model: "", models: [] };
  assert.equal(
    unsupportedModel([empty], "p", "old", null)?.hint,
    "Make another model available in your inference configuration.",
  );
  assert.equal(
    unsupportedModel([{ ...empty, backend: "sub2api" }], "p", "old", null)
      ?.hint,
    "Ask your admin to make another model available.",
  );
  assert.equal(
    unsupportedModel([provider], "removed-service", "new", null)?.fallback
      ?.providerId,
    "p",
  );
});

test("skill import notices use explicit singular and plural templates without ICU", () => {
  assert.deepEqual(skillImportNotice(1, 0), {
    title: "{n} skill uploaded from Claudex (third-party)",
    detail: "See it in Customize › Skills.",
    remaining: undefined,
  });
  assert.equal(
    skillImportNotice(2, 0).title,
    "{n} skills uploaded from Claudex (third-party)",
  );
  assert.deepEqual(skillImportNotice(1, 2), {
    title: "{n} of {total} skills uploaded from Claudex (third-party)",
    detail: "See it in Customize › Skills.",
    remaining: "Find the rest in Settings › Import.",
  });
  assert.equal(
    skillImportNotice(2, 1).detail,
    "See them in Customize › Skills.",
  );
});

test("imports keep successful skills and leave failed files retryable", () => {
  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-skill-import-"),
  );
  try {
    const good = {
      name: "notes.md",
      data: Buffer.from("---\nname: notes\ndescription: Notes\n---\nBody"),
    };
    const bad = { name: "broken.skill", data: Buffer.from("not a zip") };
    const results = importSkillFiles(folder, [good, bad]);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(
      fs.readFileSync(path.join(folder, "notes", "SKILL.md"), "utf8"),
      Buffer.from(good.data).toString(),
    );
    assert.equal(importSkillFiles(folder, [good])[0].ok, false);
    assert.deepEqual(fs.readdirSync(folder), ["notes"]);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("imports accept the official 30 MB limit without changing ordinary skill uploads", () => {
  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-skill-import-limit-"),
  );
  try {
    const data = Buffer.alloc(21 * 1024 * 1024, " ");
    data.write("---\nname: large\ndescription: Large\n---\n");
    assert.equal(
      importSkillFiles(folder, [{ name: "large.md", data }])[0].ok,
      true,
    );
    assert.equal(
      fs.statSync(path.join(folder, "large", "SKILL.md")).size,
      data.length,
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("source folder import follows user-created manifest entries and preserves supporting files", async () => {
  const root =
    "source/skills-plugin/00000000-0000-4000-8000-000000000001/install/";
  const files = [
    source(
      `${root}manifest.json`,
      JSON.stringify({
        skills: [
          { name: "notes", creatorType: "user" },
          { name: "ignored", creatorType: "plugin" },
          { name: "../escape", creatorType: "user" },
        ],
      }),
    ),
    source(
      `${root}notes/SKILL.md`,
      "---\nname: notes\ndescription: Notes\n---\nBody",
    ),
    source(`${root}notes/scripts/run.py`, "print(1)"),
    source(`${root}notes/.private`, "secret"),
    source(`${root}notes/hooks/run.py`, "skip"),
    source(`${root}ignored/SKILL.md`, "ignored"),
  ];
  const packed = await skillSourceFiles(files);
  assert.equal(packed.length, 1);
  const entries = unzipSkill(Buffer.from(packed[0].data));
  assert.equal(entries.get("scripts/run.py")?.toString(), "print(1)");
  assert.equal(entries.has(".private"), false);
  assert.equal(entries.has("hooks/run.py"), false);
  assert.equal(entries.has("ignored/SKILL.md"), false);
});

test("portable skill folders import without a third-party manifest and enforce pack limits", async () => {
  assert.equal(
    (await skillSourceFiles([source("notes/SKILL.md", "body")])).length,
    1,
  );
  await assert.rejects(
    skillSourceFiles([source("notes/SKILL.md", "body", 31 * 1024 * 1024)]),
    /too large/,
  );
});

test("plugin counts show only a number visually and a singular or plural noun to screen readers", () => {
  for (const count of [0, 1, 2]) {
    const label = formatText(count === 1 ? "1 plugin" : "{count} plugins", {
      count,
    });
    const html = renderToStaticMarkup(
      createElement(MenuValue, { value: String(count), label }),
    );
    assert.match(html, new RegExp(`<span aria-hidden="true">${count}</span>`));
    assert.match(
      html,
      new RegExp(
        `<span class="sr-only">${count} plugin${count === 1 ? "" : "s"}</span>`,
      ),
    );
  }
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(MenuValue, { value: "⌘K" })),
    /aria-hidden|sr-only/,
  );
});

test("skill import is reachable on web without desktop-only history methods", () => {
  assert.equal(tabAvailable("import", hostFor("web"), false), true);
});
