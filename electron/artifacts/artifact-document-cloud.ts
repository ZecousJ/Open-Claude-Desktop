import { z } from "zod";
import type { AppContext } from "../app/app-context";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { documentCloudInput } from "../../shared/artifact-document-input";
import type {
  DocumentCloudSave,
  DocumentConnector,
} from "../../shared/artifact-document";
import { withArtifactConnector } from "./artifact-tools";

const toolsInput = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      inputSchema: z.object({
        properties: z.record(z.string(), z.unknown()).default({}),
        required: z.array(z.string()).optional(),
      }),
    }),
  ),
});
type Tool = z.infer<typeof toolsInput>["tools"][number];
const failure = "Unable to export document.";

export function documentToolArguments(tool: Tool, input: DocumentCloudSave) {
  const properties = tool.inputSchema.properties;
  const args: Record<string, unknown> = {};
  const supported =
    input.service === "notion"
      ? /(?:create.*pages?|pages?.*create)/i
      : /(?:(?:create|upload).*(?:file|document)|(?:file|document).*(?:create|upload))/i;
  if (!supported.test(tool.name)) return;
  if (
    input.service === "notion" &&
    /create[-_]pages$/i.test(tool.name) &&
    "pages" in properties
  ) {
    args.pages = [
      { properties: { title: input.title }, content: input.markdown },
    ];
  } else {
    const title = ["title", "name", "file_name", "filename"].find(
      (key) => key in properties,
    );
    const content = ["markdown", "content", "text", "body"].find(
      (key) => key in properties,
    );
    if (!title || !content) return;
    const titleSchema = properties[title] as { type?: string } | null;
    if (titleSchema?.type && titleSchema.type !== "string") return;
    const schema = properties[content] as { type?: string } | null;
    if (schema?.type && schema.type !== "string") return;
    args[title] = input.title;
    args[content] = input.markdown;
    for (const key of ["mimeType", "mime_type"])
      if (key in properties) args[key] = "application/vnd.google-apps.document";
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (key in args) continue;
    const schema = properties[key] as { default?: unknown } | null;
    if (schema && schema.default !== undefined) args[key] = schema.default;
    else return;
  }
  return args;
}

// Cloud export actions.
export class ArtifactDocumentCloud {
  constructor(
    private context: Pick<AppContext, "store" | "policy" | "connectors">,
    private connect = withArtifactConnector,
  ) {}

  private async session<Result>(
    input: DocumentConnector,
    run: (
      request: (method: string, params: unknown) => Promise<any>,
      tool: Tool,
    ) => Promise<Result>,
  ) {
    const raw = this.context.store.settings.mcpServers[input.server];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error(failure);
    const config = raw as Record<string, unknown>;
    const service = /notion/i.test(input.server)
      ? "notion"
      : /(?:gdrive|google.?drive|google.?docs)/i.test(input.server)
        ? "gdrive"
        : undefined;
    if (
      service !== input.service ||
      config.enabled === false ||
      !connectorAllowed(this.context.policy(), input.server, config)
    )
      throw new Error(failure);
    if (typeof config.url === "string")
      await this.context.connectors?.assertUrl(config.url);
    return this.connect(
      config,
      async (request) => {
        const { tools } = toolsInput.parse(await request("tools/list", {}));
        const tool = tools.find(
          (candidate) =>
            !(
              Array.isArray(config.disabled_tools) &&
              config.disabled_tools.includes(candidate.name)
            ) &&
            !(
              Array.isArray(config.enabled_tools) &&
              !config.enabled_tools.includes(candidate.name)
            ) &&
            documentToolArguments(candidate, {
              ...input,
              title: "document",
              markdown: "",
            }) !== undefined,
        );
        if (!tool) throw new Error(failure);
        return run(request, tool);
      },
      {
        fetch: this.context.connectors?.fetch,
        token: this.context.connectors?.getToken?.(input.server),
        remoteOnly: Boolean(this.context.connectors),
      },
    );
  }

  async connectors(): Promise<DocumentConnector[]> {
    const results = await Promise.all(
      Object.keys(this.context.store.settings.mcpServers).map(
        async (server) => {
          const service = /notion/i.test(server)
            ? "notion"
            : /(?:gdrive|google.?drive|google.?docs)/i.test(server)
              ? "gdrive"
              : undefined;
          if (!service) return;
          const input = { server, service } as DocumentConnector;
          try {
            return await this.session(input, async () => input);
          } catch {
            return;
          }
        },
      ),
    );
    return results.filter(
      (value): value is DocumentConnector => value !== undefined,
    );
  }

  async save(raw: unknown) {
    const input = documentCloudInput.parse(raw);
    await this.session(input, async (request, tool) => {
      const result = await request("tools/call", {
        name: tool.name,
        arguments: documentToolArguments(tool, input),
      });
      if (!result || result.isError) throw new Error(failure);
    });
  }
}
