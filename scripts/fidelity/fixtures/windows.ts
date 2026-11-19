/**
 * Separate conversation windows (R2) for the preview. The page opened with
 * `window=conversation&id=<conversation id>` renders as that conversation's
 * own window (src/conversation-window/window-role.ts); the preview has one
 * page, so opening and returning navigate it instead of making windows.
 *
 * - `handoff=1`: the window starts with a draft the main window handed over.
 * - Open in new window navigates to the window's page, carrying the draft.
 * - Return to the main window navigates back to the main page with
 *   `returned=<id>`; the main page then gets the "open-conversation"
 *   command and the draft, as it would from the main process.
 */
import type { WindowHandoff } from "../../../shared/windows-api";
import type { FixtureDomain } from "./index";

const draftKey = "fixture.windowHandoff";

function stash(handoff: WindowHandoff | undefined) {
  try {
    if (handoff) sessionStorage.setItem(draftKey, JSON.stringify(handoff));
    else sessionStorage.removeItem(draftKey);
  } catch {
    // The preview works without the draft.
  }
}

function unstash(): WindowHandoff | null {
  try {
    const raw = sessionStorage.getItem(draftKey);
    sessionStorage.removeItem(draftKey);
    return raw ? (JSON.parse(raw) as WindowHandoff) : null;
  } catch {
    return null;
  }
}

function navigate(change: (params: URLSearchParams) => void) {
  const url = new URL(location.href);
  for (const key of ["window", "id", "handoff", "returned"])
    url.searchParams.delete(key);
  change(url.searchParams);
  location.assign(url.toString());
}

export const windowsFixture: FixtureDomain = {
  params: {
    window: "conversation: the page is a separate conversation window",
    id: "the conversation a separate window shows",
    handoff: "1: the window starts with a draft handed over",
    returned: "<id>: the main page as a separate window returned to it",
  },
  bridge: ({ params, emit }) => {
    const separate =
      params.get("window") === "conversation" && Boolean(params.get("id"));
    let pinned = false;
    let handedOver =
      separate && params.get("handoff") === "1"
        ? ({
            text: "Also check the exit code when the command times out.",
            attachmentIds: [],
          } satisfies WindowHandoff)
        : null;
    const returned = !separate ? params.get("returned") : null;
    if (returned) {
      // Once the app is on screen and listening, as the main process would.
      const send = () =>
        emit({
          type: "command",
          command: "open-conversation",
          conversationId: returned,
        });
      const wait = (tries: number) =>
        setTimeout(() => {
          if (document.querySelector(".sidebar") || !tries) send();
          else wait(tries - 1);
        }, 250);
      wait(80);
    }
    return {
      openConversationWindow: async (conversationId, handoff) => {
        stash(handoff);
        navigate((search) => {
          search.set("window", "conversation");
          search.set("id", conversationId);
        });
      },
      returnToMainWindow: async (handoff) => {
        if (!separate)
          throw new Error("This window isn't a separate conversation window.");
        stash(handoff);
        navigate((search) => search.set("returned", params.get("id")!));
      },
      setWindowPinned: async (on) => {
        if (!separate) return false;
        pinned = on;
        return pinned;
      },
      takeWindowHandoff: async () => {
        const stashed = unstash();
        const handoff = handedOver ?? stashed;
        handedOver = null;
        return handoff;
      },
      reportWindowVisibility: async () => {},
      forwardToMainWindow: async () => {},
      conversationWindows: async () => (separate ? [params.get("id")!] : []),
    };
  },
};
