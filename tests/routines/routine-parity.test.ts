import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readSource } from "../support/read-source";

test("scheduled-task parity keeps official confirmation and feedback copy", () => {
  const editor = fs.readFileSync(
    "src/collections/routines/RoutineEditor.tsx",
    "utf8",
  );
  const page = readSource("src/collections/routines/RoutinesPage.tsx");
  assert.match(editor, /Discard unsaved changes\?/);
  assert.match(editor, /Your changes haven’t been saved and will be lost\./);
  assert.match(editor, /Keep editing/);
  assert.match(page, /Scheduled task created/);
  assert.match(page, /Failed to create scheduled task\. You can try again\./);
});
