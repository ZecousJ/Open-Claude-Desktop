import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { Conversation } from "../../shared/types";
import type { TaskFolderSnapshot } from "../../shared/folder-browser";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import {
  webMethodKind,
  notAvailableOnWeb,
} from "../../shared/web-bridge-methods";
import { HostContext } from "../../src/host/HostContext";
import { CoworkTaskFolderButton } from "../../src/cowork/CoworkTaskFolderButton";
import { useCoworkFolders } from "../../src/cowork/task-folders";
import { routineDom } from "../support/routine-dom";

const active: Conversation = {
  id: "folder-startup",
  title: "Cowork",
  mode: "cowork",
  providerId: "provider",
  model: "model",
  createdAt: 1,
  updatedAt: 1,
  pinned: false,
  archived: false,
  turns: [],
};
const remote = {
  ...active,
  environment: { kind: "space" as const, spaceId: "actual-space" },
};
const remoteHost = {
  ...webHost,
  capabilities: { ...webHost.capabilities, cloudCowork: true },
};
const wrap = (host: HostInfo, child: ReturnType<typeof h>) =>
  h(HostContext.Provider, { value: host }, child);
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("folder startup: the actual web contract permits execution-side list/access/grant without a native chooser", () => {
  assert.equal(webHost.capabilities.localFolders, false);
  assert.equal(webMethodKind("chooseFolder"), "absent");
  for (const method of [
    "coworkFolders",
    "listTaskFolderDirectory",
    "coworkFolderAccess",
    "grantCoworkFolder",
    "listCoworkFolder",
    "readCoworkFile",
  ])
    assert.equal(webMethodKind(method), "remote-runner", method);
});

test("folder startup: real host bootstrap shows a pending native action, recovers a read error and discards native state after host change", async () => {
  const initial = deferred<TaskFolderSnapshot>();
  let requests = 0,
    subscriptions = 0;
  const env = await routineDom({
    coworkFolders: () =>
      ++requests === 1
        ? initial.promise
        : Promise.resolve({ extra: [], browser: { kind: "native" } }),
    onEvent: () => {
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
    chooseFolder: async () => {
      throw Error("startup cannot choose a folder");
    },
  });
  try {
    await env.render(
      wrap(webHost, h(CoworkTaskFolderButton, { conversation: active })),
    );
    assert.equal(requests, 0);
    assert.equal(subscriptions, 0);
    assert.equal(env.document.querySelector(".cowork-task-folder"), null);
    await env.render(
      wrap(desktopHost, h(CoworkTaskFolderButton, { conversation: active })),
    );
    assert.equal(requests, 1);
    assert.equal(subscriptions, 1);
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Loading folders…"]:disabled',
      ),
    );
    await act(async () => initial.reject(Error("connection failed")));
    assert.ok(env.document.querySelector('[role="alert"]'));
    await env.click('button[aria-label="Retry folder access"]');
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Add folder"]:not(:disabled)',
      ),
    );
    await env.render(
      wrap(remoteHost, h(CoworkTaskFolderButton, { conversation: remote })),
    );
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Folder access is unavailable for this session."]:disabled',
      ),
      "native descriptor cannot choose a folder on a remote host",
    );
    await env.render(
      wrap(
        desktopHost,
        h(CoworkTaskFolderButton, {
          conversation: {
            ...active,
            environment: { kind: "ssh", hostId: "actual-host" },
          },
        }),
      ),
    );
    assert.equal(env.document.querySelector(".cowork-task-folder"), null);
    assert.equal(subscriptions, 0);
  } finally {
    await env.clean();
  }
});

test("folder startup: explicit remote read consumer loads runner context and rejected older replies cannot replace a new environment", async () => {
  const old = deferred<TaskFolderSnapshot>();
  let reads = 0;
  const env = await routineDom({
    coworkFolders: () =>
      ++reads === 1
        ? old.promise
        : Promise.resolve({ primary: "/runner/next", extra: [] }),
  });
  function Context({ conversation }: { conversation: Conversation }) {
    const folders = useCoworkFolders(conversation, true);
    return h("output", null, folders?.primary ?? "pending");
  }
  try {
    await env.render(wrap(remoteHost, h(Context, { conversation: remote })));
    assert.equal(reads, 1);
    await env.render(
      wrap(
        remoteHost,
        h(Context, {
          conversation: {
            ...remote,
            environment: { kind: "space", spaceId: "next-space" },
          },
        }),
      ),
    );
    await act(async () => old.resolve({ primary: "/runner/old", extra: [] }));
    assert.equal(
      env.document.querySelector("output")?.textContent,
      "/runner/next",
    );
  } finally {
    await env.clean();
  }
});

test("folder startup: unavailable runner explicitly disables the slot; real advertised remote support enables it for Chat", async () => {
  let supported = false;
  const env = await routineDom({
    coworkFolders: async () => {
      if (!supported) throw Error(notAvailableOnWeb);
      return {
        extra: [],
        browser: { kind: "execution", root: "/own", initialPath: "/own" },
      };
    },
    listTaskFolderDirectory: async () => ({ path: "/own", directories: [] }),
  });
  try {
    await env.render(
      wrap(remoteHost, h(CoworkTaskFolderButton, { conversation: remote })),
    );
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Folder access is unavailable for this session."]:disabled',
      ),
    );
    supported = true;
    await env.render(
      wrap(
        remoteHost,
        h(CoworkTaskFolderButton, {
          conversation: { ...remote, mode: "chat" },
        }),
      ),
    );
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Add folder"]:not(:disabled)',
      ),
    );
    assert.equal(
      env.document.querySelector('[role="dialog"]'),
      null,
      "bootstrap does not eagerly mount the lazy browser",
    );
  } finally {
    await env.clean();
  }
});

test("folder button: a Chat on this computer with no folder access has no button; an unlinked cloud task links first", async () => {
  const linked: string[] = [];
  const env = await routineDom({
    coworkFolders: async () => ({ extra: [] }),
    linkCoworkTaskToComputer: async (id: string) => {
      linked.push(id);
      return { ...remote, linkedToComputer: true } as Conversation;
    },
  });
  try {
    await env.render(
      wrap(
        desktopHost,
        h(CoworkTaskFolderButton, {
          conversation: { ...active, mode: "chat" },
        }),
      ),
    );
    await act(async () => {});
    assert.equal(
      env.document.querySelector(".cowork-task-folder"),
      null,
      "no folder capability, no reason: nothing is drawn",
    );
    await env.render(
      wrap(desktopHost, h(CoworkTaskFolderButton, { conversation: remote })),
    );
    await env.click(
      'button[aria-label="Link this task to this computer to add folders"]',
    );
    assert.equal(linked.join(), remote.id);
  } finally {
    await env.clean();
  }
});
