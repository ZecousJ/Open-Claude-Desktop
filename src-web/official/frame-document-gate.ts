/** One document per mounted frame. Lifecycle fencing, NOT a same-origin sandbox. */
export function createOfficialFrameDocumentGate(frame: {
  window(): unknown;
  document(): unknown;
  url(): string;
  connected(): boolean;
}, origin: string) {
  const expectedWindow = frame.window();
  let live = true, claimed = false, expectedDocument: unknown;
  const revoke = () => { live = false; };
  const isCurrent = () => {
    if (!live || !claimed) return false;
    try {
      if (frame.connected() && frame.window() === expectedWindow && frame.document() === expectedDocument) return true;
    } catch { /* A cross-origin replacement is not the authorized document. */ }
    revoke();
    return false;
  };
  return {
    claim(window: unknown, document: unknown) {
      if (!live || claimed || !expectedWindow || !document) return false;
      try {
        const url = new URL(frame.url());
        if (!frame.connected() || window !== expectedWindow || frame.window() !== expectedWindow || frame.document() !== document || url.origin !== origin || url.pathname !== '/official-frame.html' || url.search || url.hash) return false;
      } catch { return false; }
      expectedDocument = document;
      claimed = true;
      return true;
    },
    get claimed() { return claimed; },
    isCurrent,
    revoke,
  };
}
