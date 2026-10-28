import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type {
  OfficeConnectedFile,
  OfficeConversationSummary,
  OfficeHandoff,
} from "../../shared/office-addin-api";

// Connected-file state and expiring, document-bound handoffs follow desktop
// Transport stays local to this account.
export class OfficeAddinBridge {
  private files = new Map<string, OfficeConnectedFile>();
  private commands = new Map<string, unknown[]>();
  private handoffs = new Map<
    string,
    { input: OfficeHandoff; expiresAt: number }
  >();
  private summary: OfficeConversationSummary | null = null;
  private selections = new Map<
    string,
    { documentId: string; finish(text?: string): void }
  >();
  private token = randomBytes(32).toString("hex");
  private server?: http.Server;
  private origin = "";
  private sweep?: NodeJS.Timeout;

  constructor(
    private changed: (files: OfficeConnectedFile[]) => void,
    private options: {
      key?: string;
      cert?: string;
      port?: number;
      token?: string;
    } = {},
  ) {
    if (options.token) this.token = options.token;
  }

  connectedFiles() {
    return [...this.files.values()].map((file) => ({ ...file }));
  }

  async selection(
    documentId: string,
    input: { text?: string; expectedText?: string },
    signal: AbortSignal,
  ) {
    const file = this.files.get(documentId);
    if (
      !file?.isSelected ||
      file.status === "disconnected" ||
      this.selections.size >= 16 ||
      signal.aborted ||
      (input.text !== undefined &&
        (typeof input.expectedText !== "string" ||
          input.text.length > 12000 ||
          input.expectedText.length > 12000))
    )
      throw new Error("The request failed.");
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const finish = (text?: string) => {
        if (!this.selections.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.commands.set(
          documentId,
          (this.commands.get(documentId) ?? []).filter(
            (entry) =>
              (entry as { requestId?: string }).requestId !== requestId,
          ),
        );
        if (text === undefined) reject(new Error("The request failed."));
        else resolve(text);
      };
      const abort = () => finish();
      const timer = setTimeout(abort, 30000);
      this.selections.set(requestId, { documentId, finish });
      signal.addEventListener("abort", abort, { once: true });
      this.enqueue(documentId, {
        type: "selection",
        requestId,
        ...input,
        expiresAt: Date.now() + 30000,
      });
    });
  }

  completeSelection(documentId: string, requestId: string, text?: unknown) {
    const pending = this.selections.get(requestId);
    if (!pending || pending.documentId !== documentId) return false;
    const file = this.files.get(documentId);
    pending.finish(
      file?.isSelected && typeof text === "string" && text.length <= 12000
        ? text
        : undefined,
    );
    return true;
  }

  select(id: string) {
    const target = this.files.get(id);
    if (!target || target.status === "disconnected") return false;
    for (const file of this.files.values())
      if (file.app === target.app) file.isSelected = file.id === id;
    this.changed(this.connectedFiles());
    return true;
  }

  focus(id: string) {
    if (!this.select(id)) return false;
    this.enqueue(id, { type: "focus" });
    return true;
  }

  updateSummary(summary: OfficeConversationSummary | null) {
    this.summary = summary;
    for (const file of this.files.values())
      if (file.isSelected) this.enqueue(file.id, { type: "summary", summary });
  }

  queue(input: OfficeHandoff) {
    if (this.handoffs.size >= 16) return { queued: false };
    const handoffId = randomUUID();
    this.handoffs.set(handoffId, { input, expiresAt: Date.now() + 120_000 });
    this.deliver();
    return { queued: true, handoffId };
  }

  cancel(handoffId: string) {
    this.handoffs.delete(handoffId);
    for (const [id, commands] of this.commands)
      this.commands.set(
        id,
        commands.filter(
          (command) =>
            (command as { handoffId?: string }).handoffId !== handoffId,
        ),
      );
  }

  private enqueue(id: string, command: unknown) {
    const queue = this.commands.get(id) ?? [];
    if (queue.length >= 32) queue.shift();
    queue.push(command);
    this.commands.set(id, queue);
  }

  private deliver() {
    for (const [id, handoff] of this.handoffs) {
      if (handoff.expiresAt <= Date.now()) {
        this.handoffs.delete(id);
        continue;
      }
      const file = [...this.files.values()].find(
        (file) =>
          file.document === path.basename(handoff.input.filePath) &&
          file.status !== "disconnected",
      );
      if (!file) continue;
      this.enqueue(file.id, {
        type: "handoff",
        handoffId: id,
        title: handoff.input.title,
        messages: handoff.input.messages,
        expiresAt: handoff.expiresAt,
      });
      this.handoffs.delete(id);
    }
  }

  async start() {
    if (this.server) return this.origin;
    const listener: http.RequestListener = async (request, response) => {
      const expectedHost = new URL(this.origin).host;
      if (
        request.headers.host !== expectedHost ||
        (request.headers.origin && request.headers.origin !== this.origin)
      ) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method === "GET" && request.url === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self' https://appsforoffice.microsoft.com; connect-src 'self'; style-src 'self'",
        );
        response.end(officeTaskpane);
        return;
      }
      if (request.method === "GET" && request.url === "/taskpane.js") {
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(officeTaskpaneScript);
        return;
      }
      const authorization = request.headers.authorization ?? "";
      const expected = `Bearer ${this.token}`;
      const actualBytes = Buffer.from(authorization);
      const expectedBytes = Buffer.from(expected);
      if (
        actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes)
      ) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      try {
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const part of request) {
          bytes += part.length;
          if (bytes > 64 * 1024) {
            response.writeHead(413).end();
            return;
          }
          parts.push(part);
        }
        const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
        let result: unknown;
        if (request.url === "/connect") {
          if (
            !["excel", "word", "powerpoint"].includes(body.app) ||
            typeof body.document !== "string" ||
            !body.document ||
            body.document.length > 1000 ||
            this.files.size >= 32
          ) {
            response.writeHead(400).end();
            return;
          }
          const id = randomUUID();
          const now = Date.now();
          const file: OfficeConnectedFile = {
            id,
            addinId: id,
            app: body.app,
            document: body.document,
            status: "connected",
            isSelected: true,
            lastConnectedAt: now,
            lastActivityAt: now,
          };
          for (const existing of this.files.values())
            if (existing.app === file.app) existing.isSelected = false;
          this.files.set(id, file);
          this.enqueue(id, { type: "summary", summary: this.summary });
          this.deliver();
          this.changed(this.connectedFiles());
          result = { id };
        } else {
          const file = this.files.get(body.id);
          if (!file) {
            response.writeHead(404).end();
            return;
          }
          file.lastActivityAt = Date.now();
          if (request.url === "/poll") {
            file.status = "connected";
            result = { commands: this.commands.get(file.id) ?? [] };
            this.commands.delete(file.id);
          } else if (request.url === "/disconnect") {
            this.files.delete(file.id);
            this.commands.delete(file.id);
            for (const pending of this.selections.values())
              if (pending.documentId === file.id) pending.finish();
            this.changed(this.connectedFiles());
            result = {};
          } else if (request.url === "/selection-result") {
            result = {
              accepted: this.completeSelection(
                file.id,
                body.requestId,
                body.text,
              ),
            };
          } else {
            response.writeHead(404).end();
            return;
          }
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400).end();
      }
    };
    const server =
      this.options.key && this.options.cert
        ? https.createServer(
            { key: this.options.key, cert: this.options.cert },
            listener,
          )
        : http.createServer(listener);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.origin = `${this.options.cert ? "https" : "http"}://127.0.0.1:${(server.address() as AddressInfo).port}`;
    this.server = server;
    this.sweep = setInterval(() => {
      for (const [id, file] of this.files)
        if (Date.now() - file.lastActivityAt > 30_000) {
          this.files.delete(id);
          this.commands.delete(id);
          for (const pending of this.selections.values())
            if (pending.documentId === id) pending.finish();
          this.changed(this.connectedFiles());
        }
      this.deliver();
    }, 10_000);
    this.sweep.unref();
    return this.origin;
  }

  manifest() {
    if (!this.server) throw new Error("Office bridge is not running.");
    return `<?xml version="1.0" encoding="UTF-8"?><OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="TaskPaneApp"><Id>df53e84a-ed92-41ae-b3c7-f58f00f212ca</Id><Version>1.0.0.0</Version><ProviderName>Claudex</ProviderName><DefaultLocale>en-US</DefaultLocale><DisplayName DefaultValue="Claudex"/><Description DefaultValue="Claudex"/><Hosts><Host Name="Workbook"/><Host Name="Document"/><Host Name="Presentation"/></Hosts><DefaultSettings><SourceLocation DefaultValue="${this.origin}/#${this.token}"/></DefaultSettings><Permissions>ReadWriteDocument</Permissions></OfficeApp>`;
  }

  configuration() {
    return { port: Number(new URL(this.origin).port), token: this.token };
  }

  dispose() {
    for (const pending of this.selections.values()) pending.finish();
    if (this.sweep) clearInterval(this.sweep);
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    this.files.clear();
    this.commands.clear();
    this.handoffs.clear();
    this.summary = null;
    this.token = randomBytes(32).toString("hex");
  }
}

