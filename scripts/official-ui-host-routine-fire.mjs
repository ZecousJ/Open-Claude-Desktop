import fs from "node:fs";
import path from "node:path";

export const hostRoutineFireTarget = "c29d48294-xo5LR0U9.js";
export const hostRoutineFireRevision = "claudex-routine-fire-v4";
const routineList = "c0c89c77a-CjFtYm1f.js";
const routineRun = "c9bd7af9c-B1XHjRXl.js";

export function deriveOfficialUiHostRoutineFireModule(file, source) {
  if (file === routineRun) {
    const archiveFirst = '(await n({ type: "remote", id: e }),\n      r(e),';
    const cancelAfter = "i({ triggerId: t, sessionId: e }),\n      a());";
    const hook = "{ mutate: o } = en(),";
    if (
      [archiveFirst, cancelAfter, hook].some(
        (anchor) => source.split(anchor).length !== 2,
      )
    )
      throw Error("Pinned scheduled run cancellation anchor mismatch.");
    return source
      .replace(
        archiveFirst,
        '(await i({ triggerId: t, sessionId: e }),\n      await n({ type: "remote", id: e }),\n      r(e),',
      )
      .replace(cancelAfter, "a());")
      .replace(hook, "{ mutateAsync: o } = en(),");
  }
  if (file === routineList) {
    const anchor =
      '...(V\n                    ? { codeRoutineSource: "code_routines_page", onCreated: ae }';
    if (source.split(anchor).length !== 2)
      throw Error("Pinned Code routine editor anchor mismatch.");
    return source.replace(
      anchor,
      anchor.replace(
        "...(V",
        "...(V && !globalThis.__claudexOfficialAccountContext",
      ),
    );
  }
  if (file !== hostRoutineFireTarget) return source;
  const url =
    "y = `${J0($, 0) ? K0($, 0, Na()) : $[0]}/v1/claude_code/routines/${v}/fire`,";
  const result =
    "o.mutateAsync({ triggerId: v }).then((e) => u(e.token ?? null), w)";
  const state =
    '[l, u] = t(null),\n    [f, p] = t(!1),\n    [m, g] = t(!1),\n    _ = bn(),\n    v = n.id ?? "",';
  const revoke = "s.mutateAsync({ triggerId: v }).then(() => u(null), w)";
  if (
    [url, result, state, revoke].some(
      (anchor) => source.split(anchor).length !== 2,
    )
  )
    throw Error("Pinned routine token panel anchor mismatch.");
  return source
    .replace(
      state,
      state.replace(
        "[l, u] = t(null),",
        "[l, u] = t(null),\n    [__claudexRoutineFireUrl, __claudexSetRoutineFireUrl] = t(null),",
      ),
    )
    .replace(url, 'y = (() => { const url = __claudexRoutineFireUrl ?? n.api_fire_url; return !url ? "" : globalThis.__claudexOfficialAccountContext ? new URL(new URL(url).pathname, location.origin).href : url; })(),')
    .replace(
      result,
      "o.mutateAsync({ triggerId: v }).then((e) => { __claudexSetRoutineFireUrl(e.api_fire_url ?? null); u(e.token ?? null); }, w)",
    )
    .replace(
      revoke,
      "s.mutateAsync({ triggerId: v }).then(() => { __claudexSetRoutineFireUrl(null); u(null); }, w)",
    );
}

export function applyOfficialUiHostRoutineFire(directory) {
  for (const name of [hostRoutineFireTarget, routineList, routineRun]) {
    const file = path.join(directory, name);
    fs.writeFileSync(
      file,
      deriveOfficialUiHostRoutineFireModule(
        name,
        fs.readFileSync(file, "utf8"),
      ),
    );
  }
  return { revision: hostRoutineFireRevision };
}
