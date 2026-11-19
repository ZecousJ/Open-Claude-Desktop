import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  deriveOfficialUiHostCodeErrorModule,
  hostCodeErrorTarget,
} from "../scripts/official-ui-host-code-error.mjs";
import { brandedModule } from "../scripts/official-web-assets.mjs";

const root = process.env.F156_OFFICIAL_ORIGINAL_ASSETS ??
  ".restore/archive-extracted/claude-frontend-4.4212.0/src/cloud/assets/v1";
const requiredFiles = [hostCodeErrorTarget, "c76153c1e-B4keJzlO.js", "cbb2d9547-Cqy_m5EL.js"];
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

interface Message {
  id: string;
  defaultMessage: string;
}

function readErrorCopy(source: string, turnSource: string, busySource: string) {
  const start = source.indexOf("var kM = M7({");
  const end = source.indexOf("  Iq = M7({", start);
  const serverError = source.match(/^  api_server_error: (\{\n[\s\S]*?^  \}),/m);
  const overloaded = source.match(/^  api_overloaded: (\{\n[\s\S]*?^  \}),/m);
  const classifier = source.match(/^function Nf\(e\) \{[\s\S]*?^\}/m);
  const turnEntries = turnSource.slice(turnSource.indexOf("var Sr = {"));
  const turnServer = turnEntries.match(/^    server_error: (\{\n[\s\S]*?^    \}),/m);
  const turnOverloaded = turnEntries.match(/^    overloaded: (\{\n[\s\S]*?^    \}),/m);
  const turnBusy = busySource.match(/^function vX\(e, t, n, r, i, a, o\) \{[\s\S]*?^\}/m);
  assert.ok(start >= 0 && end > start && serverError && overloaded && classifier);
  assert.ok(turnServer && turnOverloaded && turnBusy);
  const descriptors = source.slice(start, end).replace(/,\s*$/, ";");
  return vm.runInNewContext(
    `${descriptors}
    ${classifier[0]}
    ${turnBusy[0]}
    const categories = { api_server_error: ${serverError[1]}, api_overloaded: ${overloaded[1]} };
    const Ct = WF, St = LC, kt = kM, Dt = e0, vr = {}, nne = WF, tne = LC;
    const intl = {
      formatMessage(message, values) {
        return message.defaultMessage.replace("{statusUrl}", values?.statusUrl ?? "");
      },
    };
    const serverTurn = ${turnServer[1]};
    const overloadedTurn = ${turnOverloaded[1]};
    ({
      server: categories[Nf("api_error_503")],
      overloaded: categories[Nf("api_error_529")],
      turnServer: intl.formatMessage(serverTurn.hint, serverTurn.hintValues),
      turnOverloaded: intl.formatMessage(overloadedTurn.hintWithoutComposer, overloadedTurn.hintValues),
      turnBusy: vX(intl, "error", 503, false, false).hintWithoutComposer,
    })`,
    { M7: (messages: unknown) => messages, rZ: "https://status.claude.com/" },
  ) as {
    server: { title: Message; body: Message; retryHelps: boolean; showRawMessage: boolean };
    overloaded: { title: Message; body: Message; bodyWithoutComposer: Message; retryHelps: boolean };
    turnServer: string;
    turnOverloaded: string;
    turnBusy: string;
  };
}

test("Claudex Code session and turn errors use the original neutral translations", {
  skip: requiredFiles.every((file) => fs.existsSync(path.join(root, file)))
    ? false
    : "Set F156_OFFICIAL_ORIGINAL_ASSETS to pinned resources.",
}, () => {
  const [original, turnSource, busySource] = requiredFiles.map(read);
  const vendor = readErrorCopy(original, turnSource, busySource);
  const branded = brandedModule(original);
  const derived = deriveOfficialUiHostCodeErrorModule(hostCodeErrorTarget, branded);
  const host = readErrorCopy(derived, turnSource, busySource);

  assert.equal(vendor.server.body.id, "iogOCq");
  assert.match(vendor.server.body.defaultMessage, /\{statusUrl\}/);
  assert.equal(host.server.body.id, "IO8lP8");
  assert.equal(
    host.server.body.defaultMessage,
    "The server returned an error while handling this message. It’s usually temporary.",
  );
  assert.equal(host.server.title.id, vendor.server.title.id);
  assert.equal(host.server.retryHelps, true);
  assert.equal(host.server.showRawMessage, true);
  assert.match(vendor.overloaded.bodyWithoutComposer.defaultMessage, /\{statusUrl\}/);
  assert.equal(host.overloaded.bodyWithoutComposer.id, "upWIU2");
  assert.equal(host.overloaded.bodyWithoutComposer.defaultMessage, "This is usually temporary.");
  assert.equal(host.overloaded.title.id, vendor.overloaded.title.id);
  assert.equal(host.overloaded.body.id, vendor.overloaded.body.id);
  assert.equal(host.overloaded.retryHelps, true);
  assert.match(vendor.turnServer, /https:\/\/status\.claude\.com/);
  assert.equal(host.turnServer, host.server.body.defaultMessage);
  assert.match(vendor.turnOverloaded, /https:\/\/status\.claude\.com/);
  assert.equal(host.turnOverloaded, host.overloaded.bodyWithoutComposer.defaultMessage);
  assert.match(vendor.turnBusy, /https:\/\/status\.claude\.com/);
  assert.equal(host.turnBusy, "Service is busy. This is usually temporary.");
  assert.equal(deriveOfficialUiHostCodeErrorModule("shared-other.js", original), original);
});
