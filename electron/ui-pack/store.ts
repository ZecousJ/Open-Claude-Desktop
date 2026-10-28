/**
 * The interface packs on disk (docs/releasing.md):
 * `<userData>/ui-packs/<version>/` holds a verified pack's files and its
 * manifest; `state.json` records which version the windows run (`active`),
 * which one they should run next (`target`), and versions that failed to
 * start. No Electron imports: launch.ts wires it to the app.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  bundledUi,
  chooseUi,
  parseUiManifest,
  safePackPath,
  validUiVersion,
  type UiManifest,
} from "../../shared/ui-pack";
import type { VerifiedPack } from "./verify";

/** Start failures after which a version is not tried again. */
export const maxUiFailures = 2;

interface UiState {
  /** What the open windows run. */
  active: string;
  /** What the next window load or idle refresh switches to. */
  target: string;
  failures: Record<string, number>;
  bad: string[];
  /** The file:// page's local storage was copied to the pack origin. */
  migrated?: boolean;
}

export class UiPackStore {
  readonly dir: string;
  private state: UiState;

  constructor(
    userData: string,
    private readonly options: {
      bundledVersion: string;
      bridge: number;
      bundledDir: string;
    },
  ) {
    this.dir = path.join(userData, "ui-packs");
    this.state = this.read();
  }

  private read(): UiState {
    const empty: UiState = {
      active: bundledUi,
      target: bundledUi,
      failures: {},
      bad: [],
    };
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(this.dir, "state.json"), "utf8"),
      );
      const version = (value: unknown) =>
        value === bundledUi || validUiVersion(value) ? value : bundledUi;
      return {
        active: version(raw.active),
        target: version(raw.target),
        failures:
          raw.failures && typeof raw.failures === "object" ? raw.failures : {},
        bad: Array.isArray(raw.bad) ? raw.bad.filter(validUiVersion) : [],
        migrated: raw.migrated === true,
      };
    } catch {
      return empty;
    }
  }

  private write() {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, "state.json");
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state));
    fs.renameSync(temp, file);
  }

  get active() {
    return this.state.active;
  }
  get target() {
    return this.state.target;
  }
  get bad(): readonly string[] {
    return this.state.bad;
  }
  /** A newer interface is waiting for the windows to load it. */
  get pending() {
    return this.state.target !== this.state.active;
  }
  get migrated() {
    return this.state.migrated === true;
  }
  markMigrated() {
    this.state.migrated = true;
    this.write();
  }

  /** The verified pack of `version` on disk, or undefined. */
  manifest(version: string): UiManifest | undefined {
    if (!validUiVersion(version)) return undefined;
    try {
      const manifest = parseUiManifest(
        fs.readFileSync(path.join(this.dir, version, "manifest.json"), "utf8"),
      );
      return manifest.version === version ? manifest : undefined;
    } catch {
      return undefined;
    }
  }

  /** A version this shell can run from disk (the bundled one always). */
  runnable(version: string) {
    if (version === bundledUi) return true;
    const manifest = this.manifest(version);
    return (
      !!manifest &&
      manifest.bridge <= this.options.bridge &&
      !this.state.bad.includes(version)
    );
  }

  /** Writes a verified pack next to the others (atomically, by rename). */
  install(pack: VerifiedPack) {
    const { version } = pack.manifest;
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = path.join(
      this.dir,
      `.tmp-${version}-${crypto.randomBytes(4).toString("hex")}`,
    );
    try {
      for (const [name, data] of pack.files) {
        if (!safePackPath(name)) throw new Error(`Unsafe path ${name}`);
        const file = path.join(temp, ...name.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
      }
      fs.writeFileSync(
        path.join(temp, "manifest.json"),
        JSON.stringify(pack.manifest),
      );
      const final = path.join(this.dir, version);
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(temp, final);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  /**
   * The service's offer: null takes any pack back, undefined (unreachable)
   * changes nothing. Returns the version to download, if it is not on disk.
   */
  offer(
    offered: { version: string; bridge: number } | null | undefined,
  ): string | undefined {
    if (offered === undefined) return undefined;
    const target = chooseUi({
      offered,
      bundled: { version: this.options.bundledVersion },
      bridge: this.options.bridge,
      bad: this.state.bad,
    });
    if (target !== bundledUi && !this.runnable(target)) return target;
    if (this.state.target !== target) {
      this.state.target = target;
      this.write();
    }
    return undefined;
  }

  /** After `install`: the offered version becomes the target. */
  installed(version: string) {
    if (!this.runnable(version)) return;
    this.state.target = version;
    this.write();
  }

  /**
   * Switches the windows to the target (at launch or on an idle refresh)
   * and returns the version to load. A target that is gone or failed falls
   * back to the bundled interface.
   */
  activate(): string {
    const next = this.runnable(this.state.target)
      ? this.state.target
      : bundledUi;
    this.state.active = next;
    this.state.target = next;
    this.write();
    return next;
  }

  /** The version windows should load now (the active one, if still runnable). */
  current(): string {
    return this.runnable(this.state.active) ? this.state.active : bundledUi;
  }

  // : a page load gets the new interface.
  pageVersion() {
    return this.pending ? this.activate() : this.current();
  }

  /** A window of `version` started (its code said it is ready). */
  ready(version: string) {
    if (version === bundledUi || !this.state.failures[version]) return;
    delete this.state.failures[version];
    this.write();
  }

  /**
   * A window of `version` did not start. After `maxUiFailures` the version
   * is not tried again (until the service offers a newer one); the windows
   * go back to the bundled interface either way. Returns what to load.
   */
  failed(version: string): string {
    if (version === bundledUi) return bundledUi;
    const count = (this.state.failures[version] ?? 0) + 1;
    this.state.failures[version] = count;
    if (count >= maxUiFailures && !this.state.bad.includes(version))
      this.state.bad.push(version);
    this.state.active = bundledUi;
    if (this.state.target === version) this.state.target = bundledUi;
    this.write();
    return bundledUi;
  }

  /** The folder a version's files are served from. */
  rootFor(version: string): string | undefined {
    if (version === bundledUi) return this.options.bundledDir;
    return this.manifest(version) ? path.join(this.dir, version) : undefined;
  }

  /** Removes packs no window runs or will run (call before any window opens). */
  prune() {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const keep = new Set([this.state.active, this.state.target]);
    for (const entry of entries)
      if (
        (validUiVersion(entry) && !keep.has(entry)) ||
        entry.startsWith(".tmp-")
      )
        fs.rmSync(path.join(this.dir, entry), { recursive: true, force: true });
  }
}
