import test from "node:test";
import assert from "node:assert/strict";
import { isPackageFolder } from "../../electron/workspace/package-folder";

test("Open in reveals macOS packages instead of launching them", () => {
  assert.equal(isPackageFolder("/Applications/Calculator.app"), true);
  assert.equal(isPackageFolder("/Applications/Calculator.app/"), true);
  assert.equal(isPackageFolder("/Library/Frameworks/Foo.framework"), true);
  assert.equal(isPackageFolder("/Users/me/projects/claudex"), false);
  assert.equal(isPackageFolder("/Users/me/app"), false);
  assert.equal(isPackageFolder("C:\\work\\site"), false);
});
