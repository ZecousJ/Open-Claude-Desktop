import { satisfies, valid, validRange } from "semver";
import { z } from "zod";
import { extensionMcpTemplate } from "../../connectors/extension-lifecycle-support";

const manifestSchema = z
  .object({
    manifest_version: z.string().optional(),
    dxt_version: z.string().optional(),
    server: z.object({
      type: z.enum(["node", "python", "binary", "uv"]),
      mcp_config: z.object({
        command: z.string().min(1),
        platform_overrides: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
    compatibility: z
      .object({
        claude_desktop: z.string().optional(),
        platforms: z.array(z.string()).optional(),
        runtimes: z
          .object({
            node: z.string().optional(),
            python: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    user_config: z
      .record(
        z.string(),
        z.object({
          type: z.enum(["string", "number", "boolean", "directory", "file"]),
          multiple: z.boolean().optional(),
          sensitive: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

const toolsSchema = z.array(
  z.object({
    name: z.string(),
    versions: z.array(z.string()),
    builtInVersion: z.string().nullable(),
  }),
);

export function detectedExtensionRuntimes(input: unknown) {
  return toolsSchema.parse(input).map((tool) => ({
    ...tool,
    versions: tool.versions.flatMap((version) => {
      const match = version.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
      return match && valid(match[0]) ? [match[0]] : [];
    }),
  }));
}

export function extensionCompatibility(
  input: unknown,
  rawTools: unknown,
  system: { platform: string; appVersion: string; builtInNode: boolean },
) {
  const manifest = manifestSchema.parse(input);
  if (
    Object.values(manifest.user_config ?? {}).some(
      (field) =>
        (field.sensitive && field.type !== "string") ||
        (field.multiple && field.type !== "directory" && field.type !== "file"),
    )
  )
    throw Error("This extension's configuration is unavailable.");
  const tools = toolsSchema.parse(rawTools);
  const requirements: { name: string; met: boolean }[] = [];
  const constraint = manifest.compatibility;
  const matches = (version: string | undefined | null, range?: string) => {
    const match = version?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
    const parsed = match && valid(match[0]);
    if (!parsed) return false;
    return (
      range === undefined || (!!validRange(range) && satisfies(parsed, range))
    );
  };
  const formatPlatform = (name: string) =>
    (
      ({ darwin: "macOS", win32: "Windows", linux: "Linux" }) as Record<
        string,
        string
      >
    )[name] ?? name;

  const manifestVersion = manifest.manifest_version ?? manifest.dxt_version;
  if (manifestVersion) {
    const parsed = Number.parseFloat(manifestVersion);
    requirements.push({
      name: "an update to Claude Desktop",
      met: Number.isFinite(parsed) && parsed <= 0.4,
    });
  }
  if (constraint?.platforms?.length) {
    const met = constraint.platforms.includes(system.platform);
    requirements.push({
      name: met
        ? formatPlatform(system.platform)
        : constraint.platforms.map(formatPlatform).join(", "),
      met,
    });
  }
  if (constraint?.claude_desktop) {
    requirements.push({
      name: `Claude Desktop ${constraint.claude_desktop}`,
      met: matches(system.appVersion, constraint.claude_desktop),
    });
  }
  if (manifest.server.type === "node") {
    const node = tools.find((tool) => tool.name === "Node.js");
    const range = constraint?.runtimes?.node;
    const systemNode =
      node?.versions.some((version) => matches(version, range)) ?? false;
    const command =
      extensionMcpTemplate(manifest, system.platform).command ?? "";
    const builtIn =
      system.builtInNode &&
      /^node(?:\.exe)?$/.test(command) &&
      matches(node?.builtInVersion, range);
    if (constraint || !(systemNode || builtIn))
      requirements.push({
        name: range ? `Node.js ${range}` : "Node.js",
        met: systemNode || builtIn,
      });
  } else if (manifest.server.type === "python") {
    const python = tools.find((tool) => tool.name === "Python");
    const range = constraint?.runtimes?.python;
    const met =
      python?.versions.some((version) => matches(version, range)) ?? false;
    if (constraint || !met)
      requirements.push({ name: range ? `Python ${range}` : "Python", met });
  }
  return {
    compatible: requirements.every((requirement) => requirement.met),
    requirements,
  };
}
