import test from "node:test";
import assert from "node:assert/strict";
import { registerRemoteAuthHandlers } from "../../electron/ipc/remote-auth";
import { loadSub2ApiConfig } from "../../server/sub2api-config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function setup(answers: boolean) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const chosen: string[] = [];
  const accounts = {
    baseUrl: "",
    get configured() {
      return this.baseUrl !== "";
    },
    hasAccounts: false,
    useService(url: string) {
      this.baseUrl = url;
    },
    async publicSettings() {
      if (!answers) throw new Error("offline");
      return {};
    },
    async policy() {
      return { registrationEnabled: true };
    },
  };
  registerRemoteAuthHandlers((name, fn) => handlers.set(name, fn), {
    accounts: accounts as any,
    activate: async () => {
      throw new Error("unused");
    },
    deactivate: async () => {},
    serviceChosen: async (url) => void chosen.push(url),
  });
  return { handlers, accounts, chosen };
}

test("without a service the sign-in page asks for its address", async () => {
  const { handlers } = setup(true);
  assert.deepEqual(await handlers.get("authStatus")!(), {
    serviceConfigured: false,
    hasAccounts: false,
  });
});

test("an address that answers is kept; one that doesn't is refused", async () => {
  const ok = setup(true);
  const status = await ok.handlers.get("setServiceAddress")!(
    "https://claudex.example.com/",
  );
  assert.equal(status.serviceOrigin, "https://claudex.example.com");
  assert.deepEqual(ok.chosen, ["https://claudex.example.com"]);
  const bad = setup(false);
  await assert.rejects(
    bad.handlers.get("setServiceAddress")!("https://nothing.example.com"),
    /No Claudex service answered/,
  );
  assert.equal(bad.accounts.baseUrl, "");
  assert.deepEqual(bad.chosen, []);
  await assert.rejects(
    ok.handlers.get("setServiceAddress")!("http://plain.example.com"),
    /https/,
  );
});

test("with no file, variable or build default there is no service", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-service-"));
  try {
    assert.equal(loadSub2ApiConfig(root, {}).baseUrl, "");
    assert.equal(
      loadSub2ApiConfig(root, {
        CLAUDEX_SUB2API_URL: "https://claudex.example.com/",
      }).baseUrl,
      "https://claudex.example.com",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
