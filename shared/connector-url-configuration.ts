export type ServerUrlType = "universal" | "multiple" | "regex" | "template";

export interface ConnectorUrlConfiguration {
  serverUrlType?: ServerUrlType;
  remoteUrlOptions?: { url: string; label?: string }[];
  remoteUrlRegex?: string;
  remoteUrlTemplate?: string;
  remoteUserConfig?: {
    title: string;
    description: string;
    placeholder: string;
    pattern: string;
  };
  testServerUrl?: string;
}

// URL configuration validation.
export function connectorRegexError(pattern: string) {
  if (!pattern.trim()) return "This field is required";
  if (pattern.length > 200) return "200 characters or fewer";
  try {
    new RegExp(pattern);
  } catch {
    return "Not a valid regular expression";
  }
  if (/\(\?=|\(\?!|\(\?<[=!]|\\[1-9]|\\k</.test(pattern))
    return "Lookarounds and backreferences aren't supported — rewrite without (?=, (?!, (?<=, (?<! or \\1-style references";
  if (
    /\((?:\?:)?(?:\\.|\.|\[[^\]]*\]|\w)(?:[+*]|\{\d+,\d*\})\)\s*(?:[+*]|\{\d+,\d*\})/.test(
      pattern,
    )
  )
    return "Avoid nested repetition like (a+)+ — it can hang on long inputs";
  if (!pattern.startsWith("^https://"))
    return "Pattern must start with ^https://";
  if (!pattern.endsWith("$"))
    return "Pattern must end with $ so it can't match a longer host";
  if (pattern.includes("|"))
    return "Alternation (|) isn't allowed — use the Multiple URLs option instead";
  const decoded = pattern.replace(
    /\\x(23|2f|3f|40)|\\u00(23|2f|3f|40)/gi,
    (_match, hex: string, unicode: string) =>
      String.fromCharCode(parseInt(hex ?? unicode, 16)),
  );
  if (decoded.includes("@"))
    return "Remove the @ — userinfo before the host isn't allowed";
  const authority = decoded.slice(9);
  let bracketDepth = 0;
  let hostEnd = authority.length;
  for (let index = 0; index < authority.length; index++) {
    const character = authority[index];
    if (character === "\\") {
      if (authority[index + 1] === "/" && bracketDepth === 0) {
        hostEnd = index;
        break;
      }
      index++;
    } else if (character === "[") bracketDepth++;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === "/" && bracketDepth === 0) {
      hostEnd = index;
      break;
    }
  }
  const host = authority
    .slice(0, hostEnd)
    .replace(/(?=((?:\((?:\?:)?:\d+\)\??|:\d+|[()$?])+))\1$/, "");
  const literalDomain =
    /(?:^|\\\.(?:\)[+*?]?)?)(?:[a-z0-9-]+\\\.)+[a-z0-9-]+$/i.exec(host);
  if (!literalDomain)
    return "Only the subdomain may vary — end the host with your literal domain, e.g. ^https://[a-z0-9-]+\\.mcp\\.example\\.com/mcp$";
  if (/(?<!\\)\.|\\[SDW]|\[\^|\//.test(host.slice(0, literalDomain.index)))
    return "The subdomain slot can't use wildcards that match `/`, `.`, `?`, `#` or `@` — use a character class like [a-z0-9-]+ instead of .+ or \\S+";
}

export function templateConnectorUrl(
  config: ConnectorUrlConfiguration,
  value?: string,
) {
  const template = config.remoteUrlTemplate ?? "";
  return template.replace(
    /\$\{user_config\.([a-z][a-z0-9_]{0,31})\}|\{([a-z][a-z0-9_]{0,31})\}/g,
    () => value ?? config.remoteUserConfig?.placeholder ?? "",
  );
}

export function connectorConfigurationError(
  config: ConnectorUrlConfiguration,
  address?: string,
) {
  const type = config.serverUrlType ?? "universal";
  const publicUrl = (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  if (address !== undefined && !publicUrl(address))
    return "Server URL must start with https://";
  if (type === "multiple") {
    const options = config.remoteUrlOptions ?? [];
    if (!options.length) return "This field is required";
    if (options.length > 10 || options.some((option) => !publicUrl(option.url)))
      return "Server URL must start with https://";
    if (
      address !== undefined &&
      !options.some((option) => option.url === address)
    )
      return "Doesn't match the allowed URLs";
  } else if (type === "regex") {
    const error = connectorRegexError(config.remoteUrlRegex ?? "");
    if (error) return error;
    const test = address ?? config.testServerUrl;
    if (!test || !publicUrl(test)) return "Server URL must start with https://";
    if (!new RegExp(config.remoteUrlRegex!).test(test))
      return "Doesn't match the allowed URLs";
  } else if (type === "template") {
    const template = config.remoteUrlTemplate ?? "";
    const slots = [
      ...template.matchAll(
        /\$\{user_config\.([a-z][a-z0-9_]{0,31})\}|\{([a-z][a-z0-9_]{0,31})\}/g,
      ),
    ];
    if (template.length > 400) return "Must be 400 characters or fewer";
    if (!slots.length)
      return "Mark the part each customer fills in, like ${user_config.mydomain}";
    if (slots.length > 1) return "Use one ${user_config.key} only";
    if (!template.startsWith("https://"))
      return "Server URL must start with https://";
    const markerUrl = templateConnectorUrl(config, "claudex-placeholder");
    let parsed: URL;
    try {
      parsed = new URL(markerUrl);
    } catch {
      return "Enter a valid https:// URL";
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      /[\s%]/.test(template)
    )
      return "Enter a valid https:// URL";
    if (
      parsed.hostname.includes("claudex-placeholder") &&
      !/^claudex-placeholder\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(
        parsed.hostname,
      )
    )
      return "Enter a valid https:// URL";
    const option = config.remoteUserConfig;
    if (
      !option?.title.trim() ||
      !option.description.trim() ||
      !option.placeholder.trim()
    )
      return "This field is required";
    if (
      !/^\^\[((?:[A-Za-z0-9_]|[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9])+-?)\](\+|\{\d+\}|\{\d+,\d+\})\$$/.test(
        option.pattern,
      )
    )
      return "Not a valid regular expression";
    let pattern: RegExp;
    try {
      pattern = new RegExp(option.pattern);
    } catch {
      return "Not a valid regular expression";
    }
    if (!pattern.test(option.placeholder))
      return "Doesn't match the allowed characters";
    const resolved = templateConnectorUrl(config);
    if (!publicUrl(resolved)) return "Server URL must start with https://";
    if (address !== undefined) {
      const marker = "claudex-placeholder";
      const [prefix, suffix] = templateConnectorUrl(config, marker).split(
        marker,
      );
      const value = address.slice(
        prefix.length,
        suffix ? -suffix.length : undefined,
      );
      if (
        !address.startsWith(prefix) ||
        !address.endsWith(suffix) ||
        !pattern.test(value)
      )
        return "Doesn't match the allowed URLs";
    }
  }
}
