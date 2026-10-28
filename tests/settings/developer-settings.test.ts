import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  developerModeAllowed,
  developerToolsAllowed,
  enableDeveloperSettings,
  readDeveloperSettings,
  type DeveloperModeDialog,
} from "../../electron/store/developer-settings";
import {
  parseOperatorPolicy,
  resolveClientPolicy,
} from "../../server/operator-policy";

test("Developer Mode requires persisted opt-in and allows policy revocation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "developer-mode-"));
  const file = path.join(root, "developer_settings.json");
  try {
    assert.deepEqual(readDeveloperSettings(file), {});
    assert.equal(developerToolsAllowed(file, {}), false);
    fs.writeFileSync(file, '{"allowDevTools":true}');
    assert.equal(developerToolsAllowed(file, {}), true);
    assert.equal(
      developerToolsAllowed(file, { developerModeEnabled: false }),
      false,
    );
    assert.equal(developerModeAllowed({ pending: true }), false);
    fs.writeFileSync(file, '{"allowDevTools":"true"}');
    assert.equal(developerToolsAllowed(file, {}), false);
    fs.writeFileSync(file, "broken");
    assert.equal(developerToolsAllowed(file, {}), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the local operator policy carries the Developer Mode switch", () => {
  const file = parseOperatorPolicy({
    version: 1,
    defaults: { developerModeEnabled: false },
  });
  const policy = resolveClientPolicy(file, {
    accountId: "local",
    platform: "darwin",
    appVersion: "1.0.0",
  });
  assert.equal(policy.developerModeEnabled, false);
});

test("Developer Mode confirmation defaults to cancellation and preserves settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "developer-mode-"));
  const file = path.join(root, "developer_settings.json");
  let restarts = 0;
  const dialogs: DeveloperModeDialog[] = [];
  let response = 1;
  const options = {
    file,
    allowed: () => true,
    translate: (text: string) => `translated:${text}`,
    showMessageBox: async (dialog: DeveloperModeDialog) => {
      dialogs.push(dialog);
      return { response };
    },
    restart: () => {
      restarts++;
    },
  };
  try {
    await enableDeveloperSettings(options);
    assert.equal(fs.existsSync(file), false);
    assert.equal(restarts, 0);
    assert.equal(dialogs[0].defaultId, 1);
    assert.equal(dialogs[0].cancelId, 1);
    assert.deepEqual(dialogs[0].buttons, [
      "translated:Enable",
      "translated:Don't Enable",
    ]);
    fs.writeFileSync(file, '{"other":42}');
    response = 0;
    await enableDeveloperSettings(options);
    assert.deepEqual(readDeveloperSettings(file), {
      other: 42,
      allowDevTools: true,
    });
    assert.equal(restarts, 1);
    assert.deepEqual(fs.readdirSync(root), ["developer_settings.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Developer Mode does not restart on write failure or policy changes during confirmation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "developer-mode-"));
  const dialogs: DeveloperModeDialog[] = [];
  let restarts = 0;
  const file = path.join(root, "developer_settings.json");
  try {
    fs.mkdirSync(file);
    await enableDeveloperSettings({
      file,
      allowed: () => true,
      translate: (text) => text,
      showMessageBox: async (dialog) => {
        dialogs.push(dialog);
        return { response: 0 };
      },
      restart: () => {
        restarts++;
      },
    });
    assert.equal(dialogs[1].message, "Couldn't enable developer mode");
    assert.equal(restarts, 0);
    let allowed = true;
    await enableDeveloperSettings({
      file,
      allowed: () => allowed,
      translate: (text) => text,
      showMessageBox: async () => {
        allowed = false;
        return { response: 0 };
      },
      restart: () => {
        restarts++;
      },
    });
    assert.equal(restarts, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
