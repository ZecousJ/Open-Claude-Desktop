// Injected into the official page by harness.mjs (window.__e2e). Plain browser JavaScript.
window.__e2e = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const all = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const byLabel = (label, scope = document) =>
    all("[aria-label]", scope).filter((el) => el.getAttribute("aria-label") === label && visible(el));
  const byText = (text, selector = "button, [role=menuitem], [role=tab], a", scope = document) =>
    all(selector, scope).filter((el) => el.innerText.trim() === text && visible(el));
  async function waitFor(fn, timeout = 15000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = fn();
      if (value) return value;
      await sleep(200);
    }
    throw new Error("waitFor timed out: " + fn.toString().slice(0, 160));
  }
  function press(el) {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    el.click();
  }
  async function clickLabel(label, { last = false } = {}) {
    const found = await waitFor(() => { const list = byLabel(label); return list.length ? list : null; });
    press(last ? found[found.length - 1] : found[0]);
  }
  async function clickText(text, selector) {
    const el = await waitFor(() => byText(text, selector)[0]);
    press(el);
  }
  /** A menu item by its label (items carry their shortcut letter after it). */
  async function clickMenu(label) {
    const item = await waitFor(() => all("[role=menuitem]").find((m) => visible(m) && m.textContent.replace(/[\uE000-\uF8FF]/g, "").trim().replace(/[A-Z]$/, "") === label));
    item.click();
  }
  async function closeMenus() {
    for (let i = 0; i < 3 && all("[role=menu]").some(visible); i++) {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(300);
    }
  }
  /** Presses a menu button until its menu shows (a page that just loaded may miss the first press). */
  async function openMenu(find) {
    await closeMenus();
    for (let attempt = 0; attempt < 4; attempt++) {
      const button = await waitFor(find);
      press(button);
      const until = Date.now() + 1500;
      while (Date.now() < until) {
        if (all("[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]").some(visible)) { await sleep(200); return; }
        await sleep(100);
      }
    }
    throw new Error("The menu did not open");
  }
  /** Opens the menu of the button with this accessible label. */
  const menuOf = (label) => openMenu(() => byLabel(label)[0]);
  /** Opens the transcript header's conversation menu. */
  const conversationMenu = () => openMenu(() => [...document.querySelectorAll('main button[aria-label^="More options for"]')].find(visible));
  /** Chat (the "Claudex" side of the Mode switch) rather than Code. */
  async function chatMode() {
    const radio = document.querySelector('[role=radio][aria-label=Claudex]');
    if (radio && radio.getAttribute("aria-checked") !== "true") { press(radio); await sleep(1500); }
  }
  async function type(text) {
    const editor = await waitFor(() => all("[contenteditable=true]").find(visible));
    editor.focus();
    document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
    await sleep(300);
  }
  async function send() {
    const button = await waitFor(() => byLabel("Send message").find((b) => !b.disabled));
    button.click();
  }
  async function attach(name, type, content) {
    const input = await waitFor(() => document.querySelector("input[type=file][data-testid=file-upload]"));
    const dt = new DataTransfer();
    dt.items.add(new File([content], name, { type }));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  async function pngOf(color, width = 64, height = 48) {
    const c = document.createElement("canvas"); c.width = width; c.height = height;
    const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, width, height);
    return await new Promise((r) => c.toBlob(r, "image/png"));
  }
  const mainText = () => (document.querySelector("main") ?? document.body)?.innerText ?? "";
  /** The text of the last "Claudex responded" message. */
  function lastReply() {
    const t = mainText();
    const i = t.lastIndexOf("Claudex responded:");
    return i < 0 ? "" : t.slice(i + "Claudex responded:".length).split("\n")[0].trim();
  }
  const finished = () => /Claudex finished the response/.test(mainText()) || (!/Claudex is responding/.test(mainText()) && !all("button[aria-label]").some((b) => visible(b) && /^Stop .*response$/i.test(b.getAttribute("aria-label"))));
  const conversationId = () => (/\/chat\/([0-9a-f-]{36})/.exec(location.pathname) || [])[1] ?? null;
  const dialogText = () => all("[role=dialog]").filter(visible).map((d) => d.innerText).join("\n");
  return { clickMenu, closeMenus, conversationMenu, openMenu, menuOf, sleep, waitFor, visible, all, byLabel, byText, press, clickLabel, clickText, chatMode, type, send, attach, pngOf, mainText, lastReply, finished, conversationId, dialogText };
})();
