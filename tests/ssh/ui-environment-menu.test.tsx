import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { SshHost, SshPrompt, SshStatus } from "../../shared/ssh-api";
import type { Conversation } from "../../shared/types";
import type { MenuEntry } from "../../src/ui/Menu";
import {
  bannerFor,
  childPath,
  environmentMenu,
  hostInputError,
  parentPath,
  parsePort,
  promptView,
  sameEnvironment,
  statusDetail,
} from "../../src/ssh/model";
import { previewRemoteSessions, sshUiReady } from "../../src/ssh/availability";
import {
  applySshEvent,
  resetSshStore,
  sshState,
} from "../../src/ssh/useSshHosts";
import {
  codeEnvironmentState,
  currentCodeEnvironment,
  setCodeEnvironment,
} from "../../src/ssh/codeEnvironment";
import {
  recentFolders,
  recentWorkFolders,
} from "../../src/composer/recentFolders";
import { defaultFilter, recentRows } from "../../src/sidebar/listFilter";
import { historyRows } from "../../src/collections/history/history-rows";
import { EnvironmentChipContent } from "../../src/ssh/EnvironmentChip";
import { SshPromptDialog } from "../../src/ssh/SshPromptDialog";
import {
  AddSshHostDialog,
  hostInputFrom,
  splitDestination,
} from "../../src/ssh/AddSshHostDialog";
import { ReconnectBanner } from "../../src/ssh/ReconnectBanner";

const devbox: SshHost = {
  id: "h1",
  label: "devbox",
  destination: "me@devbox",
  createdAt: 1,
};
const gpu: SshHost = {
  id: "h2",
  label: "gpu",
  destination: "ubuntu@10.0.0.2",
  port: 2222,
  createdAt: 2,
};
const noop = () => {};
const labels = (entries: MenuEntry[]) =>
  entries.map((entry) =>
    "label" in entry ? entry.label : "separator" in entry ? "—" : "#",
  );
const item = (entries: MenuEntry[], label: string) => {
  const found = entries.find((e) => "label" in e && e.label === label);
  assert.ok(found && "label" in found, `missing ${label}`);
  return found;
};

test("the environment menu lists Local alone until SSH works", () => {
  const entries = environmentMenu({
    hosts: [devbox],
    statuses: {},
    selected: { kind: "local" },
    ssh: false,
    onLocal: noop,
    onHost: noop,
    onAdd: noop,
  });
  assert.deepEqual(labels(entries), ["Local"]);
  assert.equal(item(entries, "Local").checked, true);
});

test("the SSH submenu lists hosts with their state and edit affordances, then Add", () => {
  const chosen: SshHost[] = [];
  const edited: SshHost[] = [];
  let added = 0;
  const entries = environmentMenu({
    hosts: [devbox, gpu],
    statuses: {
      h2: { state: "error", code: "host-unreachable", message: "x" },
    },
    selected: { kind: "ssh", hostId: "h1" },
    ssh: true,
    onLocal: noop,
    onHost: (host) => chosen.push(host),
    onEdit: (host) => edited.push(host),
    onAdd: () => added++,
  });
  // Cloud and Remote Control have no Claudex counterpart.
  assert.deepEqual(labels(entries), ["Local", "SSH"]);
  assert.equal(item(entries, "Local").checked, false);
  const ssh = item(entries, "SSH");
  assert.equal(ssh.value, "devbox");
  const sub = ssh.submenu!;
  assert.deepEqual(labels(sub), [
    "devbox",
    "gpu · Offline",
    "—",
    "Add SSH connection…",
  ]);
  assert.equal(item(sub, "devbox").checked, true);
  assert.equal(item(sub, "gpu · Offline").title, "ubuntu@10.0.0.2:2222");
  assert.equal(item(sub, "gpu · Offline").settings?.label, "Edit connection…");
  item(sub, "gpu · Offline").settings!.onSelect();
  assert.deepEqual(edited, [gpu]);
  item(sub, "gpu · Offline").onSelect!();
  item(sub, "Add SSH connection…").onSelect!();
  assert.deepEqual(chosen, [gpu]);
  assert.equal(added, 1);
});

test("with no hosts the SSH submenu shows its empty state and Add SSH connection", () => {
  const entries = environmentMenu({
    hosts: [],
    statuses: {},
    selected: { kind: "local" },
    ssh: true,
    onLocal: noop,
    onHost: noop,
    onAdd: noop,
  });
  assert.deepEqual(labels(item(entries, "SSH").submenu!), [
    "No SSH hosts yet",
    "Add SSH connection…",
  ]);
});

