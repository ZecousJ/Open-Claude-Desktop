import os from "node:os";
import { directorySubmissionInput } from "../../shared/directory-submissions-input";
import { z } from "zod";
import { connectorConfigurationError } from "../../shared/connector-url-configuration";
import { id, defaultModelChoice } from "./collections";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { PluginService } from "../plugins/plugins";
import type { DirectorySubmissions } from "../connectors/directory-submissions";

/** What registerDirectoryHandlers needs from collections.ts. */
export interface RegisterDirectoryHandlersKit {
  ctx: AppContext;
  handle: IpcHandle;
  plugins: PluginService;
  submissions: () => DirectorySubmissions;
}

export function registerDirectoryHandlers(kit: RegisterDirectoryHandlersKit) {
  const { ctx, handle, plugins, submissions } = kit;
  handle("listApprovedDirectory", () => submissions().directory());
  handle("listDirectorySubmissions", () => submissions().list());
  handle(
    "saveDirectorySubmission",
    async (raw: unknown, rawSubmit: unknown) => {
      const root = ctx.store.root;
      const input = directorySubmissionInput.parse(raw);
      input.slug =
        input.slug ||
        input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
      const submit = z.boolean().parse(rawSubmit);
      if (input.kind === "mcp" && submit) {
        const configurationError = connectorConfigurationError(
          input,
          input.url,
        );
        if (configurationError) throw Error(configurationError);
        const config = ctx.store.settings.mcpServers[input.serverName ?? ""] as
          { url?: string } | undefined;
        if (!config || config.url !== input.url)
          throw new Error("Failed to submit. You can try again.");
        const response = await ctx.engine.rpc?.call("mcpServerStatus/list", {});
        const server = response?.data?.find(
          (entry: { name: string }) => entry.name === input.serverName,
        );
        input.tools = Object.keys(server?.tools ?? {});
        input.toolsVerified = input.toolsVerified && input.tools.length > 0;
      }
      if (root !== ctx.store.root)
        throw new Error("That submission wasn’t found in this organization.");
      return submissions().save(input, submit);
    },
  );
  handle("deleteDirectorySubmission", (raw: unknown) =>
    submissions().delete(z.string().uuid().parse(raw)),
  );
  handle("verifyDirectorySubmissionTools", async (raw: unknown) => {
    const name = id.parse(raw);
    const response = await ctx.engine.rpc?.call("mcpServerStatus/list", {});
    const server = response?.data?.find(
      (entry: { name: string }) => entry.name === name,
    );
    return Object.keys(server?.tools ?? {});
  });
  handle("readPlugin", (raw: unknown) => plugins.read(id.parse(raw)));
  handle("installPlugin", (raw: unknown) => plugins.install(id.parse(raw)));
  handle("uninstallPlugin", (raw: unknown) => plugins.uninstall(id.parse(raw)));
  handle("addPluginMarketplace", (raw: unknown) => plugins.addMarketplace(raw));
  handle("removePluginMarketplace", (raw: unknown) =>
    plugins.removeMarketplace(id.parse(raw)),
  );
  handle("upgradePluginMarketplaces", (raw?: unknown) =>
    plugins.upgradeMarketplaces(raw === undefined ? undefined : id.parse(raw)),
  );
  handle("setPluginMarketplaceAutoSync", (raw: unknown, enabled: unknown) =>
    plugins.setAutoSync(id.parse(raw), z.boolean().parse(enabled)),
  );
  // Duplicate plugin: the copy goes to the personal marketplace in this
  // computer's home folder, which the local runtime reads. A host without a
  // window (the web runner) shares its home folder between users: refused.
  handle("duplicatePlugin", (raw: unknown, rawCopy: unknown) => {
    if (ctx.window === undefined)
      throw new Error("Duplicating plugins needs the Claudex desktop app.");
    const copy = z
      .object({
        name: z.string().min(1).max(64),
        displayName: z.string().min(1).max(256).optional(),
      })
      .parse(rawCopy);
    return plugins.duplicate(id.parse(raw), copy, os.homedir());
  });
  // Rename plugin: the person's own plugins in that personal marketplace.
  handle("renamePlugin", (raw: unknown, rawTo: unknown) => {
    if (ctx.window === undefined)
      throw new Error("Renaming plugins needs the Claudex desktop app.");
    const to = z
      .object({
        name: z.string().min(1).max(64),
        displayName: z.string().min(1).max(256).optional(),
      })
      .parse(rawTo);
    return plugins.rename(id.parse(raw), to, os.homedir());
  });
  // Routines on "Default" follow the default model when Settings change.
  ctx.onSettingsChanged((settings) => {
    const choice = defaultModelChoice(settings);
    if (choice)
      ctx.scheduler?.retargetDefaults(choice.providerId, choice.model);
  });
}
