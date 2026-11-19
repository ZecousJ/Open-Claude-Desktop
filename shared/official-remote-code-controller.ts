import { z } from "zod";
import {
  officialCodeHistoryRequest,
  officialCodeMutation,
  type OfficialCodeHistoryRequest,
} from "./official-code-history";
import {
  officialCodeControlContentType,
  officialCodeFollowupPath,
} from "./official-code-followup";
import {
  remoteCodeArchivedInventoryPath,
  remoteCodeEnvironmentId,
  remoteCodeEnvironmentTarget,
  remoteCodeHeartbeatPath,
  remoteCodeInventory,
  remoteCodeInventoryPage,
  remoteCodeInventoryPath,
  remoteCodeLinkTarget,
  remoteCodeSession,
  remoteCodeSessionId,
  type RemoteCodeEnvironment,
  type RemoteCodeRequest,
} from "./official-remote-code";
import { officialCodeViewerSession } from "./official-code-viewers";
import type { DeviceInfo } from "./remote-devices";
import type {
  OfficialUiReadRequest,
  OfficialUiReadResponse,
} from "./official-ui-web";

type Session = z.infer<typeof remoteCodeSession>;
type Inventory = z.infer<typeof remoteCodeInventory> & { next_cursor?: string | null };
type HistoryList = Extract<OfficialCodeHistoryRequest, { kind: "list" }>;
type InventoryRefresh = { devices: DeviceInfo[]; verified: Set<string> };
type InventoryScope = "active" | "archived";
type InventoryCache = {
  path: string;
  last: Map<string, Inventory>;
  pending?: Promise<InventoryRefresh>;
};
type HeartbeatOutcome = "fresh" | "no_worker" | "unknown";
type Target = NonNullable<ReturnType<typeof remoteCodeLinkTarget>>;
type Operation = {
  current(): void;
  organization?: string;
  hint?: Target;
  fallback(path?: string): Promise<OfficialUiReadResponse | undefined>;
};
type Relay = {
  list(): Promise<DeviceInfo[]>;
  call(device: string, request: RemoteCodeRequest): Promise<unknown>;
  changed?(conversationId: string): void;
};

export function usesRemoteCodeSessions(
  method: string,
  pathname: string,
  search = "",
) {
  if (pathname === remoteCodeHeartbeatPath) return method === "POST" && !search;
  return pathname === remoteCodeInventoryPath
    ? method === "GET" || method === "POST"
    : sessionKey.test(pathname);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const result = z.strictObject({
  status: z.number().int().min(200).max(599),
  value: z.unknown(),
  contentType: z.literal(officialCodeControlContentType).optional(),
});
const sessionReply = z.object({ session: remoteCodeSession });
const listRow = z.looseObject({
  id: z.string(),
  last_event_at: z.string().nullish(),
  tags: z.array(z.string()).optional(),
});
const cloudList = z.looseObject({
  data: listRow.array(),
  next_cursor: z.string().nullish(),
  pinned_beyond_page: z.object({ sessions: listRow.array() }).nullish(),
});
type ListRow = z.infer<typeof listRow>;
type RowsPage<Row> = { data: Row[]; next_cursor?: string | null };

function inventoryPagePath(
  scope: InventoryScope,
  cursor?: string,
  pinned = false,
) {
  const query = new URLSearchParams({ limit: "100" });
  const statuses =
    scope === "archived" ? ["archived"] : ["active", "paused", "failed"];
  for (const status of statuses) query.append("statuses", status);
  if (cursor) query.set("cursor", cursor);
  if (pinned) query.set("tags", "ui:pinned");
  return remoteCodeInventoryPath + "?" + query;
}

async function* pagedRows<Row>(
  first: RowsPage<Row>,
  load: (cursor: string) => Promise<RowsPage<Row>>,
) {
  let page = first;
  for (;;) {
    yield* page.data;
    if (!page.next_cursor) return;
    page = await load(page.next_cursor);
  }
}

async function* mergeRows(sources: AsyncGenerator<ListRow>[]) {
  const heads = await Promise.all(sources.map((source) => source.next()));
  const seen = new Set<string>();
  for (;;) {
    let best: { index: number; row: ListRow } | undefined;
    for (const [index, head] of heads.entries()) {
      if (
        !head.done &&
        (!best ||
          (head.value.last_event_at ?? "") > (best.row.last_event_at ?? ""))
      )
        best = { index, row: head.value };
    }
    if (!best) return;
    const { index, row } = best;
    if (!seen.has(row.id)) {
      seen.add(row.id);
      yield row;
    }
    heads[index] = await sources[index].next();
  }
}

class ListUnavailable extends Error {
  constructor(readonly reply: OfficialUiReadResponse) {
    super("Code history page unavailable");
  }
}
const heartbeatRequest = z.strictObject({
  session_ids: z.array(z.string().regex(/^cse_[a-f0-9]{32}$/)).max(25),
});
const sessionKey =
  /^\/v1\/(?:code\/)?sessions\/(?:session|cse)_([a-f0-9]{32})(?:\/|$)/;
const response = (status: number, value: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body:
    status === 204
      ? new Uint8Array()
      : encoder.encode(JSON.stringify(value ?? null)),
});
const failure = (status: number, message: string) =>
  response(status, {
    type: "error",
    error: { type: status === 404 ? "not_found_error" : "api_error", message },
  });
