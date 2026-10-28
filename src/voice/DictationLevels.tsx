import { useEffect, useRef } from "react";
import "./dictation-levels.css";

export function frequencyLevel(data: Uint8Array) {
  let sum = 0;
  for (const value of data) sum += value;
  return data.length ? Math.min(1, sum / data.length / 128) : 0;
}

/** Microphone menu meter. */
export function DictationLevels({ stream }: { stream?: MediaStream }) {
  const fill = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (fill.current) fill.current.style.width = "0%";
    if (!stream) return;
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    const draw = () => {
      analyser.getByteFrequencyData(data);
      if (fill.current)
        fill.current.style.width = `${frequencyLevel(data) * 100}%`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(() => {});
    };
  }, [stream]);
  return (
    <span className="dictation-input-level" aria-hidden="true">
      <span ref={fill} />
    </span>
  );
}
