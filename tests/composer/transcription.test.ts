import test from "node:test";
import assert from "node:assert/strict";
import {
  BufferedDictation,
  RealtimeDictation,
  dictationMessages,
  maxBufferedSeconds,
  maxDictationBytes,
  pcmBytesPerSecond,
  readRealtimeMessage,
  transcribeRecordedAudio,
  wavFromPcm,
} from "../../server/transcription";
import {
  encodeFrame,
  FrameReader,
  Opcode,
} from "../../server/transcription-socket";
import { joinSpoken } from "../../shared/voice-api";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import type { Provider } from "../../shared/types";
import { RealtimeTranscriptionMock } from "../support/realtime-transcription-mock";

const remote = (baseUrl: string): Provider => ({
  id: "claudex",
  name: "Claudex",
  baseUrl,
  protocol: "responses",
  model: "chat",
  models: ["chat"],
  backend: "sub2api",
});

test("realtime messages are read by their type and flags; errors keep their code", () => {
  assert.deepEqual(
    readRealtimeMessage(
      '{"type":"error","requestId":"r","code":"MODEL_NOT_FOUND","message":"Bidirectional streaming speech model is unavailable."}',
    ),
    {
      kind: "error",
      code: "MODEL_NOT_FOUND",
      message: "Bidirectional streaming speech model is unavailable.",
    },
  );
  assert.deepEqual(
    readRealtimeMessage('{"type":"transcript.partial","text":"hel"}'),
    {
      kind: "partial",
      text: "hel",
    },
  );
  assert.deepEqual(
    readRealtimeMessage('{"type":"result","text":"hello","is_final":false}'),
    {
      kind: "partial",
      text: "hello",
    },
  );
  assert.deepEqual(
    readRealtimeMessage('{"type":"result","text":"hello.","is_final":true}'),
    {
      kind: "final",
      text: "hello.",
    },
  );
  assert.deepEqual(
    readRealtimeMessage('{"type":"sentence","result":{"text":"Hi."}}'),
    {
      kind: "final",
      text: "Hi.",
    },
  );
  assert.deepEqual(
    readRealtimeMessage('{"type":"transcript.delta","delta":" there"}'),
    {
      kind: "delta",
      text: " there",
    },
  );
  assert.deepEqual(
    readRealtimeMessage(
      '{"type":"transcription.completed","transcript":"All."}',
    ),
    {
      kind: "final",
      text: "All.",
    },
  );
  for (const done of [
    '{"type":"finished"}',
    '{"type":"transcript.done"}',
    '{"type":"session.completed"}',
  ])
    assert.deepEqual(readRealtimeMessage(done), { kind: "done" });
  // Voice-activity events and unknown messages change nothing.
  for (const other of [
    '{"type":"speech_stopped"}',
    '{"type":"started"}',
    "not json",
    "[1]",
  ])
    assert.deepEqual(readRealtimeMessage(other), { kind: "ignore" });
});

test("spoken text joins with a space between words and none around CJK", () => {
  assert.equal(joinSpoken("Hello", "world"), "Hello world");
  assert.equal(joinSpoken("你好", "世界"), "你好世界");
  assert.equal(joinSpoken("", " x"), "x");
  assert.equal(joinSpoken("a ", ""), "a");
});

test("a WAV file wraps 16 kHz mono 16-bit PCM", () => {
  const wav = Buffer.from(wavFromPcm(new Uint8Array(3200)));
  assert.equal(wav.length, 44 + 3200);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 3200);
  assert.equal(
    maxBufferedSeconds,
    Math.floor((maxDictationBytes - 44) / 32000),
  );
});

test("frames round-trip masked and unmasked, in pieces, up to the size limit", () => {
  const reader = new FrameReader();
  const big = Buffer.alloc(70_000, 7);
  const bytes = Buffer.concat([
    encodeFrame(Opcode.Text, Buffer.from("hi"), true),
    encodeFrame(Opcode.Binary, big, false),
  ]);
  const frames = [
    ...reader.push(bytes.subarray(0, 5)),
    ...reader.push(bytes.subarray(5)),
  ];
  assert.equal(frames.length, 2);
  assert.equal(frames[0].payload.toString(), "hi");
  assert.equal(frames[1].payload.length, 70_000);
  assert.ok(frames[1].payload.every((value) => value === 7));
  const header = Buffer.from([0x82, 127, 0, 0, 0, 0, 0x10, 0, 0, 0]);
  assert.throws(() => new FrameReader().push(header), /too large/);
});

