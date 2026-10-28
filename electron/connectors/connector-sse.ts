export async function openSseConnector(
  address: string,
  request: typeof fetch,
  headers: Record<string, string>,
  receive: (message: unknown) => void,
) {
  const source = new URL(address);
  const controller = new AbortController();
  let endpoint: URL | undefined;
  let resolveEndpoint!: () => void;
  let rejectEndpoint!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveEndpoint = resolve;
    rejectEndpoint = reject;
  });
  void ready.catch(() => {});
  const timer = setTimeout(() => {
    rejectEndpoint(Error("The request failed."));
    controller.abort();
  }, 30_000);
  const response = await request(address, {
    headers: { ...headers, Accept: "text/event-stream" },
    redirect: "error",
    signal: controller.signal,
  }).catch((error) => {
    clearTimeout(timer);
    controller.abort();
    throw error;
  });
  if (!response.ok || !response.body) {
    clearTimeout(timer);
    await response.body?.cancel();
    throw Error("The request failed.");
  }
  const reader = response.body.getReader();
  const completed = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 2_000_000) throw Error("The request failed.");
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const lines = event.split(/\r?\n/);
          const kind = lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (kind === "endpoint") {
            if (endpoint || data.length > 2048)
              throw Error("The request failed.");
            const target = new URL(data, source);
            if (
              target.origin !== source.origin ||
              target.username ||
              target.password
            )
              throw Error("The request failed.");
            endpoint = target;
            clearTimeout(timer);
            resolveEndpoint();
          } else if (data && (kind === "message" || !kind))
            receive(JSON.parse(data));
        }
      }
      if (!controller.signal.aborted) throw Error("The request failed.");
    } finally {
      clearTimeout(timer);
      rejectEndpoint(Error("The request failed."));
      await reader.cancel().catch(() => {});
    }
  })();
  void completed.catch(() => {});
  try {
    await ready;
  } catch (error) {
    controller.abort();
    throw error;
  }
  return {
    completed,
    close: () => {
      controller.abort();
      void reader.cancel().catch(() => {});
    },
    send: async (message: unknown) => {
      controller.signal.throwIfAborted();
      const response = await request(endpoint!.href, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(60_000),
        ]),
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      await response.body?.cancel();
      if (!response.ok) throw Error("The request failed.");
    },
  };
}
