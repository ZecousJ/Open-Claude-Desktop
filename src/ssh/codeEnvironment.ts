/**
 * Where the Code home's next session runs (R9): this computer, or an SSH
 * host with a folder on it. The composer's send reads
 * `currentCodeEnvironment()` for a new Code conversation; a folder on a host
 * is only ever the working folder together with its host, so a remote path
 * is never taken for a local one.
 */
import { useSyncExternalStore } from "react";
import type { EnvironmentRef } from "../../shared/types";
import { localEnvironment } from "./model";

export interface CodeEnvironment {
  environment: EnvironmentRef;
  /** The folder chosen on the host (SSH only; the app's cwd mirrors it). */
  folder?: string;
}

let current: CodeEnvironment = { environment: localEnvironment };
const listeners = new Set<() => void>();

export function setCodeEnvironment(next: CodeEnvironment) {
  current = next;
  listeners.forEach((listener) => listener());
}

/** The environment a new Code conversation starts in. */
export const currentCodeEnvironment = (): EnvironmentRef => current.environment;

export const codeEnvironmentState = () => current;

export function useCodeEnvironment() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => current,
  );
}
