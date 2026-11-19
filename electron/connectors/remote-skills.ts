import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { z } from "zod";
import { connectorAllowed } from "../../shared/client-policy-rules";
import {
  mcpConnectionIdentity,
  mcpPolicyIdentity,
} from "../../shared/mcp-connection-identity";
import { validResourceBase64 } from "../../shared/message-resources";
import type { ClientPolicy } from "../../shared/client-policy";
import type { McpServerState } from "../../shared/settings-desktop-api";
import type { Conversation } from "../../shared/types";
import { withArtifactConnector } from "../artifacts/artifact-tools";
import type { RemoteConnectorSkillResolver } from "../engine/skill-invocation";
import { connectorUuid } from "../official-ui/api/connector-auth";
import type { Store } from "../store/store";
import { ConnectorClients } from "./connector-clients";

const extension = "io.modelcontextprotocol/skills";
const indexUri = "skill://index.json";
const maxIndexBytes = 512 * 1024;
const maxSkillBytes = 256 * 1024;
const remoteConfig = z.looseObject({
  url: z.string().min(1),
  command: z.undefined().optional(),
  enabled: z.boolean().optional(),
});
const capabilitiesSchema = z.object({
  extensions: z.record(z.string(), z.unknown()).optional(),
});
const indexSchema = z.object({
  skills: z
    .array(
      z.object({
        frontmatter: z.object({
          name: z
            .string()
            .max(64)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          description: z.string().max(1024),
        }),
        url: z.string().min(1).max(8192),
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      }),
    )
    .max(256),
});
const resourceSchema = z.object({
  contents: z.array(
    z.object({
      uri: z.string(),
      text: z.string().optional(),
      blob: z.string().optional(),
    }),
  ),
});

type SkillIndex = z.infer<typeof indexSchema>["skills"];
type ConnectorRequest = (method: string, params: unknown) => Promise<unknown>;
type Host = {
  store: Store;
  current(): boolean;
  activation?(): unknown;
  policy(): ClientPolicy;
  headers(name: string): Record<string, string> | undefined;
  fetch?: typeof fetch;
};

class RemoteSkillError extends Error {}
const unavailable = () =>
  new RemoteSkillError(
    "The connector skill is unavailable. Check the connector and select the skill again.",
  );
const changed = () =>
  new RemoteSkillError(
    "The connector or account changed. Select the skill again.",
  );

