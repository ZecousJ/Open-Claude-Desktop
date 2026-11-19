const nativeHost = "cn.zecous.claudex";
let selected;

function badge(tabId, text) {
  void chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

function release(selection, indicator = "") {
  if (selected !== selection) return;
  selected = undefined;
  selection.port?.disconnect();
  badge(selection.tabId, indicator);
}

function operationInDocument(command, expectedOrigin) {
  if (location.origin !== expectedOrigin)
    throw Error("The shared page has changed.");

  const visible = (element) => {
    const bounds = element.getBoundingClientRect();
    return (
      bounds.width > 0 &&
      bounds.height > 0 &&
      getComputedStyle(element).visibility === "visible" &&
      !element.closest("[inert]") &&
      !element.matches(":disabled, [aria-disabled=true]")
    );
  };
  const canFill = (element) =>
    (element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement &&
        ["text", "email", "url", "search", "tel", "number"].includes(
          element.type,
        ))) &&
    !element.readOnly;
  const label = (element) =>
    (
      element.getAttribute("aria-label") ||
      element.labels?.[0]?.textContent ||
      element.textContent ||
      element.getAttribute("placeholder") ||
      ""
    )
      .trim()
      .slice(0, 200);

  if (command.operation === "inspect") {
    const controls = Array.from(
      document.querySelectorAll(
        "a[href], button, input, textarea, [role=button]",
      ),
    )
      .filter(
        (element) =>
          visible(element) &&
          !element.matches(
            "input[type=password], input[type=file], input[type=hidden]",
          ),
      )
      .slice(0, 128);
    const revision = Array.from(
      crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    globalThis.claudexChromeSnapshot = { revision, controls };
    return {
      revision,
      url: document.URL,
      title: document.title.slice(0, 512),
      text: (document.body?.innerText ?? "").slice(0, 12_000),
      controls: controls.map((element, index) => ({
        index,
        label: label(element),
        type: canFill(element) ? "input" : element.localName,
      })),
    };
  }

  if (command.operation === "scroll") {
    scrollBy(0, command.pixels);
    return { scrollY };
  }

  const snapshot = globalThis.claudexChromeSnapshot;
  const element =
    snapshot?.revision === command.revision
      ? snapshot.controls[command.index]
      : undefined;
  if (!element?.isConnected || !visible(element))
    throw Error("Inspect the shared page again before acting on this control.");

  if (command.operation === "click") {
    if (
      element.matches(
        "input[type=password], input[type=file], input[type=hidden]",
      )
    )
      throw Error("This control cannot be clicked.");
    element.click();
  } else {
    if (!canFill(element)) throw Error("This field cannot receive text.");
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(
      element,
      command.text,
    );
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { applied: true };
}

function validOperation(value) {
  if (
    value?.type !== "request" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 64
  )
    return false;
  if (value.operation === "inspect") return true;
  if (value.operation === "scroll")
    return Number.isInteger(value.pixels) && Math.abs(value.pixels) <= 2000;
  if (value.operation !== "click" && value.operation !== "fill") return false;
  return (
    typeof value.revision === "string" &&
    /^[a-f0-9]{32}$/.test(value.revision) &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    value.index < 128 &&
    (value.operation === "click" ||
      (typeof value.text === "string" && value.text.length <= 4000))
  );
}

async function run(selection, documentId, message) {
  if (selected !== selection || !validOperation(message)) return;
  if (selection.busy) {
    selection.port.postMessage({
      type: "reply",
      id: message.id,
      error: "Another browser action is running.",
    });
    return;
  }
  selection.busy = true;
  try {
    const [response] = await chrome.scripting.executeScript({
      target: { tabId: selection.tabId, documentIds: [documentId] },
      func: operationInDocument,
      args: [message, selection.origin],
    });
    if (selected !== selection) return;
    if (response?.documentId !== documentId)
      throw Error("The shared page is no longer available.");
    selection.port.postMessage({
      type: "reply",
      id: message.id,
      value: response.result,
    });
  } catch {
    if (selected === selection)
      selection.port.postMessage({
        type: "reply",
        id: message.id,
        error:
          "The action could not run on this page. Inspect the currently shared page and try again.",
      });
  } finally {
    selection.busy = false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const previous = selected;
  if (previous) release(previous);
  if (
    previous?.tabId === tab.id ||
    tab.incognito ||
    tab.id === undefined ||
    !/^https?:\/\//.test(tab.url ?? "")
  )
    return;

  const selection = {
    tabId: tab.id,
    origin: new URL(tab.url).origin,
    busy: false,
  };
  selected = selection;
  try {
    const [document] = await chrome.scripting.executeScript({
      target: { tabId: selection.tabId },
      func: () => ({
        origin: location.origin,
        title: globalThis.document.title.slice(0, 512),
      }),
    });
    if (selected !== selection) return;
    if (!document?.documentId || document.result?.origin !== selection.origin)
      throw Error("The shared page changed.");
    const port = chrome.runtime.connectNative(nativeHost);
    selection.port = port;
    port.onDisconnect.addListener(() => {
      const disconnected = chrome.runtime.lastError;
      release(selection, disconnected ? "!" : "");
    });
    port.onMessage.addListener((message) => {
      if (selected !== selection) return;
      if (message?.type === "ready") badge(selection.tabId, "ON");
      else void run(selection, document.documentId, message);
    });
    port.postMessage({
      type: "shared",
      version: 1,
      origin: selection.origin,
      title: document.result.title,
    });
  } catch {
    release(selection, "!");
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (selected?.tabId === tabId) release(selected);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (selected?.tabId === tabId && (change.status === "loading" || change.url))
    release(selected);
});
