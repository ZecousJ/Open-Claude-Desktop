import assert from "node:assert/strict";
import test from "node:test";
import {
  dictationFailure as serverFailure,
  dictationMessages as serverMessages,
  readRealtimeMessage as serverRead,
} from "../../server/transcription";
import {
  dictationFailure,
  dictationMessages,
  readRealtimeMessage,
} from "../../src-web/bridge/realtime-message";
import { FakeClock, flush, signedInBridge } from "./web-bridge-fakes.test.ts";
import { createOfficialWebDictation } from "../../src-web/official/dictation";

const samples = [
  "not json",
  "[]",
  JSON.stringify({ type: "partial", text: " hel" }),
  JSON.stringify({ type: "transcript.delta", delta: "lo" }),
  JSON.stringify({ type: "final", text: "hello" }),
  JSON.stringify({ type: "result", text: "x", is_final: true }),
  JSON.stringify({ type: "result", text: "x", is_final: false }),
  JSON.stringify({
    event: "sentence_end",
    result: { text: "y", sentence_end: true },
  }),
  JSON.stringify({ type: "interim", transcript: "maybe" }),
  JSON.stringify({ type: "done" }),
  JSON.stringify({ type: "session.finished" }),
  JSON.stringify({
    type: "error",
    code: "usage_limit",
    message: "Limit",
    status: 429,
  }),
  JSON.stringify({ error: { type: "audio_disabled", message: "off" } }),
  JSON.stringify({ type: "hello" }),
];

test("the browser reads realtime messages exactly as the provider service does", () => {
  for (const raw of samples)
    assert.deepEqual(readRealtimeMessage(raw), serverRead(raw), raw);
  assert.deepEqual(dictationMessages, serverMessages);
  for (const [code, status, message] of [
    ["AUDIO_DISABLED", undefined, ""],
    ["", 413, ""],
    ["X", undefined, "Quota\u0000 hit"],
    ["", undefined, ""],
  ] as const)
    assert.equal(
      dictationFailure(code, status, message),
      serverFailure(code, status, message),
    );
});

async function dictationSetup(available = true, maxSeconds: number | null = 2) {
  const clock = new FakeClock();
  const setup = await signedInBridge(
    (method) =>
      method === "voiceAvailability"
        ? {
            transcription: available,
            maxTranscriptionBytes: null,
            maxSeconds,
            streaming: true,
          }
        : null,
    { clock },
  );
  // The event stream's socket is not the dictation socket.
  setup.tab.sockets.at(-1)!.open();
  return { ...setup, clock };
}

test("dictation streams PCM to the realtime socket with a web ticket and selected input language", async () => {
  const { bridge, tab } = await dictationSetup();
  const starting = bridge.api.startDictation({ language: "zh-CN" });
  await flush();
  const socket = tab.sockets.at(-1)!;
  assert.equal(
    socket.url,
    "wss://claudex.example/v1/audio/realtime/transcriptions",
  );
  assert.equal(socket.protocols[0], "claudex.v1");
  assert.match(socket.protocols[1]!, /^ticket\./);
  assert.ok(
    tab.requests.some((r) => r.url.endsWith("/auth/voice-ticket")),
    "the dictation socket has its own ticket (bound to the web session)",
  );
  socket.open();
  const session = await starting;
  assert.deepEqual(
    { streaming: session.streaming, maxSeconds: session.maxSeconds },
    { streaming: true, maxSeconds: 2 },
  );
  const start = socket.frames()[0];
  assert.equal(start.type, "start");
  assert.equal(start.language, "zh-CN");
  assert.deepEqual(start.audio, {
    format: "pcm_s16le",
    sampleRate: 16000,
    channels: 1,
  });
  const progress = await bridge.api.dictationAudio(
    session.sessionId,
    new Uint8Array(3200),
  );
  assert.deepEqual(progress, { text: "", partial: "" });
  assert.equal((socket.sent[1] as Uint8Array).byteLength, 3200);
  socket.receive({ type: "partial", text: "hello wor" });
  socket.receive({ type: "final", text: "hello world" });
  socket.receive({ type: "partial", text: "again" });
  assert.deepEqual(
    await bridge.api.dictationAudio(session.sessionId, new Uint8Array(2)),
    { text: "hello world", partial: "again" },
  );
  const finishing = bridge.api.finishDictation(session.sessionId);
  // Dictation's code loads lazily, so the frame goes out a tick later.
  await flush();
  assert.deepEqual(socket.frames().at(-1), {
    type: "finish",
    requestId: start.requestId,
  });
  socket.receive({ type: "done" });
  assert.equal(await finishing, "hello world again");
  assert.equal(socket.closedWith?.code, 1000);
  await assert.rejects(
    bridge.api.dictationAudio(session.sessionId, new Uint8Array(2)),
    /Dictation has ended/,
  );
});

test("web dictation shares the official default, session headroom, and credential ceiling", async () => {
  for (const [offered, expected] of [
    [null, 600],
    [90, 75],
    [43_200, 43_185],
  ] as const) {
    const { bridge, tab } = await dictationSetup(true, offered);
    const starting = bridge.api.startDictation();
    await flush();
    tab.sockets.at(-1)!.open();
    const session = await starting;
    assert.equal(session.maxSeconds, expected);
    await bridge.api.cancelDictation(session.sessionId);
  }
});

