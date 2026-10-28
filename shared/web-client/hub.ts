import type { AppEvent } from "../types";

/** The window's `onEvent` listeners; the stream and the bridge emit into it. */
export class EventHub {
  private listeners = new Set<(event: AppEvent) => void>();
  private watchers = new Set<(count: number) => void>();

  subscribe(listener: (event: AppEvent) => void) {
    this.listeners.add(listener);
    this.watchers.forEach((watch) => watch(this.listeners.size));
    return () => {
      if (!this.listeners.delete(listener)) return;
      this.watchers.forEach((watch) => watch(this.listeners.size));
    };
  }

  emit(event: AppEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        // One window listener failing must not keep the event from the rest.
        console.error(error);
      }
    }
  }

  get size() {
    return this.listeners.size;
  }

  /** Called with the listener count whenever it changes. */
  watch(watcher: (count: number) => void) {
    this.watchers.add(watcher);
  }
}
