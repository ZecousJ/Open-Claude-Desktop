import assert from "node:assert/strict";
import test from "node:test";
import { artifactProjectFile } from "../../src/artifacts/artifact-project-file";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import { knowledgeName } from "../../electron/projects/project-knowledge";

const artifact = (extra: Partial<Artifact>): Artifact => ({
  id: "a",
  name: "Quarterly report",
  language: "html",
  content: "<p>héllo</p>",
  surface: "artifact",
  ...extra,
});

test("a text artifact becomes <title>.<extension> with its text", () => {
  const file = artifactProjectFile(artifact({}));
  assert.equal(file?.name, "Quarterly report.html");
  assert.equal(new TextDecoder().decode(file?.data), "<p>héllo</p>");
  const names = (extra: Partial<Artifact>) =>
    artifactProjectFile(artifact(extra))?.name;
  assert.equal(names({ language: "svg" }), "Quarterly report.svg");
  assert.equal(names({ language: "markdown" }), "Quarterly report.md");
  assert.equal(names({ language: "react" }), "Quarterly report.tsx");
  assert.equal(names({ language: "jsx" }), "Quarterly report.tsx");
  assert.equal(names({ language: "mermaid" }), "Quarterly report.mermaid");
  assert.equal(names({ language: "csv" }), "Quarterly report.csv");
  assert.equal(names({ language: "python" }), "Quarterly report.py");
  assert.equal(names({ language: "cobol" }), "Quarterly report.txt");
  // A file's own name keeps its extension and is not doubled.
  assert.equal(
    names({ name: "notes.md", filename: "notes.md", language: "text" }),
    "notes.md",
  );
  // A dot in a title is not an extension.
  assert.equal(names({ name: "Plan v1.2" }), "Plan v1.2.html");
  assert.equal(names({ name: " " }), "Artifact.html");
});

test("what the project keeps accepts every name it makes", () => {
  for (const language of [
    "html",
    "svg",
    "react",
    "markdown",
    "mermaid",
    "csv",
    "tsv",
    "javascript",
    "unknown",
  ]) {
    const file = artifactProjectFile(artifact({ language }));
    assert.ok(file);
    assert.equal(knowledgeName(file.name), file.name);
  }
});

test("a binary artifact cannot be copied to a project", () => {
  assert.equal(
    artifactProjectFile(
      artifact({ blob: true, content: "", mime: "image/png", name: "a.png" }),
    ),
    null,
  );
});
