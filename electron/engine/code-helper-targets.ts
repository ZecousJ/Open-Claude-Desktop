import { z } from "zod";
import type { AppContext } from "../app/app-context";
import { workspaceRepository } from "../git/git-branch";
import { inAdapterScope, type AdapterScope } from "../official-ui/api/scope";
import { readState } from "../official-ui/api/state";
import type { Conversation } from "../../shared/types";
import { codeEffortLevels } from "../../shared/code-effort";
import {
  codeExecutionSettings,
  codePermissionModeOf,
} from "../../shared/code-session-permissions";
import type { Settings } from "../../shared/types";

export const codeHelperPermissionInput = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
]);
const nativeMode = {
  default: "manual",
  acceptEdits: "acceptEdits",
  plan: "plan",
  auto: "auto",
  bypassPermissions: "bypass",
} as const;
const permissionOrder = [
  "plan",
  "manual",
  "auto",
  "acceptEdits",
  "bypass",
] as const;

export function codeHelperPermission(
  settings: Settings,
  parent: Conversation,
  requested?: z.infer<typeof codeHelperPermissionInput>,
) {
  const current = codePermissionModeOf(codeExecutionSettings(settings, parent));
  if (!requested) return current;
  const desired = nativeMode[requested];
  if (permissionOrder.indexOf(desired) > permissionOrder.indexOf(current))
    throw Error(
      "The child Code session cannot use a higher permission mode than its parent.",
    );
  return desired;
}

const preset = z.object({
  name: z.string().min(1).max(150),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local"), cwd: z.string().min(1).max(4096) }),
    z.object({
      kind: z.literal("ssh"),
      sshConfigId: z.string().min(1).max(500),
      cwd: z.string().max(4096).nullish(),
    }),
  ]),
  settings: z
    .object({
      worktree: z.boolean().optional(),
      modelId: z.string().min(1).max(200).optional(),
      branch: z.string().min(1).max(255).optional(),
      effort: z.enum(codeEffortLevels).optional(),
      permissionMode: codeHelperPermissionInput.optional(),
    })
    .optional(),
});

export function codeHelperPresets(scope: AdapterScope) {
  const storage = inAdapterScope(scope, () =>
    readState<{ presets?: unknown }>("code-session-presets", {}),
  );
  return Array.isArray(storage?.presets)
    ? storage.presets.flatMap((row) => {
        const result = preset.safeParse(row);
        return result.success ? [result.data] : [];
      })
    : [];
}

export function applyCodeHelperPreset(
  ctx: AppContext,
  scope: AdapterScope,
  args: Record<string, unknown>,
) {
  const { preset: name, ...rest } = args;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    rest.initiation !== "user_asked" ||
    rest.context === "fork" ||
    [rest.target, rest.host, rest.cwd, rest.environment, rest.repository].some(
      (value) => value !== undefined,
    )
  )
    throw Error(
      "Use one named preset for a fresh Code session, without another placement.",
    );
  const matches = codeHelperPresets(scope).filter(
    (row) => row.name === name.trim(),
  );
  if (matches.length !== 1)
    throw Error("Choose one saved Code preset by its unique name.");
  const { target, settings } = matches[0];
  const opts = {
    ...(settings?.worktree === undefined
      ? {}
      : { use_worktree: settings.worktree }),
    ...(settings?.modelId && settings.modelId !== "default"
      ? { model: settings.modelId }
      : {}),
    ...(settings?.worktree && settings.branch
      ? { source_branch: settings.branch }
      : {}),
    ...(settings?.effort ? { effort: settings.effort } : {}),
    ...(settings?.permissionMode
      ? { permission_mode: settings.permissionMode }
      : {}),
    ...rest,
  };
  if (target.kind === "local")
    return { ...opts, target: "local", cwd: target.cwd };
  const host = ctx.services.ssh?.hosts.get(target.sshConfigId);
  if (!host)
    throw Error("The SSH connection for this Code preset is unavailable.");
  return {
    ...opts,
    target: "ssh",
    host: host.label,
    ...(target.cwd ? { cwd: target.cwd } : {}),
  };
}

export async function codeHelperStartTargets(
  ctx: AppContext,
  parent: Conversation,
  scope: AdapterScope,
  visible: (conversation: Conversation) => boolean,
) {
  const rows = ctx.store.conversations
    .filter((row) => !row.archived && visible(row))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const folders = (rows: Conversation[], cap: number) =>
    [
      ...new Set(rows.flatMap((row) => row.worktree?.origin ?? row.cwd ?? [])),
    ].slice(0, cap);
  const local = folders(
    rows.filter((row) => (row.environment?.kind ?? "local") === "local"),
    8,
  );
  const projectFolder = parent.worktree?.origin ?? parent.cwd;
  const repositories = Object.fromEntries(
    [...new Set([projectFolder, ...local])].flatMap((folder) => {
      const repository = folder && workspaceRepository(folder);
      return repository ? [[folder, repository]] : [];
    }),
  );
  const hosts = ctx.services.ssh?.allowed()
    ? ctx.services.ssh.hosts.list()
    : [];
  const presets = codeHelperPresets(scope).flatMap(({ name, target }) => {
    if (target.kind === "local")
      return [{ name, kind: "local", where: target.cwd }];
    const host = hosts.find((row) => row.id === target.sshConfigId);
    return host
      ? [
          {
            name,
            kind: "ssh",
            where: [host.label, target.cwd].filter(Boolean).join(" · "),
          },
        ]
      : [];
  });
  const cloud = ctx.officialCodeHelperCloud?.();
  const environments = cloud?.available()
    ? await cloud.listCloudEnvironments().catch(() => [])
    : [];
  return {
    thisComputer: { projectFolder, recentFolders: local, repositories },
    ssh: hosts.map((host) => ({
      name: host.label,
      defaultFolder: host.defaultFolder,
      worktreeByDefault: false,
      recentFolders: folders(
        rows.filter(
          (row) =>
            row.environment?.kind === "ssh" &&
            row.environment.hostId === host.id,
        ),
        5,
      ),
    })),
    cloud: environments.length
      ? {
          available: true,
          targets: environments.map((environment) => ({
            kind: "environment",
            id: environment.id,
            name: environment.name,
            isDefault: environment.id === "default",
          })),
        }
      : { available: false, reason: "cloud_unavailable" },
    presets,
  };
}

export function codeModelProposalSession(
  c: Conversation | undefined,
  owner: string,
): c is Conversation {
  return (
    !!c?.cwd &&
    c.mode === "code" &&
    !c.archived &&
    !c.incognito &&
    !c.cloudHosted &&
    !c.cloudEnvironmentId &&
    !c.remoteControlStarted &&
    !c.remoteCodeWorktree &&
    !c.linkedToComputer &&
    !c.chatDeviceBinding &&
    !c.projectOrganizationId &&
    !c.scheduledRun &&
    c.worktree?.state !== "deleted" &&
    (c.environment?.kind ?? "local") === "local" &&
    (!c.sessionAuthors ||
      (c.sessionAuthors.ownerAccountUuid === owner &&
        c.sessionAuthors.viewerAccountUuid === owner))
  );
}
