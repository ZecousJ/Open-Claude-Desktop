import type { DesktopAPI, Snapshot } from "../../../shared/types";
import type { ModelCatalog } from "../../../shared/model-catalog-api";

/** Explicit offline bridge scenarios. They never call a model or modify a
 * live service, and are inactive unless their own query flags are present. */
export function applyMenuAsyncFixture(
  api: Partial<DesktopAPI>,
  params: URLSearchParams,
  state: Snapshot,
) {
  const delay = (key: string) => {
    const value = Number(params.get(key));
    return Number.isFinite(value) ? Math.min(30_000, Math.max(0, value)) : 0;
  };
  const wait = (ms: number) =>
    ms ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  const catalogCase = params.get("catalog");
  if (["some", "null", "error-once", "error"].includes(catalogCase ?? "")) {
    const provider = state.settings.providers[0];
    const extra = Math.min(80, Math.max(0, Math.floor(Number(params.get("catalogExtra")) || 0)));
    const additions = Array.from({ length: extra }, (_, i) => `qa-model-${i + 1}`);
    if (provider && additions.length)
      provider.models = [...new Set([...provider.models, ...additions])];
    const ids = [...new Set(state.settings.providers.flatMap((p) => [p.model, ...p.models]))];
    const catalog: ModelCatalog = {
      defaultModel: provider?.model ?? null,
      items: ids.map((id, sort) => ({
        id,
        displayName: id.startsWith("qa-model-") ? `QA model ${id.slice(9)}` : id,
        description: id.startsWith("Opus")
          ? "For complex work and everyday tasks"
          : id.startsWith("Sonnet")
            ? "Most efficient for simpler tasks"
            : id.startsWith("Haiku") ? "Fastest for quick answers" : "",
        badges: [],
        sort,
        hidden: id.startsWith("qa-model-"),
        isDefault: id === provider?.model,
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultEffort: "medium",
        usageHint: "",
      })),
    };
    let reads = 0;
    api.modelCatalog = async () => {
      const attempt = ++reads;
      await wait(delay("catalogDelay"));
      if (catalogCase === "error" || (catalogCase === "error-once" && attempt === 1))
        throw Error("Offline fixture catalog request failed.");
      return catalogCase === "null" ? null : structuredClone(catalog);
    };
  }
  // A genuinely empty enabled inventory is separate from pending/failure.
  if (params.get("skillMenu") === "empty") api.customizeSkills = async () => [];
  const wrap = <T,>(read: (() => Promise<T>) | undefined, key: string) => {
    if (!read || (!params.has(`${key}Delay`) && !params.has(`${key}Failure`))) return read;
    let reads = 0;
    return async () => {
      const attempt = ++reads;
      await wait(delay(`${key}Delay`));
      const failure = params.get(`${key}Failure`);
      if (failure === "always" || (failure === "once" && attempt === 1))
        throw Error(`Offline fixture ${key} request failed.`);
      return read();
    };
  };
  const skills = wrap(api.customizeSkills, "skills");
  const designs = wrap(api.listDesignSystems, "designs");
  if (skills) api.customizeSkills = skills;
  if (designs) api.listDesignSystems = designs;

  // A partial cloud failure still resolves the local snapshot. The flag
  // remains failed after Retry: this fixture never invents a recovery.
  const projectCase = params.get("projectCatalog");
  if (projectCase === "failed" || projectCase === "cached") {
    const cached = projectCase === "cached";
    state.projectCatalog = { status: "failed", cached };
    if (cached && !state.projects.length)
      state.projects.push({
        id: "qa-cached-cloud-project",
        name: "QA cached cloud project",
        description: "Offline fixture: a usable cloud row from an earlier read.",
        instructions: "",
        createdAt: 1,
      });
    const read = api.snapshot;
    let reads = 0;
    if (read)
      api.snapshot = async () => {
        // Boot remains atomic; only later real snapshot retries are delayed.
        if (++reads > 1) await wait(delay("projectCatalogDelay"));
        return read();
      };
  }
}
