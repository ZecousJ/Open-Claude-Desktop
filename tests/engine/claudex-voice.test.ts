import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Store } from "../../electron/store/store";
import type { AppContext } from "../../electron/app/app-context";
import {
  DictationSessions,
  voiceAvailability,
} from "../../electron/voice/dictation";
import { ProviderServiceClient } from "../../electron/engine/provider-service-client";
import { registerSpeechHandlers } from "../../electron/ipc/speech";
import { maxBufferedSeconds } from "../../server/transcription";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import type { ClaudexVoice } from "../../shared/claudex-contract";
import type { Provider } from "../../shared/types";
import { voiceMethods } from "../../shared/voice-api";
import { PcmEncoder, chunkSamples, pcm16 } from "../../src/voice/pcm";
import { withSpoken } from "../../src/voice/useDictationDraft";
import { RealtimeTranscriptionMock } from "../support/realtime-transcription-mock";

let script = "";
const roots: string[] = [];
test.before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-voice-"));
  roots.push(root);
  script = path.join(root, "provider-service.cjs");
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: script,
    logLevel: "silent",
  });
});
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const voiceSection = (
  patch: Partial<ClaudexVoice["transcription"]> = {},
): ClaudexVoice => ({
  transcription: {
    enabled: true,
    model: null,
    maxBytes: null,
    maxSeconds: 90,
    ...patch,
  },
  available: { transcription: patch.enabled ?? true },
});

