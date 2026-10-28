/**
 * Microphone capture for dictation (package C6): 16 kHz mono pcm_s16le in
 * chunks of about 100 ms. An AudioWorklet reads the samples; where it
 * cannot be loaded, a ScriptProcessorNode does.
 */
import workletUrl from "./pcm-capture-worklet.js?url&no-inline";
import { dictationAudioFormat } from "../../shared/voice-api";
import { PcmEncoder } from "./pcm";
import { errorName, microphoneError } from "./microphone-error";

export interface Microphone {
  /** Stops recording; with `flush`, the last partial chunk is sent first. */
  stop(flush?: boolean): void;
  /** The recorded input, for a level display while it lasts. */
  stream: MediaStream;
}

export async function startMicrophone(
  onChunk: (pcm: Uint8Array) => void,
  /** The input chosen in the microphone menu; the system default when absent. */
  deviceId?: string,
): Promise<Microphone> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw Error("Audio recording is unavailable on this device.");
  const constraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  const open = (audio: MediaTrackConstraints) =>
    navigator.mediaDevices.getUserMedia({ audio, video: false });
  let stream: MediaStream;
  try {
    try {
      stream = await open(
        deviceId
          ? { ...constraints, deviceId: { exact: deviceId } }
          : constraints,
      );
    } catch (error) {
      // The chosen device was unplugged: record from the default one instead.
      if (
        !deviceId ||
        !["OverconstrainedError", "NotFoundError"].includes(errorName(error))
      )
        throw error;
      stream = await open(constraints);
    }
  } catch (error) {
    throw microphoneError(error);
  }
  let context: AudioContext | undefined;
  try {
    // Chromium resamples the microphone to the context's rate.
    try {
      context = new AudioContext({
        sampleRate: dictationAudioFormat.sampleRate,
      });
    } catch {
      context = new AudioContext();
    }
    const audio = context;
    const encoder = new PcmEncoder(audio.sampleRate, onChunk);
    const source = audio.createMediaStreamSource(stream);
    let node: AudioNode;
    try {
      await audio.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(audio, "claudex-pcm-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) =>
        encoder.push(event.data);
      node = worklet;
      source.connect(worklet);
    } catch {
      const processor = audio.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) =>
        encoder.push(event.inputBuffer.getChannelData(0));
      source.connect(processor);
      // A script processor only runs while connected to the output; it writes silence.
      processor.connect(audio.destination);
      node = processor;
    }
    if (audio.state === "suspended") await audio.resume();
    let stopped = false;
    return {
      stream,
      stop(flush = false) {
        if (stopped) return;
        stopped = true;
        source.disconnect();
        node.disconnect();
        if (node instanceof AudioWorkletNode) node.port.onmessage = null;
        stream.getTracks().forEach((track) => track.stop());
        void audio.close().catch(() => {});
        if (flush) encoder.flush();
      },
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
    throw error;
  }
}
