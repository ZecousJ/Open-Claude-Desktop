import fs from "node:fs";
import {createHash} from 'node:crypto';
import path from 'node:path';
/** Stable host identity only. Never adopt the former shared partition. */
export function accountBrowserStorage(owner: string, storeRoot: string, userData: string) {
  if (typeof owner !== 'string' || !owner || typeof storeRoot !== 'string' || !path.isAbsolute(storeRoot))
    throw new Error('Account browser storage identity is unavailable.');
  const key = createHash('sha256').update(JSON.stringify(['official-browser-v1', owner, path.resolve(storeRoot)])).digest('hex');
  return {key, partition: `persist:claudex-official-v1-${key}`,
    portFile: path.join(userData, 'official-ui-accounts', key, 'server-port')};
}
/** Reusing storage is safe only once every prior document and listener is gone. */
export async function prepareAccountBrowserStorage(previous: Array<{
  settle(): Promise<unknown>; closePending(): Promise<unknown>; destroy(): void;
  hasDocuments(): boolean; closeServer(): Promise<unknown>;
}>, current: () => boolean) {
  const check = () => { if (!current()) throw new Error('Account browser storage activation retired.'); };
  check();
  for (const runtime of previous) {
    await runtime.settle(); check();
    runtime.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([runtime.closePending(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Previous account interface setup has not finished.")), 5000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    check();
    if (runtime.hasDocuments()) throw new Error('The previous account interface could not be closed.');
    await runtime.closeServer(); check();
  }
}

export function readSavedUiPort(file: string): number | undefined {
  try {
    const port = Number(fs.readFileSync(file, "utf8").trim());
    if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
  } catch { /* Reservation hints do not replace the active account's strict read. */ }
  return undefined;
}
export function savedAccountUiPort(owner: string, storeRoot: string, userData: string) {
  return readSavedUiPort(accountBrowserStorage(owner, storeRoot, userData).portFile);
}
/** Saved account origins are excluded from random startup listeners. */
export function savedAccountUiPorts(userData: string): number[] {
  const directory = path.join(userData, "official-ui-accounts");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
  return entries.filter(entry => entry.isDirectory()).flatMap(entry => {
    const port = readSavedUiPort(path.join(directory, entry.name, "server-port"));
    return port === undefined ? [] : [port];
  });
}
