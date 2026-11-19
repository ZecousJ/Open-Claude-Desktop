import { BrowserWindow, nativeTheme, type IpcMainInvokeEvent } from "electron";
import {
  designWindowArgument,
  designWindowChannels,
  type DesignWindowContext,
  type DesignWindowConversation,
} from "../../shared/design-window";
import { isOwnedDesign } from "../../shared/official-design-artifacts";
import type { AppEvent, Conversation } from "../../shared/types";
import { mergeConversationTurn } from "../../src/host/events";
import { nearestLocale } from "../../shared/locales";
import { preference } from "../../shared/settings-extras";
import { mainState } from "../app/main-state";
import { extraPagePreferences, loadExtraPage } from "../extra-pages";
import { dirname, onAppEvent, routedCall } from "../main";
import { organizationUuid } from "./api/context";
import type { OfficialActivationLease } from "./activation-lease";

const openDesigns = new WeakMap<
  OfficialActivationLease,
  Map<string, Promise<BrowserWindow>>
>();

type ConversationEvent = Extract<
  AppEvent,
  { type: "conversation" | "conversation-turn" }
>;

function applyConversationEvent(
  existing: Conversation | undefined,
  event: ConversationEvent,
) {
  return event.type === "conversation"
    ? event.conversation
    : mergeConversationTurn(existing, event);
}

function windowConversation(
  conversation: Conversation & {
    blankArtifact: DesignWindowConversation["blankArtifact"];
  },
): DesignWindowConversation {
  const last =
    conversation.turns.filter((turn) => turn.status === "inProgress").at(-1) ??
    conversation.turns.at(-1);
  return {
    id: conversation.id,
    updatedAt: conversation.updatedAt,
    blankArtifact: conversation.blankArtifact,
    ...(last && { lastTurn: { id: last.id, status: last.status } }),
  };
}

export async function openDesignWindow({
  lease,
  conversation,
  title,
  readConversation,
  hidden = false,
}: {
  lease: OfficialActivationLease;
  conversation: Conversation & {
    blankArtifact: DesignWindowConversation["blankArtifact"];
  };
  title: string;
  readConversation(): Promise<Conversation | undefined>;
  hidden?: boolean;
}) {
  const unavailable = () =>
    new Error("This Design window is no longer available.");
  if (!lease.current()) throw unavailable();
  const target = {
    conversationId: conversation.id,
    artifactId: conversation.blankArtifact.id,
  };
  let designs = openDesigns.get(lease);
  if (!designs) openDesigns.set(lease, (designs = new Map()));
  const previous = designs.get(target.artifactId);
  if (previous) {
    const window = await previous;
    if (!lease.current() || window.isDestroyed()) throw unavailable();
    if (!hidden) {
      window.show();
      window.focus();
    }
    return window;
  }

  const dark = nativeTheme.shouldUseDarkColors;
  const context: DesignWindowContext = {
    accountId: lease.identity.owner,
    conversation: windowConversation(conversation),
    title,
    theme: dark ? "dark" : "light",
    locale: nearestLocale(preference(mainState.store.settings, "locale")),
  };
  const window = new BrowserWindow({
    show: false,
    ...(hidden ? { focusable: false, skipTaskbar: true } : {}),
    width: 1100,
    height: 760,
    minWidth: 400,
    minHeight: 420,
    title,
    backgroundColor: dark ? "#181817" : "#f8f8f6",
    autoHideMenuBar: true,
    webPreferences: {
      ...extraPagePreferences(dirname, "design-window-preload.cjs"),
      additionalArguments: [designWindowArgument + JSON.stringify(context)],
    },
  });
  const contents = window.webContents;
  const check = (event: IpcMainInvokeEvent) => {
    if (
      window.isDestroyed() ||
      event.senderFrame !== contents.mainFrame ||
      !lease.current()
    )
      throw unavailable();
  };
  let current = conversation;
  let metadata = context.conversation;
  let observed = false;
  let pendingRead: { events: ConversationEvent[] } | undefined;
  const live = () => !window.isDestroyed() && lease.current();
  const owner = lease.identity.owner;
  const org = organizationUuid(owner);
  const update = (next: Conversation | undefined) => {
    if (!live()) return;
    if (
      !next ||
      !isOwnedDesign(next, owner, org) ||
      next.blankArtifact.id !== target.artifactId
    ) {
      window.destroy();
      return;
    }
    current = next;
    const projected = windowConversation(next);
    if (
      metadata.updatedAt === projected.updatedAt &&
      metadata.lastTurn?.id === projected.lastTurn?.id &&
      metadata.lastTurn?.status === projected.lastTurn?.status
    )
      return;
    metadata = projected;
    if (observed) contents.send(designWindowChannels.conversation, metadata);
  };
  const refresh = () => {
    const request = { events: [] as ConversationEvent[] };
    pendingRead = request;
    void readConversation()
      .then((snapshot) => {
        if (pendingRead !== request || !live()) return;
        pendingRead = undefined;
        let next = snapshot;
        for (const event of request.events)
          next = applyConversationEvent(next, event);
        update(next);
      })
      .catch((error) => {
        if (pendingRead !== request) return;
        pendingRead = undefined;
        if (live())
          console.error("Could not refresh the Design conversation:", error);
      });
  };
  const stopUpdates = onAppEvent((event) => {
    if (!live()) return;
    if (event.type === "resync") {
      refresh();
      return;
    }
    const matches =
      (event.type === "conversation" &&
        event.conversation.id === target.conversationId) ||
      (event.type === "conversation-turn" &&
        event.conversationId === target.conversationId);
    if (!matches) return;
    pendingRead?.events.push(event);
    const next = applyConversationEvent(current, event);
    if (next) update(next);
  });
  contents.ipc.handle(designWindowChannels.currentConversation, (event) => {
    check(event);
    observed = true;
    return metadata;
  });
  contents.ipc.handle(designWindowChannels.read, async (event) => {
    check(event);
    const document = await routedCall("readBlankArtifact", target);
    check(event);
    return document;
  });
  contents.ipc.handle(
    designWindowChannels.save,
    async (event, content: unknown, expectedRevision: unknown) => {
      check(event);
      const result = await routedCall("saveBlankArtifact", {
        ...target,
        content,
        expectedRevision,
      });
      check(event);
      return result;
    },
  );
  const stop = lease.onRetire(() => window.destroy());
  const currentDesigns = designs;
  window.once("closed", () => {
    stopUpdates();
    stop();
    currentDesigns.delete(target.artifactId);
  });
  window.on("page-title-updated", (event) => event.preventDefault());
  refresh();
  const ready = loadExtraPage(contents, "design.html", dirname)
    .then(() => {
      if (!lease.current() || window.isDestroyed()) throw unavailable();
      if (hidden) {
        window.setOpacity(0);
        window.setIgnoreMouseEvents(true);
        window.showInactive();
      } else window.show();
      return window;
    })
    .catch((error: unknown) => {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    });
  designs.set(target.artifactId, ready);
  return ready;
}
