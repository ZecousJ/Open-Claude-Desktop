import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useEffect, useRef, useState } from "react";
import type { AppController } from "../../src/app/AppContext";
import type { Attachment, Conversation } from "../../shared/types";
import { openPolicy } from "../../shared/client-policy";
import { sendDraft } from "../../src/app/composer-send";
import {
  draftPlace,
  readDraft,
  resetDraftMemory,
  usePlacedDraft,
  writeDraft,
} from "../../src/composer/draft-store";
import { insertSkillToken } from "../../src/composer/skill-tokens";
import { useSkillDraft } from "../../src/composer/useSkillDraft";
import { useComposerSending } from "../../src/composer/useComposerSending";
import { routineDom } from "../support/routine-dom";
import { queuedMessages, removeQueued } from "../../src/composer/queue";

const record = (id: string, running: boolean): Conversation => ({
  id,
  title: id,
  mode: "chat",
  providerId: "default",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [
    {
      id: `${id}-turn`,
      prompt: "Previous",
      attachments: [],
      items: [],
      status: running ? "inProgress" : "completed",
      createdAt: 1,
    },
  ],
});
type Pending = { resolve(value: any): void; reject(error: Error): void };
async function harness() {
  resetDraftMemory();
  const pending: Pending[] = [];
  const enqueue = () =>
    new Promise<any>((resolve, reject) => pending.push({ resolve, reject }));
  const dom = await routineDom({ send: enqueue, steerTurn: enqueue });
  let live!: AppController;
  const navigation: string[] = [],
    focuses: string[] = [],
    upserts: string[] = [];
  function App({
    account = "owner",
    id,
    session = "first",
    running = false,
  }: {
    account?: string;
    id?: string;
    session?: string;
    running?: boolean;
  }) {
    const draft = useSkillDraft();
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const busy = useComposerSending(
      `${account}\n${id ? `conversation:${id}` : `draft:${session}`}\nchat\nfalse`,
    );
    const currentController = useRef<AppController | undefined>(undefined);
    const controllerScope = useRef({}).current;
    const active = id ? record(id, running) : undefined;
    const place = draftPlace({ conversationId: id, mode: "chat" });
    usePlacedDraft({
      owner: account,
      place,
      ...draft,
      attachments,
      setAttachments,
    });
    useEffect(
      () => () => {
        currentController.current = undefined;
      },
      [],
    );
    live = {
      accountId: account,
      controllerScope,
      currentController,
      draftSession: session,
      ...draft,
      ...busy,
      attachments,
      setAttachments,
      active,
      activeId: id,
      mode: "chat",
      page: "chat",
      running,
      model: "m",
      providerId: "default",
      effort: "high",
      incognitoShown: false,
      snapshot: { settings: {} },
      policy: openPolicy,
      draftWebSearch: false,
      selectNext: { current: false },
      follow: { current: false },
      latest: { current: { conversations: active ? [active] : [] } },
      navigation: { replaceNext() {} },
      composer: {
        current: {
          focus() {
            focuses.push(id ?? session);
          },
          blur() {},
        },
      },
      setError() {},
      notify() {},
      report() {},
      upsert(value: Conversation) {
        upserts.push(value.id);
      },
      setActiveId(value: string) {
        navigation.push(value);
      },
      setPage(value: string) {
        navigation.push(value);
      },
    } as unknown as AppController;
    currentController.current = live;
    return createElement("div", {
      "data-busy": busy.sending,
      "data-text": draft.text,
    });
  }
  const render = (props: Parameters<typeof App>[0], key = "same-app") =>
    dom.render(createElement(App, { ...props, key }));
  const seed = async (text: string, name?: string) => {
    const draft = name
      ? insertSkillToken(text, [], name, 0)!
      : { text, skillTokens: [] };
    await act(async () => {
      live.setText(draft.text);
      live.setSkillTokens?.(draft.skillTokens);
    });
    return draft;
  };
  const start = async () => {
    let request!: Promise<void>;
    const app = live;
    await act(async () => {
      request = sendDraft(app);
      await Promise.resolve();
    });
    assert.ok(pending.length);
    return { request };
  };
  const clean = async () => {
    for (const id of ["A", "B"])
      for (const entry of queuedMessages(id)) removeQueued(id, entry.id);
    await dom.clean();
  };
  return {
    ...dom,
    clean,
    render,
    seed,
    start,
    pending,
    get live() {
      return live;
    },
    navigation,
    focuses,
    upserts,
  };
}

