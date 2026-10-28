import { blankArtifactCreateLease } from "./blank-artifact-request";
import type { AppController } from "../app/AppContext";
interface Scope {
  account: string;
  owner: object | undefined;
  bridge: Window["desktop"];
  conversationId: string;
  artifactId: string;
}
interface Editor {
  flush(): Promise<boolean>;
  lock(): () => void;
  revision(): string | undefined;
}
const editors = new Set<Scope & Editor>();
export interface BlankArtifactSendLease {
  saved: boolean;
  current(): boolean;
  expected?: { artifactId: string; revision: string };
  release(): void;
}
/** Only save operations live here; document bytes remain in the scoped editor. */
export function registerBlankArtifactFlush(scope: Scope, editor: Editor) {
  const entry = { ...scope, ...editor };
  editors.add(entry);
  return () => {
    editors.delete(entry);
  };
}
export async function prepareScopedBlankEditors(input: {
  account: string | undefined;
  owner?: object;
  matchOwner?: boolean;
  bridge: Window["desktop"];
  conversationId: string;
  artifactId: string;
  current(): boolean;
}): Promise<BlankArtifactSendLease> {
  const releases: (() => void)[] = [];
  let released = false;
  const lease: BlankArtifactSendLease = {
    saved: false,
    current: input.current,
    release() {
      if (released) return;
      released = true;
      for (const release of releases) release();
    },
  };
  try {
    const selected = [...editors].filter(
      (entry) =>
        entry.account === input.account &&
        entry.bridge === input.bridge &&
        entry.conversationId === input.conversationId &&
        entry.artifactId === input.artifactId &&
        (!input.matchOwner || entry.owner === input.owner),
    );
    for (const entry of selected) releases.push(entry.lock());
    let revision: string | undefined;
    for (const entry of selected) {
      if (
        !input.current() ||
        !editors.has(entry) ||
        !(await entry.flush()) ||
        !input.current()
      )
        return lease;
      const actual = entry.revision();
      if (revision && actual && revision !== actual) return lease;
      revision = actual ?? revision;
    }
    lease.saved = input.current();
    if (revision) lease.expected = { artifactId: input.artifactId, revision };
    return lease;
  } catch (error) {
    lease.release();
    throw error;
  }
}
export async function prepareBlankArtifactSend(
  app: AppController,
): Promise<BlankArtifactSendLease> {
  const bridge = window.desktop,
    account = app.accountId,
    owner = app.controllerScope,
    id = app.activeId,
    artifactId = app.active?.blankArtifact?.id;
  if (!artifactId || !id)
    return { saved: true, current: () => true, release() {} };
  const intent = blankArtifactCreateLease(app, false);
  const current = () => {
    const now = app.currentController?.current ?? app;
    return Boolean(
      intent.current() &&
      now &&
      now.accountId === account &&
      now.controllerScope === owner &&
      now.activeId === id &&
      now.active?.blankArtifact?.id === artifactId &&
      window.desktop === bridge,
    );
  };
  let lease: BlankArtifactSendLease;
  try {
    lease = await prepareScopedBlankEditors({
      account,
      owner,
      matchOwner: true,
      bridge,
      conversationId: id,
      artifactId,
      current,
    });
  } catch (error) {
    intent.release();
    throw error;
  }
  const release = lease.release;
  lease.release = () => {
    release();
    intent.release();
  };
  return lease;
}
/** Independent callers that need to flush without holding a send operation. */
export async function flushBlankArtifactDrafts(app: AppController) {
  const lease = await prepareBlankArtifactSend(app);
  try {
    return lease.saved;
  } finally {
    lease.release();
  }
}
