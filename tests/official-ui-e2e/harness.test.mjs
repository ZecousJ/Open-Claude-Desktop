import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import packageJson from "../../package.json" with { type: "json" };
import { Client } from "./harness.mjs";

test(
  "packaged macOS E2E launches require a fixture bundle ID",
  {
    skip: process.platform === "darwin" ? false : "macOS app bundle identities",
  },
  async (t) => {
    const logDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "claudex-e2e-identity-"),
    );
    const contents = path.join(logDir, "Claudex Fixture.app", "Contents");
    const executable = path.join(contents, "MacOS", "Claudex");
    const marker = `${executable}.launched`;
    const originalExecutable = process.env.CLAUDEX_E2E_EXECUTABLE;
    t.after(() => {
      if (originalExecutable === undefined)
        delete process.env.CLAUDEX_E2E_EXECUTABLE;
      else process.env.CLAUDEX_E2E_EXECUTABLE = originalExecutable;
      fs.rmSync(logDir, { recursive: true, force: true });
    });
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(
      executable,
      '#!/bin/sh\nprintf launched > "$0.launched"\n',
      {
        mode: 0o755,
      },
    );
    process.env.CLAUDEX_E2E_EXECUTABLE = executable;
    const setBundleId = (bundleId) =>
      fs.writeFileSync(
        path.join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`,
      );

    setBundleId(packageJson.build.appId);
    await assert.rejects(Client.launch({ logDir }), (error) => {
      assert.equal(
        fs.existsSync(marker),
        false,
        "production bundle was launched",
      );
      assert.match(String(error), /fixture bundle ID/);
      return true;
    });
    assert.equal(fs.existsSync(path.join(logDir, "client.log")), false);

    setBundleId(`${packageJson.build.appId}.e2e`);
    await assert.rejects(Client.launch({ logDir }), /client did not start/);
    assert.equal(fs.readFileSync(marker, "utf8"), "launched");
  },
);
