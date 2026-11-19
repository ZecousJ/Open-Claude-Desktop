import test from "node:test";
import assert from "node:assert/strict";
import { bindNativeCommandContext } from "../electron/official-ui/native-command-context";
import type { AdapterContext } from "../electron/official-ui/api/context";

test("native command permissions follow the active account window", () => {
  const first = { project: () => "first" } as any;
  const second = { project: () => "second" } as any;
  let active: any = first;
  const context = bindNativeCommandContext({ appVersion: "fixture" } as AdapterContext, () => active);
  assert.equal(context.codeCommandPermissions, first);
  active = undefined;
  assert.equal(context.codeCommandPermissions, undefined);
  active = second;
  assert.equal(context.codeCommandPermissions, second);
  assert.equal(context.appVersion, "fixture");
});
