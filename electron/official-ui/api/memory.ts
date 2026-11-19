/** Official classic-memory reads and switches (shared-0 Ep/$k/Cca/vD).
 * The engine owns the data and policy; the adapter never returns fixture
 * memory or acknowledges an unsupported write.
 */
import type http from "node:http";
import { z } from "zod";
import { readBoundedJson, RequestBodyError } from "./request-body";
import { withMelangeSettings } from "./melange";
import { MelangeConflictError, MelangeLimitError, type MelangeImportStatus, type MelangeMode } from "../../memory/melange";
import { officialMemoryAction, parseOfficialMemorySettings, type OfficialMemoryAction, type OfficialMemoryPreferenceActions } from "../../../shared/official-memory-capability";
import { memoryMessages, projectScope } from "../../memory/types";
import type {
  MemoryDocView,
  MemoryPrefs,
  MemoryScopeRef,
  MemoryStatus,
} from "../../../shared/memory-api";
import {
  empty,
  readBody,
  readJson,
  reply,
  organizationUuid,
  type AdapterContext,
} from "./context";

const classicReset = { classicOnly: true } as const;
const memorySettingsBodyBytes = 1024;
const synthesisScope = z.strictObject({
  project_uuid: z.string().refine((value) => projectScope(value) !== undefined).optional(),
});
const melangeSettingsGesture = z.union([
  z.strictObject({ enabled_melange: z.literal(true), user_initiated: z.literal(true) }),
  z.strictObject({
    enabled_melange: z.literal(false),
    enabled_saffron: z.literal(true),
    user_initiated: z.literal(true),
  }),
  z.strictObject({
    enabled_melange: z.literal(false),
    enabled_saffron: z.literal(false),
    clear_data: z.literal(true).optional(),
    user_initiated: z.literal(true).optional(),
  }),
]);
const disableMemorySettings = z.union([
  z.strictObject({ enabled_saffron: z.literal(false), user_initiated: z.literal(true).optional() }),
  z.strictObject({
    enabled_saffron: z.literal(false),
    enabled_melange: z.literal(false),
    clear_data: z.literal(true).optional(),
    user_initiated: z.literal(true).optional(),
  }),
]);

export function memorySettings(
  status: MemoryStatus,
  surface: "read-only" | "native" = "read-only",
  resetAvailable = surface === "native",
  preferenceActions?: OfficialMemoryPreferenceActions,
) {
  if (
    !status ||
    typeof status.available !== "boolean" ||
    !status.allowed ||
    !status.prefs ||
    [
      status.allowed.generate,
      status.allowed.searchChats,
      status.prefs.generate,
      status.prefs.searchChats,
    ].some((v) => typeof v !== "boolean")
  )
    throw Error("Invalid memory status source");
  if (status.reason !== undefined && !["policy", "server", "offline", "unsupported"].includes(status.reason))
    throw Error("Invalid memory status reason");
  if (status.global === null) throw Error("Invalid memory snapshot source");
  const snapshot = status.global === undefined
    ? { state: "not_provided" as const }
    : { state: "present" as const, ...memoryRow(status.global) };
  const generate =
    status.available && status.allowed.generate && status.prefs.generate;
  const search = (status.available || status.reason === "server" && preferenceActions?.searchChats === true) &&
    status.allowed.searchChats && status.prefs.searchChats;
  return {
    enabled_saffron: generate,
    enabled_saffron_search: search,
    enabled_melange: false,
    memory_mode: generate ? "classic" as const : "off" as const,
    classic_mode_available: status.available && status.allowed.generate,
    melange_available: false,
    melange_imported_at: null,
    // Facts from the current host snapshot, not permission/consent or vendor entitlement.
    claudex_memory: {
      version: 1,
      available: status.available,
      reason: status.reason ?? null,
      allowed: { generate: status.allowed.generate, searchChats: status.allowed.searchChats },
      preferences: { generate: status.prefs.generate, searchChats: status.prefs.searchChats },
      surface,
      generation_action: status.available && status.allowed.generate && preferenceActions?.generate === true
        ? "available" : "consent_and_budget_not_established",
      reset_action: resetAvailable && status.available && status.allowed.generate ? "available" : "unavailable",
      generation_disable_action: status.available && status.allowed.generate && status.prefs.generate
        ? surface === "native" ? "existing_native_policy" : resetAvailable ? "available" : "unavailable"
        : "unavailable",
      search_action: preferenceActions?.searchChats === true ? "available"
        : surface === "native" && status.available && status.allowed.searchChats ? "existing_native_policy" : "unavailable",
      snapshot,
    },
  };
}

