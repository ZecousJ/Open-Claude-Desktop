import electron, { dialog, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  createAuthoredSkillFolder,
  duplicateSkillFolder,
  installSkillContents,
  installSkillFile,
  skillFileContents,
  skillReplacementSnapshot,
  skillName,
  maxSkillFolderFiles,
  officialSkillAuthoring,
  renameSkillFolder,
  withSkillName,
} from "../skills/skill-folder";
import { skillExistsMessage } from "../../shared/skill-upload";
import { skillNamePattern, skillNameTaken } from "../../shared/duplicate-name";
import { isSavedSkillName, skillNamePlan } from "../../shared/skill-name-plan";
import {
  importSkillFiles,
  skillImportNotification,
} from "../skills/skill-import";
import {
  skillImportLimits,
  type SkillImportFile,
  type SkillImportOutcome,
} from "../../shared/skill-import";
import { preference } from "../../shared/settings-extras";
import { scanSkillContents } from "../skills/skill-scan";

type Handle = (name: string, fn: (...args: any[]) => any) => void;
interface Context {
  readonly remote?: AppContext["remote"];
  readonly accountActivationIdentity?: unknown;
  readonly accountRetiring?: boolean;
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
const skillMutationQueues = new WeakMap<Store, Promise<unknown>>();
async function mutateSkills<T>(store: Store, operation: () => T | Promise<T>): Promise<T> {
  const prior = skillMutationQueues.get(store) ?? Promise.resolve();
  const work = prior.catch(() => {}).then(operation);
  skillMutationQueues.set(store, work);
  try { return await work; }
  finally { if (skillMutationQueues.get(store) === work) skillMutationQueues.delete(store); }
}
const officialUploadLimits = { ...skillImportLimits, files: maxSkillFolderFiles };
const uploadTarget = z.object({
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(128).refine((name) => [...name].length <= 64),
}).strict();
const authoredSkill = z.object({
  name: z.string().refine(isSavedSkillName),
  displayName: z.string().optional(),
  files: z.array(z.object({
    relativePath: z.string().min(1).max(4096).refine((file) =>
      !/[\\\0]/.test(file) && !/^[A-Za-z]:/.test(file) &&
      (process.platform !== "win32" || !file.includes(":")) &&
      !file.split("/").some((part) => !part || part === "." || part === "..")),
    content: z.string(),
  })).min(1).max(maxSkillFolderFiles),
});

/**
 * Skills: switch on and off, upload a folder, duplicate any listed skill,
 * and rename, delete or show one of the user's own.
 */
export function registerSkillHandlers(handle: Handle, context: Context) {
  // All supported upload paths enforce the local content scanner before a
  // package is written; a signed-in service adds its scan as well.
  handle("skillUploadCapabilities", () => ({ securityScan: true }));
  const serviceScan = async (contents: Map<string, Buffer>, currentCheck?: () => void) => {
    const root = context.store.root;
    const remote = context.remote;
    if (!remote) return;
    const name =
      skillName(contents.get("SKILL.md")?.toString("utf8") ?? "") ?? "skill";
    await remote.session.authorized((token) => {
      currentCheck?.();
      return remote.backend.client.directoryRequest(token, "/claudex/skills/scan", {
        method: "POST",
        body: {
          name,
          files: [...contents].map(([path, data]) => ({
            path,
            data: data.toString("base64"),
          })),
        },
      });
    });
    currentCheck?.();
    if (root !== context.store.root || remote !== context.remote)
      throw new Error("That skill isn't in your own files.");
  };
  const userSkills = () => {
    assertSkillsFolderPrivate(context);
    return path.join(context.store.root, "codex-home", "skills");
  };
  const captureSkillUpload = () => {
    const store = context.store,
      root = store.root,
      engine = context.engine,
      remote = context.remote,
      window = context.window,
      identity = context.accountActivationIdentity;
    const current = () =>
      identity != null &&
      context.accountActivationIdentity === identity &&
      context.accountRetiring === false &&
      context.store === store &&
      store.root === root &&
      context.engine === engine &&
      context.remote === remote;
    const check = () => {
      if (!current()) throw Error("The signed-in account changed. Try again.");
    };
    const skills = () => {
      check();
      assertSkillsFolderPrivate({ store, window });
      return path.join(root, "codex-home", "skills");
    };
    const scan = async (contents: Map<string, Buffer>) => {
      check();
      await serviceScan(contents, check);
      check();
    };
    return {
      check,
      current,
      skills,
      scan,
      async install(files: readonly SkillImportFile[], replace?: boolean) {
        const installed: string[] = [];
        for (const file of files) {
          check();
          const upload = { name: file.name, data: Buffer.from(file.data) };
          await scan(skillFileContents(upload));
          installed.push(installSkillFile(skills(), upload, replace));
        }
        return installed;
      },
      async import(files: readonly SkillImportFile[]) {
        const results: SkillImportOutcome[] = [];
        for (const file of files) {
          try {
            check();
            await scan(
              skillFileContents(
                { name: file.name, data: Buffer.from(file.data) },
                skillImportLimits,
              ),
            );
            results.push(...importSkillFiles(skills(), [file]));
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
        if (
          added &&
          current() &&
          window &&
          !window.isDestroyed() &&
          Notification?.isSupported()
        ) {
          const notice = await skillImportNotification(
            added,
            results.length - added,
            preference(store.settings, "locale"),
          );
          if (!current() || window.isDestroyed()) return results;
          const notification = new Notification(notice);
          notification.on("click", () => {
            if (!current() || window.isDestroyed()) return;
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
      },
      async chooseFolder() {
        check();
        const result = await dialog.showOpenDialog(window!, {
          title: "Upload skill",
          buttonLabel: "Upload",
          message: "Choose a skill folder that contains SKILL.md.",
          properties: ["openDirectory"],
        });
        check();
        const source = result.filePaths[0];
        if (!source) return null;
        const name = checkSkillFolder(source);
        const contents = new Map<string, Buffer>();
        const collect = (folder: string) => {
          for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const full = path.join(folder, entry.name);
            if (entry.isDirectory()) collect(full);
            else
              contents.set(path.relative(source, full), fs.readFileSync(full));
          }
        };
        collect(source);
        scanSkillContents(contents, name);
        await scan(contents);
        const destinationRoot = skills();
        const target = path.join(destinationRoot, name);
        if (fs.existsSync(target)) throw Error(skillExistsMessage(name));
        fs.mkdirSync(destinationRoot, { recursive: true });
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
      },
    };
  };
  const skillRpc = async (current?: () => boolean) => {
    const store = context.store, engine = context.engine;
    if (!engine.rpc) {
      const provider = store.settings.providers.find((item) => item.id === store.settings.activeProviderId);
      if (!provider) throw Error("The model service is unavailable.");
      await engine.ensure(provider, { interactive: false, ...(current ? { current } : {}) });
    }
    if (context.store !== store || context.engine !== engine || !engine.rpc)
      throw Error("The signed-in account changed. Try again.");
    return { store, engine, rpc: engine.rpc };
  };
  /** A skill the runtime lists; paths from the page are never trusted as they are. */
  const listed = async (raw: unknown, current?: () => boolean): Promise<Listed> => {
    const target = z.string().min(1).max(4096).parse(raw);
    const { store, engine, rpc } = await skillRpc(current);
    const groups =
      (await rpc.call("skills/list", { forceReload: true })).data ?? [];
    if (context.store !== store || context.engine !== engine || engine.rpc !== rpc)
      throw Error("The signed-in account changed. Try again.");
    const skill = groups
      .flatMap((group: { skills?: Listed[] }) => group.skills ?? [])
      .find((item: Listed) => item.path === target);
    if (!skill) throw Error("That skill is no longer installed.");
    return skill;
  };
  const own = (skill: Listed) => {
    const folder = path.dirname(skill.path);
    const root = userSkills();
    if (fs.lstatSync(folder).isSymbolicLink() || path.dirname(fs.realpathSync(folder)) !== fs.realpathSync(root))
      throw Error("Only skills you added can be changed here.");
    assertSkillPathPrivate(context, folder);
    return folder;
  };
  const setSkillEnabled = (raw: unknown, enabled: unknown) => {
    const target = z.string().min(1).max(4096).parse(raw), on = z.boolean().parse(enabled);
    const store = context.store, engine = context.engine, root = store.root;
    const identity = context.accountActivationIdentity;
    const current = () => identity != null && context.accountActivationIdentity === identity &&
      context.accountRetiring === false && context.store === store && store.root === root && context.engine === engine;
    const check = () => { if (!current()) throw Error("The signed-in account changed. The skill update outcome is not confirmed."); };
    const write = async () => {
      check();
      const { rpc } = await skillRpc(current); check();
      const checkRpc = () => { check(); if (engine.rpc !== rpc) throw Error("The skill runtime changed. The update outcome is not confirmed."); };
      const read = async () => {
        checkRpc(); const result = await rpc.call("skills/list", { forceReload: true }); checkRpc();
        const matches = (result.data ?? []).flatMap((group: {skills?: Listed[]}) => group.skills ?? []).filter((skill: Listed) => skill.path === target);
        if (matches.length !== 1) throw Error("That skill is no longer uniquely installed. The update outcome is not confirmed.");
        return matches[0] as Listed;
      };
      const skill = await read(); checkRpc();
      if (context.window === undefined) {
        if ((skill.scope ?? "user") !== "user")
          throw Error("Only your own skills can be changed here.");
        own(skill);
        assertSkillPathPrivate(context, skill.path);
      }
      // A failed RPC is not permission to replay or compensate a possibly applied write.
      try { await rpc.call("skills/config/write", { path: skill.path, enabled: on }); }
      catch { checkRpc(); throw Error("The skill update could not be confirmed. Reopen the skill to check its current state."); }
      checkRpc();
      let after: Listed;
      try { after = await read(); }
      catch { checkRpc(); throw Error("The skill update was sent, but its resulting state could not be confirmed. Reopen the skill before trying again."); }
      checkRpc();
      if (after.enabled !== on) throw Error("The skill runtime did not confirm the requested state. Reopen the skill before trying again.");
      const settings = store.settings, previous = settings.disabledSkills;
      const disabled = new Set(previous ?? []);
      if (on) disabled.delete(skill.path); else disabled.add(skill.path);
      const saved = [...disabled]; settings.disabledSkills = saved;
      try { await store.persistSkillPreference(); }
      catch {
        if (current() && store.settings === settings && settings.disabledSkills === saved) settings.disabledSkills = previous;
        throw Error("The skill changed in the runtime, but saving its restart state was not confirmed. Reopen the skill to check its state.");
      }
      checkRpc(); return after;
    };
    return { store, write };
  };
  handle("setSkillEnabled", (raw: unknown, enabled: unknown) => {
    const { store, write } = setSkillEnabled(raw, enabled);
    return mutateSkills(store, write);
  });
  handle("uploadSkill", () => captureSkillUpload().chooseFolder());
  // Upload a skill (R-1130): .md files with a name in their front matter,
  // and .zip or .skill archives with a SKILL.md. A name that is taken is
  // refused (`skillExistsMessage`) unless `options.replace` says to swap it.
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
      .object({
        replace: z.boolean().optional(),
        expectedTarget: uploadTarget.optional(),
        upload: z.object({
          target: uploadTarget.optional(),
          newName: z.string().max(128).optional(),
          carryForward: z.boolean().optional(),
          enableOnReplace: z.boolean().optional(),
        }).strict().optional(),
      })
      .optional()
      .parse(rawOptions ?? undefined);
    if (options?.upload) {
      const { target, newName, carryForward, enableOnReplace } = options.upload;
      if (options.expectedTarget || files.length !== 1 ||
        (!options.replace && (target || carryForward || enableOnReplace)) ||
        carryForward && !target)
        throw Error("Choose a valid skill upload request.");
      const upload = captureSkillUpload();
      const { store } = context;
      upload.check();
      const file = files[0];
      if (file.data.byteLength > officialUploadLimits.bytes) throw Error(officialUploadLimits.message);
      const contents = skillFileContents({ name: file.name, data: Buffer.from(file.data) }, officialUploadLimits);
      const manifest = contents.get("SKILL.md")?.toString("utf8") ?? "";
      const originalName = skillName(manifest);
      const name = newName !== undefined ? skillNamePlan(newName).name : originalName;
      if (!originalName || !name || !skillNamePattern.test(name))
        throw Error(`${file.name}: the skill needs a name of lowercase letters, numbers and hyphens in its YAML.`);
      if (target && target.name !== name)
        throw Error(`Uploaded skill is "${name}" but Replace was for "${target.name}".`);
      if (name !== originalName) contents.set("SKILL.md", Buffer.from(withSkillName(manifest, name)));
      scanSkillContents(contents, name);
      await upload.scan(contents);
      return mutateSkills(store, async () => {
        const folder = upload.skills();
        const skillPath = path.join(folder, name, "SKILL.md");
        if (target && (!fs.lstatSync(skillPath, { throwIfNoEntry: false })?.isFile() ||
          fs.realpathSync.native(target.path) !== fs.realpathSync.native(skillPath)))
          throw Error("The skill to replace no longer exists.");
        installSkillContents(folder, { name, contents, replace: options.replace === true, limits: officialUploadLimits, carryForward });
        if (enableOnReplace) {
          const installed = await listed(fs.realpathSync.native(skillPath), upload.current);
          upload.check();
          if (installed.enabled === false) await setSkillEnabled(installed.path, true).write();
          upload.check();
        }
        return [name];
      });
    }
    if (options?.expectedTarget) {
      if (!options.replace || files.length !== 1)
        throw Error("Save one existing skill at a time.");
      const expected = options.expectedTarget;
      const store = context.store,
        engine = context.engine,
        root = store.root;
      const identity = context.accountActivationIdentity,
        remote = context.remote;
      const current = () =>
        identity != null &&
        context.accountActivationIdentity === identity &&
        context.accountRetiring === false &&
        context.store === store &&
        context.engine === engine &&
        store.root === root &&
        context.remote === remote;
      const check = () => {
        if (!current())
          throw Error(
            "The signed-in account changed. The skill save outcome is not confirmed.",
          );
      };
      check();
      const { rpc } = await skillRpc(current);
      check();
      const checkRpc = () => {
        check();
        if (engine.rpc !== rpc)
          throw Error(
            "The skill runtime changed. Reopen the skill before saving.",
          );
      };
      const read = async () => {
        checkRpc();
        const result = await rpc.call("skills/list", { forceReload: true });
        checkRpc();
        const matches = (result.data ?? [])
          .flatMap((group: { skills?: Listed[] }) => group.skills ?? [])
          .filter(
            (skill: Listed) =>
              skill.path === expected.path &&
              skill.name === expected.name &&
              (skill.scope ?? "user") === "user",
          );
        if (matches.length !== 1)
          throw Error("That skill is no longer uniquely installed.");
        const skill = matches[0] as Listed,
          folder = own(skill);
        if (
          path.basename(skill.path) !== "SKILL.md" ||
          path.basename(folder) !== expected.name ||
          fs.lstatSync(skill.path).isSymbolicLink()
        )
          throw Error("Only the selected skill's own files can be saved.");
        return folder;
      };
      const folder = await read();
      checkRpc();
      const snapshot = skillReplacementSnapshot(folder);
      const upload = { name: files[0].name, data: Buffer.from(files[0].data) };
      const contents = skillFileContents(upload);
      if (
        skillName(contents.get("SKILL.md")?.toString("utf8") ?? "") !==
        expected.name
      )
        throw Error("The edited skill name must match the selected skill.");
      scanSkillContents(contents, expected.name);
      await serviceScan(contents, checkRpc);
      checkRpc();
      if ((await read()) !== folder)
        throw Error("The skill changed while saving.");
      checkRpc();
      return [
        installSkillFile(userSkills(), upload, true, undefined, {
          name: expected.name,
          fingerprint: snapshot.fingerprint,
        }),
      ];
    }
    return captureSkillUpload().install(files, options?.replace);
  });
  handle("deleteSkill", async (raw: unknown) => {
    const upload = captureSkillUpload();
    const { store, engine } = context;
    return mutateSkills(store, async () => {
      upload.check();
      const skill = await listed(raw, upload.current);
      upload.check();
      const folder = own(skill);
      if ((skill.scope ?? "user") !== "user" || path.basename(skill.path) !== "SKILL.md" ||
        !fs.lstatSync(skill.path).isFile()) throw Error("Only skills you added can be deleted here.");
      const paths = new Set([skill.path, fs.realpathSync.native(skill.path), path.join(upload.skills(), path.basename(folder), "SKILL.md")]);
      fs.rmSync(folder, { recursive: true });
      store.settings.disabledSkills = (store.settings.disabledSkills ?? []).filter((value) => !paths.has(value));
      store.flush();
      if (skill.enabled === false) {
        try { await engine.rpc?.call("skills/config/write", { path: skill.path, enabled: true }); }
        catch { throw Error("The skill was removed, but its disabled setting could not be cleared."); }
        upload.check();
      }
    });
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
    return captureSkillUpload().import(files);
  });
  const changeSkillName = async (raw: unknown, rawName: unknown, rename: boolean) => {
    const plan = skillNamePlan(rawName);
    const requestedPath = z.string().min(1).max(4096).parse(raw);
    const store = context.store, engine = context.engine, root = store.root;
    const identity = context.accountActivationIdentity;
    const current = () => identity != null && context.accountActivationIdentity === identity &&
      context.accountRetiring === false && context.store === store && store.root === root && context.engine === engine;
    const check = () => { if (!current()) throw Error("The signed-in account changed. The skill update outcome is not confirmed."); };
    check();
    return mutateSkills(store, async () => {
      check();
      const { rpc } = await skillRpc(current); check();
      const checkRpc = () => { check(); if (engine.rpc !== rpc) throw Error("The skill runtime changed. The update outcome is not confirmed."); };
      const read = async (target: string) => {
        checkRpc();
        const result = await rpc.call("skills/list", { forceReload: true });
        checkRpc();
        const matches = (result.data ?? []).flatMap((group: { skills?: Listed[] }) => group.skills ?? [])
          .filter((skill: Listed) => skill.path === target);
        if (matches.length !== 1) throw Error("That skill is no longer uniquely installed. The update outcome is not confirmed.");
        return matches[0] as Listed;
      };
      const skill = await read(requestedPath);
      checkRpc();
      const folder = rename ? fs.realpathSync.native(own(skill)) : path.dirname(skill.path);
      assertSkillPathPrivate(context, folder);
      const skills = userSkills();
      if (!rename) {
        duplicateSkillFolder(folder, skills, plan.name, plan.displayName);
        return plan.name;
      }
      const renameRoot = fs.realpathSync.native(skills);
      const target = path.join(renameRoot, plan.name);
      const moving = target !== folder;
      if (moving && fs.existsSync(target)) throw Error(skillNameTaken);
      const manifest = path.basename(skill.path);
      const sourcePaths = new Set([
        skill.path,
        path.join(folder, manifest),
        path.join(skills, path.basename(folder), manifest),
      ]);
      const movedPath = path.join(target, manifest);
      const destinationAlias = path.join(skills, plan.name, manifest);
      const disabled = new Set(store.settings.disabledSkills ?? []);
      if (!moving || (skill.enabled !== false && ![...sourcePaths].some((file) => disabled.has(file)))) {
        renameSkillFolder(folder, renameRoot, plan.name, plan.displayName);
        return plan.name;
      }

      try { await rpc.call("skills/config/write", { path: movedPath, enabled: false }); }
      catch { checkRpc(); throw Error("The renamed skill's disabled state could not be confirmed. The original skill has not been moved."); }
      checkRpc();
      const destinationWasDisabled = disabled.has(movedPath) || disabled.has(destinationAlias);
      const verifySource = async () => {
        const source = await read(requestedPath);
        checkRpc();
        if (source.name !== skill.name || source.enabled !== skill.enabled || fs.realpathSync.native(own(source)) !== folder)
          throw Error("The source skill changed while renaming. The original skill has not been moved.");
      };
      let saving = false;
      try {
        await verifySource();
        // A restart can occur on either side of the directory move.
        const prepared = new Set(store.settings.disabledSkills ?? []);
        prepared.add(skill.path).add(movedPath);
        store.settings.disabledSkills = [...prepared];
        saving = true;
        await store.persistSkillPreference();
        checkRpc();
        await verifySource();
        renameSkillFolder(folder, renameRoot, plan.name, plan.displayName);
      } catch (error) {
        if (current() && engine.rpc === rpc && !destinationWasDisabled && !fs.existsSync(target)) {
          await rpc.call("skills/config/write", { path: movedPath, enabled: true }).catch(() => {});
          checkRpc();
          if (saving) {
            store.settings.disabledSkills = (store.settings.disabledSkills ?? []).filter((file) => file !== movedPath);
            await store.persistSkillPreference().catch(() => {});
            checkRpc();
          }
        }
        throw error;
      }

      const after = await read(movedPath);
      checkRpc();
      if (after.enabled !== false)
        throw Error("The runtime did not confirm the renamed skill's disabled state. Reopen the skill to check its state.");
      store.settings.disabledSkills = (store.settings.disabledSkills ?? [])
        .filter((file) => !sourcePaths.has(file) && (file !== destinationAlias || file === movedPath));
      await store.persistSkillPreference();
      checkRpc();
      try { await rpc.call("skills/config/write", { path: skill.path, enabled: true }); }
      catch { checkRpc(); throw Error("The skill was renamed and remains disabled, but its old path's configuration could not be cleared."); }
      checkRpc();
      return plan.name;
    });
  };
  handle("duplicateSkill", (raw: unknown, rawName: unknown) => changeSkillName(raw, rawName, false));
  handle("renameSkill", (raw: unknown, rawName: unknown) => changeSkillName(raw, rawName, true));
  handle("revealSkill", async (raw: unknown) => {
    shell.showItemInFolder((await listed(raw)).path);
  });
  handle("listSkills", async () => {
    const { store, engine, rpc } = await skillRpc();
    const r = await rpc.call("skills/list", { forceReload: true });
    if (context.store !== store || context.engine !== engine || engine.rpc !== rpc)
      throw Error("The signed-in account changed. Try again.");
    return r.data ?? [];
  });
  handle("saveSkill", async (raw: unknown, source?: unknown) => {
    if (context.accountRetiring === true) throw Error("The signed-in account changed. Try again.");
    if (source === officialSkillAuthoring) {
      const { name, displayName, files } = authoredSkill.parse(raw);
      if (displayName !== undefined && skillNamePlan(displayName).name !== name)
        throw Error("The skill title must match its saved name.");
      const manifest = files.find(({ relativePath }) => relativePath === "SKILL.md");
      if (!manifest || skillName(manifest.content) !== name)
        throw Error("The skill needs a SKILL.md with its saved name.");
      createAuthoredSkillFolder(userSkills(), name, files, displayName);
      return;
    }
    const skill = z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        description: z.string().min(1).max(1024),
        instructions: z.string().min(1).max(100000),
      })
      .parse(raw);
    const folder = path.join(userSkills(), skill.name);
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory())
      throw Error("The skill folder must be a directory, not a link or file.");
    fs.mkdirSync(folder, { recursive: true });
    assertSkillPathPrivate(context, folder);
    const manifest = path.join(folder, "SKILL.md");
    if (fs.lstatSync(manifest, { throwIfNoEntry: false })) throw Error(skillNameTaken);
    fs.writeFileSync(
      manifest,
      `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`,
      { flag: "wx", mode: 0o600 },
    );
  });
  handle("editSkill", async (raw: unknown, rawText: unknown) => {
    const store = context.store, engine = context.engine, root = store.root;
    const text = z.string().min(1).max(200000).parse(rawText);
    const skill = await listed(raw);
    if (context.store !== store || context.engine !== engine || context.store.root !== root) throw Error("The account changed while editing this skill.");
    const folder = own(skill);
    if (path.basename(skill.path) !== "SKILL.md") throw Error("That skill file cannot be edited.");
    const folderStat = fs.lstatSync(folder);
    const original = fs.lstatSync(skill.path);
    if (!folderStat.isDirectory() || folderStat.isSymbolicLink() || !original.isFile() || original.isSymbolicLink())
      throw Error("That skill file cannot be edited.");
    assertSkillPathPrivate(context, skill.path);
    const temp = path.join(folder, `.claudex-edit-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, text, { flag: "wx", mode: original.mode & 0o777 });
      const nowFolder = fs.lstatSync(folder), nowFile = fs.lstatSync(skill.path);
      if (context.store !== store || context.engine !== engine || context.store.root !== root || nowFolder.dev !== folderStat.dev || nowFolder.ino !== folderStat.ino ||
          nowFile.dev !== original.dev || nowFile.ino !== original.ino || nowFile.isSymbolicLink())
        throw Error("The skill changed while it was being edited. Try again.");
      assertSkillPathPrivate(context, skill.path);
      fs.renameSync(temp, skill.path);
    } finally { try { fs.unlinkSync(temp); } catch {} }
  });
}
