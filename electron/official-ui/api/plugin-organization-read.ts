import type http from "node:http";
import {
  officialPluginOrganizationTarget,
  pluginOrganizationNotFoundCode,
  pluginOrganizationRefusal,
  pluginOrganizationResponse,
  validPluginOrganizationQuery,
} from "../../../shared/official-plugin-organizations";
import { Sub2ApiError } from "../../sub2api/http";
import { installedOrganizationPluginItems, organizationRuntimeCandidates } from "../../../shared/official-organization-catalog";
import { organizationUuid, reply, type AdapterContext } from "./context";

export async function readInstalledOrganizationPlugins(ctx: AdapterContext) {
  const owner = ctx.account()?.id;
  if (!owner || !ctx.readPluginOrganization || !ctx.readOrganizationPluginStates) return [];
  const identity = ctx.sessionIdentity?.();
  const root = ctx.stateDirectory?.();
  let value: unknown;
  try {
    value = await ctx.readPluginOrganization({ kind: "catalog", organization: organizationUuid(owner), view: "home" });
  } catch (error) {
    if (error instanceof Sub2ApiError && error.status === 404) return [];
    throw error;
  }
  if (ctx.isCurrent?.() === false || ctx.account()?.id !== owner || ctx.sessionIdentity?.() !== identity || ctx.stateDirectory?.() !== root)
    throw Error("The account changed.");
  const states = await ctx.readOrganizationPluginStates(organizationRuntimeCandidates.parse(value));
  return states ? installedOrganizationPluginItems(value, states) : [];
}

export async function pluginOrganizationRead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: AdapterContext,
) {
  const target = officialPluginOrganizationTarget(req.method ?? "GET", url.pathname, url.search);
  if (!target) return false;
  const refuse = (status: number) => reply(res, pluginOrganizationRefusal(status), status);
  const owner = ctx.account()?.id;
  const identity = ctx.sessionIdentity?.();
  if (!owner) return refuse(401);
  if (!validPluginOrganizationQuery(target, url.search)) return refuse(400);
  const current = () => ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner && ctx.sessionIdentity?.() === identity;
  if (!current()) return refuse(409);
  const home = target.kind === "catalog" && target.view === "home";
  if (target.kind === "catalog" && target.organization.toLowerCase() !== organizationUuid(owner))
    return refuse(404);
  if (target.kind === "marketplaces" && target.organization.toLowerCase() === organizationUuid(owner))
    return reply(res, { marketplaces: [] });
  if (!ctx.readPluginOrganization) return home ? reply(res, { blocks: [] }) : refuse(503);
  try {
    const value = await ctx.readPluginOrganization(target);
    if (!current()) return refuse(409);
    const states = target.kind === "catalog" && ctx.readOrganizationPluginStates
      ? await ctx.readOrganizationPluginStates(organizationRuntimeCandidates.parse(value))
      : undefined;
    if (!current()) return refuse(409);
    return reply(res, pluginOrganizationResponse(target, value, url.search, states));
  } catch (error) {
    if (!current()) return refuse(409);
    if (home) return reply(res, { blocks: [] });
    const absent = target.kind === "marketplaces" && error instanceof Sub2ApiError &&
      error.status === 404 && error.code === pluginOrganizationNotFoundCode;
    return refuse(absent ? 404 : 503);
  }
}
