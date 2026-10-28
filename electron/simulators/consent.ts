/**
 * Asking before Claude uses a device: the first time a session wants to drive a
 * simulator or emulator, a dialog names the device and what Claude will do, and
 * only Allow lets it. The answer is kept for that device: an allowed device
 * stays allowed (until the person takes it back in the pane), and a refusal or
 * an unanswered dialog is not asked again for ten minutes, so a model that
 * keeps trying does not keep interrupting. Only one dialog is open at a time.
 */
import {
  consentText,
  deviceToolsConsentText,
  type SimulatorKind,
} from "../../shared/simulators";

export type ConsentAnswer = "granted" | "declined" | "cooldown" | "timeout";

export interface ConsentRequest {
  auto?: boolean;
  kind: SimulatorKind;
  /** The key the answer is kept under (`consentKey`). */
  key: string;
  /** The device's name, one line. */
  label: string;
}

/** What the dialog answered: the Allow button, the Cancel button, or nothing in time. */
export type DialogAnswer = "allow" | "cancel" | "timeout";

export interface ConsentDeps {
  /** Shows the dialog. */
  ask(text: ReturnType<typeof consentText>): Promise<DialogAnswer>;
  /** The devices allowed before. */
  load(): string[];
  save(keys: string[]): void;
  now(): number;
  signature?: string;
}

/** A refusal or an unanswered dialog is not asked again for this long. */
export const declinedCooldownMs = 10 * 60_000;

export class Consent {
  private granted: Set<string>;
  private declinedAt = new Map<string, number>();
  private asking = new Map<string, Promise<ConsentAnswer>>();
  private signature?: string;
  private toolsPending?: Promise<ConsentAnswer>;
  private toolsDeclinedAt?: number;
  constructor(private deps: ConsentDeps) {
    const saved = deps.load();
    this.signature = saved
      .find((key) => key.startsWith("tools-signature:"))
      ?.slice("tools-signature:".length);
    this.granted = new Set(
      saved.filter((key) => !key.startsWith("tools-signature:")),
    );
    if (!saved.length) this.signature = deps.signature;
  }

  has(key: string) {
    return (
      (!this.deps.signature || this.signature === this.deps.signature) &&
      this.granted.has(key)
    );
  }

  /** The person's own answer in the pane ("Let Claude use it"). */
  set(key: string, allow: boolean) {
    if (allow) {
      this.granted.add(key);
      this.declinedAt.delete(key);
    } else this.granted.delete(key);
    this.save();
  }

  private save() {
    this.deps.save([
      ...this.granted,
      ...(this.signature ? [`tools-signature:${this.signature}`] : []),
    ]);
  }

  async ensureTools(): Promise<ConsentAnswer> {
    if (!this.deps.signature || this.signature === this.deps.signature)
      return "granted";
    if (this.toolsPending) return this.toolsPending;
    if (
      this.asking.size ||
      (this.toolsDeclinedAt !== undefined &&
        this.deps.now() - this.toolsDeclinedAt < declinedCooldownMs)
    )
      return "cooldown";
    this.toolsPending = this.deps
      .ask(deviceToolsConsentText())
      .then((answer): ConsentAnswer => {
        if (answer === "allow") {
          this.signature = this.deps.signature;
          this.save();
          return "granted";
        }
        this.toolsDeclinedAt = this.deps.now();
        return answer === "cancel" ? "declined" : "timeout";
      })
      .finally(() => {
        this.toolsPending = undefined;
      });
    return this.toolsPending;
  }

  /** Allowed devices are never asked again; Claude's asks wait for the cooldown. */
  async request(request: ConsentRequest): Promise<ConsentAnswer> {
    if (this.deps.signature && this.signature !== this.deps.signature) {
      const tools = await this.ensureTools();
      if (tools !== "granted") return tools;
    }
    if (request.auto) {
      if (this.signature) this.save();
      return "granted";
    }
    if (this.granted.has(request.key)) return "granted";
    const waiting = this.asking.get(request.key);
    if (waiting) return waiting;
    // Another device's dialog is open: ask again later.
    if (this.asking.size > 0) return "cooldown";
    const declined = this.declinedAt.get(request.key);
    if (
      declined !== undefined &&
      this.deps.now() - declined < declinedCooldownMs
    )
      return "cooldown";
    const pending = this.dialog(request).finally(() =>
      this.asking.delete(request.key),
    );
    this.asking.set(request.key, pending);
    return pending;
  }

  private async dialog(request: ConsentRequest): Promise<ConsentAnswer> {
    const answer = await this.deps.ask(
      consentText(request.kind, request.label),
    );
    if (answer === "allow") {
      this.set(request.key, true);
      return "granted";
    }
    this.declinedAt.set(request.key, this.deps.now());
    return answer === "cancel" ? "declined" : "timeout";
  }
}
