import { useEffect, useRef, useState } from "react";
import type { BackgroundTerminalInfo, Conversation } from "../../shared/types";

type TerminalList = (
  conversationId: string,
) => Promise<BackgroundTerminalInfo[]>;
function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
export function useNativeBackgroundTerminals(
  conversations: Conversation[],
  activeConversationId: string | undefined,
  engineReady: boolean,
  onList: TerminalList | undefined,
  onError: (error: unknown) => void,
) {
  const [terminals, setTerminals] = useState<BackgroundTerminalInfo[]>([]);
  const candidates = conversations
    .filter(
      (conversation) =>
        !conversation.archived &&
        conversation.threadId &&
        conversation.mode === "code",
    )
    .sort(
      (a, b) =>
        Number(b.id === activeConversationId) -
          Number(a.id === activeConversationId) || b.updatedAt - a.updatedAt,
    )
    .slice(0, 20);
  const candidateKey = candidates
    .map((conversation) => conversation.id)
    .join("|");
  const hasList = Boolean(onList);
  const callbacks = useRef({ candidates, onList, onError });
  callbacks.current = { candidates, onList, onError };
  useEffect(() => {
    if (!engineReady || !hasList || !candidateKey) {
      setTerminals([]);
      return;
    }
    let mounted = true,
      pending = false,
      lastError = "";
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const { candidates, onList, onError } = callbacks.current;
        if (!onList) return;
        const results = await Promise.allSettled(
          candidates.map((conversation) => onList(conversation.id)),
        );
        if (!mounted) return;
        setTerminals(
          results.flatMap((result) =>
            result.status === "fulfilled" ? result.value : [],
          ),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") {
          const message = errorMessage(failed.reason);
          if (message !== lastError) {
            lastError = message;
            onError(failed.reason);
          }
        } else lastError = "";
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [candidateKey, engineReady, hasList]);
  return { terminals, setTerminals };
}
export function useWorkflowRefresh(
  activeIds: string,
  onRefresh: (() => Promise<void>) | undefined,
  onError: (error: unknown) => void,
) {
  const callbacks = useRef({ onRefresh, onError });
  callbacks.current = { onRefresh, onError };
  const hasRefresh = Boolean(onRefresh);
  useEffect(() => {
    if (!activeIds || !hasRefresh) return;
    let mounted = true,
      pending = false,
      lastError = "";
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        await callbacks.current.onRefresh?.();
        if (mounted) lastError = "";
      } catch (error) {
        if (mounted && errorMessage(error) !== lastError) {
          lastError = errorMessage(error);
          callbacks.current.onError(error);
        }
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [activeIds, hasRefresh]);
}
