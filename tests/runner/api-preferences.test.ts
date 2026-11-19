import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultSettings } from "../../electron/store/store";
import { CloudStore, type StoreTransport } from "../../runner/src/cloud-store";
import { LinkRequestError } from "../../runner/src/control-link";
import type { Settings } from "../../shared/types";
import { webErrorCodes } from "../../shared/web-protocol";

for (const outcome of ["refused", "unconfirmed"] as const) {
  test(`cloud API preferences retain their last confirmed values when a save is ${outcome}`, async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "claudex-api-preferences-"),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let saved: Settings & { imageModel?: string } = {
      ...defaultSettings,
      apiGroups: { openai: 4 },
      imageModel: "gpt-image-1",
    };
    const writes: Settings[] = [];
    let refuse = true;
    const transport: StoreTransport = {
      async request(op, _owner, body) {
        if (op === "store.settings.get")
          return { settings: structuredClone(saved) };
        if (op === "store.projects.list") return { projects: [] };
        if (op === "store.conversations.list") return { items: [] };
        assert.equal(op, "store.settings.put");
        if (!body || typeof body !== "object" || !("settings" in body))
          assert.fail("Missing settings write");
        const settings = body.settings as Settings;
        writes.push(settings);
        if (refuse && outcome === "refused")
          throw new LinkRequestError({
            code: webErrorCodes.quotaExceeded,
            message: "Quota exceeded.",
          });
        saved = structuredClone(settings);
        if (refuse) throw Error("Acknowledgement lost.");
        return {};
      },
    };
    const store = await CloudStore.open({ root, userId: 1, transport });
    t.after(() => store.close());
    const patch = () => ({
      apiGroups: { openai: 11 },
    });
    await assert.rejects(
      store.persistApiPreferences(patch, () => true),
      outcome === "refused" ? /Quota exceeded/ : /could not be confirmed/,
    );
    assert.deepEqual(store.settings.apiGroups, { openai: 4 });
    refuse = false;
    store.settings.instructions = "Other setting";
    await store.sync("full");
    if (outcome === "unconfirmed") {
      assert.equal(writes.length, 1);
      assert.deepEqual(saved.apiGroups, { openai: 11 });
      await assert.rejects(
        store.persistApiPreferences(patch, () => true),
        /cannot be saved/,
      );
      return;
    }
    assert.deepEqual(saved.apiGroups, { openai: 4 });
    assert.equal(saved.imageModel, "gpt-image-1");
    assert.equal(saved.instructions, "Other setting");
    await store.persistApiPreferences(patch, () => true);
    const reopened = await CloudStore.open({ root, userId: 1, transport });
    t.after(() => reopened.close());
    assert.deepEqual(reopened.settings.apiGroups, { openai: 11 });
    assert.equal(saved.imageModel, "gpt-image-1");
  });
}
