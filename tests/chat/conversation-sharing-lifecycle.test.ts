import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import type { AppEvent, DesktopAPI } from "../../shared/types";
import type { HostedShare, SharingStatus } from "../../shared/sharing-api";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { useConversationShare } from "../../src/conversation/ConversationShareDialog";
import { conversationShareUrl } from "../../src/sharing/share-link";
import { routineDom } from "../support/routine-dom";

const allowed: SharingStatus = {
  conversations: true,
  artifacts: true,
  maxSnapshotBytes: 1000,
  maxArtifactBytes: 1000,
};
const blocked: SharingStatus = {
  ...allowed,
  conversations: false,
  blocked: true,
};
const hosted = (id: string, patch: Partial<HostedShare> = {}): HostedShare => ({
  id: `share-${id}`,
  sourceKey: id,
  kind: "conversation",
  title: id,
  url: `https://share.example.test/s/${id}`,
  createdAt: 1,
  snapshotAt: 1,
  status: "active",
  ...patch,
});
type Request = {
  method: string;
  args: unknown[];
  resolve(value: any): void;
  reject(error: Error): void;
};
async function harness() {
  const requests: Request[] = [];
  const listeners = new Set<(event: AppEvent) => void>();
  const copies: string[] = [];
  const enqueue = (method: string, ...args: unknown[]) =>
    new Promise<any>((resolve, reject) =>
      requests.push({ method, args, resolve, reject }),
    );
  const bridge = {
    conversationShare: (id: string) => enqueue("read", id),
    shareConversation: (id: string, access?: string) =>
      enqueue("create", id, access),
    setShareAccess: (id: string, access: string) =>
      enqueue("access", id, access),
    inviteToShare: (id: string, email: string) => enqueue("invite", id, email),
    removeShareInvite: (id: string, email: string) =>
      enqueue("uninvite", id, email),
    unshareConversation: (id: string) => enqueue("stop", id),
    copyText: async (url: string) => {
      copies.push(url);
    },
    onEvent: (callback: (event: AppEvent) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  } as unknown as DesktopAPI;
  const dom = await routineDom(bridge);
  let current!: ReturnType<typeof useConversationShare>;
  const controllers = new Map<string, object>();
  function Hook({ id, status }: { id: string; status: SharingStatus }) {
    current = useConversationShare({ id, title: id, mode: "chat" }, status);
    return createElement("div", {
      "data-share": current.state.share?.sourceKey,
      "data-busy": current.state.busy,
    });
  }
  const render = async (
    id: string,
    options: { owner?: string; key?: string; status?: SharingStatus } = {},
  ) => {
    const owner = options.owner ?? "A";
    if (!controllers.has(owner)) controllers.set(owner, {});
    await dom.render(
      createElement(
        AppContext.Provider,
        {
          value: {
            accountId: owner,
            controllerScope: controllers.get(owner),
          } as AppController,
        },
        createElement(Hook, {
          id,
          status: options.status ?? allowed,
          key: options.key,
        }),
      ),
    );
  };
  const settle = (request: Request, result: unknown) =>
    act(async () => {
      request.resolve(result);
    });
  const fail = (request: Request, reason: string) =>
    act(async () => {
      request.reject(new Error(reason));
    });
  return {
    ...dom,
    render,
    settle,
    fail,
    requests,
    copies,
    bridge,
    get current() {
      return current;
    },
    async event(id: string) {
      await act(async () => {
        for (const callback of listeners)
          callback({ type: "sharing", kind: "conversation", sourceKey: id });
      });
    },
  };
}

test("the actual hook masks A's share on B's first render and rejects A's late invite result", async () => {
  const env = await harness();
  try {
    await env.render("A");
    await env.settle(env.requests[0], hosted("A"));
    const old = env.current;
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = old.invite("synthetic@example.test");
    });
    assert.equal(env.requests[1].method, "invite");
    await env.render("B");
    assert.equal(
      env.current.state.share,
      undefined,
      "A data is absent before B's read settles",
    );
    await env.settle(env.requests[2], hosted("B"));
    await env.settle(env.requests[1], {
      share: hosted("A"),
      added: true,
      mailed: true,
    });
    assert.equal(await pending, false);
    assert.equal(
      (env.current.state.share as HostedShare | null | undefined)?.sourceKey,
      "B",
    );
    assert.equal(env.current.state.notice, undefined);
    assert.equal(await old.invite("stale@example.test"), false);
    assert.equal(
      env.requests.length,
      3,
      "a retained A callback cannot initiate another bridge request",
    );
  } finally {
    await env.clean();
  }
});

test("a keyed account unmount and a replacement bridge reject retained sharing actions before transport", async () => {
  const env = await harness();
  try {
    await env.render("same", { owner: "A", key: "A" });
    await env.settle(env.requests[0], hosted("same"));
    const old = env.current;
    await env.render("same", { owner: "B", key: "B" });
    await env.settle(env.requests[1], null);
    for (const action of [
      () => old.invite("stale@example.test"),
      () => old.share(true),
      () => old.setAccess("link"),
      () => old.stop(),
      () => old.copyNew(),
    ])
      assert.equal(await action(), false);
    assert.equal(env.requests.length, 2);
    const beforeBridgeChange = env.current;
    let forbidden = 0;
    env.window.desktop = {
      ...env.window.desktop,
      shareConversation: async () => {
        forbidden++;
        return hosted("wrong");
      },
    };
    assert.equal(await beforeBridgeChange.copyNew(), false);
    assert.equal(forbidden, 0);
    await env.render("same", { owner: "B", key: "B" });
    assert.equal(env.current.state.share, undefined);
  } finally {
    await env.clean();
  }
});

