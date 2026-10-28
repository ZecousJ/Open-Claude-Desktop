import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the sign-in page's calls answer before an account is signed in", () => {
  const source = readFileSync("electron/app/ipc-handle.ts", "utf8");
  const allowed = source.slice(
    source.indexOf("!new Set(["),
    source.indexOf("]).has(name)"),
  );
  for (const name of [
    "loginAccount",
    "sendSignInCode",
    "loginWithCode",
    "loginWithPasskey",
    "loginWithGoogle",
    "cancelGoogleSignIn",
  ])
    assert.match(allowed, new RegExp(`"${name}"`), name);
});
