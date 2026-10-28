import test from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../support/read-source";

test("Ongoing in Dispatch and Go to scheduled task open the task's detail, not its editor", () => {
  for (const file of [
    "src/dispatch/DispatchPage.tsx",
    "src/sidebar/RowMenu.tsx",
  ]) {
    const source = readSource(file, "utf8");
    assert.match(source, /openRoutineId:/, file);
    assert.doesNotMatch(
      source,
      /requestScheduleConfirmation\(\{[^}]*\broutineId:/,
      file,
    );
  }
});
