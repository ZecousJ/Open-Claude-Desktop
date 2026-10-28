import assert from "node:assert/strict";
import test from "node:test";
import {
  commandOutput,
  runKind,
  runnableCommand,
} from "../../src/code-run/run-store";

test("shell blocks run; PowerShell on Windows reads Run in PowerShell", () => {
  assert.equal(runKind("bash", false), "terminal");
  assert.equal(runKind("console", false), "terminal");
  assert.equal(runKind("powershell", true), "powershell");
  assert.equal(runKind("powershell", false), undefined);
  assert.equal(runKind("js", false), undefined);
  assert.equal(
    runnableCommand("$ npm test\nok 1\n$ npm run build"),
    "npm test\nnpm run build",
  );
  assert.equal(runnableCommand("ls -la"), "ls -la");
});

test("the output is what printed between the command marks", () => {
  const raw =
    "prompt % \u001b]133;A\u0007ls\r\n\u001b]133;C\u0007\u001b[32ma.txt\u001b[0m\r\nb.txt\r\n\u001b]133;D;0\u0007prompt % ";
  assert.equal(commandOutput(raw), "a.txt\nb.txt");
});
