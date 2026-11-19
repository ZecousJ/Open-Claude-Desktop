import { z } from "zod";
import type { Store } from "../../store/store";
import type { NativeHost } from "./host";

const scopeId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((id) => id !== "__proto__");
const variables = z.record(z.string(), z.string());
const managedNames = new Set([
  "PATH",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BASE_URL",
  "DISABLE_AUTOUPDATER",
  "CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES",
  "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
  "CLAUDE_CODE_DISABLE_CRON",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_AGENT_SDK_MCP_NO_PREFIX",
  "CLAUDE_CODE_PROCESS_WRAPPER",
  "CLAUDEX_GATEWAY_TOKEN",
]);
const machineOnly = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR"]);

export const codeSessionEnvironmentSelection = z.object({
  envScopeId: z.string().optional(),
  startedFromEnvironmentId: z.string().min(1).max(128).nullish(),
});

export type CodeSessionEnvironmentSelection = z.infer<
  typeof codeSessionEnvironmentSelection
>;

const mask = "••••••";

function preview(value: string) {
  return value.length < 17
    ? mask
    : value.slice(0, 10) + "..." + value.slice(-4);
}

function previews(values: Record<string, string> = {}) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, preview(value)]),
  );
}

function editedValues(
  input: unknown,
  scoped: boolean,
  previous: Record<string, string> = {},
) {
  return Object.fromEntries(
    Object.entries(variables.parse(input)).flatMap(([key, value]) => {
      const name = key.toUpperCase();
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        key === "__proto__" ||
        managedNames.has(name) ||
        (scoped && machineOnly.has(name)) ||
        value.includes("\0")
      )
        return [];
      if (
        value === mask ||
        (value.length === 17 && value.slice(10, 13) === "...")
      )
        return Object.hasOwn(previous, key) ? [[key, previous[key]]] : [];
      return [[key, value]];
    }),
  );
}

export function registerCodeSessionEnvironment(
  host: Pick<NativeHost, "ctx" | "on">,
) {
  const { ctx } = host;
  const store = (): Store => {
    const current = ctx.codeSessionEnvironmentStore?.();
    if (
      !current ||
      ctx.readOnly ||
      !ctx.account()?.id ||
      ctx.isCurrent?.() === false
    )
      throw Error("Account identity is unresolved right now");
    return current;
  };
  const save = (scope: string, input: unknown) => {
    store().updateCodeSessionEnvironment((current) => {
      const next = editedValues(
        input,
        Boolean(scope),
        Object.hasOwn(current, scope) ? current[scope] : undefined,
      );
      if (!scope || Object.keys(next).length) current[scope] = next;
      else delete current[scope];
    });
    return { success: true };
  };
  host.on("LocalSessionEnvironment.get", () =>
    previews(store().readCodeSessionEnvironment()[""]),
  );
  host.on("LocalSessionEnvironment.save", (value: unknown) => save("", value));
  host.on("LocalSessionEnvironment.getScoped", (raw: unknown) => {
    const scope = scopeId.safeParse(raw);
    if (!scope.success) return {};
    const current = store().readCodeSessionEnvironment();
    return previews(
      Object.hasOwn(current, scope.data) ? current[scope.data] : undefined,
    );
  });
  host.on(
    "LocalSessionEnvironment.saveScoped",
    (raw: unknown, value: unknown) => {
      const scope = scopeId.safeParse(raw);
      return scope.success ? save(scope.data, value) : { success: false };
    },
  );
  host.on("LocalSessionEnvironment.removeScoped", (raw: unknown) => {
    const scope = scopeId.safeParse(raw);
    if (!scope.success) return { success: false };
    store().updateCodeSessionEnvironment((current) => {
      delete current[scope.data];
    });
    return { success: true };
  });
  host.on(
    "LocalSessionEnvironment.moveIntoScopes",
    (local: unknown, remote: unknown) => {
      const localIds = z.array(scopeId).parse(local);
      const remoteIds = z.array(scopeId).parse(remote);
      let moved = false;
      store().updateCodeSessionEnvironment((current) => {
        const machine = current[""];
        if (!machine) return;
        const localValues = Object.fromEntries(
          Object.entries(machine).filter(
            ([key]) => !machineOnly.has(key.toUpperCase()),
          ),
        );
        const remoteValues = Object.fromEntries(
          Object.entries(localValues).filter(([key]) =>
            /^(?:CLAUDE_|ANTHROPIC_|DISABLE_|ENABLE_TOOL_SEARCH$)/.test(key),
          ),
        );
        for (const [ids, values] of [
          [localIds, localValues],
          [remoteIds, remoteValues],
        ] as const) {
          if (!ids.length || !Object.keys(values).length) continue;
          for (const id of ids)
            current[id] = {
              ...values,
              ...(Object.hasOwn(current, id) ? current[id] : {}),
            };
          for (const key of Object.keys(values)) delete machine[key];
          moved = true;
        }
      });
      return { moved };
    },
  );
}
