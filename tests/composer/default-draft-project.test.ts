import test from "node:test";
import assert from "node:assert/strict";
import { draftProjectId } from "../../src/app/default-draft-project";
import type { Project } from "../../shared/types";

const project: Project = {
  id: "live",
  name: "Live project",
  description: "",
  instructions: "",
  createdAt: 1,
};
test("remembered project applies to a new unified draft with a current project", () => {
  for (const mode of ["chat", "cowork"] as const)
    assert.equal(
      draftProjectId({
        mode,
        incognito: false,
        defaultId: "live",
        projects: [project],
      }),
      "live",
    );
});
test("Code and incognito drafts do not inherit the remembered project", () => {
  assert.equal(
    draftProjectId({
      mode: "code",
      incognito: false,
      defaultId: "live",
      projects: [project],
    }),
    undefined,
  );
  assert.equal(
    draftProjectId({
      mode: "chat",
      incognito: true,
      defaultId: "live",
      projects: [project],
    }),
    undefined,
  );
});
test("missing, deleted and archived default projects are ignored", () => {
  for (const projects of [
    [],
    [project],
    [{ ...project, id: "gone", archivedAt: 123 }],
  ])
    assert.equal(
      draftProjectId({
        mode: "chat",
        incognito: false,
        defaultId: "gone",
        projects,
      }),
      undefined,
    );
});
test("an explicit project always takes precedence over the remembered choice", () => {
  for (const mode of ["chat", "cowork", "code"] as const)
    assert.equal(
      draftProjectId({
        mode,
        incognito: false,
        defaultId: "live",
        explicitId: "explicit",
        projects: [project],
      }),
      "explicit",
    );
});
