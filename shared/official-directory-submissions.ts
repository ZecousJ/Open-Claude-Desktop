const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const connectors = new RegExp(
  `^/api/organizations/(${uuid})/directory/mcp-servers(?:/(.*))?$`,
);
const plugins = new RegExp(
  `^/api/console/organizations/(${uuid})/directory/plugin-submissions(?:/(${uuid}))?$`,
);
const connectorId = new RegExp(`^(${uuid})(?:/(submit|publish))?$`);
const slug = /^by-slug\/[a-z0-9-]{1,100}$/;

export const officialDirectorySubmissionMaxBytes = 192 * 1024;

export function officialDirectorySubmissionTarget(method: string, path: string) {
  const connector = connectors.exec(path);
  if (connector) {
    const [, organizationId, tail] = connector;
    const id = tail && connectorId.exec(tail);
    const write = tail === undefined ? method === "POST" :
      !!id && (id[2] ? method === "POST" : ["PATCH", "DELETE"].includes(method));
    const read = method === "GET" && (tail === undefined || slug.test(tail));
    if (read || write) return { organizationId, write };
  }
  const plugin = plugins.exec(path);
  if (plugin) {
    const [, organizationId, id] = plugin;
    const write = id ? ["PATCH", "DELETE"].includes(method) : method === "POST";
    if (method === "GET" || write) return { organizationId, write };
  }
}
