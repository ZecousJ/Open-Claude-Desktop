import { z } from "zod";
import path from "node:path";
import { preference } from "../../../shared/settings-extras";
import { builtInOutputStyles } from "../../../shared/output-styles";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";

/** The settings affect new local Code sessions; no workspace files are read. */
export function registerCodeSandbox(host: NativeHost) {
  const { ctx } = host;
  const account = sessionAccountScope(ctx, () => {});
  const current = () => {
    account.sync();
    if (!ctx.account()?.id || ctx.isCurrent?.() === false)
      throw Error("This account window has retired.");
  };
  const state = () => {
    current();
    return ctx.codeLocalSandboxState?.();
  };
  const status = () => {
    const runtime = state();
    const available = runtime?.available === true && !runtime.policyLocked && !ctx.readOnly && !!ctx.localCall;
    const settings = ctx.settings();
    return {
      enabled: available && preference(settings, "codeLocalSandbox"),
      enabledSource: available ? "settings" : "off",
      strictMode: available && preference(settings, "codeStrictSandbox"),
      strictModeSource: available ? "settings" : "off",
      ...(runtime?.windowsInstalled !== undefined && {
        windowsInstall: { installed: runtime.windowsInstalled, policyLocked: runtime.policyLocked },
      }),
      ...(!available && { unavailableReason: runtime?.policyLocked
        ? "Local sandbox settings are managed by your organization."
        : "Local sandbox is unavailable on this host." }),
    };
  };
  const save = (key: "codeLocalSandbox" | "codeStrictSandbox", value: unknown, sessionId?: unknown) =>
    account.run(async () => {
      const enabled = z.boolean().parse(value);
      if (sessionId !== undefined) z.string().parse(sessionId);
      const runtime = state();
      if (!runtime?.available || runtime.policyLocked || ctx.readOnly || !ctx.localCall || sessionId !== undefined)
        return { status: "unavailable", sandboxStatus: status() };
      if (key === "codeStrictSandbox" && enabled && !preference(ctx.settings(), "codeLocalSandbox"))
        return { status: "unavailable", sandboxStatus: status() };
      if (key === "codeLocalSandbox" && enabled && runtime.windowsInstalled === false) {
        const setup = await account.guard(() => ctx.localCall!("setupWindowsSandbox"));
        current();
        const result = z.object({ ready: z.boolean(), message: z.string() }).parse(setup);
        if (!result.ready) return { status: "error", message: result.message };
        const latest = state();
        if (!latest?.available || latest.policyLocked || latest.windowsInstalled !== true)
          return { status: "unavailable", sandboxStatus: status() };
      }
      await account.guard(() => ctx.localCall!("saveSettings", { ...ctx.settings(), [key]: enabled }));
      current();
      return preference(ctx.settings(), key) === enabled ? { status: "ok" } : { status: "error" };
    });
  host.on("ClaudeCode.resolveLocalSettings", (workspace: unknown, options: unknown) => {
    current();
    const folder = z.string().nullish().parse(workspace);
    if (folder != null && !path.isAbsolute(folder)) throw Error("workspacePath must be absolute");
    z.object({ boundedManagedSettingsWait: z.boolean().optional(), retryFailedManagedSettings: z.boolean().optional() }).optional().parse(options);
    const runtime = state();
    return {
      outputStyle: { value: preference(ctx.settings(), "codeOutputStyle"), source: "user" },
      ...(runtime?.available && !runtime.policyLocked ? {
        sandboxEnabled: { value: preference(ctx.settings(), "codeLocalSandbox"), source: "user" },
        strictSandboxMode: { value: preference(ctx.settings(), "codeStrictSandbox"), source: "user" },
      } : {}),
    };
  });
  host.on("ClaudeCode.patchUserSettings", (patch: unknown) => account.run(async () => {
    current();
    const parsed = z.object({ outputStyle: z.string().optional() }).strict().safeParse(patch);
    if (!parsed.success || !Object.hasOwn(parsed.data, "outputStyle") || ctx.readOnly || !ctx.localCall)
      return false;
    const style = parsed.data.outputStyle;
    if (style !== undefined && !builtInOutputStyles.some(item => item.name === style)) return false;
    const codeOutputStyle = style === "default" ? "" : (style ?? "");
    await account.guard(() => ctx.localCall!("saveSettings", { ...ctx.settings(), codeOutputStyle }));
    current();
    return preference(ctx.settings(), "codeOutputStyle") === codeOutputStyle;
  }));
  host.on("ClaudeCode.getLocalSandboxStatus", status);
  host.on("ClaudeCode.setLocalSandboxEnabled", (enabled: unknown) => save("codeLocalSandbox", enabled));
  host.on("ClaudeCode.setStrictSandboxMode", (strict: unknown, sessionId: unknown) => save("codeStrictSandbox", strict, sessionId));
  return ctx.onEvent(event => {
    if (event.type === "settings" || event.type === "policy" || event.type === "resync")
      host.emit("ClaudeCode", "resolvedSettingsChanged");
  });
}
