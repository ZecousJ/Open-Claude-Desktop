import type { RefObject } from "react";
import type { AppController } from "../app/AppContext";
import { requestFolderAccess } from "../cowork/useFolderAccess";
import { defaultProjectId } from "./project-picker-preferences";
import { nativeDefaultFolder } from "./native-place-preferences";
import {
  knownLocalFolder,
  liveNativeProjectFolder,
} from "./native-place-model";

type Expected = { accountId: string; scope: object; draftSession: string };
const states = new WeakMap<
  object,
  { generation: number; draft?: string; pending?: Promise<boolean> }
>();
function state(scope: object) {
  let value = states.get(scope);
  if (!value) {
    value = { generation: 0 };
    states.set(scope, value);
  }
  return value;
}
/** Explicit choices invalidate an older automatic draft selection. */
export function invalidateNativeDefaultPlace(app: AppController) {
  return app.controllerScope ? ++state(app.controllerScope).generation : 0;
}
export function nativePlaceGeneration(app: AppController) {
  return app.controllerScope ? state(app.controllerScope).generation : 0;
}

/** Only a committed ordinary native draft receives a remembered local folder.
 * A preference never grants filesystem access. It is rechecked before and
 * after the existing main-process authorization; account/draft/selection
 * changes, incognito, sending and remote/deleted history invalidate it.
 */
export function applyNativeDefaultPlace(
  ref: RefObject<AppController | undefined>,
  expected: Expected,
  authorize: typeof requestFolderAccess = requestFolderAccess,
): Promise<boolean> {
  const cache = state(expected.scope);
  if (cache.draft === expected.draftSession && cache.pending)
    return cache.pending;
  const generation = cache.generation;
  const current = () => {
    const app = ref.current;
    return app &&
      app.accountId === expected.accountId &&
      app.controllerScope === expected.scope &&
      app.draftSession === expected.draftSession &&
      cache.generation === generation &&
      app.host?.kind === "desktop" &&
      app.host.capabilities.localFolders &&
      app.mode !== "code" &&
      !app.activeId &&
      !app.active &&
      !app.incognitoShown &&
      !app.sending &&
      !app.cwd &&
      !app.projectId &&
      app.page === "chat"
      ? app
      : undefined;
  };
  cache.draft = expected.draftSession;
  cache.pending = (async () => {
    const app = current();
    if (!app) return false;
    const projectId = defaultProjectId(expected.accountId);
    const project = app.snapshot.projects.find(
      (p) => p.id === projectId && liveNativeProjectFolder(p),
    );
    const folder = project?.cwd ?? nativeDefaultFolder(expected.accountId);
    const projectEnvironment = project?.environment?.kind;
    if (!project && !knownLocalFolder(folder, app.snapshot.conversations))
      return false;
    const allowed = await authorize(folder!, {
      notify: app.notify,
      ...(project ? { projectId: project.id } : {}),
    });
    const live = current();
    if (allowed !== "granted" || !live) return false;
    if (project) {
      if (
        defaultProjectId(expected.accountId) !== projectId ||
        !live.snapshot.projects.some(
          (p) =>
            p.id === projectId &&
            p.cwd === folder &&
            liveNativeProjectFolder(p) &&
            p.environment?.kind === projectEnvironment,
        )
      )
        return false;
      await live.addConversationToProject(projectId!);
    } else {
      if (
        !knownLocalFolder(folder, live.snapshot.conversations) ||
        nativeDefaultFolder(expected.accountId) !== folder ||
        defaultProjectId(expected.accountId)
      )
        return false;
      live.setCwd(folder);
    }
    return true;
  })();
  return cache.pending;
}
