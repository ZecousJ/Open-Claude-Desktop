/** Only reconnect transcription transport failures, never permission errors. */
export function isVoiceConnectionError(error: unknown) {
  return (
    error instanceof Error &&
    !/permission|not.?allowed|denied|unauthori[sz]ed|forbidden|\b40[13]\b/i.test(
      error.message,
    ) &&
    /network|connection|disconnected|fetch failed|failed to fetch|speech service couldn't be reached|\b50[234]\b/i.test(
      error.message,
    )
  );
}
