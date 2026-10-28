import test from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../support/read-source";

// The window-level SSH dialogs confirm what they did: the overlay registers on
// import, so the wiring is read from its source.
test("saving and deleting an SSH connection tell the person so", () => {
  const source = readSource("src/ssh/ssh.slot.tsx");
  assert.match(
    source,
    /await saveSshHost\(input\);\s*app\.notify\(\s*t\(\s*dialog\.host\s*\? "SSH connection updated\."\s*: "SSH connection added\.",?\s*\),?\s*\);/,
  );
  assert.match(
    source,
    /await deleteSshHost\(dialog\.host!\.id\);\s*closeSshDialog\(\);\s*app\.notify\(t\("SSH connection deleted\."\)\);/,
  );
});
