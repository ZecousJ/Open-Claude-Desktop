import fs from "node:fs";
import path from "node:path";
import type { McpServerState } from "../../shared/settings-desktop-api";

interface SignInRecord {
  url: string;
  lastConnectedAt?: number;
  pending?: boolean;
  authStatus?: McpServerState["authStatus"];
}

// Record successful sign-ins, not polling times.
export class ConnectorHistory {
  private readonly file: string;
  private records: Record<string, SignInRecord> = Object.create(null);
  constructor(
    root: string,
    private readonly now = Date.now,
  ) {
    this.file = path.join(root, "connector-history.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [name, raw] of Object.entries(saved)) {
        const record = raw as SignInRecord;
        if (record && typeof record.url === "string")
          this.records[name] = {
            ...record,
            lastConnectedAt: Number.isFinite(record.lastConnectedAt)
              ? record.lastConnectedAt
              : undefined,
          };
      }
    } catch {}
  }
  private save() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.records), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }
  begin(name: string, url: string) {
    const previous = this.records[name];
    this.records[name] = {
      ...(previous?.url === url ? previous : {}),
      url,
      pending: true,
    };
    this.save();
  }
  complete(name: string, url: string) {
    this.records[name] = {
      url,
      lastConnectedAt: this.now(),
      authStatus: "oAuth",
    };
    this.save();
  }
  states(servers: McpServerState[]) {
    const before = JSON.stringify(this.records);
    const names = new Set(servers.map((server) => server.name));
    for (const name of Object.keys(this.records))
      if (!names.has(name)) delete this.records[name];
    const result = servers.map((server) => {
      if (!server.url) return server;
      const previous = this.records[server.name];
      const record: SignInRecord =
        previous?.url === server.url ? previous : { url: server.url };
      const signedIn =
        server.state === "ready" &&
        (server.authStatus === "oAuth" || server.authStatus === "bearerToken");
      if (signedIn && (record.pending || record.authStatus === "notLoggedIn")) {
        record.lastConnectedAt = this.now();
        record.pending = false;
      }
      if (server.authStatus) record.authStatus = server.authStatus;
      this.records[server.name] = record;
      return {
        ...server,
        ...(record.lastConnectedAt
          ? { lastConnectedAt: record.lastConnectedAt }
          : {}),
      };
    });
    if (before !== JSON.stringify(this.records)) this.save();
    return result;
  }
}
