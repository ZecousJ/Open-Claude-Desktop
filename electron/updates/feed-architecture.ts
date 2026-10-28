// .
export class FeedArchitecture {
  private cached?: { url: string; at: number; selected: string };

  constructor(
    private readonly fetchStatus: (url: string) => Promise<number>,
    private readonly now = Date.now,
  ) {}

  clear() {
    this.cached = undefined;
  }

  async select(base: string, arch: string) {
    const universal = new URL(base);
    if (!/\/desktop\/[^/]+\/(universal|arm64|x64)\//.test(universal.pathname))
      return base;
    universal.pathname = universal.pathname.replace(
      /(\/desktop\/[^/]+\/)\w+(\/)/,
      "$1universal$2",
    );
    if (arch !== "arm64" && arch !== "x64") return universal.href;
    const probe = new URL(universal);
    probe.pathname = probe.pathname.replace("/universal/", `/${arch}/`);
    if (
      this.cached?.url === probe.href &&
      this.now() - this.cached.at < 24 * 60 * 60_000
    )
      return this.cached.selected;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([
        this.fetchStatus(probe.href).catch(() => 0),
        new Promise<number>((resolve) => {
          timer = setTimeout(() => resolve(0), 5000);
          timer.unref?.();
        }),
      ]);
      const selected =
        status === 200 || status === 404 ? probe.href : universal.href;
      if (status === 200 || status === 404)
        this.cached = { url: probe.href, at: this.now(), selected };
      return selected;
    } finally {
      clearTimeout(timer);
    }
  }
}
