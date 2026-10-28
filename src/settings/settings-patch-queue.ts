import type { DesktopAPI, Settings } from "../../shared/types";

type Change = {
  patch: Partial<Settings>;
  saved(value: Settings): void;
  failed(error: unknown): void;
  resolve(kept: boolean): void;
};

/** The bridge saves whole snapshots. Only confirmed values may form the base
 * of another write; an optimistic choice must not hitchhike on a later patch. */
export class SettingsPatchQueue {
  private changes: Change[] = [];
  private listeners = new Set<(value: Settings) => void>();
  private running = false;
  private cancelled = false;
  private incoming: Settings;

  constructor(
    private confirmed: Settings,
    private persist: (value: Settings) => Promise<Settings>,
    private current: () => boolean,
  ) {
    this.incoming = confirmed;
  }

  get value(): Settings {
    return this.changes.reduce(
      (value, change) => ({ ...value, ...change.patch }),
      this.confirmed,
    );
  }

  subscribe(listener: (value: Settings) => void) {
    this.listeners.add(listener);
    listener(this.value);
    return () => {
      this.listeners.delete(listener);
    };
  }

  rebase(value: Settings) {
    if (this.incoming === value || this.cancelled) return;
    this.incoming = value;
    this.confirmed = value;
    this.publish();
  }

  update(
    patch: Partial<Settings>,
    saved: (value: Settings) => void,
    failed: (error: unknown) => void,
  ): Promise<boolean> {
    if (!this.valid()) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.changes.push({ patch: { ...patch }, saved, failed, resolve });
      this.publish();
      void this.drain();
    });
  }

  cancel() {
    this.cancelled = true;
    for (const change of this.changes) change.resolve(false);
    this.changes = [];
    this.listeners.clear();
  }

  private valid() {
    return !this.cancelled && this.current();
  }

  private publish() {
    const value = this.value;
    for (const listener of this.listeners) listener(value);
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.changes.length) {
        if (!this.valid()) {
          this.cancel();
          break;
        }
        const change = this.changes[0];
        let result: Settings | undefined;
        let error: unknown;
        let failed = false;
        try {
          result = await this.persist({ ...this.confirmed, ...change.patch });
        } catch (reason) {
          failed = true;
          error = reason;
        }
        if (!this.valid()) {
          this.cancel();
          break;
        }
        this.changes.shift();
        if (!failed) this.confirmed = result!;
        this.publish();
        // These callbacks belong to the still-signed-in App, not to the
        // dialog. Ordinary close therefore keeps authorized writes alive.
        try {
          if (failed) change.failed(error);
          else change.saved(result!);
        } finally {
          change.resolve(!failed);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

type Account = {
  id: string;
  active: boolean;
  queues: WeakMap<DesktopAPI, SettingsPatchQueue>;
  owned: Set<SettingsPatchQueue>;
};
let account: Account | undefined;
const standalone = new WeakMap<DesktopAPI, SettingsPatchQueue>();

/** App, which survives Settings close, owns the real sign-in lifetime. */
export function activateSettingsWriteAccount(id: string) {
  const invalidate = (scope: Account) => {
    scope.active = false;
    scope.owned.forEach((queue) => queue.cancel());
    scope.owned.clear();
    if (account === scope) account = undefined;
  };
  if (account) invalidate(account);
  const scope: Account = {
    id,
    active: true,
    queues: new WeakMap(),
    owned: new Set(),
  };
  account = scope;
  return () => invalidate(scope);
}

export function settingsPatchQueue(
  bridge: DesktopAPI,
  initial: Settings,
  accountId?: string,
) {
  const scope = account?.id === accountId ? account : undefined;
  const registry = scope?.queues ?? standalone;
  let queue = registry.get(bridge);
  if (!queue) {
    queue = new SettingsPatchQueue(
      initial,
      bridge.saveSettings.bind(bridge),
      () =>
        window.desktop === bridge &&
        (!scope || (scope.active && account === scope)),
    );
    registry.set(bridge, queue);
    scope?.owned.add(queue);
  }
  return queue;
}
