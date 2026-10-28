/**
 * Microphone samples to the dictation format (package C6): 16 kHz mono
 * pcm_s16le, in chunks of about 100 ms.
 */
import { dictationAudioFormat } from "../../shared/voice-api";

const targetRate = dictationAudioFormat.sampleRate;
/** 100 ms of audio. */
export const chunkSamples = targetRate / 10;

/**
 * Converts float samples at the input rate to 16 kHz 16-bit samples by
 * linear interpolation; the sampling position carries across blocks.
 */
export class PcmEncoder {
  private readonly step: number;
  /** Position of the next output sample, in input samples from the current block. */
  private position = 0;
  private pending: number[] = [];
  constructor(
    inputRate: number,
    private onChunk: (pcm: Uint8Array) => void,
  ) {
    if (!(inputRate >= 8000 && inputRate <= 384_000))
      throw Error("Unsupported microphone sample rate.");
    this.step = inputRate / targetRate;
  }

  push(input: Float32Array) {
    while (this.position < input.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const before = input[index];
      const after = index + 1 < input.length ? input[index + 1] : before;
      this.pending.push(before + (after - before) * fraction);
      if (this.pending.length >= chunkSamples) this.emit(chunkSamples);
      this.position += this.step;
    }
    this.position -= input.length;
  }

  /** Sends what is left, however short. */
  flush() {
    if (this.pending.length) this.emit(this.pending.length);
  }

  private emit(count: number) {
    const samples = this.pending.splice(0, count);
    this.onChunk(pcm16(samples));
  }
}

/** Little-endian 16-bit samples, clipped. */
export function pcm16(samples: ArrayLike<number>) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return bytes;
}
