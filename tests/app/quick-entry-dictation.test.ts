import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuickDictationSession } from "../../src/quick-window/dictation-session";
import type { QuickEntryBridge } from "../../shared/quick-entry";
import {
  VoiceShortcut,
  voiceShortcutOptions,
} from "../../src/settings/VoiceShortcut";
import { preferenceDefaults } from "../../shared/settings-extras";
import { preferenceFields } from "../../shared/settings-extras-schema";

function recording() {
  const calls: string[] = [];
  const live: string[] = [];
  const errors: unknown[] = [];
  const done: string[] = [];
  let send: (pcm: Uint8Array) => void = () => {};
  const voice: NonNullable<QuickEntryBridge["voice"]> = {
    requestMicrophone: async () => true,
    startDictation: async () => ({
      sessionId: "quick",
      streaming: true,
      maxSeconds: 600,
    }),
    dictationAudio: async (_id, pcm) => {
      calls.push(`audio:${pcm[0]}`);
      return { text: "Hello", partial: "world" };
    },
    finishDictation: async () => {
      calls.push("finish");
      return "Hello world";
    },
    cancelDictation: async () => {
      calls.push("cancel");
    },
  };
  const session = new QuickDictationSession(
    voice,
    async (callback) => {
      send = callback;
      return {
        stream: {} as MediaStream,
        stop: (flush) => {
          calls.push(flush ? "flush" : "stop");
          if (flush) send(new Uint8Array([2]));
        },
      };
    },
    {
      live: (text) => live.push(text),
      ready: () => calls.push("ready"),
      done: (text) => done.push(text),
      error: (error) => errors.push(error),
    },
  );
  return {
    session,
    voice,
    calls,
    live,
    errors,
    done,
    send: (pcm: Uint8Array) => send(pcm),
  };
}

test("Quick Entry dictation streams partials and flushes queued audio before finishing once", async () => {
  const state = recording();
  await state.session.start();
  state.send(new Uint8Array([1]));
  await Promise.all([state.session.stop(), state.session.stop()]);
  assert.deepEqual(state.calls, [
    "ready",
    "audio:1",
    "flush",
    "audio:2",
    "finish",
  ]);
  assert.deepEqual(state.live, ["Hello world", "Hello world"]);
  assert.deepEqual(state.done, ["Hello world"]);
  assert.deepEqual(state.errors, []);
  state.session.cancel();
  assert.equal(state.calls.includes("cancel"), false);
});

test("stopping during microphone permission waits for startup and finalizes", async () => {
  const state = recording();
  let permit!: (allowed: boolean) => void;
  state.voice.requestMicrophone = () =>
    new Promise((resolve) => {
      permit = resolve;
    });
  const opening = state.session.start();
  const stopping = state.session.stop();
  permit(true);
  await Promise.all([opening, stopping]);
  assert.deepEqual(state.done, ["Hello world"]);
});

test("hiding Quick Entry while permission is pending prevents a recording", async () => {
  const state = recording();
  let permit!: (allowed: boolean) => void;
  state.voice.requestMicrophone = () =>
    new Promise((resolve) => {
      permit = resolve;
    });
  const opening = state.session.start();
  state.session.cancel();
  permit(true);
  await opening;
  assert.deepEqual(state.calls, []);
});

test("microphone failure cancels the service session and reports the error", async () => {
  const state = recording();
  const failure = Error("microphone failed");
  const session = new QuickDictationSession(
    state.voice,
    async () => {
      throw failure;
    },
    {
      live: () => {},
      ready: () => {},
      done: () => {},
      error: (error) => state.errors.push(error),
    },
  );
  await session.start();
  assert.deepEqual(state.calls, ["cancel"]);
  assert.deepEqual(state.errors, [failure]);
});

test("voice shortcut defaults off and only offers custom when the native capability supports it", () => {
  assert.equal(preferenceDefaults.quickEntryDictationShortcut, "off");
  for (const value of ["off", "capslock", "Command+Shift+Alt+Space"])
    assert.equal(
      preferenceFields.quickEntryDictationShortcut.safeParse(value).success,
      true,
    );
  assert.equal(
    preferenceFields.quickEntryDictationShortcut.safeParse("Q").success,
    false,
  );
  const render = (customSupported: boolean, value = "off") =>
    renderToStaticMarkup(
      createElement(VoiceShortcut, {
        value,
        platform: "darwin",
        customSupported,
        onChange: async () => {},
        onError: () => {},
      }),
    );
  assert.deepEqual(
    voiceShortcutOptions(true).map((option) => option.label),
    ["Caps Lock", "Custom…", "No shortcut"],
  );
  assert.deepEqual(
    voiceShortcutOptions(false).map((option) => option.label),
    ["Caps Lock", "No shortcut"],
  );
  assert.match(render(true, "Command+Shift+Alt+Space"), /Custom…/);
  assert.match(render(true, "capslock"), /Press once to start dictation/);
  assert.doesNotMatch(render(true), /Press once to start dictation/);
});

test("cancel stops the microphone and service once and discards late partial transcripts", async () => {
  const state = recording();
  await state.session.start();
  state.send(new Uint8Array([1]));
  state.session.cancel();
  state.session.cancel();
  await state.session.stop();
  assert.deepEqual(state.calls, ["ready", "stop", "cancel"]);
  assert.deepEqual(state.live, []);
  assert.deepEqual(state.done, []);
});

test("dictation shortcuts validate the primary modifier at save time", () => {
  const schema = preferenceFields.dictationShortcut;
  for (const value of ["", "CommandOrControl+D", "Control+Alt+D"])
    assert.equal(schema.safeParse(value).success, true);
  const result = schema.safeParse("Alt+D");
  assert.equal(result.success, false);
  if (!result.success)
    assert.equal(
      result.error.issues[0].message,
      'Dictation shortcut "Alt+D" needs a Command or Control modifier',
    );
});