function context(
  provider: Provider,
  options: {
    policy?: ClientPolicy;
    sessionKey?: string;
    voice?: ClaudexVoice;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-voice-ctx-"));
  roots.push(root);
  const store = new Store(root);
  store.settings.providers = [provider];
  store.settings.activeProviderId = provider.id;
  const remote =
    provider.backend === "sub2api"
      ? {
          sessionKey: (id: string) =>
            id === provider.id ? (options.sessionKey ?? "") : "",
          ...(options.voice
            ? { bootstrap: { current: () => ({ voice: options.voice }) } }
            : {}),
        }
      : undefined;
  return {
    store,
    remote,
    providerServiceScript: script,
    dataRoot: root,
    credentials: { vaultKey: undefined },
    policy: () => options.policy ?? openPolicy,
  } as unknown as AppContext;
}

const remoteProvider = (
  baseUrl: string,
  transcriptionModel?: string,
): Provider => ({
  id: "claudex",
  name: "Claudex",
  baseUrl,
  protocol: "responses",
  model: "chat",
  models: ["chat"],
  backend: "sub2api",
  ...(transcriptionModel ? { transcriptionModel } : {}),
});

test("dictation limits reach the main-process provider child and preserve the advertised ceiling", async (t) => {
  const requested: number[] = [];
  const languages: (string | undefined)[] = [];
  t.mock.method(
    ProviderServiceClient.prototype,
    "startDictation",
    async (maxSeconds: number, options?: { language?: string }) => {
      requested.push(maxSeconds);
      languages.push(options?.language);
      return { streaming: true, maxSeconds };
    },
  );
  t.mock.method(
    ProviderServiceClient.prototype,
    "cancelDictation",
    async () => {},
  );
  t.mock.method(ProviderServiceClient.prototype, "close", async () => {});
  for (const maxSeconds of [null, 90, 43_200]) {
    const ctx = context(remoteProvider("http://127.0.0.1:1/v1"), {
      voice: voiceSection({ maxSeconds }),
    });
    const sessions = new DictationSessions(ctx);
    const session = await sessions.start({ language: "en-IN" });
    assert.equal(session.maxSeconds, requested.at(-1));
    await sessions.cancel(session.sessionId);
  }
  assert.deepEqual(requested, [600, 75, 43_185]);
  assert.deepEqual(languages, ["en-IN", "en-IN", "en-IN"]);
});

test("dictation shows only while the policy allows voice and the service offers it", () => {
  const local: Provider = {
    ...remoteProvider("http://127.0.0.1:1/v1"),
    id: "local",
    backend: undefined,
  };
  assert.equal(voiceAvailability(context(local)).transcription, false);
  assert.deepEqual(
    voiceAvailability(context({ ...local, transcriptionModel: "whisper-1" })),
    {
      transcription: true,
      maxTranscriptionBytes: 5 * 1024 * 1024,
      maxSeconds: maxBufferedSeconds,
      streaming: false,
    },
  );
  assert.equal(
    voiceAvailability(
      context(
        { ...local, transcriptionModel: "whisper-1" },
        { policy: { ...openPolicy, voice: false } },
      ),
    ).transcription,
    false,
  );
  // Remote accounts: the bootstrap "voice" section decides, with its limit.
  const remote = remoteProvider("http://127.0.0.1:1/v1");
  assert.equal(voiceAvailability(context(remote)).transcription, false);
  assert.deepEqual(
    voiceAvailability(context(remote, { voice: voiceSection() })),
    {
      transcription: true,
      maxTranscriptionBytes: null,
      maxSeconds: 90,
      streaming: true,
    },
  );
  assert.equal(
    voiceAvailability(
      context(remote, { voice: voiceSection({ enabled: false }) }),
    ).transcription,
    false,
  );
  // Before the bootstrap is exposed: the transcription model the plan gave the provider.
  assert.equal(
    voiceAvailability(
      context(remoteProvider("http://127.0.0.1:1/v1", "realtime")),
    ).transcription,
    true,
  );
});

test("the voice bridge has dictation calls and no read aloud", () => {
  assert.deepEqual([...voiceMethods].sort(), [
    "cancelDictation",
    "dictationAudio",
    "finishDictation",
    "openMicrophoneSettings",
    "requestMicrophone",
    "startDictation",
    "voiceAvailability",
  ]);
  const handlers = new Map<string, unknown>();
  registerSpeechHandlers(
    (name, fn) => handlers.set(name, fn),
    context(remoteProvider("http://127.0.0.1:1/v1")),
  );
  assert.deepEqual([...handlers.keys()].sort(), [
    "cancelDictation",
    "dictationAudio",
    "finishDictation",
    "startDictation",
    "voiceAvailability",
  ]);
});

test("a remote dictation streams through the provider child with the device key, which the main process never logs", async () => {
  const mock = await new RealtimeTranscriptionMock({
    key: "synthetic-device-key",
  }).start();
  const logged: string[] = [];
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  for (const name of ["log", "error", "warn"] as const)
    console[name] = (...args: unknown[]) =>
      void logged.push(args.map(String).join(" "));
  const ctx = context(remoteProvider(mock.url), {
    sessionKey: "synthetic-device-key",
    voice: voiceSection(),
  });
  const sessions = new DictationSessions(ctx);
  try {
    const started = await sessions.start();
    assert.equal(started.streaming, true);
    assert.equal(started.maxSeconds, 75);
    const replies = [];
    for (let i = 0; i < 3; i++)
      replies.push(
        await sessions.audio(started.sessionId, new Uint8Array(3200)),
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const progress = await sessions.audio(started.sessionId, new Uint8Array(0));
    assert.equal(progress.partial, "heard 3");
    assert.equal(
      await sessions.finish(started.sessionId),
      "Hello from the microphone.",
    );
    assert.equal(mock.sessions[0].authorization, "Bearer synthetic-device-key");
    assert.equal(mock.sessions[0].audioBytes, 9600);
    // A finished session takes no more audio.
    assert.throws(
      () => sessions.audio(started.sessionId, new Uint8Array(2)),
      /ended/,
    );
    // The window cannot send odd or oversized chunks.
    const next = await sessions.start();
    assert.throws(
      () => sessions.audio(next.sessionId, new Uint8Array(3)),
      /Invalid audio/,
    );
    assert.throws(
      () => sessions.audio(next.sessionId, new Uint8Array(70_000)),
      /Invalid audio/,
    );
    assert.throws(
      () => sessions.audio(next.sessionId, "AAAA"),
      /Invalid audio/,
    );
    await sessions.cancel(next.sessionId);
    assert.throws(
      () => sessions.audio(next.sessionId, new Uint8Array(2)),
      /ended/,
    );
  } finally {
    Object.assign(console, originals);
    await mock.stop();
  }
  assert.equal(logged.join("\n").includes("synthetic-device-key"), false);
  // The usage ledger keeps the request, not the key or the words.
  const usage = path.join(ctx.store.root, "usage");
  const persisted = fs
    .readdirSync(usage)
    .map((file) => fs.readFileSync(path.join(usage, file), "utf8"))
    .join("\n");
  assert.match(persisted, /"statusCode":200/);
  assert.doesNotMatch(persisted, /synthetic-device-key|microphone/);
});

test("the recording stops at the service's limit and a refused dictation reaches the usage banner", async () => {
  const mock = await new RealtimeTranscriptionMock({ key: "k" }).start();
  try {
    const ctx = context(remoteProvider(mock.url), {
      sessionKey: "k",
      voice: voiceSection({ maxSeconds: 1 }),
    });
    const sessions = new DictationSessions(ctx);
    const started = await sessions.start();
    assert.equal(started.maxSeconds, 1);
    await sessions.audio(started.sessionId, new Uint8Array(32_000));
    assert.throws(
      () => sessions.audio(started.sessionId, new Uint8Array(2)),
      /too long/,
    );
    await sessions.cancel(started.sessionId);
  } finally {
    await mock.stop();
  }
  const limited = await new RealtimeTranscriptionMock({
    key: "k",
    refuse: {
      status: 429,
      body: {
        code: "USAGE_LIMIT_EXCEEDED",
        message: "weekly usage limit exceeded",
      },
    },
  }).start();
  const refusals: GatewayRefusal[] = [];
  const client = new ProviderServiceClient(
    script,
    roots[0],
    remoteProvider(limited.url),
    "k",
    undefined,
    roots[0],
    undefined,
    undefined,
    (refusal) => refusals.push(refusal),
  );
  try {
    await assert.rejects(client.startDictation(60), /weekly usage limit/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(refusals[0]?.code, "USAGE_LIMIT_EXCEEDED");
    assert.equal(refusals[0]?.exceeded, true);
  } finally {
    await client.close();
    await limited.stop();
  }
});

test("a local model service gets the whole recording as a WAV upload", async () => {
  const mock = await new RealtimeTranscriptionMock({
    key: "unused",
    transcript: "Local words",
  }).start();
  try {
    const provider: Provider = {
      ...remoteProvider(mock.url, "fixture-transcribe"),
      id: "local",
      backend: undefined,
    };
    const client = new ProviderServiceClient(
      script,
      roots[0],
      provider,
      "server-key",
    );
    try {
      assert.deepEqual(await client.startDictation(600), {
        streaming: false,
        maxSeconds: maxBufferedSeconds,
      });
      assert.deepEqual(await client.dictationAudio(new Uint8Array(6400)), {
        text: "",
        partial: "",
      });
      assert.equal(await client.finishDictation(), "Local words");
      assert.equal(mock.uploads[0].authorization, "Bearer server-key");
    } finally {
      await client.close();
    }
  } finally {
    await mock.stop();
  }
});

test("microphone samples become 16 kHz 16-bit chunks of 100 ms", () => {
  const chunks: Uint8Array[] = [];
  const encoder = new PcmEncoder(48_000, (pcm) => chunks.push(pcm));
  // One second at 48 kHz in render quanta of 128 samples.
  const sine = Float32Array.from(
    { length: 48_000 },
    (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5,
  );
  for (let i = 0; i < sine.length; i += 128)
    encoder.push(sine.subarray(i, i + 128));
  encoder.flush();
  const samples = chunks.reduce(
    (total, chunk) => total + chunk.byteLength / 2,
    0,
  );
  assert.equal(samples, 16_000);
  assert.equal(chunks[0].byteLength, chunkSamples * 2);
  const view = new DataView(chunks[0].buffer);
  // Output sample n is input sample 3n.
  for (const n of [1, 17, 400])
    assert.ok(
      Math.abs(view.getInt16(n * 2, true) / 0x7fff - sine[3 * n]) < 0.001,
    );
  assert.deepEqual(
    [...new Int16Array(pcm16([2, -2, 0]).buffer)],
    [0x7fff, -0x8000, 0],
  );
  assert.throws(() => new PcmEncoder(100, () => {}), /sample rate/);
});

test("the composer puts spoken text after what was typed", () => {
  assert.equal(withSpoken("", "Hello"), "Hello");
  assert.equal(withSpoken("Note:", "hello"), "Note: hello");
  assert.equal(withSpoken("Line\n", "hello"), "Line\nhello");
  assert.equal(withSpoken("Typed", ""), "Typed");
});