test("statuses read as short details and banners", () => {
  assert.equal(statusDetail({ state: "ready" }), "");
  assert.equal(statusDetail({ state: "probing" }), "Connecting…");
  assert.equal(statusDetail({ state: "needs-auth" }), "Sign in");
  assert.equal(bannerFor({ state: "ready" }, "devbox"), undefined);
  // A changed host key offers removing the old key, not a plain retry.
  assert.deepEqual(
    bannerFor(
      { state: "error", code: "host-key-changed", message: "" },
      "devbox",
    )?.action,
    { label: "Remove the old key and try again", kind: "forget-key" },
  );
  assert.equal(
    bannerFor({ state: "reconnecting", attempt: 2 }, "devbox")?.text,
    "Reconnecting to devbox…",
  );
  const install = bannerFor(
    { state: "installing", phase: "upload", progress: 0.424 },
    "devbox",
  );
  assert.equal(install?.text, "Setting up Claudex on devbox… 42%");
  assert.equal(install?.progress, 0.424);
  assert.equal(
    bannerFor({ state: "needs-auth" }, "devbox")?.action?.label,
    "Sign in to devbox",
  );
  const failed = bannerFor(
    { state: "error", code: "timeout", message: "" },
    "devbox",
  );
  assert.equal(
    failed?.text,
    "Can’t reach devbox: The host took too long to answer.",
  );
  assert.equal(failed?.action?.label, "Try again");
  // Turned off by the administrator: nothing to retry.
  assert.equal(
    bannerFor(
      { state: "error", code: "policy-disabled", message: "" },
      "devbox",
    )?.action,
    undefined,
  );
  assert.equal(bannerFor(undefined, "devbox")?.action?.label, "Connect");
});

test("askpass dialogs: passwords are hidden and never remembered", () => {
  const password: SshPrompt = {
    id: "p",
    hostId: "h1",
    kind: "password",
    text: "me@devbox's password:",
  };
  assert.deepEqual(promptView(password, "devbox"), {
    title: "Sign in to devbox",
    input: "password",
    confirm: "Continue",
  });
  const html = renderToStaticMarkup(
    <SshPromptDialog prompt={password} label="devbox" onAnswer={noop} />,
  );
  assert.match(html, /type="password"/);
  assert.match(html, /me@devbox&#x27;s password:/);
  assert.doesNotMatch(html, /Remember/i);
  const hostkey: SshPrompt = {
    id: "k",
    hostId: "h1",
    kind: "hostkey",
    text: "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
    fingerprint: "SHA256:abc",
  };
  const view = promptView(hostkey, "devbox");
  assert.equal(view.title, "Verify host");
  assert.equal(view.input, undefined);
  assert.equal(view.confirm, "Connect");
  const keyHtml = renderToStaticMarkup(
    <SshPromptDialog prompt={hostkey} label="devbox" onAnswer={noop} />,
  );
  assert.match(keyHtml, /SHA256:abc/);
  assert.doesNotMatch(keyHtml, /<input/);
  assert.equal(
    promptView({ ...hostkey, kind: "passphrase" }, "x").title,
    "Unlock SSH key",
  );
});

test("host input is checked before it reaches the main process", () => {
  assert.equal(hostInputError({ destination: "" }), "Enter a host.");
  assert.match(hostInputError({ destination: "-oProxyCommand=x" })!, /“-”/);
  assert.match(hostInputError({ destination: "me@host name" })!, /spaces/);
  assert.match(hostInputError({ destination: "me@ho\nst" })!, /spaces/);
  assert.match(hostInputError({ destination: "h", port: 0 })!, /port/);
  assert.match(hostInputError({ destination: "h", port: Number.NaN })!, /port/);
  assert.match(
    hostInputError({ destination: "h", identityFile: "a\u0000b" })!,
    /identity file/,
  );
  assert.equal(
    hostInputError({ destination: "me@devbox", port: 22 }),
    undefined,
  );
  assert.equal(parsePort(""), undefined);
  assert.equal(parsePort("2222"), 2222);
  assert.ok(Number.isNaN(parsePort("22a")));
  assert.deepEqual(
    hostInputFrom({
      address: " devbox ",
      user: " me ",
      password: "",
      label: "",
      port: "",
      identityFile: "~/.ssh/id_ed25519",
      defaultFolder: " ",
      remoteRoot: "",
      sshPath: "",
    }),
    {
      destination: "me@devbox",
      label: "me@devbox",
      port: undefined,
      identityFile: "~/.ssh/id_ed25519",
      defaultFolder: undefined,
      remoteRoot: undefined,
      sshPath: undefined,
    },
  );
});

test("the form's address and username make the destination", () => {
  assert.deepEqual(splitDestination("me@devbox"), {
    user: "me",
    address: "devbox",
  });
  assert.deepEqual(splitDestination("staging"), {
    user: "",
    address: "staging",
  });
  const base = {
    label: "",
    port: "",
    identityFile: "",
    defaultFolder: "",
    remoteRoot: "",
    sshPath: "",
  };
  assert.equal(
    hostInputFrom({ ...base, address: "10.0.0.2", user: "", password: "" })
      .destination,
    "10.0.0.2",
  );
  const withPassword = hostInputFrom({
    ...base,
    address: "10.0.0.2",
    user: "root",
    password: "pw",
  });
  assert.equal(withPassword.destination, "root@10.0.0.2");
  assert.equal(withPassword.password, "pw");
});

test("the Add dialog asks for the host IP, username and password", () => {
  const html = renderToStaticMarkup(
    <AddSshHostDialog
      suggestions={["staging", "build-01"]}
      onTest={async () => ({ ok: true })}
      onSave={async () => {}}
      onClose={noop}
    />,
  );
  assert.match(html, /Add SSH connection/);
  assert.match(html, /A password is saved encrypted/);
  assert.match(html, /Host IP/);
  assert.match(html, /Username/);
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /user@hostname/);
  // Identity file and Default folder wait behind Advanced.
  assert.doesNotMatch(html, /Identity file/);
  assert.match(html, />staging</);
  assert.match(html, /Test connection/);
  assert.match(html, />Add</);
  const edit = renderToStaticMarkup(
    <AddSshHostDialog
      host={gpu}
      suggestions={[]}
      onTest={async () => ({ ok: true })}
      onSave={async () => {}}
      onClose={noop}
    />,
  );
  assert.match(edit, /Edit SSH connection/);
  assert.match(edit, /value="2222"/);
  assert.match(edit, />Save</);
});

