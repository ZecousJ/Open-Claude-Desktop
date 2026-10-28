/**
 * The web Code page on a cloud runner: the environment record and chip, the
 * permission modes the sandbox supports, the greyed Terminal and Browser
 * toggles, and the send input's repository (src/composer/CloudWorkspaceBar.tsx,
 * src/CodePermissionPicker.tsx, src/ConversationPanelButtons.tsx).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cloudInfoFrom,
  defaultCloudEnvironment,
  desktopHost,
  resolveHost,
  webHost,
  type HostInfo,
} from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { CloudWorkspaceBar } from "../../src/composer/CloudWorkspaceBar";
import { offeredPermissionChoices } from "../../src/composer/code/CodePermissionPicker";
import { ConversationPanelButtons } from "../../src/conversation/ConversationPanelButtons";
import {
  currentCodeRepository,
  setCodeRepository,
} from "../../src/composer/code-repository";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";

const cloud = {
  environments: [
    {
      id: "default",
      name: "Default",
      network: "trusted" as const,
      isDefault: true,
    },
  ],
  permissionModes: ["auto", "manual", "acceptEdits", "plan"] as const,
};
const cloudWeb: HostInfo = {
  kind: "web",
  capabilities: { ...webHost.capabilities, cloudCode: true },
  cloud: { ...cloud, permissionModes: [...cloud.permissionModes] },
};

const render = (host: HostInfo, node: ReactNode) =>
  renderToStaticMarkup(
    createElement(HostContext.Provider, { value: host }, node),
  );

test("the runner's environment record reaches the web host, well formed only", () => {
  const reported = {
    capabilities: { cloudCode: true },
    cloud: {
      environments: [
        { id: "default", name: "Default", network: "trusted", isDefault: true },
        { id: "x", name: "Bad", network: "everything" },
        { name: "No id", network: "none" },
      ],
      permissionModes: ["auto", "plan", "plan", "root", 3],
    },
  };
  const host = resolveHost("web", reported as never);
  assert.equal(host.capabilities.cloudCode, true);
  assert.deepEqual(host.cloud, {
    environments: [
      { id: "default", name: "Default", network: "trusted", isDefault: true },
    ],
    permissionModes: ["auto", "plan"],
  });
  // The desktop has no cloud record, whatever a snapshot says.
  assert.equal(resolveHost("desktop", reported as never).cloud, undefined);
  assert.equal(cloudInfoFrom("nope"), undefined);
  assert.equal(cloudInfoFrom({ environments: [] }), undefined);
  assert.equal(defaultCloudEnvironment(undefined), undefined);
  assert.equal(defaultCloudEnvironment(host.cloud)?.name, "Default");
});

test("the environment chip uses the runner's record until saved profiles load", () => {
  const html = render(cloudWeb, createElement(CloudWorkspaceBar));
  assert.match(html, /<span>Default<\/span>/);
  assert.match(html, /aria-label="Environment: Default"/);
  assert.match(html, /aria-label="Add repository" aria-haspopup="menu"/);
  assert.match(html, /<span>Repo<\/span>/);
  const renamed = render(
    {
      ...cloudWeb,
      cloud: {
        ...cloud,
        permissionModes: [],
        environments: [{ ...cloud.environments[0], name: "Sandbox" }],
      },
    },
    createElement(CloudWorkspaceBar),
  );
  assert.match(renamed, /<span>Sandbox<\/span>/);
  // A host that reports no environments must not claim to have Default.
  assert.match(
    render(webHost, createElement(CloudWorkspaceBar)),
    /<span>No environment<\/span>/,
  );
});

test("the web offers only the permission modes the sandbox supports", () => {
  const all = offeredPermissionChoices(openPolicy, "linux", true).map(
    (choice) => choice.id,
  );
  assert.ok(all.includes("bypass"));
  const web = offeredPermissionChoices(
    openPolicy,
    "linux",
    true,
    cloudWeb.cloud!.permissionModes,
  ).map((choice) => choice.id);
  assert.deepEqual(web, ["manual", "acceptEdits", "plan", "auto"]);
  // The desktop passes no list and keeps every mode.
  assert.deepEqual(
    offeredPermissionChoices(openPolicy, "darwin", true).map(
      (choice) => choice.id,
    ),
    all,
  );
});

const code = { id: "c", mode: "code" } as unknown as Conversation;
const buttons = (host: HostInfo) =>
  render(
    host,
    createElement(ConversationPanelButtons, {
      conversation: code,
      mode: "code",
      panel: null,
      onTogglePanel: () => {},
    }),
  );

test("a cloud Code session has no Terminal or Browser and keeps Changes", () => {
  // Changes, Files and Share.
  const html = buttons(cloudWeb);
  assert.doesNotMatch(html, /aria-label="Terminal"/);
  assert.doesNotMatch(html, /aria-label="Browser"/);
  const changes = html.match(/<button[^>]*aria-label="Changes"[^>]*>/)![0];
  assert.doesNotMatch(changes, /disabled/);
  // The desktop is unchanged: Terminal works.
  const desktop = buttons(desktopHost);
  assert.doesNotMatch(
    desktop.match(/<button[^>]*aria-label="Terminal"[^>]*>/)![0],
    /disabled/,
  );
});

test("the repository chosen on the Code home is what a new session sends", () => {
  assert.equal(currentCodeRepository(), undefined);
  setCodeRepository({ url: "https://github.com/acme/tool", ref: "main" });
  assert.deepEqual(currentCodeRepository(), {
    url: "https://github.com/acme/tool",
    ref: "main",
  });
  setCodeRepository(undefined);
  assert.equal(currentCodeRepository(), undefined);
});
