// Failure headings.
export function marketplaceFailure(error: string): string {
  if (
    /git.*(?:not found|ENOENT|not installed|is required)|spawn git ENOENT/i.test(
      error,
    )
  )
    return "Git is required";
  if (/blocked.*egress|egress.*blocked/i.test(error))
    return "Marketplace unreachable";
  if (/egress|network.*(?:disabled|required)/i.test(error))
    return "Network access required";
  return "Sync failed";
}
