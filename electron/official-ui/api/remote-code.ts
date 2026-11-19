import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { officialCodeStreamRequest } from "../../../shared/official-code-history";
import {
  officialCodeControlContentType,
  officialCodeFollowupPath,
} from "../../../shared/official-code-followup";
import { remoteCodeLinkTarget } from "../../../shared/official-remote-code";
import { usesRemoteCodeSessions } from "../../../shared/official-remote-code-controller";
import {
  officialUiRequestLimit,
  type OfficialUiReadRequest,
  type OfficialUiReadResponse,
} from "../../../shared/official-ui-web";
import {
  openOfficialCodeStream,
  type CodeControlReply,
} from "../../../src-web/official/code-stream";
import { officialCloudEnvironmentRequest } from "../../../src-web/official/cloud-environment-fetch";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedBytes, RequestBodyError } from "./request-body";

type Fallback = (
  request: OfficialUiReadRequest,
) => Promise<OfficialUiReadResponse | undefined>;
const unavailable = (status: number) => ({
  status,
  contentType: "application/json",
  body: new TextEncoder().encode(
    JSON.stringify({ error: { message: "The Code session is unavailable." } }),
  ),
});
const methods = ["GET", "POST", "PUT", "DELETE"] as const;
type Method = (typeof methods)[number];
const supported = (value: string): value is Method =>
  methods.some((method) => value === method);
const accountControls = new WeakMap<
  NonNullable<AdapterContext["officialRemoteCode"]>,
  EventTarget
>();

export async function desktopRemoteCodeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AdapterContext,
  cloud?: Fallback,
) {
  const controller = ctx.officialRemoteCode;
  const account = ctx.account();
  const method = req.method ?? "GET";
  if (!controller || !account || !supported(method)) return false;
  const organization = organizationUuid(account.id);
  let controls = accountControls.get(controller);
  if (!controls) {
    controls = new EventTarget();
    accountControls.set(controller, controls);
  }
  const current = () => {
    if (
      res.destroyed ||
      ctx.isCurrent?.() === false ||
      ctx.account()?.id !== account.id
    )
      throw new DOMException("The account activation changed.", "AbortError");
  };
  const environmentsPath = `/v1/environment_providers/private/organizations/${organization}/environments`;
  if (
    method === "GET" &&
    (url.pathname === environmentsPath ||
      url.pathname.startsWith(environmentsPath + "/env_bridge_"))
  ) {
    const header = req.headers["x-organization-uuid"];
    const request = new Request(url, {
      headers:
        typeof header === "string" ? { "x-organization-uuid": header } : {},
    });
    const response = await officialCloudEnvironmentRequest(
      request,
      url,
      {
        organization,
        accountUuid: account.id,
        api: {
          listCloudEnvironments: () =>
            ctx.officialDesktopCloudCode?.listCloudEnvironments() ??
            Promise.resolve([]),
          listRemoteCodeEnvironments: () => controller.environments(current),
        },
      },
      async () => null,
      request.signal,
    );
    if (response) {
      current();
      res.writeHead(response.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(Buffer.from(await response.arrayBuffer()));
      return true;
    }
  }
  if (!usesRemoteCodeSessions(method, url.pathname, url.search)) return false;
  const path = url.pathname + url.search;
  const suppliedOrg = req.headers["x-organization-uuid"];
  const source = req.headers.referer;
  const hint =
    source && URL.canParse(source)
      ? remoteCodeLinkTarget(new URL(source))
      : undefined;
  const stream = officialCodeStreamRequest(method, url.pathname, url.search);
  const send = async (request: OfficialUiReadRequest, fallback?: Fallback) => {
    return controller.request(request, {
      current,
      organization,
      hint,
      fallback: (path = request.path) => fallback?.({ ...request, path }) ?? Promise.resolve(undefined),
    });
  };
  const metadata = {
    method,
    path,
    ...(typeof suppliedOrg === "string"
      ? { codeOrganizationId: suppliedOrg }
      : {}),
  };
  if (stream) {
    const initial = await send(metadata);
    if (!initial) return false;
    if (initial.status !== 200) {
      res.writeHead(initial.status, {
        "Content-Type": initial.contentType,
        "Cache-Control": "no-store",
      });
      res.end(initial.body);
      return true;
    }
    const stop = new AbortController();
    res.once("close", () => stop.abort());
    let first: OfficialUiReadResponse | undefined = req.headers["last-event-id"]
      ? undefined
      : initial;
    const headers = new Headers();
    if (typeof suppliedOrg === "string")
      headers.set("x-organization-uuid", suppliedOrg);
    if (typeof req.headers["last-event-id"] === "string")
      headers.set("last-event-id", req.headers["last-event-id"]);
    const response = await openOfficialCodeStream(
      new Request(url, { headers, signal: stop.signal }),
      url,
      stream,
      async (request) => {
        const prepared = first;
        first = undefined;
        return prepared ?? (await send(request)) ?? unavailable(404);
      },
      ctx.onEvent ?? (() => () => {}),
      controls,
    );
    current();
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      const chunks = async function* () {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return;
            yield chunk.value;
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
      };
      const readable = Readable.from(chunks());
      res.once("close", () => readable.destroy());
      readable.on("error", () => res.end());
      readable.pipe(res);
    } else res.end();
    return true;
  }
  let body: Uint8Array | undefined;
  if (method !== "GET") {
    try {
      body = await readBoundedBytes(req, officialUiRequestLimit(method, path));
    } catch (error) {
      if (error instanceof RequestBodyError)
        return reply(res, { error: { message: error.message } }, error.status);
      throw error;
    }
  }
  const contentType = req.headers["content-type"];
  const request = {
    ...metadata,
    ...(body !== undefined && { body }),
    ...(method !== "GET" && contentType && { contentType }),
  };
  const response = await send(request, cloud);
  if (!response) {
    if (method === "GET") return false;
    const forwarded = await cloud?.(request);
    if (!forwarded)
      return reply(
        res,
        { error: { message: "This Code action is unavailable." } },
        501,
      );
    current();
    res.writeHead(forwarded.status, {
      "Content-Type": forwarded.contentType,
      "Cache-Control": "no-store",
    });
    res.end(forwarded.body);
    return true;
  }
  current();
  if (response.contentType === officialCodeControlContentType) {
    const followup = officialCodeFollowupPath(method, url.pathname);
    if (!followup)
      return reply(
        res,
        { error: { message: "Invalid Code control reply." } },
        502,
      );
    const detail: CodeControlReply = JSON.parse(
      new TextDecoder().decode(response.body),
    );
    if (
      controls.dispatchEvent(
        new CustomEvent(followup.key, { cancelable: true, detail }),
      )
    )
      return reply(
        res,
        { error: { message: "Reconnect the Code session." } },
        409,
      );
    return reply(res, { events: [] });
  }
  res.writeHead(response.status, {
    "Content-Type": response.contentType,
    "Cache-Control": "no-store",
  });
  res.end(response.body);
  return true;
}
