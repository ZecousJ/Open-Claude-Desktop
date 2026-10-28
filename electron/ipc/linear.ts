import path from "node:path";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { LinearClient } from "../connectors/linear";
import { ProviderVault } from "../../server/provider-vault";
import { mcpEditingRefusal } from "../../shared/client-policy";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { linearMcpUrl } from "../../shared/linear-api";
import { linearExtension } from "../connectors/linear-extension";

export function registerLinearHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  client = new LinearClient(),
) {
  let vault: ProviderVault | undefined;
  let memoryKey = "";
  let vaultIdentity = "";
  const storage = () => {
    if (!ctx.credentials.canPersist) return undefined;
    const identity = `${ctx.store.root}:${ctx.credentials.vaultKey}`;
    if (vaultIdentity !== identity) {
      vault = undefined;
      vaultIdentity = identity;
    }
    return (vault ??= new ProviderVault(
      path.join(ctx.store.root, "linear"),
      ctx.credentials.vaultKey,
    ));
  };
  const key = () =>
    ctx.integrationTokens?.get("linear") ||
    storage()?.get("linear") ||
    memoryKey;
  const allowed = () => {
    if (!connectorAllowed(ctx.policy(), "Linear", { url: linearMcpUrl }))
      throw Error("Your administrator doesn't allow this connector.");
  };
  const editable = () => {
    allowed();
    if (!ctx.policy().localMcpEditing)
      throw Error(mcpEditingRefusal(ctx.policy()));
  };
  handle("linearStatus", () => {
    try {
      allowed();
      return { connected: Boolean(key()) };
    } catch {
      return { connected: false };
    }
  });
  handle("linearConnect", async (raw: unknown) => {
    editable();
    const token = z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .parse(raw);
    await client.connect(token);
    ctx.integrationTokens?.set("linear", token);
    storage()?.setMany({ linear: token }, ["linear"]);
    memoryKey = token;
  });
  handle("linearDisconnect", () => {
    editable();
    ctx.integrationTokens?.set("linear", undefined);
    storage()?.setMany({ linear: "" }, ["linear"]);
    memoryKey = "";
  });
  handle("linearIssues", (raw: unknown) => {
    allowed();
    const query = z.string().trim().max(300).default("").parse(raw);
    const token = key();
    if (!token) throw Error("Unable to load Linear issues.");
    return client.issues(token, query);
  });
  let cleanup: (() => void) | undefined;
  ctx.onAccountActivated?.(() => {
    cleanup?.();
    const engine = ctx.engine;
    const extension = linearExtension(key, () =>
      connectorAllowed(ctx.policy(), "Linear", { url: linearMcpUrl }),
    );
    const remove = engine.extensions.add(extension);
    engine.peerExtensions.push(extension);
    cleanup = () => {
      remove();
      const index = engine.peerExtensions.indexOf(extension);
      if (index >= 0) engine.peerExtensions.splice(index, 1);
    };
  });
  ctx.onAccountDeactivating?.(() => {
    cleanup?.();
    cleanup = undefined;
    memoryKey = "";
    vault = undefined;
    vaultIdentity = "";
  });
}
