export const text = (value: unknown, limit = 2000) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, limit)
    : undefined;

/** "name@marketplace" → its two parts. */
export function splitPluginId(id: string) {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1)
    throw new Error("That plugin id is not valid.");
  return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}