test("remote paths move up and down like POSIX paths", () => {
  assert.equal(parentPath("/home/me/project"), "/home/me");
  assert.equal(parentPath("/home/"), "/");
  assert.equal(parentPath("/"), "/");
  assert.equal(childPath("/", "home"), "/home");
  assert.equal(childPath("/home/me/", "src"), "/home/me/src");
  assert.ok(sameEnvironment(undefined, { kind: "local" }));
  assert.ok(!sameEnvironment({ kind: "ssh", hostId: "a" }, { kind: "local" }));
});

const conversation = (
  id: string,
  cwd: string,
  updatedAt: number,
  extra: Partial<Conversation> = {},
): Conversation => ({
  id,
  threadId: id,
  title: id,
  mode: "code",
  cwd,
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: updatedAt,
  updatedAt,
  turns: [],
  ...extra,
});
const conversations = [
  conversation("local", "/Users/me/app", 3),
  conversation("remote", "/home/me/app", 2, {
    environment: { kind: "ssh", hostId: "h1" },
  }),
  conversation("other-host", "/srv/app", 1, {
    environment: { kind: "ssh", hostId: "h2" },
  }),
];

test("recent folders keep each environment's folders apart", () => {
  assert.deepEqual(recentFolders(conversations), ["/Users/me/app"]);
  assert.deepEqual(recentFolders(conversations, 8, { kind: "local" }), [
    "/Users/me/app",
  ]);
  assert.deepEqual(
    recentFolders(conversations, 8, { kind: "ssh", hostId: "h1" }),
    ["/home/me/app"],
  );
  // Cowork runs only on this computer.
  assert.deepEqual(recentWorkFolders(conversations), ["/Users/me/app"]);
});

