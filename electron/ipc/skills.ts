import electron, { dialog, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Engine } from "../engine/engine";
import type { Store } from "../store/store";
import type { AppContext } from "../app/app-context";
import {
  assertSkillPathPrivate,
  assertSkillsFolderPrivate,
} from "../skills/skill-private";
import {
  checkSkillFolder,
  duplicateSkillFolder,
  installSkillFile,
  skillFileContents,
  skillName,
  renameSkillFolder,
} from "../skills/skill-folder";
import { skillExistsMessage } from "../../shared/skill-upload";
import { skillNamePattern } from "../../shared/duplicate-name";
import {
  importSkillFiles,
  skillImportNotification,
} from "../skills/skill-import";
import { skillImportLimits } from "../../shared/skill-import";
import { preference } from "../../shared/settings-extras";
import { scanSkillContents } from "../skills/skill-scan";

type Handle = (name: string, fn: (...args: any[]) => any) => void;
interface Context {
  readonly remote?: AppContext["remote"];
  readonly store: Store;
  readonly engine: Engine;
  readonly window: BrowserWindow | undefined;
}
type Listed = {
  path: string;
  scope?: string;
  name: string;
  enabled?: boolean;
};

/**
 * Skills: switch on and off, upload a folder, duplicate any listed skill,
 * and rename, delete or show one of the user's own.
 */
