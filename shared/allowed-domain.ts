/**
 * What a cloud environment's custom access may list: a domain of two or more
 * labels, with a leading "*." to match its subdomains, localhost, or an IPv4
 * address.
 */
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const octet = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const address = new RegExp(`^${octet}(?:\\.${octet}){3}$`);

export function validAllowedDomain(entry: string) {
  const raw = entry.trim();
  if (!raw || raw.length > 253) return false;
  const wildcard = raw.startsWith("*.");
  const host = wildcard ? raw.slice(2) : raw;
  if (address.test(host) || host.toLowerCase() === "localhost")
    return !wildcard;
  const labels = host.split(".");
  return (
    labels.length >= 2 &&
    labels.every((part) => label.test(part)) &&
    !/^\d+$/.test(labels.at(-1)!)
  );
}

export const invalidDomainMessage =
  "Invalid domain. Use example.com, *.example.com to match subdomains, or a local address like localhost or 127.0.0.1.";

export const domainsRequiredMessage =
  "Enter at least one domain, or choose another access level.";