function resourceText(result: unknown, uri: string, maxBytes: number) {
  const matching = resourceSchema
    .parse(result)
    .contents.filter((entry) => entry.uri === uri);
  const [content] = matching;
  if (!content || matching.length !== 1) throw unavailable();
  const { text, blob } = content;
  if (
    text !== undefined &&
    blob === undefined &&
    Buffer.byteLength(text) <= maxBytes
  )
    return text;
  if (
    text === undefined &&
    blob &&
    blob.length <= Math.ceil(maxBytes / 3) * 4 &&
    validResourceBase64(blob)
  ) {
    const bytes = Buffer.from(blob, "base64");
    if (bytes.length <= maxBytes)
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  throw unavailable();
}

async function readIndex(request: ConnectorRequest) {
  const result = await request("resources/read", { uri: indexUri });
  const { skills } = indexSchema.parse(
    JSON.parse(resourceText(result, indexUri, maxIndexBytes)),
  );
  const counts = new Map<string, number>();
  for (const { frontmatter } of skills)
    counts.set(frontmatter.name, (counts.get(frontmatter.name) ?? 0) + 1);
  return skills.filter(({ frontmatter }) => counts.get(frontmatter.name) === 1);
}

export class RemoteConnectorSkills {
  constructor(private readonly host: Host) {}

  private target(
    name: string,
    serverUrl: string,
    conversation?: Conversation,
    requestCurrent?: () => boolean,
  ) {
    const { host } = this;
    if (!host.current() || requestCurrent?.() === false) throw changed();
    const activation = host.activation?.();
    const source = () => host.store.settings.mcpServers[name];
    const config = remoteConfig.parse(source());
    if (config.url !== serverUrl) throw changed();
    const original = structuredClone(source());
    const credentials = () =>
      new ConnectorClients(host.store.root).get(name, serverUrl);
    const client = credentials();
    const headers = host.headers(name);
    const validate = () => {
      if (
        !host.current() ||
        requestCurrent?.() === false ||
        host.activation?.() !== activation ||
        !isDeepStrictEqual(source(), original) ||
        !isDeepStrictEqual(host.headers(name), headers) ||
        !isDeepStrictEqual(credentials(), client) ||
        !connectorAllowed(host.policy(), name, config) ||
        config.enabled === false ||
        conversation?.connectorOverrides?.[name] === false
      )
        throw changed();
      if (
        client?.oauth?.posture === "auth_required" &&
        !new Headers(headers).has("Authorization")
      )
        throw unavailable();
    };
    validate();
    const connect = async <T>(
      signal: AbortSignal,
      run: (request: ConnectorRequest, skills: SkillIndex) => Promise<T>,
      noCapability?: T,
    ): Promise<T | undefined> => {
      const fetchConnector = host.fetch ?? fetch;
      const answer = await withArtifactConnector(
        config,
        async (request, capabilities) => {
          const parsed = capabilitiesSchema.safeParse(capabilities);
          if (!parsed.success) return;
          if (!Object.hasOwn(parsed.data.extensions ?? {}, extension))
            return noCapability;
          const skills = await readIndex(request);
          validate();
          return run(request, skills);
        },
        {
          fetch: (input, init) => {
            validate();
            const requestSignal = init?.signal
              ? AbortSignal.any([signal, init.signal])
              : signal;
            return fetchConnector(input, { ...init, signal: requestSignal });
          },
          headers,
          remoteOnly: Boolean(host.fetch),
          clientCapabilities: { extensions: { [extension]: {} } },
          resourceResponseLimit: 2 * 1024 * 1024,
        },
      );
      validate();
      return answer;
    };
    return { connect, validate };
  }

  async list(servers: readonly McpServerState[]) {
    const activation = this.host.activation?.();
    const discovered = new Map<
      string,
      { skills: SkillIndex; validate: () => void }
    >();
    const signal = AbortSignal.timeout(12_000);
    for (let start = 0; start < servers.length && !signal.aborted; start += 4)
      await Promise.all(
        servers.slice(start, start + 4).map(async (server) => {
          if (
            !server.url ||
            server.command ||
            server.state === "disabled" ||
            server.authStatus === "notLoggedIn"
          )
            return;
          try {
            const { connect, validate } = this.target(server.name, server.url);
            const skills = await connect(
              signal,
              async (_request, skills) => skills,
              [],
            );
            if (skills !== undefined)
              discovered.set(server.name, { skills, validate });
          } catch {}
        }),
      );
    if (!this.host.current() || this.host.activation?.() !== activation)
      throw changed();
    const available = new Map<string, SkillIndex>();
    for (const [name, { skills, validate }] of discovered) {
      try {
        validate();
        available.set(name, skills);
      } catch {}
    }
    return available;
  }

  resolve: RemoteConnectorSkillResolver = async ({
    connectorId,
    name,
    conversation,
    expected,
    current,
  }) => {
    if (!this.host.current() || current?.() === false) throw changed();
    const matching = Object.entries(this.host.store.settings.mcpServers).filter(
      ([server]) => connectorUuid(server) === connectorId,
    );
    const [target] = matching;
    if (!target || matching.length !== 1) throw unavailable();
    const [server, raw] = target;
    const config = remoteConfig.safeParse(raw);
    if (!config.success) throw unavailable();
    const serverUrl = config.data.url;
    const connection = mcpConnectionIdentity({ [server]: raw });
    if (expected && expected.connection !== connection) throw changed();
    const { connect, validate } = this.target(
      server,
      serverUrl,
      conversation,
      current,
    );
    try {
      const skill = await connect(
        AbortSignal.timeout(30_000),
        async (request, skills) => {
          const selected = skills.find(
            ({ frontmatter }) => frontmatter.name === name,
          );
          if (!selected) throw unavailable();
          const uri = selected.url;
          const resource = mcpPolicyIdentity({ uri });
          if (expected && expected.resource !== resource) throw changed();
          const text = resourceText(
            await request("resources/read", { uri }),
            uri,
            maxSkillBytes,
          );
          const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
          if (!header) throw unavailable();
          const frontmatter = parseDocument(header[1]);
          if (frontmatter.errors.length || frontmatter.get("name") !== name)
            throw unavailable();
          return { resource, text };
        },
      );
      if (!skill) throw unavailable();
      return { ...skill, connection, validate };
    } catch (error) {
      validate();
      throw error instanceof RemoteSkillError ? error : unavailable();
    }
  };
}

const catalogs = new WeakMap<Store, RemoteConnectorSkills>();

export function registerRemoteConnectorSkills(host: Host) {
  const catalog = new RemoteConnectorSkills(host);
  catalogs.set(host.store, catalog);
  return catalog;
}

export function remoteConnectorSkillsFor(store: Store) {
  return catalogs.get(store);
}
