let sequence = 0;
/** Ephemeral UI identity, never an authentication token or native capability. */
export function presentationId(
  source: Pick<Crypto, "randomUUID"> | null | undefined = globalThis.crypto,
) {
  return (
    source?.randomUUID?.() ??
    `presentation-${Date.now().toString(36)}-${++sequence}`
  );
}