function settingsForMode(classic: ReturnType<typeof memorySettings>, mode: MelangeMode) {
  const result = withMelangeSettings(classic, mode === "classic" ? classic.memory_mode : mode, true);
  result.enabled_saffron = result.memory_mode === "classic";
  if (classic.claudex_memory.surface === "native" && classic.classic_mode_available)
    result.claudex_memory.generation_action = "available";
  return result;
}

function memoryRow(doc: MemoryDocView | null, version?: string | null) {
  if (
    doc !== null &&
    (!doc ||
      typeof doc.content !== "string" ||
      doc.content.length > 2_000_000 ||
      !Number.isFinite(doc.updatedAt) ||
      !Number.isFinite(new Date(doc.updatedAt).getTime()) ||
      !Array.isArray(doc.edits) ||
      doc.edits.length > 10000 ||
      doc.edits.some((e) => !e || typeof e.text !== "string"))
  )
    throw Error("Invalid memory document source");
  if (
    (version != null &&
      (typeof version !== "string" || version.length > 200)) ||
    (doc?.controlsVersion !== undefined &&
      (typeof doc.controlsVersion !== "string" ||
        doc.controlsVersion.length > 200))
  )
    throw Error("Invalid memory version source");
  return {
    memory: doc?.content ?? "",
    controls: doc?.edits.map((e) => e.text) ?? [],
    updated_at: doc ? new Date(doc.updatedAt).toISOString() : null,
    controls_version: doc?.controlsVersion ?? version ?? null,
    project_import: null,
    project_memory_mode: null,
  };
}

export async function memorySettingsWithMode(
  ctx: AdapterContext,
  status: MemoryStatus,
  surface: "read-only" | "native" = "read-only",
  resetAvailable = surface === "native",
) {
  const classic = memorySettings(status, surface, resetAvailable, ctx.memoryPreferenceActions?.());
  const service = await ctx.melange?.();
  if (!service) return classic;
  const state = await service.read(classic.memory_mode === "classic" ? "classic" : "off").catch(() => undefined);
  return state ? settingsForMode(classic, state.mode) : classic;
}