const offline = (row: Session): Session => ({
  ...row,
  connection_status: "disconnected",
});
const accessRevoked = (message: string) =>
  /device.{0,12}access.{0,12}revoked|verification|approve this device/i.test(
    message,
  );

export function createOfficialRemoteCodeController(relay: Relay) {
  const inventories: Record<InventoryScope, InventoryCache> = {
    active: { path: remoteCodeInventoryPath, last: new Map() },
    archived: { path: remoteCodeArchivedInventoryPath, last: new Map() },
  };
  const destinations = new Map<string, string>();
  const forgetDevice = (device: string) => {
    for (const { last } of Object.values(inventories)) last.delete(device);
  };
  const forgetSession = (device: string, key: string) => {
    for (const { last } of Object.values(inventories)) {
      const cached = last.get(device);
      if (cached)
        cached.sessions = cached.sessions.filter(
          ({ id }) => id !== "session_" + key,
        );
    }
  };
  const rememberRows = (
    scope: InventoryScope,
    device: string,
    sessions: Session[],
  ) => {
    const previous =
      inventories[scope === "active" ? "archived" : "active"].last.get(device);
    if (previous) {
      const ids = new Set(sessions.map(({ id }) => id));
      previous.sessions = previous.sessions.filter(({ id }) => !ids.has(id));
    }
    for (const { id } of sessions) {
      const key = id.slice("session_".length);
      if (!destinations.has(key)) destinations.set(key, device);
    }
  };
  const refresh = async (
    current: () => void,
    scope: InventoryScope = "active",
    listDevices = () => relay.list(),
  ) => {
    current();
    const cache = inventories[scope];
    const { last } = cache;
    if (!cache.pending) {
      const pending = listDevices().then(async (devices) => {
        current();
        const listed = new Set(devices.map(({ id }) => id));
        const verified = new Set<string>();
        for (const { last } of Object.values(inventories))
          for (const device of last.keys())
            if (!listed.has(device)) last.delete(device);
        await Promise.all(
          devices.map(async (device) => {
            if (device.online === false) return;
            try {
              const get = async (path: string) => {
                const reply = result.parse(
                  await relay.call(device.id, { method: "GET", path }),
                );
                current();
                return reply;
              };
              let reply = await get(inventoryPagePath(scope));
              const legacy = reply.status === 404 || reply.status === 501;
              if (legacy) reply = await get(cache.path);
              if (reply.status === 403) return forgetDevice(device.id);
              if (reply.status !== 200) {
                last.delete(device.id);
                return;
              }
              const inventory = legacy
                ? remoteCodeInventory.parse(reply.value)
                : remoteCodeInventoryPage.parse(reply.value);
              const sessions = inventory.sessions.filter(
                ({ status }) =>
                  (status === "archived") === (scope === "archived"),
              );
              last.set(device.id, { ...inventory, sessions });
              verified.add(device.id);
              rememberRows(scope, device.id, sessions);
            } catch (error) {
              current();
              if (
                error instanceof Error &&
                (accessRevoked(error.message) ||
                  error.message === "Remote Control is off.")
              )
                return forgetDevice(device.id);
              if (!(
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === "CLAUDEX_DEVICE_OFFLINE"
              ))
                last.delete(device.id);
            }
          }),
        );
        current();
        return { devices, verified };
      });
      cache.pending = pending;
      void pending
        .finally(() => {
          if (cache.pending === pending) cache.pending = undefined;
        })
        .catch(() => {});
    }
    const refreshed = await cache.pending;
    current();
    return refreshed;
  };
  const call = async (
    device: string,
    request: RemoteCodeRequest,
    current: () => void,
  ) => {
    current();
    try {
      const answer = result.parse(await relay.call(device, request));
      current();
      if (answer.status === 403 && request.method === "GET") forgetDevice(device);
      return answer;
    } catch (error) {
      current();
      const message =
        error instanceof Error
          ? error.message
          : "Could not reach this computer.";
      const forbidden = accessRevoked(message);
      if (forbidden || message === "Remote Control is off.") forgetDevice(device);
      return {
        status: forbidden ? 403 : 503,
        value: {
          type: "error",
          error: { type: "api_error", message },
        },
      };
    }
  };
  const listHistory = async (history: HistoryList, url: URL, op: Operation) => {
    const { statuses, tags, cursor, limit } = history;
    const includePinned = history.includePinnedBeyondPage && !cursor;
    const scopes: InventoryScope[] = [];
    if (!statuses.length || statuses.some((status) => status !== "archived"))
      scopes.push("active");
    if (!statuses.length || statuses.includes("archived"))
      scopes.push("archived");

    const cloudUrl = new URL(url);
    const cloudPath = (next: string | null) => {
      if (next) cloudUrl.searchParams.set("cursor", next);
      else cloudUrl.searchParams.delete("cursor");
      if (!includePinned || next)
        cloudUrl.searchParams.delete("include_pinned_beyond_page");
      return cloudUrl.pathname + cloudUrl.search;
    };
    let devices: Promise<DeviceInfo[]> | undefined;
    const listDevices = () => (devices ??= relay.list());
    const [initialCloud, initialRemote] = await Promise.all([
      op.fallback(cloudPath(null)),
      Promise.all(
        scopes.map(async (scope) => ({
          scope,
          refreshed: await refresh(op.current, scope, listDevices).catch(
            op.current,
          ),
        })),
      ),
    ]);
    op.current();
    const cloudFailure =
      initialCloud?.status !== 200 ? initialCloud : undefined;
    if (cloudFailure && ![404, 501, 503].includes(cloudFailure.status))
      return cloudFailure;

    const entries = initialRemote.flatMap(({ scope, refreshed }) =>
      (refreshed?.devices ?? [])
        .flatMap((device) => {
          const inventory = inventories[scope].last.get(device.id);
          return inventory?.sessions.length
            ? [
                {
                  scope,
                  device: device.id,
                  inventory,
                  online: refreshed?.verified.has(device.id) === true,
                },
              ]
            : [];
        })
        .sort((a, b) => a.device.localeCompare(b.device)),
    );
    if (!entries.length) {
      if (!cursor || cloudFailure || !initialCloud) return initialCloud;
      const original = await op.fallback();
      op.current();
      return original;
    }

    const unavailable = () =>
      new ListUnavailable(
        failure(
          503,
          "Could not load the next Code history page from this computer.",
        ),
      );
    const readCloud = (answer: OfficialUiReadResponse | undefined) => {
      if (answer?.status !== 200)
        throw new ListUnavailable(
          answer ?? failure(503, "Cloud Code history is unavailable."),
        );
      try {
        return cloudList.parse(JSON.parse(decoder.decode(answer.body)));
      } catch {
        throw new ListUnavailable(
          failure(502, "Invalid Cloud Code history response."),
        );
      }
    };
    const matches = (row: Session) =>
      (!statuses.length || statuses.includes(row.status)) &&
      tags.every((tag) => row.tags.includes(tag));
    const remoteRows = (pinned: boolean) =>
      entries.map(async function* ({ scope, device, inventory, online }) {
        const fetchPage = async (next?: string) => {
          if (!online) throw unavailable();
          const answer = await call(
            device,
            { method: "GET", path: inventoryPagePath(scope, next, pinned) },
            op.current,
          );
          const page =
            answer.status === 200 &&
            remoteCodeInventoryPage.safeParse(answer.value);
          if (!page || !page.success) throw unavailable();
          return page.data;
        };
        const canQueryPins =
          pinned && online && inventory.next_cursor !== undefined;
        let prefix = inventory;
        const first = canQueryPins ? await fetchPage() : inventory;
        const rows = pagedRows(
          { data: first.sessions, next_cursor: first.next_cursor },
          async (next) => {
            const page = await fetchPage(next);
            const cache = inventories[scope].last;
            if (!pinned && cache.get(device) === prefix) {
              prefix = {
                ...page,
                sessions: [...prefix.sessions, ...page.sessions],
              };
              cache.set(device, prefix);
              rememberRows(scope, device, page.sessions);
            }
            return { data: page.sessions, next_cursor: page.next_cursor };
          },
        );
        for await (const row of rows) {
          if (matches(row) && (!pinned || row.tags.includes("ui:pinned")))
            yield online ? row : offline(row);
        }
      });

    const data: ListRow[] = [];
    let found = !cursor;
    let nextCursor: string | null = null;
    try {
      const cloudPage =
        initialCloud?.status === 200 ? readCloud(initialCloud) : { data: [] };
      const cloudRows = pagedRows(cloudPage, async (next) => {
        const answer = await op.fallback(cloudPath(next));
        op.current();
        return readCloud(answer);
      });
      const key = (id: string) => id.replace(/^(?:session|cse)_/, "");
      for await (const row of mergeRows([cloudRows, ...remoteRows(false)])) {
        if (!found) {
          found = cursor !== null && key(cursor) === key(row.id);
          continue;
        }
        if (data.length === limit) {
          nextCursor = data.at(-1)?.id ?? null;
          break;
        }
        data.push(row);
      }
      if (!found)
        return (
          cloudFailure ??
          response(404, {
            error: "Code session cursor is no longer available.",
          })
        );
      if (cloudFailure && !cursor && !data.length) return cloudFailure;

      const pinned: ListRow[] = [];
      if (includePinned) {
        const shown = new Set(data.map(({ id }) => id));
        const cloudPins = async function* () {
          yield* cloudPage.data.filter((row) =>
            row.tags?.includes("ui:pinned"),
          );
          if ("pinned_beyond_page" in cloudPage)
            yield* cloudPage.pinned_beyond_page?.sessions ?? [];
        };
        for await (const row of mergeRows([cloudPins(), ...remoteRows(true)])) {
          if (shown.has(row.id)) continue;
          pinned.push(row);
          if (pinned.length === 500) break;
        }
      }
      op.current();
      return response(200, {
        data,
        next_cursor: nextCursor,
        ...(pinned.length && { pinned_beyond_page: { sessions: pinned } }),
      });
    } catch (error) {
      op.current();
      if (error instanceof ListUnavailable) return error.reply;
      throw error;
    }
  };
  const notify = (key: string) => {
    const id = remoteCodeSessionId(key);
    if (id) relay.changed?.(id);
  };
  return {
    owns(key: string) {
      return destinations.has(key);
    },
    clear() {
      for (const cache of Object.values(inventories)) {
        cache.pending = undefined;
        cache.last.clear();
      }
      destinations.clear();
    },
    async environments(current: () => void): Promise<RemoteCodeEnvironment[]> {
      const { devices } = await refresh(current);
      return devices.flatMap((device) => {
        const known = inventories.active.last.get(device.id);
        const available = device.online !== false && known !== undefined;
        const directories = known?.directories ?? [];
        const rows: (string | undefined)[] = [...directories];
        if (
          known?.sessions.some(
            ({ environment_id }) =>
              environment_id === remoteCodeEnvironmentId(device.id),
          ) ||
          !rows.length
        )
          rows.push(undefined);
        return rows.map((directory) => ({
          environment_id: remoteCodeEnvironmentId(device.id, directory),
          name: device.name,
          kind: "bridge",
          state: "active",
          bridge_info: {
            machine_name: device.name,
            ...(directory && { directory }),
            online: available && !!directory,
            max_sessions: known?.capacity ?? 0,
            active_sessions: known?.active ?? 0,
          },
        }));
      });
    },
    async request(
      request: OfficialUiReadRequest,
      op: Operation,
    ): Promise<OfficialUiReadResponse | undefined> {
      const { method, path, codeOrganizationId } = request;
      if (method === "PATCH") return;
      const url = URL.parse(path, "http://localhost");
      if (!url || url.origin !== "http://localhost") return;
      const { pathname, search } = url;
      const viewer = officialCodeViewerSession(method, pathname, search);
      if (viewer) {
        op.current();
        if (!op.organization || codeOrganizationId !== op.organization)
          return failure(404, "Organization not found.");
        if (!/^application\/json(?:\s*;|$)/i.test(request.contentType ?? ""))
          return failure(400, "Invalid Code viewer request body.");
      }
      if (method === "POST" && path === remoteCodeHeartbeatPath) {
        op.current();
        if (!op.organization || codeOrganizationId !== op.organization)
          return failure(404, "Organization not found.");

        let body: unknown;
        try {
          body = JSON.parse(decoder.decode(request.body));
        } catch {
          return failure(400, "Invalid Code heartbeat request body.");
        }
        const parsed = heartbeatRequest.safeParse(body);
        if (!parsed.success)
          return failure(400, "Invalid Code heartbeat request body.");
        const { session_ids } = parsed.data;
        if (!session_ids.length)
          return response(200, { checks_enabled: true, results: [] });

        const probe = await refresh(op.current).catch(() => {
          op.current();
        });
        const devices = new Map(
          probe?.devices.map((device) => [device.id, device]),
        );
        const results = session_ids.map((session_id) => {
          const key = session_id.slice("cse_".length);
          const destination = destinations.get(key);
          const device = destination && devices.get(destination);
          let outcome: HeartbeatOutcome = "unknown";
          if (
            device &&
            inventories.active.last
              .get(device.id)
              ?.sessions.some(
                (row) =>
                  row.id === "session_" + key && row.status !== "archived",
              )
          ) {
            if (device.online === false) outcome = "no_worker";
            else if (probe?.verified.has(device.id)) outcome = "fresh";
          }
          return { session_id, outcome };
        });
        return response(200, { checks_enabled: true, results });
      }
      const history = officialCodeHistoryRequest(method, pathname, search);
      const isList =
        history?.kind === "list" &&
        !history.tags.includes("cowork-remote") &&
        history.triggerSessions.kind === "any";
      const key = sessionKey.exec(pathname)?.[1];
      let body: unknown;
      let target: ReturnType<typeof remoteCodeEnvironmentTarget>;
      if (
        method === "POST" &&
        pathname === remoteCodeInventoryPath &&
        request.body
      ) {
        try {
          body = JSON.parse(decoder.decode(request.body));
        } catch {
          return op.fallback();
        }
        if (
          body &&
          typeof body === "object" &&
          "environment_id" in body &&
          typeof body.environment_id === "string" &&
          body.environment_id.startsWith("env_bridge_")
        ) {
          target = remoteCodeEnvironmentTarget(body.environment_id);
          if (!target)
            return failure(400, "Invalid Remote Control computer or folder.");
        }
      }
      if (!isList && !key && !target) return;
      const ownOrg = op.organization;
      op.current();
      if (
        !ownOrg ||
        (codeOrganizationId !== undefined &&
          codeOrganizationId.toLowerCase() !== ownOrg)
      )
        return isList || target || op.hint?.key === key
          ? failure(404, "Organization not found.")
          : undefined;

      if (target) {
        if (codeOrganizationId === undefined)
          return failure(404, "Organization not found.");
        const devices = await relay.list();
        op.current();
        const selected = devices.find(({ id }) => id === target?.device);
        if (!selected) return failure(404, "Computer not found.");
        if (selected.online === false)
          return failure(503, "This computer is not online.");
        const reply = await call(
          target.device,
          { method, path, body },
          op.current,
        );
        if (reply.status === 200) {
          const made = sessionReply.parse(reply.value).session;
          const createdKey = made.id.slice("session_".length);
          destinations.set(createdKey, target.device);
          notify(createdKey);
        }
        return response(reply.status, reply.value);
      }

      if (isList) return listHistory(history, url, op);

      if (!key) return;
      const hinted = op.hint?.key === key ? op.hint : undefined;
      let device = hinted?.device ?? destinations.get(key);
      let reply: z.infer<typeof result> | undefined;
      if (!device) {
        const cloud = method === "GET" || viewer ? await op.fallback() : undefined;
        if (cloud?.status === 200) return cloud;
        const refreshed = await refresh(op.current).catch(op.current);
        device = destinations.get(key);
        if (!device && refreshed) {
          const id = "session_" + key;
          const detail =
            history?.kind === "session" ? path : remoteCodeInventoryPath + "/" + id;
          const found = (
            await Promise.all(
              refreshed.devices
                .filter(({ online }) => online !== false)
                .map(async ({ id: candidate }) => {
                  const probe = await call(
                    candidate,
                    { method: "GET", path: detail },
                    op.current,
                  );
                  if (probe.status !== 200) return;
                  const confirmed = sessionReply.safeParse(probe.value);
                  if (confirmed.success && confirmed.data.session.id === id)
                    return { candidate, probe };
                }),
            )
          ).find((match) => match !== undefined);
          op.current();
          if (found) {
            device = found.candidate;
            destinations.set(key, device);
            if (history?.kind === "session") reply = found.probe;
          }
        }
        if (!device) return cloud;
      }
      if (request.body && body === undefined) {
        try {
          body = JSON.parse(decoder.decode(request.body));
        } catch {
          return failure(400, "Invalid Remote Control request body.");
        }
      }
      reply ??= await call(device, { method, path, body }, op.current);
      const appliedMutation = reply.status === 200
        ? officialCodeMutation(method, pathname)?.kind
        : undefined;
      if (appliedMutation === "delete") destinations.set(key, device);
      if (
        reply.status === 404 ||
        appliedMutation === "archive" ||
        appliedMutation === "unarchive" ||
        appliedMutation === "delete"
      )
        forgetSession(device, key);
      if (
        reply.status === 200 &&
        method !== "GET" &&
        !viewer &&
        !officialCodeFollowupPath(method, pathname)
      )
        notify(key);
      if (reply.status === 200 && method === "GET" && !destinations.has(key))
        destinations.set(key, device);
      return {
        ...response(reply.status, reply.value),
        ...(reply.contentType && { contentType: reply.contentType }),
      };
    },
  };
}
