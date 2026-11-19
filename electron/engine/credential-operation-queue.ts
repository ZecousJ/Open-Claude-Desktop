import fs from 'node:fs';
import { assertAccountOperationCurrent, type AccountOperationCurrent } from '../account/operation-lease';
interface Entry { tail: Promise<void>; pending: number; uncertain: boolean }
const entries = new Map<string, Entry>();
/** Same-process, canonical-root barrier. It never retries a credential operation.
 * A child whose exit cannot be established poisons this root for the process:
 * releasing a timeout as though its write stopped would permit late overwrites. */
export function credentialOperation<T>(root: string, current: AccountOperationCurrent | undefined,
  run: (uncertain: () => void) => Promise<T>): Promise<T> {
  assertAccountOperationCurrent(current);
  const key = fs.realpathSync(root);
  let entry = entries.get(key);
  if (!entry) { entry = { tail: Promise.resolve(), pending: 0, uncertain: false }; entries.set(key, entry); }
  const captured = entry;
  if (captured.uncertain) return Promise.reject(Error('A provider credential operation has an unknown outcome. Restart only after the previous provider process has stopped.'));
  if (captured.pending >= 64) return Promise.reject(Error('Provider credential operations are busy. Try again after the current operation finishes.'));
  captured.pending++;
  const result = captured.tail.then(async () => {
    assertAccountOperationCurrent(current);
    if (captured.uncertain) throw Error('A provider credential operation has an unknown outcome.');
    if (fs.realpathSync(root) !== key) throw Error('The provider credential folder changed.');
    return await run(() => { captured.uncertain = true; });
  });
  captured.tail = result.then(() => {}, () => {});
  void captured.tail.then(() => {
    captured.pending--;
    if (!captured.pending && !captured.uncertain && entries.get(key) === captured) entries.delete(key);
  });
  return result;
}
