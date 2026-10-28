import { Suspense, useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  artifactToolMessage,
  artifactToolResult,
  artifactToolDisplay,
} from "../../shared/artifact-tools";
import { lazyPiece } from "../ui/lazy-piece";
import { t } from "../i18n";

const ArtifactScheduledTaskDialog = lazyPiece(
  () => import("./ArtifactScheduledTaskDialog"),
  "ArtifactScheduledTaskDialog",
);

/**
 * Gesture, consent, and shown-version checks. Dispatch uses the same scheduler
 * as Scheduled.
 */
export function useArtifactScheduledTasks(
  frame: RefObject<HTMLIFrameElement | null>,
  identity: string,
  version: string,
  title: string,
) {
  const [request, setRequest] = useState<{
    task: string;
    decide(allow: boolean, remember: boolean): void;
  }>();
  useEffect(() => {
    let live = true;
    let busy = false;
    let cancel: (() => void) | undefined;
    const allowed = new Set<string>();
    setRequest(undefined);
    async function message(event: MessageEvent) {
      const target = frame.current?.contentWindow;
      const data = event.data;
      if (
        !target ||
        event.source !== target ||
        data?.type !== artifactToolMessage ||
        data.method !== "runScheduledTask" ||
        typeof data.id !== "string" ||
        data.id.length > 200
      )
        return;
      const shown = () => live && frame.current?.contentWindow === target;
      const answer = (result: unknown) => {
        if (shown())
          target.postMessage(
            { type: artifactToolResult, id: data.id, result },
            "*",
          );
      };
      const fail = () =>
        answer({ isError: true, error: t("The request failed.") });
      if (
        busy ||
        !Array.isArray(data.args) ||
        data.args[1] !== true ||
        typeof data.args[0] !== "string" ||
        !data.args[0] ||
        data.args[0].length > 500 ||
        document.visibilityState === "hidden"
      ) {
        fail();
        return;
      }
      busy = true;
      try {
        const taskId = data.args[0];
        const task = (await window.desktop.listSchedules()).find(
          (entry) => entry.id === taskId,
        );
        if (!shown()) return;
        if (!task) {
          fail();
          return;
        }
        const consent =
          allowed.has(taskId) ||
          (await new Promise<boolean>((resolve) => {
            cancel = () => resolve(false);
            setRequest({
              task: taskId,
              decide: (allow, remember) => {
                setRequest(undefined);
                if (allow && remember && shown()) allowed.add(taskId);
                resolve(allow);
              },
            });
          }));
        if (!consent || !shown()) {
          fail();
          return;
        }
        const run = await window.desktop.runSchedule(taskId);
        if (run.conversationId) answer({ sessionId: run.conversationId });
        else fail();
      } catch {
        fail();
      } finally {
        busy = false;
        cancel = undefined;
      }
    }
    window.addEventListener("message", message);
    return () => {
      live = false;
      cancel?.();
      window.removeEventListener("message", message);
    };
  }, [frame, identity, version]);
  return (
    request &&
    createPortal(
      <Suspense fallback={null}>
        <ArtifactScheduledTaskDialog
          artifact={artifactToolDisplay(title, 80)}
          task={artifactToolDisplay(request.task, 64)}
          onDecision={request.decide}
        />
      </Suspense>,
      document.body,
    )
  );
}