test("late copy creation never copies A's link or replaces B's state", async () => {
  const env = await harness();
  try {
    await env.render("A");
    await env.settle(env.requests[0], null);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = env.current.copyNew();
    });
    assert.deepEqual(env.requests[1].args, ["A", "invited"]);
    await env.render("B");
    await env.settle(env.requests[2], null);
    await env.settle(
      env.requests[1],
      hosted("A", {
        access: "invited",
        inviteUrl: "https://share.example.test/shared/A",
      }),
    );
    assert.equal(await pending, false);
    assert.deepEqual(env.copies, []);
    assert.equal(env.current.state.share, null);
  } finally {
    await env.clean();
  }
});

test("same-tick Copy link calls create one real invited snapshot then copy its actual invited URL", async () => {
  const env = await harness();
  try {
    await env.render("A");
    await env.settle(env.requests[0], null);
    let first!: Promise<boolean>, second!: Promise<boolean>;
    await act(async () => {
      first = env.current.copyNew();
      second = env.current.copyNew();
    });
    assert.equal(await second, false);
    assert.equal(env.requests.length, 2);
    await env.settle(
      env.requests[1],
      hosted("A", {
        access: "invited",
        inviteUrl: "https://share.example.test/shared/real-invitation",
      }),
    );
    assert.equal(await first, true);
    assert.deepEqual(env.copies, [
      "https://share.example.test/shared/real-invitation",
    ]);
    assert.equal(env.current.state.copied, true);
  } finally {
    await env.clean();
  }
});

test("read generations retain the newest share and a later mutation invalidates an older in-flight read", async () => {
  const env = await harness();
  try {
    await env.render("A");
    await env.event("A");
    await env.settle(env.requests[1], hosted("new"));
    await env.settle(env.requests[0], hosted("old"));
    assert.equal(env.current.state.share?.sourceKey, "new");
    let mutation!: Promise<boolean>;
    await act(async () => {
      mutation = env.current.setAccess("invited");
    });
    await env.event("A");
    await env.settle(env.requests[2], hosted("written", { access: "invited" }));
    assert.equal(await mutation, true);
    await env.settle(env.requests[3], hosted("stale-during-write"));
    assert.equal(env.current.state.share?.sourceKey, "written");
    assert.equal(env.current.state.busy, false);
    assert.equal(env.current.state.checking, false);
  } finally {
    await env.clean();
  }
});

test("a failed initial check cannot create a share until its actual retry succeeds", async () => {
  const env = await harness();
  try {
    await env.render("A");
    await env.fail(env.requests[0], "Read unavailable");
    assert.equal(env.current.state.checkFailed, true);
    assert.equal(env.current.state.checking, false);
    assert.equal(await env.current.copyNew(), false);
    assert.equal(env.requests.length, 1);
    let retry!: Promise<void>;
    await act(async () => {
      retry = env.current.reload();
    });
    await env.settle(env.requests[1], null);
    await retry;
    assert.equal(env.current.state.checkFailed, false);
    assert.equal(env.current.state.share, null);
  } finally {
    await env.clean();
  }
});

test("a newly blocked account stops retained write callbacks but preserves real fresh-copy and revocation operations", async () => {
  const env = await harness();
  try {
    await env.render("A");
    await env.settle(env.requests[0], hosted("A"));
    const before = env.current;
    await env.render("A", { status: blocked });
    for (const action of [
      () => before.invite("new@example.test"),
      () => before.share(false),
      () => before.setAccess("link"),
    ])
      assert.equal(await action(), false);
    assert.equal(env.requests.length, 1);
    let copy!: Promise<boolean>;
    await act(async () => {
      copy = env.current.copy(hosted("A").url);
    });
    await env.settle(
      env.requests[1],
      hosted("fresh", {
        access: "invited",
        inviteUrl: "https://share.example.test/shared/fresh",
      }),
    );
    assert.equal(await copy, true);
    assert.deepEqual(env.copies, ["https://share.example.test/shared/fresh"]);
    let remove!: Promise<boolean>;
    await act(async () => {
      remove = env.current.uninvite("old@example.test");
    });
    assert.equal(env.requests[2].method, "uninvite");
    await env.settle(env.requests[2], hosted("fresh"));
    assert.equal(await remove, true);
    let stop!: Promise<boolean>;
    await act(async () => {
      stop = env.current.stop();
    });
    assert.equal(env.requests[3].method, "stop");
    await env.settle(env.requests[3], undefined);
    assert.equal(await stop, true);
    assert.equal(env.current.state.share, null);
  } finally {
    await env.clean();
  }
});

test("revoked or invalid links are not copied and current service failures remain retryable", async () => {
  const env = await harness();
  try {
    await env.render("A");
    await env.settle(env.requests[0], hosted("A"));
    let copy!: Promise<boolean>;
    await act(async () => {
      copy = env.current.copy(hosted("A").url);
    });
    await env.settle(env.requests[1], null);
    assert.equal(await copy, false);
    assert.deepEqual(env.copies, []);
    assert.equal(env.current.state.share, null);
    assert.equal(env.current.state.busy, false);
  } finally {
    await env.clean();
  }
  for (const share of [
    hosted("x", { status: "disabled" }),
    hosted("x", { expiresAt: 1 }),
    hosted("x", { url: "javascript:alert(1)" }),
    hosted("x", { url: "https://user:pass@example.test/s/x" }),
  ])
    assert.equal(conversationShareUrl(share), undefined);
});
