import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const clientId = "3b6a227a-0bc2-4c10-91b0-72226730d013";
const exportIdPattern = /^[A-Za-z0-9_-]{16,256}$/;
const maxBytes = 1024 * 1024 * 1024;
const failure = "Your conversation export didn’t import";

/** PKCE user:data_export grant and nonce export jobs. */
export class ClaudeAiImport {
  private controller?: AbortController;
  private credentials?: {
    token: string;
    organization: string;
    email: string;
    expiresAt: number;
    root: string;
  };
  constructor(
    private options: {
      open(url: string): Promise<void>;
      fetch?: typeof fetch;
      wait?: typeof delay;
      root(): string;
    },
  ) {}
  cancel() {
    this.controller?.abort();
    this.controller = undefined;
  }
  dispose() {
    this.cancel();
    this.credentials = undefined;
  }
  private begin() {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return controller;
  }
  private async request(url: string, init: RequestInit, signal: AbortSignal) {
    const response = await (this.options.fetch ?? fetch)(url, {
      ...init,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (!response.ok) throw new Error(failure);
    return response;
  }
  async signIn() {
    this.credentials = undefined;
    const root = this.options.root();
    const controller = this.begin();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(600000),
    ]);
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const server = http.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      signal.throwIfAborted();
      const port = (server.address() as import("node:net").AddressInfo).port;
      const redirect = `http://127.0.0.1:${port}/callback`;
      const authorization = new URL("https://claude.ai/oauth/authorize");
      authorization.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirect,
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        scope: "user:data_export",
      }).toString();
      let stop: (() => void) | undefined;
      const callback = new Promise<string>((resolve, reject) => {
        const abort = () => reject(new Error(failure));
        signal.addEventListener("abort", abort, { once: true });
        stop = () => signal.removeEventListener("abort", abort);
        server.on("request", (request, response) => {
          if (
            request.method !== "GET" ||
            request.headers.host !== `127.0.0.1:${port}`
          ) {
            response.writeHead(400).end();
            return;
          }
          let url: URL;
          try {
            url = new URL(request.url ?? "/", redirect);
          } catch {
            response.writeHead(400).end();
            return;
          }
          if (
            url.pathname !== "/callback" ||
            url.searchParams.get("state") !== state
          ) {
            response.writeHead(400).end();
            return;
          }
          response
            .writeHead(200, {
              "Content-Type": "text/plain",
              "Cache-Control": "no-store",
            })
            .end("Claudex");
          const code = url.searchParams.get("code");
          if (!code || code.length > 4096 || url.searchParams.has("error"))
            reject(new Error(failure));
          else resolve(code);
        });
      });
      void callback.catch(() => {});
      let code: string;
      try {
        await this.options.open(authorization.toString());
        code = await callback;
      } finally {
        stop?.();
      }
      const response = await this.request(
        "https://api.anthropic.com/v1/oauth/token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirect,
            client_id: clientId,
            code_verifier: verifier,
            state,
          }),
        },
        signal,
      );
      const result = await response.json();
      if (
        typeof result.access_token !== "string" ||
        typeof result.organization?.uuid !== "string" ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(result.organization.uuid) ||
        typeof result.account?.email_address !== "string"
      )
        throw new Error(failure);
      signal.throwIfAborted();
      const credentials = {
        token: result.access_token,
        organization: result.organization.uuid,
        root,
        email: result.account.email_address,
        expiresAt:
          Date.now() +
          Math.min(
            900,
            typeof result.expires_in === "number"
              ? Math.max(0, result.expires_in)
              : 900,
          ) *
            1000,
      };
      await this.request(
        `${this.endpoint(credentials.organization)}?preflight=true`,
        {
          method: "POST",
          headers: this.headers(credentials),
        },
        signal,
      );
      signal.throwIfAborted();
      if (root !== this.options.root()) throw new Error(failure);
      this.credentials = credentials;
      return { email: credentials.email };
    } finally {
      server.close();
      server.closeAllConnections();
      if (this.controller === controller) this.controller = undefined;
    }
  }
  private endpoint(organization: string, ...parts: string[]) {
    return `https://claude.ai/api/oauth/organizations/${encodeURIComponent(organization)}/members/me/export_data${parts.map((part) => `/${encodeURIComponent(part)}`).join("")}`;
  }
  private headers(credentials: NonNullable<ClaudeAiImport["credentials"]>) {
    return {
      Authorization: `Bearer ${credentials.token}`,
      "x-claudeai-expected-email": credentials.email,
    };
  }
  async download() {
    const credentials = this.credentials;
    if (
      !credentials ||
      credentials.root !== this.options.root() ||
      Date.now() >= credentials.expiresAt - 30000
    )
      throw new Error(failure);
    const controller = this.begin();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15 * 60 * 1000),
    ]);
    const root = this.options.root();
    const folder = path.join(root, "claude-ai-import");
    const files: string[] = [];
    const json = async (method: string, ...parts: string[]) => {
      const response = await this.request(
        this.endpoint(credentials.organization, ...parts),
        {
          method,
          headers: this.headers(credentials),
        },
        signal,
      );
      return response.json();
    };
    let totalBytes = 0;
    const part = async (exportId: string) => {
      if (!exportIdPattern.test(exportId)) throw new Error(failure);
      const redemption = await json("POST", exportId, "signed_url");
      const signed = new URL(redemption.signed_url);
      if (
        signed.protocol !== "https:" ||
        signed.hostname !== "storage.googleapis.com" ||
        signed.username ||
        signed.password ||
        signed.port
      )
        throw new Error(failure);
      const response = await this.request(signed.toString(), {}, signal);
      if (
        !response.body ||
        Number(response.headers.get("content-length")) > maxBytes
      )
        throw new Error(failure);
      const filename = path.join(
        folder,
        `${randomBytes(12).toString("hex")}.zip`,
      );
      files.push(filename);
      const file = await fs.open(filename, "wx", 0o600);
      let length = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          length += chunk.byteLength;
          totalBytes += chunk.byteLength;
          if (totalBytes > maxBytes) throw new Error(failure);
          await file.writeFile(chunk);
        }
        const expected = Number(response.headers.get("content-length"));
        if (expected && expected !== length) throw new Error(failure);
      } finally {
        await file.close();
      }
      return filename;
    };
    try {
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      const job = await json("POST");
      if (
        typeof job.export_id !== "string" ||
        !exportIdPattern.test(job.export_id)
      )
        throw new Error(failure);
      const intervals = [3, 5, 5, 5, 10, 10, 10, 15, 15, 15, 30];
      const pause = this.options.wait ?? delay;
      let wait = Math.min(30, Math.max(3, Number(job.poll_after_seconds) || 3));
      let polls = 0;
      let failures = 0;
      for (;;) {
        await pause(wait * 1000, undefined, { signal });
        const response = await (this.options.fetch ?? fetch)(
          this.endpoint(credentials.organization, job.export_id),
          {
            method: "GET",
            headers: this.headers(credentials),
            redirect: "error",
            credentials: "omit",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          },
        );
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          if (++failures > 5) throw new Error(failure);
          const retry = Number(response.headers.get("retry-after"));
          wait = Math.min(
            response.status === 429 ? 60 : 30,
            Math.max(3, retry || 30),
          );
          continue;
        }
        if (!response.ok) throw new Error(failure);
        const status = await response.json();
        failures = 0;
        if (status.state === "ready") break;
        if (status.state !== "pending") throw new Error(failure);
        polls++;
        wait = Math.min(
          30,
          Math.max(
            3,
            Number(status.retry_after_seconds) ||
              intervals[Math.min(polls, intervals.length - 1)],
          ),
        );
      }
      const first = await part(job.export_id);
      const file = await fs.open(first, "r");
      const magic = Buffer.alloc(4);
      try {
        await file.read(magic, 0, 4, 0);
      } finally {
        await file.close();
      }
      if (!magic.equals(Buffer.from([80, 75, 3, 4]))) {
        if ((await fs.stat(first)).size > 1024 * 1024) throw new Error(failure);
        const manifest = JSON.parse(await fs.readFile(first, "utf8"));
        if (
          !Array.isArray(manifest.data_files) ||
          !manifest.data_files.length ||
          manifest.data_files.length > 64
        )
          throw new Error(failure);
        for (const entry of manifest.data_files) {
          if (
            entry.category &&
            !["conversations", "projects", "light_metadata"].includes(
              entry.category,
            )
          )
            continue;
          const url = new URL(entry.export_url);
          const prefix = `${this.endpoint(credentials.organization)}/`;
          if (!url.href.startsWith(prefix) || url.search || url.hash)
            throw new Error(failure);
          await part(url.pathname.split("/").at(-1)!);
        }
        await fs.unlink(first);
        files.splice(0, 1);
        if (!files.length) throw new Error(failure);
      }
      signal.throwIfAborted();
      if (root !== this.options.root()) throw new Error(failure);
      return files;
    } catch (error) {
      await Promise.all(files.map((file) => fs.unlink(file).catch(() => {})));
      throw error;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}
