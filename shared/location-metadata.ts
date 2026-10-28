export interface CoarseLocation {
  city: string;
  region: string;
  country: string;
}

export function parseCoarseLocation(value: unknown): CoarseLocation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    ![data.city, data.region, data.country].every(
      (part) =>
        typeof part === "string" &&
        part.length <= 200 &&
        !/[\r\n<>]/.test(part),
    )
  )
    return null;
  return {
    city: data.city as string,
    region: data.region as string,
    country: data.country as string,
  };
}