for (const running of [false, true])
  for (const outcome of ["reject", "resolve"] as const)
    test(`actual hooks: ${running ? "steer" : "manual send"} ${outcome} after leaving A cannot change or persist B's owned draft`, async () => {
      const env = await harness();
      try {
        writeDraft("owner", draftPlace({ mode: "chat", conversationId: "B" }), {
          text: "B-owned unsent draft",
          attachments: [],
        });
        await env.render({ id: "A", running });
        const original = await env.seed("A instructions", "review");
        const { request } = await env.start();
        assert.equal(env.live.sending, true);
        await env.render({ id: "B" });
        assert.equal(env.live.text, "B-owned unsent draft");
        assert.equal(env.live.sending, false);
        await act(async () => {
          if (outcome === "reject")
            env.pending[0]!.reject(Error("A transport failed"));
          else
            env.pending[0]!.resolve(
              running
                ? { messageId: "steered", conversation: record("A", true) }
                : record("A", false),
            );
          await request;
        });
        assert.equal(env.live.activeId, "B");
        assert.equal(env.live.text, "B-owned unsent draft");
        assert.deepEqual(env.live.skillTokens, []);
        assert.equal(env.live.sending, false);
        assert.equal(
          readDraft("owner", draftPlace({ mode: "chat", conversationId: "B" }))
            ?.text,
          "B-owned unsent draft",
        );
        assert.deepEqual(env.navigation, []);
        assert.deepEqual(env.focuses, []);
        if (outcome === "reject") {
          await env.render({ id: "A", running });
          assert.equal(env.live.text, original.text);
          assert.deepEqual(env.live.skillTokens, original.skillTokens);
          assert.equal(env.live.sending, false);
        }
      } finally {
        await env.clean();
      }
    });

test("a pending A mark survives B navigation and returning to A; old settlement cannot clear B's newer request", async () => {
  const env = await harness();
  try {
    await env.render({ id: "A", running: true });
    await env.seed("A", "review");
    const a = await env.start();
    await env.render({ id: "B" });
    await env.seed("B-owned", "other");
    assert.equal(env.live.sending, false);
    await env.render({ id: "A", running: true });
    assert.equal(env.live.sending, true);
    await env.render({ id: "B" });
    const b = await env.start();
    assert.equal(env.live.sending, true);
    await act(async () => {
      env.pending[0]!.reject(Error("A failed late"));
      await a.request;
    });
    assert.equal(env.live.activeId, "B");
    assert.equal(env.live.sending, true);
    assert.equal(env.live.text, "");
    assert.deepEqual(env.live.skillTokens, []);
    await act(async () => {
      env.pending[1]!.resolve(record("B", false));
      await b.request;
    });
    assert.equal(env.live.sending, false);
    assert.deepEqual(env.navigation, ["B", "chat"]);
  } finally {
    await env.clean();
  }
});

test("a newer home draft session keeps its text, ranges and saved draft when the old home send rejects", async () => {
  const env = await harness();
  try {
    await env.render({ session: "A" });
    await env.seed("Old home", "review");
    const a = await env.start();
    await env.render({ session: "B" });
    const owned = await env.seed("B-owned", "other");
    await act(async () => {
      env.pending[0]!.reject(Error("Old draft failed"));
      await a.request;
    });
    assert.equal(env.live.text, owned.text);
    assert.deepEqual(env.live.skillTokens, owned.skillTokens);
    assert.equal(env.live.sending, false);
    assert.equal(
      readDraft("owner", draftPlace({ mode: "chat" }))?.text,
      owned.text,
    );
    assert.deepEqual(env.navigation, []);
    assert.deepEqual(env.focuses, []);
  } finally {
    await env.clean();
  }
});

test("a later draft typed into A before leaving again is never replaced by A's older failed request", async () => {
  const env = await harness();
  try {
    await env.render({ id: "A", running: true });
    await env.seed("Old A", "review");
    const a = await env.start();
    const newer = await env.seed("New A-owned draft", "other");
    await env.render({ id: "B" });
    await env.seed("B-owned draft");
    await act(async () => {
      env.pending[0]!.reject(Error("Old A failed"));
      await a.request;
    });
    await env.render({ id: "A", running: true });
    assert.equal(env.live.text, newer.text);
    assert.deepEqual(env.live.skillTokens, newer.skillTokens);
    assert.equal(env.live.sending, false);
  } finally {
    await env.clean();
  }
});

test("real account-key unmount invalidates the old controller and its settlement cannot affect the next account", async () => {
  const env = await harness();
  try {
    await env.render(
      { id: "A", account: "first", running: true },
      "first-account",
    );
    await env.seed("Old account", "review");
    const old = env.live;
    const a = await env.start();
    await env.render({ id: "B", account: "second" }, "second-account");
    assert.equal(old.currentController?.current, undefined);
    const owned = await env.seed("Second-owned", "other");
    await act(async () => {
      env.pending[0]!.reject(Error("Old account failed"));
      await a.request;
    });
    assert.equal(env.live.text, owned.text);
    assert.deepEqual(env.live.skillTokens, owned.skillTokens);
    assert.equal(env.live.sending, false);
    assert.deepEqual(env.navigation, []);
    assert.deepEqual(env.focuses, []);
    assert.equal(
      readDraft("second", draftPlace({ mode: "chat", conversationId: "B" }))
        ?.text,
      owned.text,
    );
  } finally {
    await env.clean();
  }
});

test("an operation ticket cannot clear a newer request for the same place", async () => {
  const dom = await routineDom();
  let live!: ReturnType<typeof useComposerSending>;
  function App() {
    live = useComposerSending("same-place");
    return null;
  }
  try {
    await dom.render(createElement(App));
    let first!: ReturnType<typeof live.beginComposerSend>,
      second!: typeof first;
    await act(async () => {
      first = live.beginComposerSend();
    });
    await act(async () => {
      second = live.beginComposerSend();
    });
    await act(async () => first.finish());
    assert.equal(live.sending, true);
    assert.equal(second.owns(), true);
    await act(async () => second.finish());
    assert.equal(live.sending, false);
  } finally {
    await dom.clean();
  }
});
