import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  initialCloudEnvironment,
  type CloudEnvironmentConfig,
} from "../../shared/cloud-environments-api";
import { cloudEnvironmentInput } from "../../shared/cloud-environments-input";

/** Cloud profiles stay in the account. */
export class CloudEnvironments {
  constructor(private root: string) {}

  list(): CloudEnvironmentConfig[] {
    try {
      return JSON.parse(
        fs.readFileSync(
          path.join(this.root, "cloud-environments.json"),
          "utf8",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [{ ...initialCloudEnvironment }];
    }
  }

  get(id: string) {
    const environment = this.list().find((entry) => entry.id === id);
    if (!environment) throw new Error("Unavailable cloud environment");
    return environment;
  }

  save(raw: unknown) {
    const input = cloudEnvironmentInput.parse(raw);
    const entries = this.list();
    const previous = input.id ? this.get(input.id) : undefined;
    const saved = {
      ...input,
      id: input.id ?? randomUUID(),
      updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
    };
    this.write([...entries.filter((entry) => entry.id !== saved.id), saved]);
    return saved;
  }

  archive(id: string) {
    if (id === "default") throw new Error("Unavailable cloud environment");
    this.get(id);
    this.write(this.list().filter((entry) => entry.id !== id));
  }

  private write(entries: CloudEnvironmentConfig[]) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, "cloud-environments.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}
