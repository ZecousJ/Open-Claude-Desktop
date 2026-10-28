/* Native-only reading-position adapter. Copied byte-for-byte into each native target;
 * no transport credentials, network access or mutation capability live here. */
(() => {
  if (window.__claudexViewport) return;
  let context = null, restoring = false, scheduled = false;
  const viewport = () => document.querySelector('.messages-scroll');
  const post = value => {
    if (window.webkit?.messageHandlers?.claudexTranscriptUI) {
      window.webkit.messageHandlers.claudexTranscriptUI.postMessage(value);
    } else window.claudexConversation?.postMessage(JSON.stringify(value));
  };
  function capture() {
    const el = viewport();
    if (!context || !el || restoring) return;
    const turns = [...el.querySelectorAll('.messages > .turn')];
    const top = el.getBoundingClientRect().top;
    const index = turns.findIndex(turn => turn.getBoundingClientRect().bottom > top + 1);
    post({ version: 1, type: 'nativeViewport', sessionId: context.sessionId, scope: context.scope,
      top: Math.max(0, el.scrollTop), index, offset: index < 0 ? 0 : turns[index].getBoundingClientRect().top - top,
      following: el.scrollHeight - el.clientHeight - el.scrollTop < 60 });
  }
  document.addEventListener('scroll', event => {
    if (event.target !== viewport() || scheduled || restoring) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; capture(); });
  }, true);
  window.__claudexViewport = Object.freeze({
    async prepare(next, position) {
      const changed = context?.sessionId !== next.sessionId || context?.scope !== next.scope;
      context = next;
      const expected = context;
      restoring = true;
      if (document.fonts) await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (context !== expected) return false;
      const el = viewport();
      if (changed && position && el && !position.following) {
        const turn = el.querySelectorAll('.messages > .turn')[position.index];
        const target = turn ? el.scrollTop + turn.getBoundingClientRect().top - el.getBoundingClientRect().top - position.offset : position.top;
        el.scrollTop = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
        // Let the renderer's own scroll listener leave follow mode before future stream updates.
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      if (context !== expected) return false;
      restoring = false;
      return true;
    },
    capture
  });
})();
