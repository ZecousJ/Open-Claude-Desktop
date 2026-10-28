/**
 * Whether the microphone is heard at all during voice mode. Every 500 ms the
 * loudest chunk since the last look is compared with a peak RMS of 3 (16-bit
 * samples); no sound for 5 seconds while listening is "silent", a muted input
 * track is "muted".
 */
export type MicSilence = "silent" | "muted";

export const micSilenceCheckMs = 500;
export const micSilencePromptMs = 5000;
export const silentPeakRms = 3;

/** The RMS of a chunk of 16-bit little-endian mono samples. */
export function pcmRms(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / 2);
  if (!samples) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = view.getInt16(i * 2, true);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/** Tracks loudness between checks and says when to warn. */
export class MicSilenceMonitor {
  private peak = 0;
  private lastAudible: number;
  constructor(now: number) {
    this.lastAudible = now;
  }
  hear(pcm: Uint8Array) {
    this.peak = Math.max(this.peak, pcmRms(pcm));
  }
  /** The notice to show now, or null; `muted` is the input track's state. */
  check(now: number, muted: boolean): MicSilence | null {
    const peak = this.peak;
    this.peak = 0;
    if (muted) return "muted";
    if (peak > silentPeakRms) {
      this.lastAudible = now;
      return null;
    }
    return now - this.lastAudible >= micSilencePromptMs ? "silent" : null;
  }
}
