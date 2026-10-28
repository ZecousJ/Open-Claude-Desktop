import type { Provider } from "../../shared/types";
import type { ClientPolicy } from "../../shared/client-policy";
import { loadSub2ApiConfig } from "../../server/sub2api-config";
import {
  isMoreUsageUrl,
  resolveRequestLimits,
  type RequestLimits,
} from "../../server/operator-limits";
import type { StorageCipher } from "../engine/provider-credentials";
import { RemoteAccounts } from "../sub2api/identity";
import { sub2apiProviderId } from "../sub2api/backend-support";
import type { BannerPolicy } from "../sub2api/quota";

/** Claudex account sign-in, always: there are no local accounts. */
export function remoteAccountsFor(root: string, cipher: StorageCipher) {
  return new RemoteAccounts(root, loadSub2ApiConfig(root).baseUrl, cipher);
}

/**
 * Sub2API meters and refuses by its own USD windows, so the local token
 * caps are dropped; concurrency and per-minute limits remain a local guard.
 */
export function remoteRequestLimits(
  root: string,
  accountId: string,
): RequestLimits {
  return {
    ...resolveRequestLimits(root, accountId),
    dailyTokenLimit: null,
    weeklyTokenLimit: null,
  };
}

/**
 * The banner's warning threshold and Get more usage page come from the
 * administrator's policy (`usageBanner`, `links.getMoreUsage`), not from
 * limits.json. An older service without the page offers its purchase page.
 */
export async function remoteBannerPolicy(
  policy: Pick<ClientPolicy, "usageBanner" | "links">,
  accounts: RemoteAccounts,
): Promise<BannerPolicy> {
  const page = policy.links.getMoreUsage;
  if (page && isMoreUsageUrl(page))
    return { warnPercent: policy.usageBanner.warnPercent, moreUsageUrl: page };
  const purchase = await accounts
    .publicSettings()
    .then((settings) => settings.purchaseUrl)
    .catch(() => "");
  return {
    warnPercent: policy.usageBanner.warnPercent,
    moreUsageUrl: isMoreUsageUrl(purchase) ? purchase : null,
  };
}

/** The provider before the plan is known, so the key vault can be opened. */
export function placeholderProvider(accounts: RemoteAccounts): Provider {
  return {
    id: sub2apiProviderId,
    name: "Claudex",
    baseUrl: `${accounts.baseUrl}/v1`,
    protocol: "responses",
    model: "",
    models: [],
    backend: "sub2api",
  };
}
