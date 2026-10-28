import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { routineDom } from "../support/routine-dom";
import { PlanApprovalCard } from "../../src/plan/PlanApprovalCard";
import type { Conversation, Settings } from "../../shared/types";

const conversation: Conversation = {
  id: "plan-scope",
  title: "Synthetic plan",
  mode: "code",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  codePermissionMode: "plan",
  turns: [
    {
      id: "t",
      prompt: "Plan",
      attachments: [],
      items: [{ id: "plan", type: "plan", text: "Use the existing adapter." }],
      status: "completed",
      createdAt: 1,
    },
  ],
};

test("accepting a scoped plan restores a writable mode and waits for permission persistence before sending", async () => {
  for (const edits of [false, true]) {
    let release!: () => void;
    const calls: string[] = [];
    const patches: Partial<Settings>[] = [];
    const env = await routineDom({
      send: async () => {
        calls.push("send");
        return conversation;
      },
    });
    try {
      await env.render(
        createElement(PlanApprovalCard, {
          conversation,
          mac: true,
          autoAcceptAvailable: true,
          updatePreference: async (patch) => {
            patches.push(patch);
            calls.push("permission");
            await new Promise<void>((resolve) => (release = resolve));
          },
          onSent: () => calls.push("sent"),
          onKeepPlanning: () => {},
          onError: (error) => {
            throw error;
          },
        }),
      );
      const label = [
        ...env.document.querySelectorAll(".approval-button-label"),
      ].find(
        (e) => e.textContent === (edits ? "Accept and allow edits" : "Accept"),
      )!;
      await act(async () => label.parentElement!.click());
      assert.deepEqual(calls, ["permission"]);
      assert.deepEqual(patches, [
        {
          codePlanMode: false,
          autoAcceptEdits: edits,
          codeSandbox: "workspace-write",
        },
      ]);
      await act(async () => release());
      assert.deepEqual(calls, ["permission", "send", "sent"]);
    } finally {
      await env.clean();
    }
  }
});

test("a failed plan permission change retains planning and never sends an implementation message", async () => {
  let sends = 0;
  const errors: unknown[] = [];
  const env = await routineDom({
    send: async () => {
      sends++;
      return conversation;
    },
  });
  try {
    await env.render(
      createElement(PlanApprovalCard, {
        conversation,
        mac: true,
        autoAcceptAvailable: true,
        updatePreference: async () => {
          throw Error("permission save failed");
        },
        onSent: () => {
          throw Error("must not send");
        },
        onKeepPlanning: () => {},
        onError: (error) => errors.push(error),
      }),
    );
    const label = [
      ...env.document.querySelectorAll(".approval-button-label"),
    ].find((e) => e.textContent === "Accept")!;
    await act(async () => label.parentElement!.click());
    assert.equal(sends, 0);
    assert.equal(errors.length, 1);
    assert.equal(conversation.codePermissionMode, "plan");
    assert.equal((label.parentElement as HTMLButtonElement).disabled, false);
  } finally {
    await env.clean();
  }
});

test("an account change while accepting a plan cancels the dependent model message", async () => {
  let current = true;
  let release!: () => void;
  let sends = 0;
  const errors: unknown[] = [];
  const env = await routineDom({
    send: async () => {
      sends++;
      return conversation;
    },
  });
  try {
    await env.render(
      createElement(PlanApprovalCard, {
        conversation,
        mac: true,
        autoAcceptAvailable: true,
        updatePreference: async () => {
          await new Promise<void>((resolve) => (release = resolve));
        },
        canSend: () => current,
        onSent: () => {
          throw Error("must not send");
        },
        onKeepPlanning: () => {},
        onError: (error) => errors.push(error),
      }),
    );
    const label = [
      ...env.document.querySelectorAll(".approval-button-label"),
    ].find((e) => e.textContent === "Accept")!;
    await act(async () => label.parentElement!.click());
    current = false;
    await act(async () => release());
    assert.equal(sends, 0);
    assert.deepEqual(errors, []);
  } finally {
    await env.clean();
  }
});