export function registerSkillHandlers(handle: Handle, context: Context) {
  // All supported upload paths enforce the local content scanner before a
  // package is written; a signed-in service adds its scan as well.
  handle("skillUploadCapabilities", () => ({ securityScan: true }));
  const serviceScan = async (contents: Map<string, Buffer>) => {
    const root = context.store.root;
    const remote = context.remote;
    if (!remote) return;
    const name =
      skillName(contents.get("SKILL.md")?.toString("utf8") ?? "") ?? "skill";
    await remote.session.authorized((token) =>
      remote.backend.client.directoryRequest(token, "/claudex/skills/scan", {
        method: "POST",
        body: {
          name,
          files: [...contents].map(([path, data]) => ({
            path,
            data: data.toString("base64"),
          })),
        },
      }),
    );
    if (root !== context.store.root || remote !== context.remote)
      throw new Error("That skill isn't in your own files.");
  };
  const userSkills = () => {
    assertSkillsFolderPrivate(context);
    return path.join(context.store.root, "codex-home", "skills");
  };
  /** A skill the runtime lists; paths from the page are never trusted as they are. */
  const listed = async (raw: unknown): Promise<Listed> => {
    const target = z.string().min(1).max(4096).parse(raw);
    const rpc = context.engine.rpc;
    if (!rpc) throw Error("The agent runtime is not running.");
    const groups =
      (await rpc.call("skills/list", { forceReload: true })).data ?? [];
    const skill = groups
      .flatMap((group: { skills?: Listed[] }) => group.skills ?? [])
      .find((item: Listed) => item.path === target);
    if (!skill) throw Error("That skill is no longer installed.");
    return skill;
  };
  const own = (skill: Listed) => {
    const folder = path.dirname(skill.path);
    if (path.dirname(folder) !== userSkills())
      throw Error("Only skills you added can be changed here.");
    assertSkillPathPrivate(context, folder);
    return folder;
  };
  handle("setSkillEnabled", async (raw: unknown, enabled: unknown) => {
    const skill = await listed(raw);
    const on = z.boolean().parse(enabled);
    await context.engine.rpc!.call("skills/config/write", {
      path: skill.path,
      enabled: on,
    });
    const disabled = new Set(context.store.settings.disabledSkills ?? []);
    if (on) disabled.delete(skill.path);
    else disabled.add(skill.path);
    context.store.settings.disabledSkills = [...disabled];
    context.store.flush();
  });
  handle("uploadSkill", async () => {
    const result = await dialog.showOpenDialog(context.window!, {
      title: "Upload skill",
      buttonLabel: "Upload",
      message: "Choose a skill folder that contains SKILL.md.",
      properties: ["openDirectory"],
    });
    const source = result.filePaths[0];
    if (!source) return null;
    const name = checkSkillFolder(source);
    const contents = new Map<string, Buffer>();
    const collect = (folder: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) collect(full);
        else contents.set(path.relative(source, full), fs.readFileSync(full));
      }
    };
    collect(source);
    scanSkillContents(contents, name);
    await serviceScan(contents);
    const target = path.join(userSkills(), name);
    if (fs.existsSync(target)) throw Error(skillExistsMessage(name));
    fs.mkdirSync(userSkills(), { recursive: true });
    fs.mkdirSync(target);
    try {
      for (const [relative, data] of contents) {
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, data, { flag: "wx" });
      }
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true });
      throw error;
    }
    return name;
  });
  // Upload a skill: .md files with a name in their front matter, and .zip or
  // .skill archives with a SKILL.md. A name that is taken is refused
  // (`skillExistsMessage`) unless `options.replace` says to swap it.
  handle("installSkillFiles", async (raw: unknown, rawOptions?: unknown) => {
    const files = z
      .array(
        z.object({
          name: z.string().min(1).max(255),
          data: z.instanceof(Uint8Array),
        }),
      )
      .min(1)
      .max(20)
      .parse(raw);
    const options = z
      .object({ replace: z.boolean().optional() })
      .optional()
      .parse(rawOptions ?? undefined);
    const installed: string[] = [];
    for (const file of files) {
      const upload = { name: file.name, data: Buffer.from(file.data) };
      await serviceScan(skillFileContents(upload));
      installed.push(installSkillFile(userSkills(), upload, options?.replace));
    }
    return installed;
  });
  handle("deleteSkill", async (raw: unknown) => {
    const skill = await listed(raw);
    fs.rmSync(own(skill), { recursive: true, force: true });
    context.store.settings.disabledSkills = (
      context.store.settings.disabledSkills ?? []
    ).filter((value) => value !== skill.path);
    context.store.flush();
  });
  handle("importSkillFiles", async (raw: unknown) => {
    const files = z
      .array(
        z.object({
          name: z.string().min(1).max(255),
          data: z
            .instanceof(Uint8Array)
            .refine((data) => data.byteLength <= skillImportLimits.bytes),
        }),
      )
      .min(1)
      .max(200)
      .parse(raw);
    const results = [];
    for (const file of files) {
      try {
        await serviceScan(
          skillFileContents(
            { name: file.name, data: Buffer.from(file.data) },
            skillImportLimits,
          ),
        );
        results.push(...importSkillFiles(userSkills(), [file]));
      } catch (error) {
        results.push({
          file: file.name,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const added = results.filter((result) => result.ok).length;
    const Notification = electron.Notification;
    if (added && context.window && Notification?.isSupported()) {
      const notice = await skillImportNotification(
        added,
        results.length - added,
        preference(context.store.settings, "locale"),
      );
      const window = context.window;
      const notification = new Notification(notice);
      notification.on("click", () => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        window.webContents.send("app:event", {
          type: "command",
          command: "customize-skills",
        });
      });
      notification.show();
    }
    return results;
  });
  const newName = (raw: unknown) =>
    z
      .string()
      .regex(
        skillNamePattern,
        "Names can only contain lowercase letters, numbers, and hyphens.",
      )
      .parse(raw);
  // Duplicate skill: any skill the runtime lists, copied into the user's own
  // skills folder. On the web runner the source must be inside the user's own
  // profile.
  handle("duplicateSkill", async (raw: unknown, rawName: unknown) => {
    const name = newName(rawName);
    const skill = await listed(raw);
    const folder = path.dirname(skill.path);
    assertSkillPathPrivate(context, folder);
    duplicateSkillFolder(folder, userSkills(), name);
    return name;
  });
  // Rename skill: only the user's own. A skill that was off stays off under
  // its new name (the runtime keeps on and off by path).
  handle("renameSkill", async (raw: unknown, rawName: unknown) => {
    const name = newName(rawName);
    const skill = await listed(raw);
    const folder = own(skill);
    const disabled = new Set(context.store.settings.disabledSkills ?? []);
    const off = skill.enabled === false || disabled.has(skill.path);
    const target = renameSkillFolder(folder, userSkills(), name);
    if (off) {
      const moved = path.join(target, path.basename(skill.path));
      const rpc = context.engine.rpc;
      await rpc
        ?.call("skills/config/write", { path: moved, enabled: false })
        .catch(() => {});
      // The old path's entry would turn off a later skill of that name.
      await rpc
        ?.call("skills/config/write", { path: skill.path, enabled: true })
        .catch(() => {});
      disabled.delete(skill.path);
      disabled.add(moved);
      context.store.settings.disabledSkills = [...disabled];
      context.store.flush();
    }
    return name;
  });
  handle("revealSkill", async (raw: unknown) => {
    shell.showItemInFolder((await listed(raw)).path);
  });
  handle("listSkills", async () => {
    const rpc = context.engine.rpc;
    if (!rpc) return [];
    const r = await rpc.call("skills/list", { forceReload: true });
    return r.data ?? [];
  });
  handle("saveSkill", async (raw: unknown) => {
    const skill = z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        description: z.string().min(1).max(1024),
        instructions: z.string().min(1).max(100000),
      })
      .parse(raw);
    const folder = path.join(userSkills(), skill.name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "SKILL.md"),
      `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`,
      { flag: "wx", mode: 0o600 },
    );
  });
}
