import {
  officialCodeFollowupPath,
  officialCodeReceiptPath,
} from "../../shared/official-code-followup";
import type { OfficialFrameBindings } from "./frame-lifecycle";

const marker = "claudex:pending-code-send";
const draftPrefix = "composer-draft:epitaxy-";
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Pending = {
  draftKey: string;
  snapshot: string | null;
  receipt: string;
  text: string;
  imageCount: number;
};

/** A reload may interrupt the original composer's success callback. Retire only its exact sent draft. */
export function createCodeDraftRecovery(storage: {
  localStorage: DraftStorage;
  sessionStorage: DraftStorage;
}) {
  let confirmed: Pending | undefined;
  let outgoing: Pending | undefined;
  let exiting = false;
  const leave = () => {
    exiting = true;
  };
  const edited = () => {
    if (!outgoing || exiting) return;
    outgoing = undefined;
    try {
      storage.sessionStorage.removeItem(marker);
    } catch {}
  };
  const trackWrite = (key: string, raw: string) => {
    if (
      !exiting ||
      !outgoing ||
      key !== outgoing.draftKey ||
      raw.length > 262_144
    )
      return;
    try {
      const value = JSON.parse(raw);
      if (
        value.text !== outgoing.text ||
        value.snippets?.length ||
        value.files?.length ||
        (value.readyImageCount ?? 0) > outgoing.imageCount
      )
        return;
      // The original page rewrites the sent text at unload. Capture its exact
      // revision only in that lifecycle, before the next document opens.
      outgoing = { ...outgoing, snapshot: raw };
      storage.sessionStorage.setItem(marker, JSON.stringify(outgoing));
    } catch {}
  };
  const remember = (path: string, bytes: Uint8Array) => {
    const route = officialCodeFollowupPath("POST", path);
    if (!route) return;
    try {
      const body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (body?.events?.length !== 1) return;
      const row = route.wrapped ? body.events[0]?.payload : body.events[0];
      if (row?.type !== "user" || typeof row.uuid !== "string") return;
      const session = "session_" + route.key;
      const draftKey = draftPrefix + session;
      const snapshot = storage.localStorage.getItem(draftKey);
      if (snapshot && snapshot.length > 262_144) return;
      const draft = snapshot ? JSON.parse(snapshot) : undefined;
      const blocks = row.message?.content;
      const text = Array.isArray(blocks)
        ? blocks
            .filter((block) => block?.type === "text")
            .map((block) => block.text)
            .join("\n")
        : blocks;
      const images = Array.isArray(blocks)
        ? blocks.filter((block) => block?.type === "image").length
        : 0;
      if (
        typeof text !== "string" ||
        text.length > 200_000 ||
        (draft &&
          (text !== draft.text ||
            draft.snippets?.length ||
            draft.files?.length ||
            (draft.readyImageCount ?? 0) !== images))
      )
        return;
      const receipt = `/v1/code/sessions/${session}/events/${row.uuid.toLowerCase()}/receipt`;
      if (officialCodeReceiptPath("GET", receipt)) {
        outgoing = {
          draftKey,
          snapshot,
          receipt,
          text,
          imageCount: images,
        };
        storage.sessionStorage.setItem(marker, JSON.stringify(outgoing));
      }
    } catch {
      // Draft storage is best effort; a blocked store cannot hold up a send.
    }
  };

  const reconcile = async (
    read: OfficialFrameBindings["read"],
    current: () => boolean,
  ) => {
    let timeout: ReturnType<typeof setTimeout> | number | undefined;
    try {
      const raw = storage.sessionStorage.getItem(marker);
      if (!raw || raw.length > 1_600_000) return;
      const pending: Pending = JSON.parse(raw);
      const route = officialCodeReceiptPath("GET", pending?.receipt);
      if (!route || pending.draftKey !== draftPrefix + "session_" + route.key)
        return;
      const snapshot = storage.localStorage.getItem(pending.draftKey);
      if (!snapshot || pending.snapshot !== snapshot) return;
      const proof = await Promise.race([
        read({ method: "GET", path: pending.receipt }),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(resolve, 1_500);
        }),
      ]);
      if (current() && proof?.status === 204)
        confirmed = { ...pending, snapshot };
    } catch {
      // Keep the draft when history or the account cannot be verified.
    } finally {
      clearTimeout(timeout);
    }
  };

  const takeConfirmed = (key: string) => {
    if (!confirmed || confirmed.draftKey !== "composer-draft:" + key)
      return false;
    const pending = confirmed;
    confirmed = undefined;
    try {
      if (storage.localStorage.getItem(pending.draftKey) !== pending.snapshot)
        return false;
      storage.sessionStorage.removeItem(marker);
      return true;
    } catch {
      return false;
    }
  };
  return { remember, reconcile, takeConfirmed, trackWrite, leave, edited };
}
