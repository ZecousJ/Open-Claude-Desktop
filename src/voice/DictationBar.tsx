import { useEffect, useRef } from "react";
import { DictationActions } from "./DictationActions";
import "./dictation-bar.css";

/** Waveform. */
export function waveformLevel(samples: Uint8Array) {
  let sum = 0;
  for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, (Math.max(0, rms - 0.015) / 0.985) ** 0.5 * 2.2);
}

export function waveformBars(
  levels: number[],
  width: number,
  height: number,
  offset: number,
) {
  return levels.map((level, index) => {
    const left = width - 7 - offset - (levels.length - 1 - index) * 7;
    const edge = Math.min(left, width - left - 2);
    const fade = edge >= 21 ? 0 : 1 - Math.max(0, edge) / 21;
    const barHeight = Math.max(
      2,
      (2 + (height - 2) * level) * Math.sqrt(Math.max(0, 1 - fade * fade)),
    );
    return { x: left, y: height / 2 - barHeight / 2, height: barHeight };
  });
}

export function DictationBar({
  stream,
  connecting,
  onCancel,
  onDone,
}: {
  stream?: MediaStream;
  connecting: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const waveform = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!stream) return;
    let audio: AudioContext;
    try {
      audio = new AudioContext();
    } catch {
      return;
    }
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    const source = audio.createMediaStreamSource(stream);
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = [];
    let last = 0;
    let frame = 0;
    const draw = (time: number) => {
      const svg = waveform.current;
      const width = container.current?.clientWidth ?? 0;
      if (svg && width) {
        if (time - last >= 80) {
          last = time - ((time - last) % 80);
          analyser.getByteTimeDomainData(samples);
          levels.push(waveformLevel(samples));
          const count = Math.max(1, Math.floor(width / 7));
          if (levels.length > count) levels.splice(0, levels.length - count);
        }
        const bars = waveformBars(
          levels,
          width,
          svg.clientHeight || 20,
          ((time - last) / 80) * 7,
        );
        while (svg.childNodes.length < bars.length) {
          const rect = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "rect",
          );
          rect.setAttribute("width", "2");
          rect.setAttribute("rx", "1");
          rect.setAttribute("fill", "currentColor");
          svg.appendChild(rect);
        }
        while (svg.childNodes.length > bars.length) svg.lastChild?.remove();
        bars.forEach((bar, index) => {
          const rect = svg.children[index];
          rect.setAttribute("x", bar.x.toFixed(2));
          rect.setAttribute("y", bar.y.toFixed(2));
          rect.setAttribute("height", bar.height.toFixed(2));
        });
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void audio.close().catch(() => {});
      waveform.current?.replaceChildren();
    };
  }, [stream]);
  return (
    <div className="dictation-bar">
      <div className="dictation-waveform" ref={container} aria-hidden="true">
        <svg ref={waveform} />
      </div>
      <DictationActions
        connecting={connecting}
        onCancel={onCancel}
        onDone={onDone}
      />
    </div>
  );
}
