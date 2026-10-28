import type { BlankArtifactSendLease } from "../artifacts/blank-artifact-flush";
import { validSkillTokens } from "../composer/skill-tokens";
import { beginComposerSending, composerSendScope } from "./composer-send-scope";
import { api } from "../desktop-api";
import type { Conversation } from "../../shared/types";
import type { AppController } from "./AppContext";
import { addQueued } from "../composer/queue";
import { conversationChanged, sendQueued } from "../composer/queue";

/**
 * A message written while the conversation runs: the running turn reads it at
 * its next step (`turn/steer`); when no turn can take it now, it is queued and
 * sent as the next message once the turn ends. Either way it waits above the
 * composer until it is delivered. `later` skips the steer: the message is
 * queued for after the turn.
 */
export async function sendWhileRunning(
  app: AppController,
  active: Conversation,
  later = false,
) {
  if (app.sending) return;
  const scope = composerSendScope(app);
  const blankBridge = active.blankArtifact ? window.desktop : undefined;
  const busy = beginComposerSending(app);
  const text = app.text,
    files = app.attachments;
  const skillTokens = validSkillTokens(text, app.skillTokens);
  const target = { providerId: active.providerId, model: active.model };
  const entry = {
    text,
    attachments: files,
    ...(skillTokens.length ? { skillTokens } : {}),
    mode: active.mode,
    effort: app.effort,
    webSearch: app.policy.webSearch && Boolean(active.webSearch),
    ...target,
  };
  let blankLease: BlankArtifactSendLease | undefined;
  try {
    if (active.blankArtifact) {
      const { prepareBlankArtifactSend } =
        await import("../artifacts/blank-artifact-flush");
      blankLease = await prepareBlankArtifactSend(app);
      if (
        !blankLease.saved ||
        !scope.foreground() ||
        !busy.owns() ||
        !blankLease.current()
      )
        return;
    }
    app.setText("");
    app.setSkillTokens?.([]);
    app.setAttachments([]);
    const steered =
      later || Boolean(active.chatDeviceBinding)
        ? null
        : await api.steerTurn(
            active.id,
            text,
            files.map((file) => file.id),
          );
    if (!scope.controllerCurrent()) return;
    if (steered) {
      addQueued(active.id, {
        ...entry,
        state: "steered",
        messageId: steered.messageId,
      });
      app.upsert(steered.conversation);
    } else {
      addQueued(active.id, { ...entry, state: "queued" });
      // The turn may have ended while asking; send it now if so.
      const latest = app.latest.current?.conversations.find(
        (c) => c.id === active.id,
      );
      if (latest) void conversationChanged(latest, sendQueued);
    }
  } catch (e) {
    if (blankLease && !blankLease.current()) {
      if (window.desktop === blankBridge && scope.controllerCurrent()) {
        if (scope.current() && scope.empty()) {
          app.setText(text);
          app.setSkillTokens?.(skillTokens);
          app.setAttachments(files);
        } else scope.restoreDeparted({ text, attachments: files, skillTokens });
      }
      return;
    }
    if (scope.current() && busy.owns()) {
      if (scope.empty()) {
        app.setText(text);
        app.setSkillTokens?.(skillTokens);
        app.setAttachments(files);
      }
      if (scope.foreground()) app.report(e);
    } else scope.restoreDeparted({ text, attachments: files, skillTokens });
  } finally {
    blankLease?.release();
    const owned = busy.owns();
    busy.finish();
    if (owned && scope.foreground()) settleComposer(app);
  }
}

/**
 * After a send the composer keeps the focus for the next message, except on
 * a touch screen: there it lets go, so the on-screen keyboard closes and the
 * reply has the screen (as claude.ai does on a phone).
 */
export function settleComposer(app: AppController) {
  if (touchScreen()) app.composer.current?.blur();
  else app.composer.current?.focus();
}

/** Sends the composer's draft; while a turn runs, hands it to that turn or queues it. */
/** A touch screen: its on-screen keyboard follows the composer's focus. */
export const touchScreen = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
