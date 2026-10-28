import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../app/app-context";
import type { KnowledgeDriveFile } from "../../shared/collections-api";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { withArtifactConnector } from "../artifacts/artifact-tools";
import {
  KnowledgeSourceError,
  knowledgeFailureState,
  knowledgeSourceFailure,
  withKnowledgeProviderErrors,
} from "./project-knowledge-errors";
import {
  knowledgeFileLimit,
  knowledgeName,
  knowledgeProjectLimit,
  ProjectKnowledgeStore,
} from "./project-knowledge";

const failure = "Google Drive is temporarily unavailable. You can try again.";
const driveUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["drive.google.com", "docs.google.com"].includes(url.hostname)
    );
  });
export const knowledgeDriveFileInput = z.object({
  id: z.string().min(1).max(2048),
  title: z.string().min(1).max(500),
  url: driveUrl,
});
const toolInput = z.object({
  name: z.string(),
  inputSchema: z.object({
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
  }),
});
type DriveTool = z.infer<typeof toolInput>;

function payload(result: unknown): unknown {
  const value = z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional(),
    })
    .parse(result);
  if (value.isError)
    throw new KnowledgeSourceError(
      knowledgeSourceFailure(value.structuredContent),
      failure,
    );
  if (value.structuredContent) return value.structuredContent;
  const text =
    value.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function argument(tool: DriveTool, names: string[]) {
  const key = names.find((name) =>
    Object.hasOwn(tool.inputSchema.properties, name),
  );
  if (!key || tool.inputSchema.required?.some((name) => name !== key))
    return undefined;
  return key;
}

// Drive search, fetch and refresh use the configured connector, not Google
// sign-in.
export class ProjectKnowledgeDrive {
  private syncing = new Set<string>();
  constructor(
    private context: Pick<AppContext, "store" | "policy" | "connectors">,
    private connect = withArtifactConnector,
  ) {}

  private config(server: string) {
    if (!/(?:gdrive|google.?drive)/i.test(server)) throw new Error(failure);
    const raw = this.context.store.settings.mcpServers[server];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new KnowledgeSourceError("reconnect", failure);
    const config = raw as Record<string, unknown>;
    if (config.enabled === false)
      throw new KnowledgeSourceError("reconnect", failure);
    if (!connectorAllowed(this.context.policy(), server, config))
      throw new KnowledgeSourceError("forbidden", failure);
    return config;
  }

  private async session<Result>(
    server: string,
    action: (
      request: (method: string, params: unknown) => Promise<any>,
      search: DriveTool,
      fetch: DriveTool,
    ) => Promise<Result>,
  ) {
    const config = this.config(server);
    if (typeof config.url === "string")
      await this.context.connectors?.assertUrl(config.url);
    return withKnowledgeProviderErrors(
      this.context.connectors?.fetch ?? fetch,
      (request) =>
        this.connect(
          config,
          async (request) => {
            const { tools } = z
              .object({ tools: z.array(toolInput) })
              .parse(await request("tools/list", {}));
            const enabled = tools.filter(
              (tool) =>
                !(
                  Array.isArray(config.disabled_tools) &&
                  config.disabled_tools.includes(tool.name)
                ) &&
                !(
                  Array.isArray(config.enabled_tools) &&
                  !config.enabled_tools.includes(tool.name)
                ),
            );
            const search = enabled.find(
              (tool) =>
                /(?:^|_)search$/.test(tool.name) && argument(tool, ["query"]),
            );
            const fetch = enabled.find(
              (tool) =>
                /(?:^|_)fetch$/.test(tool.name) &&
                argument(tool, ["id", "url"]),
            );
            if (!search || !fetch) throw new Error(failure);
            return action(request, search, fetch);
          },
          {
            fetch: request,
            token: this.context.connectors?.getToken?.(server),
            remoteOnly: Boolean(this.context.connectors),
          },
        ),
    );
  }

  async connectors() {
    const servers = Object.keys(this.context.store.settings.mcpServers).filter(
      (server) => /(?:gdrive|google.?drive)/i.test(server),
    );
    const available = await Promise.all(
      servers.map(async (server) => {
        try {
          return await this.session(server, async () => server);
        } catch {
          return undefined;
        }
      }),
    );
    return available.filter((server): server is string => server !== undefined);
  }

  async search(server: string, query: string) {
    z.string().trim().min(1).max(1000).parse(query);
    return this.session(server, async (request, search) => {
      const result = payload(
        await request("tools/call", {
          name: search.name,
          arguments: { query },
        }),
      );
      return z
        .object({ results: z.array(knowledgeDriveFileInput).max(200) })
        .parse(result).results;
    });
  }

  private async read(server: string, files: KnowledgeDriveFile[]) {
    return this.session(server, async (request, _search, fetch) => {
      const loaded = [];
      let bytes = 0;
      for (const file of files) {
        const key = argument(fetch, ["id", "url"])!;
        const result = payload(
          await request("tools/call", {
            name: fetch.name,
            arguments: { [key]: key === "url" ? file.url : file.id },
          }),
        );
        const { text } = z.object({ text: z.string() }).parse(result);
        const data = Buffer.from(text, "utf8");
        bytes += data.length;
        if (data.length > knowledgeFileLimit || bytes > knowledgeProjectLimit)
          throw new Error(failure);
        const hash = createHash("sha256")
          .update(`${server}:${file.id}`)
          .digest("hex")
          .slice(0, 24);
        const name = `Google Drive/${hash}/${knowledgeName(`${file.title.slice(0, 110)}.md`)}`;
        loaded.push({ name, data });
      }
      return loaded;
    });
  }

  async add(
    store: ProjectKnowledgeStore,
    projectId: string,
    server: string,
    files: KnowledgeDriveFile[],
  ) {
    store.folder(projectId);
    z.array(knowledgeDriveFileInput).min(1).max(200).parse(files);
    const loaded = await this.read(server, files);
    store.add(projectId, loaded);
    return store.setSources(
      projectId,
      Object.fromEntries(
        files.map((file, index) => [
          loaded[index].name,
          {
            ...file,
            provider: "gdrive" as const,
            server,
            status: "idle" as const,
            lastSyncedAt: Date.now(),
          },
        ]),
      ),
    );
  }

  async sync(store: ProjectKnowledgeStore, projectId: string, name: string) {
    const key = `${store.folder(projectId)}/${name}`;
    if (this.syncing.has(key)) throw new Error(failure);
    const source = store
      .list(projectId)
      .files.find((file) => file.name === name)?.source;
    if (source?.provider !== "gdrive") throw new Error(failure);
    this.syncing.add(key);
    try {
      const loaded = await this.read(source.server, [
        knowledgeDriveFileInput.parse(source),
      ]);
      const current = store
        .list(projectId)
        .files.find((file) => file.name === name)?.source;
      if (JSON.stringify(current) !== JSON.stringify(source))
        return store.list(projectId);
      store.add(projectId, [{ ...loaded[0], name }]);
      return store.setSource(projectId, name, {
        ...source,
        status: "idle",
        failure: undefined,
        lastSyncedAt: Date.now(),
      });
    } catch (error) {
      const current = store
        .list(projectId)
        .files.find((file) => file.name === name)?.source;
      if (JSON.stringify(current) === JSON.stringify(source))
        return store.setSource(projectId, name, {
          ...source,
          ...knowledgeFailureState(error),
        });
      return store.list(projectId);
    } finally {
      this.syncing.delete(key);
    }
  }
}