const officeTaskpane = `<!doctype html><html><head><meta charset="utf-8"><title>Claudex</title><script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script><script src="/taskpane.js" defer></script></head><body><h1>Claudex</h1><main aria-live="polite"></main></body></html>`;
export const officeTaskpaneScript = `const token = location.hash.slice(1); history.replaceState(null, '', '/');
const main = document.querySelector('main');
async function call(route, body) { const response = await fetch(route, {method:'POST', headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json'}, body:JSON.stringify(body)}); if (!response.ok) throw new Error(String(response.status)); return response.json(); }
Office.onReady(async info => {
  const app = String(info.host).toLowerCase();
  const url = Office.context.document.url || '';
  const documentName = decodeURIComponent(url.split(/[\\\\/]/).pop() || app);
  const {id} = await call('/connect', {app, document:documentName});
  async function poll() {
    try { const {commands} = await call('/poll', {id});
      for (const command of commands) {
        if (command.type === 'selection' && command.expiresAt > Date.now()) {
          try {
            const selected = await new Promise((resolve, reject) => Office.context.document.getSelectedDataAsync(Office.CoercionType.Text, result => result.status === Office.AsyncResultStatus.Succeeded ? resolve(result.value) : reject()));
            if (typeof selected !== 'string' || selected.length > 12000) throw new Error();
            if (command.text !== undefined) {
              if (command.expectedText !== selected || command.expiresAt <= Date.now()) throw new Error();
              await new Promise((resolve, reject) => Office.context.document.setSelectedDataAsync(command.text, {coercionType:Office.CoercionType.Text}, result => result.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject()));
            }
            await call('/selection-result', {id, requestId:command.requestId, text:command.text ?? selected});
          } catch { await call('/selection-result', {id, requestId:command.requestId}); }
        }
        if (command.type === 'focus') window.focus();
        if (command.type === 'summary') main.textContent = command.summary?.summary || '';
        if (command.type === 'handoff' && command.expiresAt > Date.now()) {
          main.replaceChildren(); const title = document.createElement('h2'); title.textContent = command.title; main.append(title);
          for (const message of command.messages) { const paragraph = document.createElement('p'); paragraph.textContent = message.text; main.append(paragraph); }
        }
      }
    } catch {} finally { setTimeout(poll, 1000); }
  }
  poll();
  window.addEventListener('pagehide', () => { void call('/disconnect', {id}); });
});`;