test("the Recents and History Environment filter", () => {
  const ids = (rows: Conversation[]) => rows.map((c) => c.id);
  assert.deepEqual(ids(recentRows(conversations, "code", defaultFilter)), [
    "local",
    "remote",
    "other-host",
  ]);
  assert.deepEqual(
    ids(
      recentRows(conversations, "code", {
        ...defaultFilter,
        environment: "ssh",
      }),
    ),
    ["remote", "other-host"],
  );
  assert.deepEqual(
    ids(
      recentRows(conversations, "code", {
        ...defaultFilter,
        environment: "local",
      }),
    ),
    ["local"],
  );
  assert.deepEqual(
    ids(
      historyRows(conversations, "code", {
        ...defaultFilter,
        environment: "local",
      }),
    ),
    ["local"],
  );
  // A filter saved before the field existed lets everything through.
  const { environment: _dropped, ...old } = defaultFilter;
  assert.equal(
    recentRows(conversations, "code", old as typeof defaultFilter).length,
    3,
  );
});

test("the store follows status and askpass events", () => {
  resetSshStore({ loaded: true, sshAvailable: true, hosts: [devbox] });
  const status: SshStatus = { state: "reconnecting", attempt: 1 };
  applySshEvent({ type: "ssh-status", hostId: "h1", status });
  assert.deepEqual(sshState().statuses.h1, status);
  const prompt: SshPrompt = {
    id: "p1",
    hostId: "h1",
    kind: "other",
    text: "?",
  };
  applySshEvent({ type: "ssh-prompt", prompt });
  applySshEvent({ type: "ssh-prompt", prompt });
  assert.equal(sshState().prompts.length, 1);
  applySshEvent({ type: "ssh-prompt-closed", id: "p1" });
  assert.equal(sshState().prompts.length, 0);
  applySshEvent({ type: "toast", message: "x" } as never);
  assert.equal(sshState().hosts.length, 1);
});

test("SSH shows only once remote sessions can run, and the chip names the host", () => {
  // Remote sessions run (R9-S3/S4), so SSH shows whenever ssh is usable.
  assert.equal(sshUiReady(true), true);
  previewRemoteSessions();
  assert.equal(sshUiReady(false), false);
  assert.equal(sshUiReady(true), true);

  assert.match(renderToStaticMarkup(<EnvironmentChipContent />), /Local/);
  const offline = renderToStaticMarkup(
    <EnvironmentChipContent
      host={devbox}
      status={{ state: "error", code: "timeout", message: "" }}
    />,
  );
  assert.match(offline, /devbox/);
  assert.match(offline, /ssh-chip-error/);
  assert.match(
    renderToStaticMarkup(
      <EnvironmentChipContent host={devbox} status={{ state: "connecting" }} />,
    ),
    /role="status"/,
  );
});

test("the reconnect banner shows for a host that is not connected", () => {
  previewRemoteSessions();
  resetSshStore({
    loaded: true,
    sshAvailable: true,
    hosts: [devbox],
    statuses: { h1: { state: "reconnecting", attempt: 1 } },
  });
  const html = renderToStaticMarkup(
    <ReconnectBanner environment={{ kind: "ssh", hostId: "h1" }} />,
  );
  assert.match(html, /Reconnecting to devbox…/);
  assert.equal(
    renderToStaticMarkup(<ReconnectBanner environment={{ kind: "local" }} />),
    "",
  );
  resetSshStore({
    loaded: true,
    sshAvailable: true,
    hosts: [devbox],
    statuses: { h1: { state: "ready" } },
  });
  assert.equal(
    renderToStaticMarkup(
      <ReconnectBanner environment={{ kind: "ssh", hostId: "h1" }} />,
    ),
    "",
  );
});

test("the Code home's environment is what a new session is sent with", () => {
  assert.deepEqual(currentCodeEnvironment(), { kind: "local" });
  setCodeEnvironment({
    environment: { kind: "ssh", hostId: "h1" },
    folder: "/home/me/app",
  });
  assert.deepEqual(currentCodeEnvironment(), { kind: "ssh", hostId: "h1" });
  assert.equal(codeEnvironmentState().folder, "/home/me/app");
  setCodeEnvironment({ environment: { kind: "local" } });
});

test("the banner's sentences are catalog templates, so every language reads them", async () => {
  const { setLocale } = await import("../../src/i18n");
  const { sourceLocale } = await import("../../shared/locales");
  try {
    await setLocale("zh-CN");
    assert.equal(
      bannerFor({ state: "probing" }, "devbox")?.text,
      "正在连接到 devbox…",
    );
    assert.equal(
      bannerFor({ state: "needs-auth" }, "devbox")?.action?.label,
      "登录 devbox",
    );
    assert.equal(bannerFor(undefined, "devbox")?.text, "未连接到 devbox。");
  } finally {
    await setLocale(sourceLocale);
  }
});
