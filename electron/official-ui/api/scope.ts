/** Account-local state for the official API adapter, including async streams. */
import { AsyncLocalStorage } from "node:async_hooks";

export interface AdapterScope {
  owner: string;
  values: Map<string, unknown>;
  loaded: boolean;
  stateBase?: string;
  sessionIdentity?: unknown;
  initializing?: Promise<void>;
}

const storage = new AsyncLocalStorage<AdapterScope>();
const fallback: AdapterScope = { owner: "", values: new Map(), loaded: false };

export function newAdapterScope(owner: string, stateBase?: string, sessionIdentity?: unknown): AdapterScope {
  return { owner, values: new Map(), loaded: false, stateBase, sessionIdentity };
}
export function currentAdapterScope(): AdapterScope { return storage.getStore() ?? fallback; }
export function inAdapterScope<T>(scope: AdapterScope, work: () => T): T { return storage.run(scope, work); }
export function bindAdapterScope<T extends (...args: any[]) => any>(fn: T): T {
  const scope = currentAdapterScope();
  return ((...args: Parameters<T>) => inAdapterScope(scope, () => fn(...args))) as T;
}
export function scopedValue<T>(key: string, make: () => T): T {
  const values = currentAdapterScope().values;
  if (!values.has(key)) values.set(key, make());
  return values.get(key) as T;
}

/** Map and Set facades keep existing callers concise while storing per scope. */
export class ScopedMap<K, V> extends Map<K, V> {
  constructor(private readonly key: string) { super(); }
  private actual(): Map<K, V> { return scopedValue(`map:${this.key}`, () => new Map<K, V>()); }
  override get size() { return this.actual().size; }
  override clear() { this.actual().clear(); }
  override delete(key: K) { return this.actual().delete(key); }
  override get(key: K) { return this.actual().get(key); }
  override has(key: K) { return this.actual().has(key); }
  override set(key: K, value: V): this { this.actual().set(key, value); return this; }
  override entries() { return this.actual().entries(); }
  override keys() { return this.actual().keys(); }
  override values() { return this.actual().values(); }
  override [Symbol.iterator]() { return this.actual()[Symbol.iterator](); }
  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown) {
    this.actual().forEach((value, key) => callback.call(thisArg, value, key, this));
  }
}
export class ScopedSet<T> extends Set<T> {
  constructor(private readonly key: string) { super(); }
  private actual(): Set<T> { return scopedValue(`set:${this.key}`, () => new Set<T>()); }
  override get size() { return this.actual().size; }
  override clear() { this.actual().clear(); }
  override delete(value: T) { return this.actual().delete(value); }
  override has(value: T) { return this.actual().has(value); }
  override add(value: T): this { this.actual().add(value); return this; }
  override entries() { return this.actual().entries(); }
  override keys() { return this.actual().keys(); }
  override values() { return this.actual().values(); }
  override [Symbol.iterator]() { return this.actual()[Symbol.iterator](); }
  override forEach(callback: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown) {
    this.actual().forEach((value) => callback.call(thisArg, value, value, this));
  }
}
