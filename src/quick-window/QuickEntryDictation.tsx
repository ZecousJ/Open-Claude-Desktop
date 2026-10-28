import { useEffect, useRef, useState } from "react";
import type { QuickEntryBridge } from "../../shared/quick-entry";
import { startMicrophone } from "../voice/microphone";
import { microphoneDeviceId } from "../voice/preferences";
import { DictationBar } from "../voice/DictationBar";
import { QuickDictationSession } from "./dictation-session";
import "../composer/voice/dictation.css";

export function QuickEntryDictation({
  voice,
  stopping,
  onLive,
  onDone,
  onError,
  onCancel,
}: {
  voice: NonNullable<QuickEntryBridge["voice"]>;
  stopping: boolean;
  onLive: (text: string) => void;
  onDone: (text: string) => void;
  onError: (error: unknown) => void;
  onCancel: () => void;
}) {
  const session = useRef<QuickDictationSession | undefined>(undefined);
  const callbacks = useRef({ onLive, onDone, onError });
  callbacks.current = { onLive, onDone, onError };
  const [stream, setStream] = useState<MediaStream>();
  useEffect(() => {
    const recording = new QuickDictationSession(
      voice,
      (send) => startMicrophone(send, microphoneDeviceId()),
      {
        live: (text) => callbacks.current.onLive(text),
        ready: setStream,
        done: (text) => callbacks.current.onDone(text),
        error: (error) => callbacks.current.onError(error),
      },
    );
    session.current = recording;
    void recording.start();
    return () => recording.cancel();
  }, [voice]);
  useEffect(() => {
    if (stopping) void session.current?.stop();
  }, [stopping]);
  return (
    <DictationBar
      stream={stream}
      connecting={!stream}
      onCancel={onCancel}
      onDone={() => void session.current?.stop()}
    />
  );
}
