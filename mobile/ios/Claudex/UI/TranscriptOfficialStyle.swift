import Foundation

/// The official transcript look and gestures, laid over the bundled web/PC renderer.
///
/// The shared bundle is locked byte for byte (shared-conversation-lock.json), so the phone's transcript values
/// are applied from outside it: a stylesheet and a small script that run in an isolated WebKit content world. The
/// script sees the DOM only; it reports long presses, the steps row and the Share button to native code through its
/// own message handler and never reaches the page's bridge.
enum TranscriptOfficialStyle {
  static let messageHandler = "claudexTranscriptUI"

  /// Fonts the stylesheet loads from the app bundle (`Resources/Fonts`, both OFL).
  static let fonts = ["NotoSerif.ttf", "JetBrainsMono.ttf", "NotoSerifSC.otf"]

  static let css = #"""
/* The phone's transcript values. */
@font-face { font-family: "Claudex Reading Serif"; src: url("/native-fonts/NotoSerif.ttf") format("truetype"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Claudex Reading Serif CJK"; src: url("/native-fonts/NotoSerifSC.otf") format("opentype"); unicode-range: U+2010-206F, U+3000-303F, U+3400-4DBF, U+4E00-9FFF, U+FF00-FFEF; font-display: swap; }
/* One bundled CJK serif weight and WebKit does not synthesise bold for it: bold text gets a
   thin same-colour stroke so bold Chinese reads bold (the Latin bold face barely changes). */
:root .app.mobile-conversation .markdown :is(strong, b, h1, h2, h3, h4, h5, h6, th) { -webkit-text-stroke: .028em currentColor; }
:root:root:root { --oc-serif: "Claudex Reading Serif", "Claudex Reading Serif CJK", "Songti SC", serif; }
@font-face { font-family: "Claudex Code Mono"; src: url("/native-fonts/JetBrainsMono.ttf") format("truetype"); font-weight: 100 800; font-display: swap; }
:root {
  --cx-text: #131313; --cx-text2: #383835; --cx-text3: #7B7974;
  --cx-raised: #FFFFFF; --cx-page: #F9F9F7; --cx-code-body: #F3F3F0; --cx-code-head: #F0EFEC;
  --cx-bubble: #F0EFEC; --cx-bubble-code-head: #F9F9F7; --cx-bubble-code-body: #FCFCFB;
  --cx-hair-strong: rgba(30, 30, 29, .30); --cx-hair: rgba(30, 30, 29, .15);
  --cx-link: #D97757; --cx-link-pressed: rgba(217, 119, 87, .20); --cx-inline-code: #184F95;
  --cx-press: rgba(11, 11, 11, .05); --cx-status: #52514E; --cx-think: #0B0B0B; --cx-quote: rgba(11, 11, 11, .10);
  --cx-serif: "Claudex Reading Serif", "Claudex Reading Serif CJK", "Songti SC", serif;
  --cx-sans: -apple-system, "PingFang SC", sans-serif;
  --cx-mono: "Claudex Code Mono", ui-monospace, Menlo, "PingFang SC", monospace;
}
:root[data-theme=dark] {
  --cx-text: #F9F9F7; --cx-text2: #C3C2B7; --cx-text3: #97958D;
  --cx-raised: #20201F; --cx-page: #151515; --cx-code-body: #111111; --cx-code-head: #0D0D0D;
  --cx-bubble: #2C2C2A; --cx-bubble-code-head: #0B0B0B; --cx-bubble-code-body: #151515;
  --cx-hair-strong: rgba(225, 224, 217, .30); --cx-hair: rgba(225, 224, 217, .15);
  --cx-inline-code: #6DA7EC; --cx-press: rgba(255, 255, 255, .08); --cx-status: #C3C2B7; --cx-think: #F0EFEC;
  --cx-quote: rgba(255, 255, 255, .10);
}
html, body { background: transparent; -webkit-tap-highlight-color: transparent; }
/* Long press opens the message menu; text is selected through its "Select text" item. */
:root .app.mobile-conversation .messages { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
:root .app.mobile-conversation .messages :is(textarea, input) { -webkit-user-select: text; user-select: text; }

/* List geometry: no list padding, each item pads itself. */
:root .app.mobile-conversation .messages { padding: 12px 0 20px; }
:root .app.mobile-conversation .turn { margin: 0; }
:root .app.mobile-conversation .turn + .turn { margin-top: 16px; }

/* User message bubble. */
:root .app.mobile-conversation .user-message {
  box-sizing: border-box; width: fit-content; max-width: min(652.8px, calc(100% - 52px));
  margin: 0 8px 0 auto; padding: 14px 12px; border-radius: 12px;
  background: var(--cx-bubble) !important; color: var(--cx-text) !important; border: .5px solid var(--cx-hair);
  font: 400 15px/1.4 var(--cx-sans);
}
:root .app.mobile-conversation .user-message:has(.reply-versions) { margin-bottom: 36px; }
:root .app.mobile-conversation .user-message.is-editing { background: transparent; border-color: var(--cx-hair-strong); box-shadow: none; margin-bottom: 40px; }
:root .app.mobile-conversation .user-message-text { font: inherit; color: inherit; }
:root .app.mobile-conversation .user-message-text .prompt-paragraph + .prompt-paragraph { margin-top: 8px; }
:root .app.mobile-conversation .user-message-actions > :not(.reply-versions) { display: none; }
:root .app.mobile-conversation .user-message-actions { color: var(--cx-text3); }
:root .app.mobile-conversation .user-message-text :is(h1, h2, h3, h4, h5, h6) { font: 550 15px/1.4 var(--cx-sans); margin: 0; }

/* Assistant text. Serif is Chat only: Code sessions read in sans. */
:root .app.mobile-conversation .assistant-message { padding: 0 20px; }
:root .app.mobile-conversation .turn > .assistant-message { margin-top: 12px; }
:root .app.mobile-conversation.mode-chat .markdown { font: 400 17px/1.5 var(--cx-serif); color: var(--cx-text); }
:root .app.mobile-conversation .markdown :is(p, li, td, th, blockquote) { font: inherit; }
:root .app.mobile-conversation .markdown > * { margin-top: 0; margin-bottom: 0; }
:root .app.mobile-conversation .markdown > * + * { margin-top: 8px; }
:root .app.mobile-conversation .markdown strong, .app.mobile-conversation .markdown b { font-weight: 550; }
:root .app.mobile-conversation.mode-chat .markdown h1 { font: 550 28px/1.3 var(--cx-serif); }
:root .app.mobile-conversation.mode-chat .markdown h2 { font: 550 24px/1.3 var(--cx-serif); }
:root .app.mobile-conversation.mode-chat .markdown h3 { font: 550 20px/1.3 var(--cx-serif); }
:root .app.mobile-conversation.mode-chat .markdown :is(h4, h5, h6) { font: 550 17px/1.5 var(--cx-serif); }
:root .app.mobile-conversation .markdown :is(h1, h2, h3, h4, h5, h6) { margin-bottom: 0; color: var(--cx-text); }
:root .app.mobile-conversation .markdown :is(ul, ol) { padding-left: 26px; margin-bottom: 0; }
:root .app.mobile-conversation .markdown.markdown li { padding-left: 4px; margin: 0; }
:root .app.mobile-conversation .markdown.markdown li + li { margin-top: 4px; }
:root .app.mobile-conversation .markdown li::marker { color: var(--cx-text); }
:root .app.mobile-conversation .markdown blockquote { margin-left: 0; padding: 0 0 0 12px; border-left: 2px solid var(--cx-quote); color: var(--cx-text2); }
:root .app.mobile-conversation .markdown hr { border: 0; border-top: .5px solid var(--cx-hair-strong); margin: 16px 0; }
/* Inline code: mono, blue, 6.4pt chip with a hairline. */
:root .app.mobile-conversation :is(.markdown, .user-message-text) :not(pre) > code {
  font: 400 15px/1.5 var(--cx-mono); font-size: .88em; color: var(--cx-inline-code) !important;
  background: var(--cx-press) !important; border: .5px solid var(--cx-hair) !important; border-radius: 6.4px; padding: 1px 4px;
}
/* Links: clay, underlined; 20 % clay behind while pressed. */
:root .app.mobile-conversation :is(.markdown, .user-message-text) a {
  color: var(--cx-link) !important; text-decoration: underline; text-decoration-color: currentColor; text-underline-offset: 2px; border-radius: 2px;
}
:root .app.mobile-conversation :is(.markdown, .user-message-text) a:active { background: var(--cx-link-pressed); }

/* Code block. */
:root .app.mobile-conversation .code-block { border: 0; border-radius: 12px; overflow: hidden; background: var(--cx-code-body); }
:root .app.mobile-conversation .code-bar {
  box-sizing: border-box; height: auto; min-height: 40px; padding: 0 16px; background: var(--cx-code-head);
  font: 400 13px/1.5 var(--cx-mono); color: var(--cx-text2); gap: 4px;
}
:root .app.mobile-conversation .code-bar > span:first-child { display: inline-block; text-transform: none; }
:root .app.mobile-conversation .code-bar > span:first-child::first-letter { text-transform: uppercase; }
:root .app.mobile-conversation .code-bar .small-action { color: var(--cx-text2); background: transparent !important; }
:root .app.mobile-conversation .code-bar .small-action.code-open { display: none; }
:root .app.mobile-conversation .code-block pre { margin: 0; padding: 16px; background: var(--cx-code-body); font: 400 15px/1.5 var(--cx-mono); white-space: pre; overflow-x: auto; }
:root .app.mobile-conversation .code-block pre code { font: inherit; }
:root .app.mobile-conversation .user-message .code-bar { background: var(--cx-bubble-code-head); }
:root .app.mobile-conversation .user-message :is(.code-block, .code-block pre) { background: var(--cx-bubble-code-body); }

/* Tables: 30 % hairline, 550 header, cells at most 520pt. */
:root .app.mobile-conversation .markdown-table { overflow-x: auto; }
:root .app.mobile-conversation.mode-chat .markdown-table table { border-collapse: collapse; border: .5px solid var(--cx-hair-strong); font: 400 17px/1.5 var(--cx-serif); }
:root .app.mobile-conversation .markdown-table :is(th, td) { max-width: 520px; padding: 8px 12px; border: .5px solid var(--cx-hair-strong); background: transparent !important; text-align: start; vertical-align: top; }
:root .app.mobile-conversation .markdown-table th { font-weight: 550; }

/* Reply actions: icons only, tertiary, 36pt circles. */
:root .app.mobile-conversation .turn .message-actions { opacity: 1 !important; visibility: visible !important; }
:root .app.mobile-conversation .message-actions { margin: 4px 0 0 0; padding: 0; gap: 0; color: var(--cx-text3); flex-wrap: wrap; align-items: center; }
:root .app.mobile-conversation .message-actions > .reply-time { display: none; }
:root .app.mobile-conversation .message-actions > button, .app.mobile-conversation .message-actions .small-action {
  width: 36px; height: 36px; min-width: 36px; min-height: 36px; padding: 0; border-radius: 50%;
  color: var(--cx-text3); background: transparent; display: inline-grid; place-items: center;
}
:root .app.mobile-conversation .message-actions .small-action:active:not(:disabled) { background: var(--cx-press); }
:root .app.mobile-conversation .message-actions .small-action:disabled { opacity: .38; }
:root .app.mobile-conversation .message-actions svg { width: 20px; height: 20px; }
:root .app.mobile-conversation .copy-tooltip { display: none; }
:root .app.mobile-conversation .reply-versions { color: var(--cx-text3); font: 400 13px/1.4 var(--cx-sans); }

/* Collapsed steps row: one line, tertiary, caret right; the steps open in a native sheet. */
:root .app.mobile-conversation .chat-steps { padding: 0; margin: 12px 0 0; --steps-label: var(--cx-text3); }
:root .app.mobile-conversation .assistant-content > .chat-steps:first-child { margin-top: 0; }
:root .app.mobile-conversation .chat-steps > summary {
  box-sizing: border-box; width: auto; max-width: none; margin: 0; padding: 12px 8px; border-radius: 0;
  display: flex; align-items: center; gap: 4px; min-height: 48px;
  font: 400 15px/1.4 var(--cx-sans); color: var(--cx-text3);
}
:root .app.mobile-conversation .chat-steps > summary > .activity-label-morph { flex: 0 1 auto; }
:root .app.mobile-conversation .chat-steps > summary > svg { display: none; }
:root .app.mobile-conversation .chat-steps > summary::after {
  content: ""; flex: none; width: 16px; height: 16px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M6 3.5 10.5 8 6 12.5' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 16px 16px no-repeat;
}
:root .app.mobile-conversation .chat-steps > summary:active { background: var(--cx-press); }
:root .app.mobile-conversation .chat-steps > summary .lone-step > .chat-step-name { color: var(--cx-text3); }
:root .app.mobile-conversation .chat-steps[open] > .chat-steps-card-wrap { display: none; }
:root .app.mobile-conversation .chat-steps > summary > .clay-mark { position: static; flex: none; }
:root .app.mobile-conversation .chat-steps[data-running] { --steps-indent: 0px; }

/* Live status: thinking verb, 15pt transcript font. Elapsed time is not shown. */
:root .app.mobile-conversation .turn-activity { margin: 12px 0 0; padding: 0; min-height: 28px; gap: 8px; font: 400 15px/1.6 var(--cx-serif); color: var(--cx-think); }
:root .app.mobile-conversation .turn-activity > .clay-mark { position: static; flex: none; width: 20px; height: 20px; }
:root .app.mobile-conversation .assistant-content > .turn-activity:first-child { margin-top: 0; }
:root .app.mobile-conversation .activity-elapsed { display: none; }
/* No plumbing status text on mobile (product rule). */
:root .app.mobile-conversation .turn-reconnecting { display: none; }

/* Notice card (interrupted / failed reply) with a Retry button. */
:root .app.mobile-conversation :is(.turn-interrupted, .turn-error, .turn-connection-card) {
  box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 48px; margin: 12px 0 0; padding: 6px 12px 6px 16px; border-radius: 16px;
  background: var(--cx-page); border: 1px solid var(--cx-hair); box-shadow: none;
  font: 400 15px/1.4 var(--cx-sans); color: var(--cx-text2);
}
:root .app.mobile-conversation :is(.turn-interrupted, .turn-error)::before {
  content: ""; flex: none; width: 20px; height: 20px; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='7.25' fill='none' stroke='black' stroke-width='1.5'/%3E%3Cpath d='M10 9v4.5' stroke='black' stroke-width='1.5' stroke-linecap='round'/%3E%3Ccircle cx='10' cy='6.5' r='.9'/%3E%3C/svg%3E") center / 20px 20px no-repeat;
}
:root .app.mobile-conversation .turn-interrupted { font-size: 0; }
:root .app.mobile-conversation .turn-interrupted > .cx-notice-text { flex: 1; min-width: 0; margin-left: -12px; font: 400 15px/1.4 var(--cx-sans); }
/* The renderer's own text node is a zero-size flex item: pull the notice text back over its gap. */
:root .app.mobile-conversation .turn-error > p { flex: 1; min-width: 0; color: var(--cx-text2); }
:root .app.mobile-conversation .turn-error.is-limit { color: var(--cx-text2); }
:root .app.mobile-conversation :is(.turn-error-action, .cx-notice-retry) {
  flex: none; height: 36px; min-width: 40px; padding: 0 12px; border-radius: 999px; border: .5px solid var(--cx-hair);
  background: transparent; color: var(--cx-text); font: 550 15px/1.4 var(--cx-sans); cursor: pointer;
}
:root .app.mobile-conversation :is(.turn-error-action, .cx-notice-retry):active:not(:disabled) { background: var(--cx-code-head); }
:root .app.mobile-conversation :is(.turn-error-action, .cx-notice-retry):disabled { opacity: .38; }
:root .app.mobile-conversation .turn-connection-notice { margin: 12px 0 0; padding: 0; }

/* Scroll-to-bottom: 40pt circle, raised @96 %, hairline, soft shadow, 16pt arrow. */
:root .app.mobile-conversation .scroll-bottom-dock { bottom: 8px; }
:root .app.mobile-conversation .scroll-bottom-button,
:root[data-theme] .app.mobile-conversation .scroll-bottom-button {
  width: 40px; height: 40px; border-radius: 50%; color: var(--cx-text);
  background: color-mix(in srgb, var(--cx-raised) 96%, transparent); border: .5px solid var(--cx-hair);
  box-shadow: 0 2px 8px rgba(0, 0, 0, .10); transform: translateY(-100%) scale(.01);
  transition: opacity .25s cubic-bezier(.2, 0, 0, 1), transform .3s cubic-bezier(.2, 1, .3, 1), visibility .25s;
}
:root .app.mobile-conversation .scroll-bottom-button[data-visible=true] { transform: translateY(-100%) scale(1); }
:root .app.mobile-conversation .scroll-bottom-button svg { width: 16px; height: 16px; }

/* Compaction divider. */
:root .app.mobile-conversation .compaction-event { font: 400 11px/1.5 var(--cx-sans); color: var(--cx-hair-strong); }
:root .app.mobile-conversation .assistant-content:has(> .turn-interrupted) > .message-actions { display: none; }
"""#

  static let scriptTemplate = #"""
(() => {
  // Runs in an isolated content world: it sees the DOM, never the page's scripts or bridge.
  const strings = __CLAUDEX_STRINGS__;
  const css = __CLAUDEX_CSS__;
  const post = (body) => { try { window.webkit.messageHandlers.claudexTranscriptUI.postMessage(body); } catch (_) {} };
  const style = document.createElement("style");
  style.id = "claudex-official-transcript";
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  const turns = () => Array.from(document.querySelectorAll(".messages > .turn"));
  const promptOf = (turn) => {
    const text = turn && turn.querySelector(":scope > .user-message .user-message-text");
    return text ? text.innerText.slice(0, 20000) : "";
  };
  const where = (node) => {
    const turn = node.closest(".messages > .turn");
    if (!turn) return null;
    return { turn, index: turns().indexOf(turn), prompt: promptOf(turn) };
  };
  const label = (button) => (button.getAttribute("aria-label") || button.getAttribute("title") || "").trim();
  const retryButton = (turn) => Array.from(turn.querySelectorAll(".message-actions > button"))
    .find((b) => ["重试", "Retry", "Retry message", "重试消息"].includes(label(b)));

  // Long press on a message opens the official message menu.
  let press = null;
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  document.addEventListener("touchstart", (event) => {
    cancelPress();
    if (event.touches.length !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest("button, a, textarea, input, summary, .code-block, .markdown-table, .is-editing")) return;
    const bubble = target.closest(".user-message, .assistant-message");
    if (!bubble) return;
    const touch = event.touches[0];
    press = { x: touch.clientX, y: touch.clientY, timer: setTimeout(() => {
      const place = where(bubble);
      press = null;
      if (!place || place.index < 0) return;
      const role = bubble.classList.contains("user-message") ? "user" : "assistant";
      const rect = bubble.getBoundingClientRect();
      if (navigator.vibrate) navigator.vibrate(10);
      post({ type: "messageMenu", role, index: place.index, prompt: place.prompt,
        x: touch.clientX, y: touch.clientY, top: rect.top, bottom: rect.bottom,
        retry: role === "assistant" && !!(retryButton(place.turn) && !retryButton(place.turn).disabled),
        edit: role === "user" && !!place.turn.querySelector(".user-message-actions button:not(:disabled)[aria-label='Edit'], .user-message-actions button:not(:disabled)[aria-label='编辑']") });
    }, 450) };
  }, { passive: true, capture: true });
  document.addEventListener("touchmove", (event) => {
    if (!press) return;
    const touch = event.touches[0];
    if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) cancelPress();
  }, { passive: true, capture: true });
  for (const name of ["touchend", "touchcancel", "scroll"]) document.addEventListener(name, cancelPress, { passive: true, capture: true });
  document.addEventListener("contextmenu", (event) => {
    if (event.target instanceof Element && event.target.closest(".messages")) event.preventDefault();
  }, true);

  // The collapsed steps row opens the native steps sheet instead of expanding inline.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const summary = target && target.closest(".chat-steps > summary");
    if (summary) {
      event.preventDefault(); event.stopPropagation();
      const place = where(summary);
      if (place && place.index >= 0) post({ type: "steps", index: place.index, prompt: place.prompt });
      return;
    }
    const share = target && target.closest(".cx-share");
    if (share) {
      const place = where(share);
      if (place && place.index >= 0) post({ type: "share", index: place.index, prompt: place.prompt });
      return;
    }
    const retry = target && target.closest(".cx-notice-retry");
    if (retry) {
      const place = where(retry);
      const button = place && retryButton(place.turn);
      if (button && !button.disabled) button.click();
    }
  }, true);

  const shareIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>';
  // Decorations the shared renderer does not draw: Share in the reply row (Copy → Share → …)
  // and the official notice text + Retry on an interrupted reply.
  const decorate = () => {
    for (const row of document.querySelectorAll(".turn .message-actions")) {
      if (row.querySelector(".cx-share") || !row.querySelector("button")) continue;
      const turn = row.closest(".turn");
      if (!turn || !turn.querySelector(".assistant-content .markdown")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "small-action icon-only cx-share";
      button.setAttribute("aria-label", strings.share);
      button.innerHTML = shareIcon;
      // The renderer's first button is its screen-reader "Show message actions": Share follows Copy.
      const first = row.querySelector("button.small-action") || row.querySelector("button");
      first.after(button);
    }
    for (const notice of document.querySelectorAll(".turn-interrupted")) {
      if (notice.querySelector(".cx-notice-text")) {
        const button = notice.querySelector(".cx-notice-retry");
        const target = retryButton(notice.closest(".turn"));
        if (button) button.disabled = !target || target.disabled;
        continue;
      }
      const text = document.createElement("span");
      text.className = "cx-notice-text";
      text.textContent = strings.incomplete;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cx-notice-retry";
      button.textContent = strings.retry;
      const target = retryButton(notice.closest(".turn"));
      button.disabled = !target || target.disabled;
      notice.append(text, button);
    }
  };
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; decorate(); });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
})();
"""#
}