export async function memoryRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  const route =
    /^\/api\/organizations\/([^/]+)\/(?:memory(?:\/(?:settings|reset|controls|synthesize|disable-generation))?|conversation\/backfill)$/.exec(
      p,
    );
  if (!route) return false;
  const failure = (status: number, message: string) =>
    reply(res, { error: { type: "invalid_request_error", message } }, status);
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  if (!owner) return failure(401, "Sign in to continue.");
  if (route[1] !== organizationUuid(owner))
    return failure(404, "Organization not found.");
  const current = () =>
    ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation;
  if (!current()) return failure(409, "The account changed. Reload memory.");
  const call = async (name: string, ...args: unknown[]) => {
    if (!current()) throw Error("Memory account changed");
    const result = await ctx.call(name, ...args);
    if (!current()) throw Error("Memory account changed");
    return result;
  };
  const method = req.method ?? "GET";
  const webAction = officialMemoryAction(method, p + url.search);
  const match =
    /^\/api\/organizations\/[^/]+\/memory(?:\/(settings|reset|controls|synthesize|disable-generation))?$/.exec(
      p,
    );
  const error = (
    message: string,
    status = 400,
    type = "invalid_request_error",
  ) =>
    reply(
      res,
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message,
          ...(type !== "invalid_request_error"
            ? { details: { error_code: type } }
            : {}),
        },
      },
      status,
    );
  const authorize = (action: OfficialMemoryAction) => {
    if (ctx.readOnly) ctx.authorizeMemoryAction?.(action);
  };
  const surface = ctx.readOnly ? "read-only" : "native";
  const resetAvailable = () => ctx.memoryResetAvailable?.() ?? !ctx.readOnly;
  const settings = (status: MemoryStatus) => memorySettings(status, surface, resetAvailable(), ctx.memoryPreferenceActions?.());
  const deletedProject = () =>
    error("Project not found.", 404, "memory_deleted_since_read");
  try {
    if (!match) {
      if (method !== "POST") return false;
      if (ctx.readOnly) {
        if (webAction !== "backfill" || !ctx.authorizeMemoryAction)
          return error("Memory search is unavailable.", 501);
        const body = await readBoundedJson(req, memorySettingsBodyBytes);
        if (Object.keys(body).length) return error("Invalid memory search request.");
        if (!current()) return error("The account changed. Reload memory.", 409);
        authorize("backfill");
        return empty(res);
      }
      const status = (await call("memoryStatus")) as MemoryStatus;
      return settings(status).enabled_saffron_search ? empty(res) : error("Chat search is turned off.");
    }
    if (
      ctx.readOnly && !(webAction && ctx.authorizeMemoryAction) &&
      (method !== "GET" || (match[1] !== undefined && match[1] !== "settings"))
    )
      return error(
        "This memory operation is not available on the web yet.",
        501,
      );
    if (match[1] === "disable-generation") {
      if (method !== "POST") return error("Unsupported memory operation.", 405);
      if ([...url.searchParams.keys()].length) return error("Invalid memory query.");
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || body.enabled !== false)
        return error("Only disabling future memory generation is supported.");
      const status = await call("setMemoryPrefs", {generate:false}, {disableOnly:true}) as MemoryStatus;
      return reply(res, settings(status));
    }
    if (match[1] === "settings") {
      if (method === "GET") {
        const status = await ctx.readMemorySettings?.()
          ?? (await call("memoryStatus", {snapshotOnly:true})) as MemoryStatus;
        if (!current()) return error("The account changed. Reload memory.", 409);
        const result = await memorySettingsWithMode(ctx, status, surface, resetAvailable());
        return current() ? reply(res, result) : error("The account changed. Reload memory.", 409);
      }
      if (method !== "POST")
        return error("Unsupported memory settings operation.", 405);
      if (ctx.readOnly) {
        const intent = parseOfficialMemorySettings(await readBoundedJson(req, memorySettingsBodyBytes));
        if (!intent) return error("Invalid memory settings.");
        authorize("settings");
        const available = ctx.memoryPreferenceActions?.();
        if (intent.kind === "search") {
          if (!available?.searchChats) return error(memoryMessages.switchDisabled, 403);
          const status = await call("setMemoryPrefs", { searchChats: intent.enabled }) as MemoryStatus;
          if (status.prefs.searchChats !== intent.enabled) throw Error("Memory search preference was not saved.");
          const result = await memorySettingsWithMode(ctx, status, surface, resetAvailable());
          if (!current()) return error("The account changed. Reload memory.", 409);
          return reply(res, result);
        }
        const enable = intent.kind === "generation" ? intent.enabled : intent.mode !== "off";
        if (enable ? !available?.generate : !resetAvailable()) return error(memoryMessages.switchDisabled, 403);
        const clear = intent.kind === "mode" && intent.clear;
        const service = await ctx.melange?.(!clear && (intent.kind === "mode" || enable));
        if (!current()) return error("The account changed. Reload memory.", 409);
        const status = service && !clear ? await call("memoryStatus", { snapshotOnly: true }) as MemoryStatus : undefined;
        const previous = status?.prefs.generate ? "classic" : "off";
        const state = clear ? undefined : await service?.read(previous);
        if (!current()) return error("The account changed. Reload memory.", 409);
        const mode = intent.kind === "mode" ? intent.mode : enable ? "classic" : undefined;
        if (mode === "melange" && !service) return error("This memory mode is not available.", 501);
        if (intent.kind === "generation" && enable && state?.mode === "melange")
          return error("Choose Classic memory to change the active memory mode.", 409);
        const sources = mode === "melange" ? await ctx.classicMelangeSources?.() : undefined;
        if (!current()) return error("The account changed. Reload memory.", 409);
        if (clear) await call("resetMemory", undefined, classicReset);
        try {
          authorize("settings");
          if (enable ? !ctx.memoryPreferenceActions?.()?.generate : !resetAvailable())
            throw Error(memoryMessages.switchDisabled);
          let next: MemoryStatus;
          if (service && mode && !clear && (intent.kind === "mode" || state?.mode !== mode)) {
            await service.setMode(mode, previous, sources);
            next = await call("memoryStatus", { snapshotOnly: true }) as MemoryStatus;
            const classic = mode === "classic";
            if (mode !== "melange" && next.prefs.generate !== classic)
              next = await (classic ? call("setMemoryPrefs", { generate: true })
                : call("setMemoryPrefs", { generate: false }, { disableOnly: true })) as MemoryStatus;
          } else {
            next = await (enable ? call("setMemoryPrefs", { generate: true })
              : call("setMemoryPrefs", { generate: false }, { disableOnly: true })) as MemoryStatus;
          }
          if (next.prefs.generate !== (enable && mode !== "melange")) throw Error("Memory generation preference was not saved.");
          const result = service ? settingsForMode(settings(next), mode ?? state?.mode ?? previous) : settings(next);
          return reply(res, { ...result, ...(clear && { complete: true }) });
        } catch (e) {
          if (clear && current()) return error("Memory was cleared. Future memory generation could not be paused.", 503);
          throw e;
        }
      }
      const body = await readJson(req);
      const gesture = melangeSettingsGesture.safeParse(body);
      if (gesture.success && !url.search) {
        const service = await ctx.melange?.();
        if (!current()) return error("The account changed. Reload memory.", 409);
        if (service) {
          authorize("settings");
          const mode: MelangeMode = gesture.data.enabled_melange ? "melange" :
            gesture.data.enabled_saffron ? "classic" : "off";
          const clear = "clear_data" in gesture.data && gesture.data.clear_data === true;
          const status = await call("memoryStatus", {snapshotOnly:true}) as MemoryStatus;
          const previous = status.prefs.generate ? "classic" : "off";
          const sources = mode === "melange" ? await ctx.classicMelangeSources?.() : undefined;
          if (!current()) return error("The account changed. Reload memory.", 409);
          if (clear) await call("resetMemory", undefined, classicReset);
          const state = await service.setMode(mode, previous, sources);
          if (!current()) return error("The account changed. Reload memory.", 409);
          const next = await call("memoryStatus", {snapshotOnly:true}) as MemoryStatus;
          return reply(res, { ...settingsForMode(settings(next), state.mode), ...(clear && { complete: true }) });
        }
      }
      const disable = disableMemorySettings.safeParse(body);
      const clear = disable.success && "clear_data" in disable.data && disable.data.clear_data === true;
      if (clear) {
        await call("resetMemory", undefined, classicReset);
        try {
          const status = await call("setMemoryPrefs", { generate: false }, { disableOnly: true }) as MemoryStatus;
          if (status?.prefs?.generate !== false) throw Error("Memory generation was not paused.");
          return reply(res, { ...settings(status), complete: true });
        } catch (e) {
          if (current()) return error("Memory was cleared. Future memory generation could not be paused.", 503);
          throw e;
        }
      }
      const keys = new Set([
        "enabled_saffron",
        "enabled_saffron_search",
        "enabled_melange",
        "clear_data",
        "user_initiated",
      ]);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !Object.keys(body).length ||
        Object.keys(body).some(
          (k) => !keys.has(k) || typeof body[k] !== "boolean",
        )
      )
        return error("Invalid memory settings.");
      if (body.enabled_melange === true)
        return error("This memory mode is not available.");
      if (
        body.clear_data === true &&
        !(body.enabled_melange === false && body.enabled_saffron === false)
      )
        return error("Clearing memory requires turning memory off.");
      const prefs: Partial<MemoryPrefs> = {};
      if (typeof body.enabled_saffron === "boolean")
        prefs.generate = body.enabled_saffron;
      if (typeof body.enabled_saffron_search === "boolean")
        prefs.searchChats = body.enabled_saffron_search;
      if (!Object.keys(prefs).length)
        return error("Choose a memory setting to change.");
      if (body.clear_data) await call("resetMemory", undefined, classicReset);
      try {
        const status = (await call("setMemoryPrefs", prefs)) as MemoryStatus;
        if (body.clear_data && status?.prefs?.generate !== false) throw Error("Memory generation was not paused.");
        const result = await memorySettingsWithMode(ctx, status, surface, resetAvailable());
        return current()
          ? reply(res, { ...result, ...(body.clear_data && { complete: true }) })
          : error("The account changed. Reload memory.", 409);
      } catch (e) {
        if (body.clear_data && current()) return error("Memory was cleared. Future memory generation could not be paused.", 503);
        throw e;
      }
    }
    const action = match[1];
    const expected = action === "controls" ? "PUT" : action ? "POST" : "GET";
    if (method !== expected) return error("Unsupported memory operation.", 405);
    if (action === "synthesize") {
      if (url.search || !/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? ""))
        return error("Invalid memory regeneration request.");
      const input = synthesisScope.safeParse(await readBoundedJson(req, 1024));
      if (!input.success) return error("Invalid memory regeneration scope.");
      const projectId = input.data.project_uuid;
      if (projectId) {
        const snapshot = await ctx.snapshot();
        if (!current()) return error("The account changed. Reload memory.", 409);
        if (!snapshot.projects.some((project) => project.id === projectId))
          return error("Project not found.", 404);
      }
      const scope: MemoryScopeRef = projectId ? { kind: "project", projectId } : { kind: "global" };
      if (ctx.readOnly) {
        authorize("synthesize");
        return reply(res, memoryRow(await call("synthesizeMemory", scope) as MemoryDocView));
      }
      const disconnected = new AbortController();
      const onClose = () => disconnected.abort();
      res.once("close", onClose);
      try {
        if (res.destroyed) return true;
        const doc = await call("synthesizeMemory", scope, disconnected.signal) as MemoryDocView;
        return res.destroyed ? true : reply(res, memoryRow(doc));
      } finally {
        res.removeListener("close", onClose);
      }
    }
    const resetBody = action === "reset" ? await readBody(req) : undefined;
    const body = resetBody ? (resetBody.length ? JSON.parse(resetBody.toString("utf8")) : {}) :
      action ? await readJson(req) : {};
    if (!body || typeof body !== "object" || Array.isArray(body))
      return error("Invalid memory request.");
    const projectImport = method === "GET" && !action &&
      url.searchParams.has("project_uuid") &&
      url.searchParams.getAll("include_project_import").length === 1 &&
      url.searchParams.get("include_project_import") === "true";
    if (
      [...url.searchParams.keys()].some((k) => k !== "project_uuid" && !(projectImport && k === "include_project_import")) ||
      url.searchParams.getAll("project_uuid").length > 1
    )
      return error("Invalid memory query.");
    const allowed = new Set(
      action === "controls"
        ? ["project_uuid", "controls", "base_controls_version"]
        : ["project_uuid"],
    );
    if (Object.keys(body).some((key) => !allowed.has(key)) ||
        (action === "reset" && "project_uuid" in body && typeof body.project_uuid !== "string"))
      return error("Invalid memory request.");
    if (
      body.project_uuid != null &&
      url.searchParams.has("project_uuid") &&
      body.project_uuid !== url.searchParams.get("project_uuid")
    )
      return error("Conflicting memory scope.");
    const projectId = body.project_uuid ?? url.searchParams.get("project_uuid");
    let scope: MemoryScopeRef = { kind: "global" };
    if (projectId !== undefined && projectId !== null) {
      if (
        typeof projectId !== "string" ||
        (action === "reset" && !projectScope(projectId))
      )
        return error("Project not found.", 404);
      const snapshot = await ctx.snapshot();
      if (!current()) return error("The account changed. Reload memory.", 409);
      if (!snapshot.projects.some((project) => project.id === projectId))
        return action === "controls" && typeof body.base_controls_version === "string"
          ? deletedProject()
          : error("Project not found.", 404);
      scope = { kind: "project", projectId };
    }
    if (action === "controls") {
      if (
        !Array.isArray(body.controls) ||
        body.controls.some((value: unknown) => typeof value !== "string") ||
        (body.base_controls_version !== undefined &&
          typeof body.base_controls_version !== "string")
      )
        return error("Invalid memory controls.");
      if (ctx.readOnly) {
        if (typeof body.base_controls_version !== "string" || !body.base_controls_version)
          return error("Reload memory to obtain a current controls version.", 409, "memory_changed_since_read");
        authorize("controls");
        if (!current()) return error("The account changed. Reload memory.",409);
      }
      let version = body.base_controls_version;
      // The official client omits a null version on first save. Never infer a
      // current token when there is existing data: that would bypass conflicts.
      if (version === undefined) {
        const state = (await call("memoryControlsState", scope, { fresh: true })) as {
          doc: MemoryDocView | null;
          version: string | null;
        };
        if (!state.version)
          return error(
            "This server does not support atomic memory controls yet.",
            501,
          );
        if (state.doc || !/^v1:0:0:0$/.test(state.version))
          return error(
            "Memory changed. Reload it before saving.",
            409,
            "memory_changed_since_read",
          );
        version = state.version;
      }
      const doc = (await call(
        "replaceMemoryControls",
        scope,
        body.controls,
        version,
        ...(ctx.readOnly ? [{nonGenerating:true}] : []),
      )) as MemoryDocView;
      return reply(res, memoryRow(doc));
    }
    if (action === "reset") {
      authorize("reset");
      const all = resetBody?.length === 0 && scope.kind === "global";
      const state = await call("resetMemory", all ? undefined : scope, classicReset) as {
        doc: MemoryDocView | null;
        version: string | null;
      };
      return reply(res, { ...memoryRow(state.doc, state.version), cleared_scope: all ? { kind: "all" } : scope });
    }
    let imported: MelangeImportStatus | undefined;
    if (projectImport) {
      const service = await ctx.melange?.();
      if (!current()) return error("The account changed. Reload memory.", 409);
      if (service && (await service.read("off")).mode === "melange") {
        if (!current()) return error("The account changed. Reload memory.", 409);
        imported = await service.importStatus("switchImport");
      }
    }
    const state = (await call("memoryControlsState", scope, { fresh: true })) as {
      doc: MemoryDocView | null;
      version: string | null;
    };
    if (scope.kind === "project") {
      // The project may have disappeared while the host read was in flight.
      // Its retained memory cache is not authority to expose a removed scope.
      const snapshot = await ctx.snapshot(true);
      if (!current()) return error("The account changed. Reload memory.", 409);
      if (!snapshot.projects.some((project) => project.id === scope.projectId))
        return error("Project not found.", 404);
    }
    const row = memoryRow(state.doc, state.version);
    if (imported) {
      if (imported.status === "pending" && state.doc)
        return reply(res, { ...row, project_import: { status: "pending", migrated_at: null } });
      if (imported.status === "failed" && state.doc)
        return reply(res, { ...row, project_import: { status: "withheld", migrated_at: null }, project_memory_mode: "classic" });
      return reply(res, { ...row, project_memory_mode: "melange" });
    }
    return reply(res, row);
  } catch (e) {
    if (res.destroyed) return true;
    if (!current()) return error("The account changed. Reload memory.", 409);
    if (e instanceof RequestBodyError) return error(e.message, e.status);
    if (e instanceof MelangeLimitError) return error(e.message, 413);
    if (e instanceof MelangeConflictError) return error(e.message, 409);
    if (e instanceof SyntaxError) return error("Invalid memory request.");
    // Electron IPC preserves the message, not the Error subclass.
    const message = e instanceof Error ? e.message : String(e);
    if (webAction === "controls" && message.endsWith("Project not found."))
      return deletedProject();
    if (method === "GET" && match && !match[1] && message.endsWith("Project not found."))
      return error("Project not found.", 404);
    if (message.includes("Memory was cleared. Reload memory to obtain its current state."))
      return error("Memory was cleared. Reload memory to obtain its current state.", 503);
    if (message.includes("Memory was reset."))
      return error(
        "Memory was reset. Reload it before saving.",
        409,
        "memory_reset_since_read",
      );
    if (message.includes("Memory changed on another device."))
      return error(memoryMessages.conflict, 409, "memory_changed_since_read");
    const known = Object.entries(memoryMessages).find(
      ([, value]) => value === message,
    );
    if (known) {
      const [kind, message] = known;
      const status = ["unsupported", "serverKey", "importUnavailable"].includes(
        kind,
      )
        ? 501
        : ["disabled", "switchDisabled"].includes(kind)
          ? 403
          : kind === "rateLimited"
            ? 429
            : ["pending", "offline", "broken"].includes(kind)
              ? 503
              : 400;
      return error(message, status);
    }
    return error(
      current()
        ? "Memory is temporarily unavailable."
        : "The account changed. Reload memory.",
      current() ? 503 : 409,
    );
  }
}