test("dictation refuses what the desktop refuses", async () => {
  const { bridge, tab } = await dictationSetup();
  const starting = bridge.api.startDictation();
  await flush();
  tab.sockets.at(-1)!.open();
  const { sessionId } = await starting;
  await assert.rejects(
    bridge.api.dictationAudio(sessionId, new Uint8Array(3)),
    /Invalid audio/,
  );
  // Two seconds at 32 000 bytes a second.
  await bridge.api.dictationAudio(sessionId, new Uint8Array(64_000));
  await assert.rejects(
    bridge.api.dictationAudio(sessionId, new Uint8Array(2)),
    /too long/,
  );
});

test("service errors end the dictation with its sentence", async () => {
  const { bridge, tab } = await dictationSetup();
  const starting = bridge.api.startDictation();
  await flush();
  const socket = tab.sockets.at(-1)!;
  socket.open();
  const { sessionId } = await starting;
  socket.receive({ type: "error", code: "AUDIO_DISABLED", message: "off" });
  await assert.rejects(
    bridge.api.dictationAudio(sessionId, new Uint8Array(2)),
    /Dictation isn't available right now/,
  );
});

test("unavailable dictation and refused sockets fail plainly", async () => {
  const off = await dictationSetup(false);
  await assert.rejects(
    off.bridge.api.startDictation(),
    /Dictation isn't available right now/,
  );
  const { bridge, tab } = await dictationSetup();
  const starting = bridge.api.startDictation();
  await flush();
  tab.sockets.at(-1)!.drop(1006);
  await assert.rejects(starting, /Dictation was disconnected/);
});

test("an abandoned dictation closes after 10 s without audio", async () => {
  const { bridge, tab, clock } = await dictationSetup();
  const starting = bridge.api.startDictation();
  await flush();
  const socket = tab.sockets.at(-1)!;
  socket.open();
  const { sessionId } = await starting;
  await clock.advance(10_001);
  assert.equal(socket.closedWith?.code, 1000);
  await assert.rejects(
    bridge.api.dictationAudio(sessionId, new Uint8Array(2)),
    /Dictation has ended/,
  );
});

const officialAddress =
  "wss://claudex.example/api/ws/speech_to_text/voice_stream?encoding=linear16&sample_rate=16000&channels=1&language=zh-CN";

test("the original composer receives the last words once after a normal relay close", async () => {
  const { bridge, tab, clock } = await dictationSetup(true, 10);
  const dictation = createOfficialWebDictation({
    env: tab.env, auth: bridge.auth, readAvailability: bridge.api.voiceAvailability,
    isCurrent: () => true,
  });
  try {
    await dictation.refresh();
    assert.equal(dictation.host.getSnapshot(), true);
    assert.equal(dictation.host.recordingMillis(), 9_000);
    assert.ok(dictation.host.drainMillis > 3_000);
    const before = tab.sockets.length;
    const composer = dictation.host.open(officialAddress);
    const seen: unknown[] = [];
    composer.onmessage = ({ data }) => seen.push(JSON.parse(String(data)));
    await flush();
    assert.equal(tab.sockets.length, before + 1);
    const relay = tab.sockets.at(-1)!;
    relay.open();
    await flush();
    assert.equal(composer.readyState, 1);
    assert.equal(relay.frames()[0].language, "zh-CN");
    composer.send(new Uint8Array([1, 2, 3, 4]).subarray(2));
    assert.deepEqual(relay.sent[1], Uint8Array.of(3, 4));
    relay.receive({ type: "partial", text: "今天" });
    relay.receive({ type: "final", text: "今天" });
    composer.send('{"type":"CloseStream"}');
    assert.equal(relay.frames().at(-1).type, "finish");
    await clock.advance(3_000);
    relay.receive({ type: "final", text: "见面" });
    relay.drop(1000);
    await flush();
    assert.deepEqual(seen.slice(-2), [
      { type: "TranscriptText", data: "今天见面" },
      { type: "TranscriptEndpoint" },
    ]);
    assert.equal(seen.filter((event) => JSON.stringify(event).includes("TranscriptText")).length, 1);
    assert.equal(composer.readyState, 3);
  } finally {
    dictation.dispose();
    bridge.dispose();
  }
});

test("retiring the original frame during availability lookup starts no socket or ticket request", async () => {
  const { bridge, tab } = await dictationSetup();
  type Availability = Awaited<ReturnType<typeof bridge.api.voiceAvailability>>;
  let release: (availability: Availability) => void = () => {};
  const pending = new Promise<Availability>((resolve) => { release = resolve; });
  let checks = 0;
  const dictation = createOfficialWebDictation({
    env: tab.env, auth: bridge.auth,
    readAvailability: () => ++checks === 1 ? bridge.api.voiceAvailability() : pending,
    isCurrent: () => true,
  });
  try {
    await dictation.refresh();
    const count = tab.sockets.length;
    const recording = dictation.host.open(officialAddress);
    dictation.dispose();
    release({ transcription: true, maxSeconds: 30, maxTranscriptionBytes: null });
    await flush();
    assert.equal(recording.readyState, 3);
    assert.equal(tab.sockets.length, count);
    assert.equal(tab.requests.some((request) => request.url.endsWith("/auth/voice-ticket")), false);
  } finally {
    dictation.dispose();
    bridge.dispose();
  }
});
