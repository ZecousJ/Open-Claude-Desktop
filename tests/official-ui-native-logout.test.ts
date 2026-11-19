import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createNativeAccountApi } from "../electron/official-ui/api/native-account-api";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { createOfficialActivationLease } from "../electron/official-ui/activation-lease";
import { authorizeRetiredTerminalResponse } from "../electron/official-ui/response-lease";
import { startOfficialUiServer } from "../electron/official-ui/server";

for (const scenario of ["success", "failure", "current-failure", "read-only"] as const) {
  test(`native logout ${scenario} keeps the response tied to its operation`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-native-logout-"));
    fs.mkdirSync(path.join(root, "ui"));
    fs.writeFileSync(path.join(root, "ui", "index.html"), "test");
    const identity = { owner: "account-a", store: {}, generation: 1, active: true };
    const lease = createOfficialActivationLease(identity, () => identity);
    const calls: string[] = [];
    const context = {
      root,
      account: () => ({ id: "account-a" }),
      sessionIdentity: () => identity,
      stateDirectory: () => root,
      isCurrent: () => lease.current(),
      readOnly: scenario === "read-only",
      log: () => {},
      call: async (method: string) => {
        calls.push(method);
        const complete = authorizeRetiredTerminalResponse(lease, method);
        if (scenario !== "current-failure") lease.retire();
        if (scenario === "failure" || scenario === "current-failure") {
          complete?.(false);
          throw new Error("native logout failed");
        }
        complete?.(true);
      },
    } as unknown as AdapterContext;
    const server = await startOfficialUiServer({ root, isCurrent: () => lease.current(), responseLease: lease, api: createNativeAccountApi(context) });
    const origin = server.origin.replace("localhost", "127.0.0.1");
    try {
      const response = await fetch(origin + "/api/auth/logout", {
        method: "POST",
        headers: { Cookie: `claudex_official_ui=${server.token}`, Connection: "close" },
      });
      assert.equal(response.status, scenario === "success" ? 204 : scenario === "failure" || scenario === "current-failure" ? 400 : 501);
      assert.deepEqual(calls, scenario === "read-only" ? [] : ["logoutAccount"]);
      const body = await response.text();
      if (scenario === "success") {
        assert.equal(body, "");
        const later = await fetch(origin + "/api/auth/logout", { method: "POST", headers: { Cookie: `claudex_official_ui=${server.token}`, Connection: "close" } });
        assert.notEqual(later.status, 204);
        assert.deepEqual(calls, ["logoutAccount"]);
      }
      if (scenario === "failure" || scenario === "current-failure") assert.doesNotMatch(body, /native logout failed/);
    } finally {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
