/**
 * The signed-in account's bootstrap (`GET /api/v1/claudex/bootstrap`,
 * design 2.10): plan, device, policy, model catalog, release, voice, usage
 * and reporting sections in one answer. Packages C4–C7 read it through the
 * `BootstrapSource` interface only.
 */
import {
  parseBootstrap,
  type BootstrapSource,
  type ClaudexBootstrap,
} from "../../shared/claudex-contract";
import type { JsonResult } from "./http";

type Listener = (bootstrap: ClaudexBootstrap | undefined) => void;

/** Reads the bootstrap with `If-None-Match`; one request at a time. */
export class ClaudexBootstrapSource implements BootstrapSource {
  private value?: ClaudexBootstrap;
  /** The answer's `data` as sent, for sections kept on disk (the policy cache). */
  private raw?: Record<string, unknown>;
  private etag?: string;
  private loading?: Promise<ClaudexBootstrap | undefined>;
  private listeners = new Set<Listener>();
  constructor(private load: (etag?: string) => Promise<JsonResult>) {}
  current() {
    return this.value;
  }
  /** A section of the last answer exactly as the service sent it. */
  rawSection(name: string): unknown {
    return this.raw?.[name];
  }
  /** The ETag of the last answer. */
  get tag() {
    return this.etag;
  }
  /**
   * Asks the service now and rejects when it cannot answer (unreachable,
   * 5xx, a refused session, an answer outside the contract).
   */
  fetch(): Promise<ClaudexBootstrap | undefined> {
    this.loading ??= this.read().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }
  private async read() {
    const result = await this.load(this.etag);
    if (result.notModified) return this.value;
    const next = parseBootstrap(result.data);
    const raw =
      result.data && typeof result.data === "object"
        ? (result.data as Record<string, unknown>)
        : undefined;
    const changed =
      !this.value ||
      JSON.stringify({ ...this.value, generatedAt: null }) !==
        JSON.stringify({ ...next, generatedAt: null });
    this.value = next;
    this.raw = raw;
    this.etag = result.etag;
    if (changed) this.emit();
    return next;
  }
  /** Asks the service again; keeps the last answer when it cannot. */
  async refresh() {
    try {
      return await this.fetch();
    } catch {
      return this.value;
    }
  }
  onChange(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Forgets the answer (sign-out). */
  clear() {
    this.value = undefined;
    this.raw = undefined;
    this.etag = undefined;
    this.emit();
  }
  private emit() {
    for (const listener of [...this.listeners])
      try {
        listener(this.value);
      } catch (error) {
        console.error(
          "Bootstrap listener failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
  }
}