test("realtime dictation sends the start message, audio and finish, and keeps the transcript", async (context) => {
  const mock = await new RealtimeTranscriptionMock({
    key: "device-key",
  }).start();
  try {
    const session = await RealtimeDictation.open({
      provider: remote(mock.url),
      apiKey: "device-key",
      headers: { "X-Claudex-Version": "0.0.1" },
      maxSeconds: 5,
      language: "zh-CN",
    });
    const chunk = new Uint8Array(3200).map((_, i) => i & 0xff);
    session.append(chunk);
    session.append(chunk);
    // Socket delivery is independent of elapsed timer time under load.
    // Observe the actual client transcript without resending audio.
    await context.waitFor(() =>
      assert.equal(session.current().partial, "heard 2"),
    );
    assert.deepEqual(session.append(new Uint8Array(0)), {
      text: "",
      partial: "heard 2",
    });
    assert.equal(await session.finish(), "Hello from the microphone.");
    const seen = mock.sessions[0];
    assert.equal(seen.authorization, "Bearer device-key");
    assert.equal(seen.headers["x-claudex-version"], "0.0.1");
    assert.deepEqual(seen.start, {
      type: "start",
      language: "zh-CN",
      requestId: seen.start!.requestId,
      audio: { format: "pcm_s16le", sampleRate: 16000, channels: 1 },
      vad: {
        enabled: true,
        threshold: 0.2,
        prefixPaddingMs: 300,
        silenceDurationMs: 800,
      },
    });
    assert.match(seen.start!.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(seen.finish, {
      type: "finish",
      requestId: seen.start!.requestId,
    });
    assert.equal(seen.audioBytes, 6400);
  } finally {
    await mock.stop();
  }
});

test("realtime transcript readiness follows the delivered reply, not audio receipt", async (context) => {
  const mock = await new RealtimeTranscriptionMock({
    key: "k",
    // Deliberately hold replies until the test releases the transcript.
    onAudio() {},
  }).start();
  let session: RealtimeDictation | undefined;
  try {
    session = await RealtimeDictation.open({
      provider: remote(mock.url),
      apiKey: "k",
      headers: {},
      maxSeconds: 5,
    });
    session.append(new Uint8Array(3200));
    session.append(new Uint8Array(3200));
    await context.waitFor(() =>
      assert.equal(mock.sessions[0]?.audioBytes, 6400),
    );
    const seen = mock.sessions[0];
    assert.equal(seen.audioBytes, 6400);
    assert.deepEqual(
      session.current(),
      { text: "", partial: "" },
      "even acknowledged audio does not imply a transcript has been delivered",
    );
    seen.send({
      type: "transcript.partial",
      requestId: seen.start!.requestId,
      text: "heard 2",
    });
    await context.waitFor(() =>
      assert.equal(session!.current().partial, "heard 2"),
    );
    assert.deepEqual(session.append(new Uint8Array(0)), {
      text: "",
      partial: "heard 2",
    });
    assert.equal(await session.finish(), "Hello from the microphone.");
    assert.equal(
      seen.audioBytes,
      6400,
      "waiting for delivery must not resend audio",
    );
    assert.deepEqual(seen.finish, {
      type: "finish",
      requestId: seen.start!.requestId,
    });
  } finally {
    session?.cancel();
    await mock.stop();
  }
});

test("realtime segments add up; the open segment counts when the service ends", async (context) => {
  const mock = await new RealtimeTranscriptionMock({
    key: "k",
    onAudio(session) {
      if (session.chunks === 1)
        session.send({ type: "final", text: "First sentence." });
      if (session.chunks === 2)
        session.send({ type: "partial", text: "second" });
    },
    onFinish(session) {
      session.send({ type: "partial", text: "second one" });
      session.close(1000);
    },
  }).start();
  try {
    const session = await RealtimeDictation.open({
      provider: remote(mock.url),
      apiKey: "k",
      headers: {},
      maxSeconds: 5,
    });
    session.append(new Uint8Array(3200));
    session.append(new Uint8Array(3200));
    await context.waitFor(() =>
      assert.deepEqual(session.current(), {
        text: "First sentence.",
        partial: "second",
      }),
    );
    assert.deepEqual(session.append(new Uint8Array(2)), {
      text: "First sentence.",
      partial: "second",
    });
    assert.equal(await session.finish(), "First sentence. second one");
  } finally {
    await mock.stop();
  }
});

test("realtime refusals and errors become the sentences the composer shows", async (context) => {
  const refusals: GatewayRefusal[] = [];
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
  try {
    await assert.rejects(
      RealtimeDictation.open({
        provider: remote(limited.url),
        apiKey: "k",
        headers: {},
        maxSeconds: 5,
        onRefusal: (refusal) => refusals.push(refusal),
      }),
      /weekly usage limit/,
    );
    assert.equal(refusals[0].status, 429);
    assert.equal(refusals[0].exceeded, true);
  } finally {
    await limited.stop();
  }
  const disabled = await new RealtimeTranscriptionMock({
    key: "k",
    refuse: {
      status: 404,
      body: { code: "CLAUDEX_AUDIO_DISABLED", message: "off" },
    },
  }).start();
  try {
    await assert.rejects(
      RealtimeDictation.open({
        provider: remote(disabled.url),
        apiKey: "k",
        headers: {},
        maxSeconds: 5,
      }),
      { message: dictationMessages.unavailable },
    );
  } finally {
    await disabled.stop();
  }
  // The provider's own error message, as seen live: the model is unavailable.
  const failing = await new RealtimeTranscriptionMock({
    key: "k",
    onAudio(session) {
      session.send({
        type: "error",
        requestId: session.start?.requestId,
        code: "MODEL_NOT_FOUND",
        message: "Bidirectional streaming speech model is unavailable.",
      });
      session.close(1007, "MODEL_NOT_FOUND");
    },
  }).start();
  try {
    const session = await RealtimeDictation.open({
      provider: remote(failing.url),
      apiKey: "k",
      headers: {},
      maxSeconds: 5,
    });
    session.append(new Uint8Array(3200));
    await context.waitFor(() => assert.throws(() => session.current()));
    assert.throws(() => session.append(new Uint8Array(2)), {
      message: dictationMessages.unavailable,
    });
    await assert.rejects(session.finish(), {
      message: dictationMessages.unavailable,
    });
  } finally {
    await failing.stop();
  }
  // More audio than the service's limit is refused before it is sent.
  const long = await new RealtimeTranscriptionMock({ key: "k" }).start();
  try {
    const session = await RealtimeDictation.open({
      provider: remote(long.url),
      apiKey: "k",
      headers: {},
      maxSeconds: 1,
    });
    session.append(new Uint8Array(pcmBytesPerSecond));
    assert.throws(() => session.append(new Uint8Array(2)), {
      message: dictationMessages.tooLong,
    });
    session.cancel();
  } finally {
    await long.stop();
  }
});

test("other model services get the recording as one WAV upload", async () => {
  const mock = await new RealtimeTranscriptionMock({
    key: "k",
    transcript: " Uploaded words ",
  }).start();
  try {
    const provider: Provider = {
      id: "local",
      name: "Local",
      baseUrl: mock.url,
      protocol: "responses",
      model: "chat",
      models: ["chat"],
      transcriptionModel: "fixture-transcribe",
    };
    const session = new BufferedDictation(provider, "server-key", 600, "fr-CA");
    assert.equal(session.maxSeconds, maxBufferedSeconds);
    assert.deepEqual(session.append(new Uint8Array(6400)), {
      text: "",
      partial: "",
    });
    assert.equal(await session.finish(), "Uploaded words");
    const upload = mock.uploads[0];
    assert.equal(upload.authorization, "Bearer server-key");
    const body = upload.body.toString("latin1");
    assert.match(body, /fixture-transcribe/);
    assert.match(body, /name="language"\r\n\r\nfr\r\n/);
    assert.match(body, /filename="dictation\.wav"/);
    assert.match(body, /Content-Type: audio\/wav/);
    assert.ok(upload.body.includes(Buffer.from("RIFF")));
    assert.throws(() => session.append(new Uint8Array(3)), /Invalid audio/);
    assert.throws(
      () =>
        new BufferedDictation(
          { ...provider, transcriptionModel: undefined },
          "",
        ),
      /not configured/,
    );
  } finally {
    await mock.stop();
  }
});

test("invalid or oversized recordings are rejected before a provider request", async () => {
  const provider: Provider = {
    id: "fixture",
    name: "Fixture",
    baseUrl: "http://127.0.0.1:1/v1",
    protocol: "responses",
    model: "chat",
    models: ["chat"],
    transcriptionModel: "transcribe",
  };
  await assert.rejects(
    transcribeRecordedAudio(provider, "", "audio/unknown", new Uint8Array(32)),
    /Unsupported/,
  );
  await assert.rejects(
    transcribeRecordedAudio(
      provider,
      "",
      "audio/wav",
      new Uint8Array(maxDictationBytes + 1),
    ),
    /oversized/,
  );
});
