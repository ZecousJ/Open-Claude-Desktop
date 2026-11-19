import { commitCodeRead } from "../../electron/ipc/code-read-state";
import {
  cloudCodeReadEvent,
  cloudCodeSessionKey,
  isOwnedCloudCodeSession,
  isOwnedCloudCoworkSession,
} from "../../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { codeReadSnapshot } from "../../shared/code-read-state";
import { officialCodeReadBody } from "../../shared/official-code-history";
import {
  applyOfficialCodeViewerLease,
  officialCodeViewerBody,
  officialCodeViewerMaxBytes,
  officialCodeViewerRefreshSeconds,
} from "../../shared/official-code-viewers";
import type { Mode } from "../../shared/types";
import type { OfficialUiReadResponse } from "../../shared/official-ui-web";
import type { WebAppContext } from "./web-app-context";

const viewerLeases = new WeakMap<
  WebAppContext,
  {
    activation: object;
    owner: string;
    store: WebAppContext["store"];
    sessions: Map<string, Map<string, number>>;
  }
>();

function matchesOrganization(header: unknown, owner: string) {
  return (
    typeof header === "string" &&
    header.toLowerCase() === organizationUuid(owner)
  );
}

function findOwnedSession(
  store: WebAppContext["store"],
  owner: string,
  key: string,
  modes: readonly Mode[] = ["code"],
) {
  return store.conversations.find(
    (row) =>
      ((modes.includes("code") && isOwnedCloudCodeSession(row, owner)) ||
        (modes.includes("cowork") && isOwnedCloudCoworkSession(row, owner))) &&
      cloudCodeSessionKey(row, owner) === key,
  );
}

export function registerOfficialCodeViewer(
  ctx: WebAppContext,
  key: string,
  request: Record<string, unknown>,
  modes: readonly Mode[],
  now: number,
): OfficialUiReadResponse {
  const reply = (status: number, payload: object) => ({
    status,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(payload)),
  });
  const owner = ctx.activeAccount?.id;
  if (!owner) return reply(409, { error: "The account activation changed." });
  if (!matchesOrganization(request.codeOrganizationId, owner))
    return reply(404, { error: "Organization not found." });
  const invalid = () =>
    reply(400, { error: "Invalid viewer presence request." });
  const { body, contentType } = request;
  if (
    !(body instanceof Uint8Array) ||
    body.byteLength > officialCodeViewerMaxBytes ||
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  )
    return invalid();
  let command;
  try {
    command = officialCodeViewerBody.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
  } catch {
    return invalid();
  }
  const { store } = ctx;
  if (!findOwnedSession(store, owner, key, modes))
    return reply(404, { error: "Code session not found." });
  const activation = ctx.officialSessionIdentity();
  let leases = viewerLeases.get(ctx);
  if (
    !leases ||
    leases.activation !== activation ||
    leases.owner !== owner ||
    leases.store !== store
  ) {
    leases = { activation, owner, store, sessions: new Map() };
    viewerLeases.set(ctx, leases);
  }
  applyOfficialCodeViewerLease(leases.sessions, key, command, now);
  return reply(200, {
    refresh_after_seconds: officialCodeViewerRefreshSeconds,
  });
}

export async function acknowledgeOfficialCodeRead(
  ctx: WebAppContext,
  key: string,
  request: Record<string, unknown>,
  activationCurrent: () => boolean,
): Promise<OfficialUiReadResponse> {
  const reply = (status: number, error?: string) => ({
    status,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(error ? { error } : {})),
  });
  const account = ctx.activeAccount;
  if (!account || !activationCurrent())
    return reply(409, "The account activation changed.");
  if (!matchesOrganization(request.codeOrganizationId, account.id))
    return reply(404, "Organization not found.");
  const { body, contentType, codeReadRevision } = request;
  if (
    !(body instanceof Uint8Array) ||
    body.byteLength > 4096 ||
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  )
    return reply(400, "Invalid Code read request.");
  let eventId: string | undefined;
  try {
    ({ event_id: eventId } = officialCodeReadBody.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    ));
  } catch {
    return reply(400, "Invalid Code read request.");
  }
  const store = ctx.store;
  const conversation = findOwnedSession(store, account.id, key);
  if (!conversation) return reply(404, "Code session not found.");
  const createdAt = conversation.createdAt;
  const current = () =>
    activationCurrent() &&
    ctx.activeAccount?.id === account.id &&
    ctx.store === store &&
    conversation.createdAt === createdAt &&
    isOwnedCloudCodeSession(conversation, account.id) &&
    store.conversations.includes(conversation);
  try {
    const expected = codeReadSnapshot(conversation);
    if (
      (eventId && eventId !== cloudCodeReadEvent(conversation)) ||
      (conversation.unread === true &&
        codeReadRevision !== expected.readStateRevision)
    )
      return reply(
        409,
        "The Code session changed. Reopen it before marking it read.",
      );
    await commitCodeRead(ctx, conversation, expected, current);
    return reply(200);
  } catch {
    return reply(
      409,
      "The Code read save could not be confirmed. Reopen before retrying.",
    );
  }
}
