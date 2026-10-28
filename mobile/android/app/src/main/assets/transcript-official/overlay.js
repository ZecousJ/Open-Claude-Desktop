/*
 * Official chat-screen behaviour over the shared conversation renderer (chat-transcript.md):
 * the Share button in the reply action row, the notice card with Retry for an unfinished reply
 * and the message long-press menu. The renderer bundle is pinned and never edited;
 * every action here presses the renderer's own button, so all mutations keep its native checks.
 * The native shell runs this once per document with window.__oxOfficialConfig = { css, strings }.
 */
(function () {
  "use strict";
  var config = window.__oxOfficialConfig;
  if (!config || window.__oxOfficialInstalled) return;
  window.__oxOfficialInstalled = true;
  var S = config.strings || {};
  var root = document.documentElement;
  root.classList.add("ox");
  root.style.setProperty("--ox-s-summary", JSON.stringify(S.summary || ""));
  var style = document.createElement("style");
  style.id = "ox-official";
  style.textContent = config.css || "";
  document.head.appendChild(style);

  var NS = "http://www.w3.org/2000/svg";
  // Outline glyphs in the transcript's 20 px icon box (the renderer's own glyphs are reused where it has one).
  var PATHS = {
    share: "M10 2.5v10M6.5 6 10 2.5 13.5 6M5 9.5H4.5A1.5 1.5 0 0 0 3 11v5a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 16v-5a1.5 1.5 0 0 0-1.5-1.5H15",
    select: "M7 3.5h6M7 16.5h6M10 3.5v13M3.5 6.5v7M16.5 6.5v7",
    info: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM10 9v4.5M10 6.6v.1"
  };
  function glyph(name) {
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("fill", "none"); svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(NS, "path");
    path.setAttribute("d", PATHS[name]); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }
  function copyGlyph(button) {
    var svg = button && button.querySelector("svg");
    if (!svg) return null;
    var clone = svg.cloneNode(true); clone.removeAttribute("class"); clone.setAttribute("aria-hidden", "true");
    return clone;
  }
  function post(message) {
    var bridge = window.claudexConversation;
    if (bridge && bridge.postMessage) bridge.postMessage(JSON.stringify(message));
  }
  function label(button) { return (button && (button.getAttribute("aria-label") || "")).trim(); }
  function findButton(container, names) {
    if (!container) return null;
    var buttons = container.querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) if (names.indexOf(label(buttons[i])) >= 0) return buttons[i];
    return null;
  }
  var COPY = ["复制", "Copy", "复制消息", "Copy message"], RETRY = ["重试", "Retry", "Retry message", "重试消息"], EDIT = ["编辑", "Edit"];
  function replyText(content) {
    var parts = [];
    var blocks = content ? content.querySelectorAll(":scope > .markdown") : [];
    for (var i = 0; i < blocks.length; i++) parts.push(blocks[i].innerText.trim());
    return parts.filter(Boolean).join("\n\n");
  }

  // Share after Copy.
  function decorateActions(actions) {
    if (actions.querySelector(".ox-share")) return;
    var content = actions.closest(".assistant-content");
    var copy = findButton(actions, COPY) || actions.querySelector("button.small-action");
    if (!copy || !content) return;
    var share = document.createElement("button");
    share.type = "button";
    share.className = "small-action icon-only ox-share";
    share.setAttribute("aria-label", S.share || "Share");
    share.appendChild(glyph("share"));
    share.addEventListener("click", function (event) {
      event.stopPropagation();
      var text = replyText(content);
      if (text) post({ version: 1, type: "nativeShare", text: text.slice(0, 100000) });
    });
    copy.insertAdjacentElement("afterend", share);
  }

  // An unfinished reply becomes the notice card with a Retry button that presses the reply's Retry.
  function decorateNotice(note) {
    if (note.classList.contains("ox-notice")) return;
    var content = note.closest(".assistant-content");
    var text = document.createElement("span");
    text.className = "ox-notice-text";
    while (note.firstChild) text.appendChild(note.firstChild);
    note.classList.add("ox-notice");
    note.appendChild(glyph("info"));
    note.appendChild(text);
    var retry = content && findButton(content.querySelector(":scope > .message-actions"), RETRY);
    if (retry) {
      var action = document.createElement("button");
      action.type = "button"; action.className = "ox-secondary"; action.textContent = S.retry || "Retry";
      action.disabled = retry.disabled;
      action.addEventListener("click", function (event) { event.stopPropagation(); var current = findButton(content.querySelector(":scope > .message-actions"), RETRY); if (current && !current.disabled) current.click(); });
      note.appendChild(action);
    }
    if (content && !content.querySelector(":scope > .markdown")) content.classList.add("ox-failed-only");
  }

  var scheduled = false;
  function decorate() {
    scheduled = false;
    report();
    var actions = document.querySelectorAll(".mode-chat .assistant-content > .message-actions");
    for (var i = 0; i < actions.length; i++) decorateActions(actions[i]);
    var notes = document.querySelectorAll(".mode-chat .assistant-content > .turn-interrupted");
    for (var j = 0; j < notes.length; j++) decorateNotice(notes[j]);
    var retries = document.querySelectorAll(".ox-notice > .ox-secondary");
    for (var k = 0; k < retries.length; k++) {
      var content = retries[k].closest(".assistant-content");
      var current = content && findButton(content.querySelector(":scope > .message-actions"), RETRY);
      retries[k].disabled = !current || current.disabled;
    }
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(decorate); } }
  new MutationObserver(schedule).observe(document.getElementById("root") || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
  schedule();

  // Long-press menu: Copy message · Select text · Edit (your messages) · Retry message (replies).
  var layer = null, selecting = false, reported = false;
  // Tell the shell when a sheet or menu is open so the system Back closes it first.
  function report() {
    var open = !!layer || !!document.querySelector(".mode-chat .chat-steps[open], .official-sheet-layer[data-open-sheet]");
    if (open !== reported) { reported = open; post({ version: 1, type: "nativeOverlay", open: open }); }
  }
  window.__oxCloseOverlay = function () {
    if (layer) closeMenu();
    // The renderer's own steps/sources sheet goes back one page per Back.
    else if (document.querySelector(".official-sheet-layer[data-open-sheet]")) document.dispatchEvent(new CustomEvent("claudex-close-sheet", { cancelable: true }));
    var steps = document.querySelectorAll(".mode-chat .chat-steps[open]");
    for (var i = 0; i < steps.length; i++) steps[i].open = false;
    report();
  };
  document.addEventListener("toggle", report, true);
  function closeMenu() { if (layer) { layer.remove(); layer = null; } report(); }
  function selectText(element) {
    selecting = true;
    root.classList.add("ox-selecting");
    var range = document.createRange(); range.selectNodeContents(element);
    var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  document.addEventListener("selectionchange", function () {
    if (selecting && window.getSelection().isCollapsed) { selecting = false; root.classList.remove("ox-selecting"); }
  });
  function menuItems(target) {
    var user = target.closest(".user-message");
    var items = [];
    if (user) {
      var actions = user.querySelector(".user-message-actions");
      var copy = findButton(actions, COPY), edit = findButton(actions, EDIT);
      var text = user.querySelector(".user-message-text");
      if (copy) items.push([S.copyMessage, copyGlyph(copy), function () { copy.click(); }]);
      if (text) items.push([S.selectText, glyph("select"), function () { selectText(text); }]);
      if (edit && !edit.disabled) items.push([S.edit, copyGlyph(edit), function () { edit.click(); }]);
      return items;
    }
    var content = target.closest(".assistant-content");
    if (!content) return items;
    var bar = content.querySelector(":scope > .message-actions");
    var copyReply = findButton(bar, COPY), retry = findButton(bar, RETRY);
    var body = target.closest(".markdown") || content.querySelector(":scope > .markdown");
    if (copyReply) items.push([S.copyMessage, copyGlyph(copyReply), function () { copyReply.click(); }]);
    if (body) items.push([S.selectText, glyph("select"), function () { selectText(body); }]);
    if (retry && !retry.disabled) items.push([S.retryMessage, copyGlyph(retry), function () { retry.click(); }]);
    return items;
  }
  function openMenu(target, x, y) {
    var items = menuItems(target);
    if (!items.length) return false;
    closeMenu();
    layer = document.createElement("div");
    layer.className = "ox-menu-layer";
    layer.addEventListener("click", closeMenu);
    var menu = document.createElement("div");
    menu.className = "ox-menu"; menu.setAttribute("role", "menu");
    menu.addEventListener("click", function (event) { event.stopPropagation(); });
    items.forEach(function (item) {
      var button = document.createElement("button");
      button.type = "button"; button.setAttribute("role", "menuitem");
      if (item[1]) button.appendChild(item[1]);
      var span = document.createElement("span"); span.textContent = item[0] || ""; button.appendChild(span);
      button.addEventListener("click", function () { closeMenu(); item[2](); });
      menu.appendChild(button);
    });
    layer.appendChild(menu);
    (document.querySelector(".app") || document.body).appendChild(layer);
    var rect = menu.getBoundingClientRect();
    var left = Math.min(Math.max(16, x), window.innerWidth - rect.width - 16);
    var top = y + 8;
    if (top + rect.height > window.innerHeight - 16) top = Math.max(16, y - rect.height - 8);
    menu.style.left = left + "px"; menu.style.top = top + "px";
    // The platform's own long-press selection must not start under the menu.
    var clear = function () { var s = window.getSelection(); if (s && !selecting) s.removeAllRanges(); };
    clear(); setTimeout(clear, 50); setTimeout(clear, 300);
    if (navigator.vibrate) try { navigator.vibrate(10); } catch (e) { /* no haptics */ }
    report();
    return true;
  }
  function messageTarget(node) {
    if (!(node instanceof Element) || node.closest("button, a, summary, input, textarea, .ox-menu, .code-bar")) return null;
    return node.closest(".mode-chat .user-message, .mode-chat .assistant-content > .markdown");
  }
  var press = null;
  document.addEventListener("touchstart", function (event) {
    if (selecting || event.touches.length !== 1) return;
    var target = messageTarget(event.target);
    if (!target) return;
    var touch = event.touches[0];
    press = { target: target, x: touch.clientX, y: touch.clientY, fired: false };
    press.timer = setTimeout(function () { if (press) press.fired = openMenu(press.target, press.x, press.y); }, 450);
  }, { passive: true });
  document.addEventListener("touchmove", function (event) {
    if (!press) return;
    var touch = event.touches[0];
    if (Math.abs(touch.clientX - press.x) > 10 || Math.abs(touch.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; }
  }, { passive: true });
  document.addEventListener("touchend", function (event) {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.fired) event.preventDefault();
    press = null;
  });
  document.addEventListener("contextmenu", function (event) {
    if (selecting) return;
    var target = messageTarget(event.target);
    if (!target) return;
    event.preventDefault();
    if (press && press.fired) return;
    if (press) { clearTimeout(press.timer); press.fired = true; }
    openMenu(target, event.clientX, event.clientY);
  });
  document.addEventListener("scroll", closeMenu, true);
})();
