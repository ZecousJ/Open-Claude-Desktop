import test from "node:test";
import assert from "node:assert/strict";
import { requestFolderAccess } from "../../src/cowork/useFolderAccess";
import type { CoworkFolderAccess } from "../../shared/cowork-api";

const access = (state: CoworkFolderAccess["state"]): CoworkFolderAccess => ({
  state,
  folder: "/w/Garden",
  name: "Garden",
});

test("a project's folder already allowed is recorded for the project without asking", async () => {
  const calls: unknown[][] = [];
  const api = {
    coworkFolderAccess: async (...args: unknown[]) => {
      calls.push(["access", ...args]);
      return access("granted");
    },
    grantCoworkFolder: async (...args: unknown[]) => {
      calls.push(["grant", ...args]);
      return access("granted");
    },
  };
  const result = await requestFolderAccess("/w/Garden", {
    projectId: "p1",
    api,
  });
  assert.equal(result, "granted");
  assert.deepEqual(calls, [
    ["access", "/w/Garden", undefined, "p1"],
    ["grant", "/w/Garden", "session", { projectId: "p1" }],
  ]);
});

test("a trusted folder needs no project record", async () => {
  let granted = false;
  const result = await requestFolderAccess("/w/Garden", {
    projectId: "p1",
    api: {
      coworkFolderAccess: async () => access("trusted"),
      grantCoworkFolder: async () => {
        granted = true;
        return access("trusted");
      },
    },
  });
  assert.equal(result, "granted");
  assert.equal(granted, false);
});
