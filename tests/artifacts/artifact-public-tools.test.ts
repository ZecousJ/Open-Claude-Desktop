import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

const source = fs.readFileSync(
  new URL(
    "../../backend/backend/internal/claudex/sharing/viewer/templates/tools.js",
    import.meta.url,
  ),
  "utf8",
);

class Element {
  children: Element[] = [];
  textContent = "";
  className = "";
  disabled = false;
  open = false;
  attributes: Record<string, string> = {};
  listeners: Record<string, (...args: any[]) => any> = {};
  parent?: Element;
  constructor(readonly tag: string) {}
  append(...items: Element[]) {
    for (const item of items) {
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(name: string, listener: (...args: any[]) => any) {
    this.listeners[name] = listener;
  }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  showModal() {
    this.open = true;
  }
  focus() {}
  close() {
    this.open = false;
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
  }
}

function page(options: { signedOut?: boolean; locale?: string } = {}) {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const posted: any[] = [];
  const requests: { method: string; args: any[]; headers: Headers }[] = [];
  const target = { postMessage: (value: unknown) => posted.push(value) };
  const dialog = new Element("dialog");
  const permissions = new Element("button");
  const elements: Record<string, unknown> = {
    ".full-frame": { contentWindow: target },
    "[data-artifact-tools]": dialog,
    "[data-artifact-permissions]": permissions,
    "[data-install-messages]": {
      textContent: fs.readFileSync(
        new URL(
          "../../backend/backend/internal/claudex/sharing/viewer/templates/install-messages.json",
          import.meta.url,
        ),
        "utf8",
      ),
    },
  };
  let granted = false;
  const context = vm.createContext({
    document: {
      querySelector: (selector: string) => elements[selector],
      createElement: (tag: string) => new Element(tag),
      addEventListener() {},
    },
    navigator: {
      languages: [options.locale ?? "en-US"],
      language: options.locale ?? "en-US",
    },
    location: { pathname: "/s/PublicToken" },
    crypto: { randomUUID },
    AbortController,
    setTimeout: (callback: () => void) => {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
    sessionStorage: { getItem: () => "42" },
    localStorage: { getItem: () => null },
    addEventListener: (name: string, listener: any) => {
      handlers[name] = listener;
    },
    fetch: async (url: string, init: RequestInit) => {
      const method = url.split("/").at(-1)!;
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      if (method === "refresh") {
        assert.equal(body.account, "42");
        if (options.signedOut) return Response.json({}, { status: 401 });
        return Response.json({
          data: { access_token: "host-only-token", expires_in: 3600 },
        });
      }
      requests.push({ method, args: body.args, headers });
      let value: unknown;
      if (method === "artifactTools")
        value = [{ server: "search", tools: [{ name: "lookup" }] }];
      if (method === "requestArtifactTool")
        value = {
          ...body.args[1],
          id: "single-use-request",
          permitted: granted,
          groups: [{ server: "search", tools: ["lookup"] }],
        };
      if (method === "respondArtifactTool") {
        if (!body.args[1]) return Response.json({ ok: false });
        granted = true;
        value = { content: [{ type: "text", text: "tool result" }] };
      }
      if (method === "artifactToolPermissions")
        value = granted ? [{ server: "search", tools: ["lookup"] }] : [];
      if (method === "revokeArtifactTools") {
        granted = false;
        value = null;
      }
      return Response.json({ ok: true, value });
    },
  });
  vm.runInContext(source, context);
  const message = (
    id: number,
    method: string,
    args: unknown[],
    sender = target,
  ) =>
    handlers.message({
      source: sender,
      data: { type: "claudex-artifact-tool", id, method, args },
    });
  return { handlers, dialog, permissions, requests, posted, message };
}

test("public artifact connector calls require host approval, isolate credentials and scope saved grants to the page", async () => {
  const host = page();
  await host.message(1, "listTools", [], {} as any);
  assert.equal(host.requests.length, 0);
  await host.message(2, "listTools", []);
  assert.equal(host.posted[0].result.servers[0].tools[0].name, "lookup");
  await host.message(3, "callTool", [
    "search",
    "lookup",
    { query: "private\u202Evalue" },
  ]);
  assert.equal(host.dialog.open, true);
  assert.ok(
    !host.requests.some((request) => request.method === "respondArtifactTool"),
  );
  assert.match(host.dialog.querySelectorAll("dd")[0].textContent, /\\u202E/);
  assert.match(
    host.dialog.querySelectorAll("h2")[0].textContent,
    /Let this artifact run these 1 tool/,
  );
  const allow = host.dialog
    .querySelectorAll("button")
    .find((button) => button.textContent === "Allow")!;
  await allow.listeners.click();
  assert.equal(host.dialog.open, false);
  assert.equal(host.posted.at(-1).result.content[0].text, "tool result");
  const request = host.requests.find(
    (entry) => entry.method === "requestArtifactTool",
  )!;
  assert.equal(request.args[0], "published:/s/PublicToken");
  assert.equal(request.headers.get("Authorization"), "Bearer host-only-token");
  assert.ok(!JSON.stringify(host.posted).includes("host-only-token"));
  await host.message(4, "callTool", ["search", "lookup", {}]);
  assert.equal(host.dialog.open, false);
  await host.permissions.listeners.click();
  const remove = host.dialog
    .querySelectorAll("button")
    .find((button) => button.textContent === "Remove")!;
  await remove.listeners.click();
  assert.ok(
    host.requests.some(
      (request) =>
        request.method === "revokeArtifactTools" &&
        request.args[0] === "published:/s/PublicToken",
    ),
  );
  await host.dialog
    .querySelectorAll("button")
    .find((button) => button.textContent === "Done")!
    .listeners.click();
  await host.message(5, "callTool", ["search", "lookup", {}]);
  assert.equal(host.dialog.open, true);
  await host.dialog
    .querySelectorAll("button")
    .find((button) => button.textContent === "Cancel")!
    .listeners.click();
  assert.equal(host.posted.at(-1).error, "The request failed.");
});

test("the public artifact shim accepts responses only from its parent", async () => {
  const shim = fs.readFileSync(
    new URL(
      "../../backend/backend/internal/claudex/sharing/viewer/templates/tool-api.js",
      import.meta.url,
    ),
    "utf8",
  );
  let listener: (event: any) => void = () => {};
  let message: any;
  const parent = {
    postMessage: (value: unknown) => {
      message = value;
    },
  };
  const window: any = {};
  vm.runInNewContext(shim, {
    window,
    parent,
    addEventListener: (_name: string, handler: any) => {
      listener = handler;
    },
    setTimeout: () => 1,
    clearTimeout() {},
  });
  const result = window.mcp.callTool("search", "lookup", { query: "value" });
  listener({
    source: {},
    data: {
      type: "claudex-artifact-tool-result",
      id: message.id,
      result: "untrusted",
    },
  });
  listener({
    source: parent,
    data: {
      type: "claudex-artifact-tool-result",
      id: message.id,
      result: "trusted",
    },
  });
  assert.equal(await result, "trusted");
  assert.equal(window.claude.mcp, window.mcp);
});

test("signed-out public artifact users can sign in without exposing tokens or disabling tools", async () => {
  const host = page({ signedOut: true });
  await host.message(1, "callTool", ["search", "lookup", {}]);
  assert.equal(host.dialog.open, true);
  assert.equal(
    host.dialog.querySelectorAll("h2")[0].textContent,
    "This artifact uses connectors",
  );
  assert.equal(host.dialog.querySelectorAll("a")[0].textContent, "Sign in");
  assert.equal(host.posted[0].error, "The request failed.");
});

test("public artifact permission controls use the same locale translations as the app", async () => {
  const host = page({ locale: "de-DE" });
  assert.equal(host.permissions.textContent, "Berechtigungen");
  await host.message(1, "callTool", ["search", "lookup", {}]);
  assert.ok(
    host.dialog
      .querySelectorAll("button")
      .some((button) => button.textContent === "Abbrechen"),
  );
  assert.ok(
    !host.dialog
      .querySelectorAll("button")
      .some((button) => button.textContent === "Close"),
  );
});
