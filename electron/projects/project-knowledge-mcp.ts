import { createHash } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../app/app-context";
import type { KnowledgeMcpResource } from "../../shared/collections-api";
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

// MCP resources as project knowledge: each connected remote MCP server that
// lists resources gets a submenu; a resource, or a URL the server resolves, is
// read with resources/read and kept as a synced file.
export const mcpResourceFailure = "Failed to add MCP resource";
export const mcpResolveFailure =
  "Failed to resolve URL. Make sure the MCP server supports this URL.";

/** The most resources a submenu lists. */
const resourceLimit = 500;

export const knowledgeMcpResourceInput = z.object({
  uri: z.string().min(1).max(4096),
  name: z.string().min(1).max(500),
  title: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  mimeType: z.string().max(200).optional(),
});

const listed = z.object({
  resources: z.array(z.unknown()).default([]),
  nextCursor: z.string().optional(),
});
const contents = z.object({
  contents: z.array(
    z.object({
      uri: z.string().optional(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
      blob: z.string().optional(),
    }),
  ),
});

/** The resource as the menu shows it; undefined for one it can't use. */
function resourceOf(value: unknown): KnowledgeMcpResource | undefined {
  const parsed = knowledgeMcpResourceInput.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A file name for a resource: its title or name, kept as Markdown unless it is text already. */
export function mcpResourceFileName(resource: KnowledgeMcpResource) {
  const base = (resource.title || resource.name)
    .replace(/[\\/]/g, " ")
    .slice(0, 100)
    .trim();
  const textual = /\.(md|txt|csv|json|html?|xml|ya?ml)$/i.test(base);
  return knowledgeName(textual ? base : `${base || "resource"}.md`);
}

export class ProjectKnowledgeMcp {
  private syncing = new Set<string>();
  constructor(
    private context: Pick<AppContext, "store" | "policy" | "connectors">,
    private connect = withArtifactConnector,
  ) {}

  /** A connected, allowed remote MCP server's settings. */
  private config(server: string) {
    const raw = this.context.store.settings.mcpServers[server];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new KnowledgeSourceError("reconnect", mcpResourceFailure);
    const config = raw as Record<string, unknown>;
    if (typeof config.url !== "string" || config.enabled === false)
      throw new KnowledgeSourceError("reconnect", mcpResourceFailure);
    if (!connectorAllowed(this.context.policy(), server, config))
      throw new KnowledgeSourceError("forbidden", mcpResourceFailure);
    return config;
  }

  private async session<Result>(
    server: string,
    action: (
      request: (method: string, params: unknown) => Promise<any>,
    ) => Promise<Result>,
  ) {
    const config = this.config(server);
    await this.context.connectors?.assertUrl(config.url as string);
    return withKnowledgeProviderErrors(
      this.context.connectors?.fetch ?? fetch,
      (request) =>
        this.connect(config, action, {
          fetch: request,
          token: this.context.connectors?.getToken?.(server),
          remoteOnly: Boolean(this.context.connectors),
        }),
    );
  }

  private async list(server: string) {
    return this.session(server, async (request) => {
      const resources: KnowledgeMcpResource[] = [];
      let cursor: string | undefined;
      for (
        let page = 0;
        page < 20 && resources.length < resourceLimit;
        page++
      ) {
        const result = listed.parse(
          await request("resources/list", cursor ? { cursor } : {}),
        );
        for (const value of result.resources) {
          const resource = resourceOf(value);
          if (resource) resources.push(resource);
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return resources.slice(0, resourceLimit);
    });
  }

  /** The connected remote servers that list at least one resource. */
  async servers() {
    const names = Object.keys(this.context.store.settings.mcpServers);
    const found = await Promise.all(
      names.map(async (server) => {
        try {
          return (await this.list(server)).length ? server : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return found.filter((server): server is string => server !== undefined);
  }

  /** A server's resources, filtered by name, title, description or URI. */
  async resources(server: string, query = "") {
    const words = query.trim().toLowerCase();
    const resources = await this.list(server);
    return words
      ? resources.filter((resource) =>
          [resource.name, resource.title, resource.description, resource.uri]
            .filter(Boolean)
            .some((value) => value!.toLowerCase().includes(words)),
        )
      : resources;
  }

  /** A pasted URL as one of the server's resources, read to check it. */
  async resolve(server: string, uri: string) {
    const url = z.string().url().max(4096).parse(uri);
    try {
      await this.read(server, { uri: url, name: url });
    } catch (error) {
      const reason = knowledgeSourceFailure(error);
      throw new KnowledgeSourceError(
        reason === "temporary" ? "resolution" : reason,
        reason === "reconnect"
          ? "Reconnect the source to resolve this URL."
          : reason === "forbidden"
            ? "Access to this resource was denied."
            : reason === "not-found"
              ? "This resource is no longer available."
              : mcpResolveFailure,
      );
    }
    const listedResource = (await this.list(server).catch(() => [])).find(
      (resource) => resource.uri === url,
    );
    return listedResource ?? { uri: url, name: url };
  }

  private async read(server: string, resource: KnowledgeMcpResource) {
    return this.session(server, async (request) => {
      const result = contents.parse(
        await request("resources/read", { uri: resource.uri }),
      );
      const text = result.contents
        .map(
          (part) =>
            part.text ??
            (part.blob && /^text\/|json|xml|yaml/.test(part.mimeType ?? "")
              ? Buffer.from(part.blob, "base64").toString("utf8")
              : ""),
        )
        .filter(Boolean)
        .join("\n\n");
      if (!text) throw new Error(mcpResourceFailure);
      const data = Buffer.from(text, "utf8");
      if (data.length > knowledgeFileLimit) throw new Error(mcpResourceFailure);
      return data;
    });
  }

  async add(
    store: ProjectKnowledgeStore,
    projectId: string,
    server: string,
    resource: KnowledgeMcpResource,
  ) {
    store.folder(projectId);
    const checked = knowledgeMcpResourceInput.parse(resource);
    let data: Buffer;
    try {
      data = await this.read(server, checked);
    } catch {
      throw new Error(mcpResourceFailure);
    }
    const used = store
      .list(projectId)
      .files.reduce((sum, file) => sum + file.bytes, 0);
    if (used + data.length > knowledgeProjectLimit)
      throw new Error(mcpResourceFailure);
    const hash = createHash("sha256")
      .update(`${server}:${checked.uri}`)
      .digest("hex")
      .slice(0, 24);
    const folder = server
      .replace(/[^\w.-]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 100);
    const name = `${folder}/${hash}/${mcpResourceFileName(checked)}`;
    store.add(projectId, [{ name, data }]);
    return store.setSource(projectId, name, {
      provider: "mcp",
      server,
      uri: checked.uri,
      name: checked.name,
      ...(checked.title ? { title: checked.title } : {}),
      ...(checked.mimeType ? { mimeType: checked.mimeType } : {}),
      status: "idle",
      lastSyncedAt: Date.now(),
    });
  }

  async sync(store: ProjectKnowledgeStore, projectId: string, name: string) {
    const key = `${store.folder(projectId)}/${name}`;
    if (this.syncing.has(key)) throw new Error(mcpResourceFailure);
    const source = store
      .list(projectId)
      .files.find((file) => file.name === name)?.source;
    if (source?.provider !== "mcp") throw new Error(mcpResourceFailure);
    this.syncing.add(key);
    try {
      const data = await this.read(source.server, {
        uri: source.uri,
        name: source.name,
      });
      const current = store
        .list(projectId)
        .files.find((file) => file.name === name)?.source;
      if (JSON.stringify(current) !== JSON.stringify(source))
        return store.list(projectId);
      store.add(projectId, [{ name, data }]);
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
      if (JSON.stringify(current) !== JSON.stringify(source))
        return store.list(projectId);
      return store.setSource(projectId, name, {
        ...source,
        ...knowledgeFailureState(error),
      });
    } finally {
      this.syncing.delete(key);
    }
  }
}
