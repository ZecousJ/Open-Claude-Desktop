import { sensitiveSite } from "./chrome-cookies";

/** A host on a private network (RFC 1918, link-local, unique local, .local). */
export function privateNetworkHost(host: string) {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (name.endsWith(".local")) return true;
  const v4 = name.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return /^f[cd][0-9a-f]{2}:/.test(name) || /^fe[89ab][0-9a-f]:/.test(name);
}

export type SiteRisk = "financial" | "high-risk" | "blocked" | undefined;

/**
 * What the browser panel knows about a site before the agent goes there: a
 * private-network host counts as high risk and a bank as financial. The
 * original also posts every URL to its vendor's classification service;
 * Claudex sends no address anywhere, so "blocked" is never decided here.
 */
export class SiteRiskChecks {
  private cache = new Map<string, { expires: number; risk: SiteRisk }>();

  async check(url: string): Promise<SiteRisk> {
    const parsed = new URL(url);
    if (privateNetworkHost(parsed.hostname)) return "high-risk";
    const saved = this.cache.get(parsed.origin);
    if (saved && saved.expires > Date.now()) return saved.risk;
    const risk: SiteRisk =
      sensitiveSite(parsed.hostname) === "financial" ? "financial" : undefined;
    if (this.cache.size >= 1000) this.cache.clear();
    this.cache.set(parsed.origin, { expires: Date.now() + 5 * 60_000, risk });
    return risk;
  }
}
