import { useEffect, useRef, useState } from "react";
import type { AgentTranscript } from "../../../shared/types";

export function useAgentTranscript(
  conversationId: string,
  agentId: string,
  onRead: (conversationId: string, agentId: string) => Promise<AgentTranscript>,
  onError: (error: unknown) => void,
) {
  const [transcript, setTranscript] = useState<AgentTranscript>();
  const [error, setError] = useState<string>();
  const [retryCount, setRetryCount] = useState(0);
  const callbacks = useRef({ onRead, onError });
  callbacks.current = { onRead, onError };
  useEffect(() => {
    let mounted = true,
      pending = false;
    let timer: number | undefined;
    setTranscript(undefined);
    setError(undefined);
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await callbacks.current.onRead(conversationId, agentId);
        if (!mounted) return;
        setTranscript(next);
        setError(undefined);
        if (next.status !== "running" && timer !== undefined)
          window.clearInterval(timer);
      } catch (failure) {
        if (!mounted) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        if (timer !== undefined) window.clearInterval(timer);
        callbacks.current.onError(failure);
      } finally {
        pending = false;
      }
    };
    timer = window.setInterval(() => {
      void refresh();
    }, 3000);
    void refresh();
    return () => {
      mounted = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [conversationId, agentId, retryCount]);
  return {
    transcript,
    error,
    retry: () => setRetryCount((value) => value + 1),
  };
}
