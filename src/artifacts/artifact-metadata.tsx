import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Artifact } from "../ui/components";
import {
  artifactNoteKey,
  type ArtifactComment,
  type ArtifactNote,
  type ArtifactNotePatch,
  type ArtifactNotes,
} from "../../shared/artifact-notes";
import { legacyMetadataKey, metadataStorageKey } from "./artifact-storage-keys";
import type { Metadata } from "./artifact-storage";
import { t } from "../i18n";
import { AppContext } from "../app/AppContext";

export type ArtifactCommentAccess = NonNullable<ArtifactNote["access"]>;
export class ArtifactCommentOperationRetired extends Error {
  readonly code = "ARTIFACT_COMMENT_OPERATION_RETIRED";
  constructor() {
    super("Artifact comment operation no longer belongs to this account.");
  }
}

export function artifactIdentity(a: Artifact) {
  return a.libraryId
    ? JSON.stringify(["library", a.libraryId])
    : JSON.stringify([a.conversationId ?? "", a.sourcePath ?? a.content]);
}
/** The key of an artifact's notes in the account profile. */
export function artifactNoteKeyOf(a: Artifact) {
  return artifactNoteKey(artifactIdentity(a));
}
export const ArtifactAccountScope = createContext<{
  id: string;
  email?: string;
  legacyOwner: boolean;
  conversationIds: ReadonlySet<string>;
}>({ id: "", legacyOwner: false, conversationIds: new Set() });

interface NotesState {
  canRename: boolean;
  notes: ArtifactNotes;
  /** False until the profile's notes have been read. */
  loaded: boolean;
  update: (a: Artifact, patch: ArtifactNotePatch) => Promise<void>;
}
const Context = createContext<NotesState>({
  canRename: false,
  notes: {},
  loaded: true,
  update() {
    return Promise.reject(Error("Artifact notes are unavailable."));
  },
});
const notesApi = () =>
  typeof window === "undefined" ? undefined : window.desktop;

/**
 * The account's artifact names, open times and comments, read from and
 * saved to its profile. Notes of an incognito chat's artifacts stay in
 * memory. Names an earlier version kept in window storage move over once.
 */
export function ArtifactMetadataProvider({
  children,
  accountId,
  accountEmail,
  legacyOwner,
  conversationIds,
}: {
  children: ReactNode;
  accountId: string;
  accountEmail?: string;
  legacyOwner: boolean;
  conversationIds: ReadonlySet<string>;
}) {
  const app = useContext(AppContext);
  const bridge = notesApi();
  const owner = useMemo(
    () => ({
      accountId,
      bridge,
      controller: app?.controllerScope,
      ref: app?.currentController,
    }),
    [accountId, bridge, app?.controllerScope, app?.currentController],
  );
  const latestOwner = useRef<typeof owner | undefined>(owner);
  latestOwner.current = owner;
  useLayoutEffect(() => {
    latestOwner.current = owner;
    return () => {
      if (latestOwner.current === owner) latestOwner.current = undefined;
    };
  }, [owner]);
  const current = useCallback(() => {
    const controller = owner.ref?.current;
    return (
      latestOwner.current === owner &&
      notesApi() === bridge &&
      (!owner.ref ||
        Boolean(
          controller &&
          controller.accountId === owner.accountId &&
          controller.controllerScope === owner.controller,
        ))
    );
  }, [owner, bridge]);
  const stateOwner = useRef(owner);
  const [notes, setNotes] = useState<ArtifactNotes>({});
  const [loaded, setLoaded] = useState(false);
  const report = useRef(app?.report);
  report.current = app?.report;
  const incognito = useRef(new Set<string>());
  incognito.current = new Set(
    app?.snapshot.conversations.filter((c) => c.incognito).map((c) => c.id),
  );
  const ids = useRef(conversationIds);
  ids.current = conversationIds;
  useEffect(() => {
    let live = true;
    stateOwner.current = owner;
    setNotes({});
    setLoaded(false);
    void (async () => {
      const api = bridge;
      // A passing failure (the runner busy while the page starts) is read
      // again once before it is reported.
      const read = () => api?.artifactNotes?.();
      let next: ArtifactNotes =
        (await read()?.catch(async () => {
          await new Promise((done) => setTimeout(done, 1500));
          if (!live || !current()) return undefined;
          return read();
        })) ?? {};
      if (!live || !current()) return;
      if (
        typeof localStorage !== "undefined" &&
        (localStorage.getItem(metadataStorageKey(accountId)) !== null ||
          (legacyOwner && localStorage.getItem(legacyMetadataKey) !== null))
      ) {
        const { importStoredArtifactNames } =
          await import("./artifact-storage");
        if (!live || !current()) return;
        next =
          (await importStoredArtifactNames(
            api,
            accountId,
            legacyOwner,
            ids.current,
            artifactNoteKey,
          )) ?? next;
      }
      if (live && current()) setNotes(next);
    })()
      .catch((error) => {
        if (live && current()) report.current?.(error);
      })
      .finally(() => {
        if (live && current()) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [owner, legacyOwner, current]);
  const update = useCallback(
    async (a: Artifact, patch: ArtifactNotePatch) => {
      if (!current()) throw new ArtifactCommentOperationRetired();
      const key = artifactNoteKeyOf(a);
      const conversationId = a.libraryId ? undefined : a.conversationId;
      const local = (current: ArtifactNote | undefined): ArtifactNote => ({
        ...current,
        ...(conversationId ? { conversationId } : {}),
        ...(patch.name !== undefined
          ? { name: patch.name, renamedAt: Date.now() }
          : {}),
        ...(patch.viewed ? { viewedAt: Date.now() } : {}),
        ...(patch.comments ? { comments: patch.comments } : {}),
      });
      const commentWrite = patch.comments !== undefined;
      // Comments appear only after a confirmed save; a refusal must not leave
      // a locally visible comment that the backend did not accept.
      if (
        !commentWrite ||
        (conversationId && incognito.current.has(conversationId))
      )
        setNotes((previous) => ({ ...previous, [key]: local(previous[key]) }));
      if (conversationId && incognito.current.has(conversationId)) return;
      const saved = await bridge?.updateArtifactNote?.(key, {
        ...patch,
        ...(conversationId ? { conversationId } : {}),
      });
      if (!current()) throw new ArtifactCommentOperationRetired();
      if (commentWrite && !saved)
        throw new Error("Artifact notes are unavailable.");
      if (saved) setNotes((previous) => ({ ...previous, [key]: saved }));
    },
    [bridge, current],
  );
  const value = useMemo(
    () => ({
      notes: stateOwner.current === owner ? notes : {},
      loaded: stateOwner.current === owner && loaded,
      update,
      canRename: stateOwner.current === owner && loaded,
    }),
    [notes, loaded, update, owner],
  );
  return (
    <ArtifactAccountScope.Provider
      value={{
        id: accountId,
        email: accountEmail,
        legacyOwner,
        conversationIds,
      }}
    >
      <Context.Provider value={value}>{children}</Context.Provider>
    </ArtifactAccountScope.Provider>
  );
}
export function applyArtifactMetadata(a: Artifact, meta?: Metadata) {
  const timestamps = [a.updatedAt, meta?.updatedAt].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  return {
    artifact: meta ? { ...a, name: meta.name } : a,
    updatedAt: timestamps.length ? Math.max(...timestamps) : undefined,
  };
}
/** The artifact under its saved name, with its latest content or rename time. */
export function useArtifactMetadata(a: Artifact) {
  const context = useContext(Context),
    note = context.notes[artifactNoteKeyOf(a)];
  const meta = note?.name
    ? { name: note.name, updatedAt: note.renamedAt ?? 0 }
    : undefined;
  return {
    ...applyArtifactMetadata(a, meta),
    canRename: context.canRename,
    viewedAt: note?.viewedAt,
    rename: (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 200)
        throw Error("Use a name between 1 and 200 characters.");
      return context.update(a, { name: trimmed });
    },
  };
}
/** An artifact's saved comments; undefined until any were saved. */
export function useArtifactComments(
  a: Artifact,
  explicitAccess?: ArtifactCommentAccess,
) {
  const context = useContext(Context);
  const account = useContext(ArtifactAccountScope);
  const app = useContext(AppContext);
  const bridge = notesApi();
  const identity = artifactIdentity(a);
  const owner = useMemo(
    () => ({
      account: app?.accountId ?? account.id,
      controller: app?.controllerScope,
      bridge,
      identity,
      ref: app?.currentController,
    }),
    [
      app?.accountId,
      account.id,
      app?.controllerScope,
      app?.currentController,
      bridge,
      identity,
    ],
  );
  const latest = useRef<typeof owner | undefined>(owner);
  latest.current = owner;
  useLayoutEffect(() => {
    latest.current = owner;
    return () => {
      if (latest.current === owner) latest.current = undefined;
    };
  }, [owner]);
  const note = context.notes[artifactNoteKeyOf(a)];
  // These are explicit backend/caller rights. Sharing audience, imports and
  // pinned versions do not describe permission to mutate account notes.
  const canRead =
    note?.access?.read !== false && explicitAccess?.read !== false;
  const readOnly =
    note?.access?.write === false || explicitAccess?.write === false;
  const canWrite = context.loaded && canRead && !readOnly;
  const permissions = useRef({ canRead, canWrite });
  permissions.current = { canRead, canWrite };
  const isCurrent = useCallback(() => {
    const controller = owner.ref?.current;
    return (
      latest.current === owner &&
      notesApi() === bridge &&
      (!owner.ref ||
        Boolean(
          controller &&
          controller.accountId === owner.account &&
          controller.controllerScope === owner.controller,
        ))
    );
  }, [owner, bridge]);
  return {
    loaded: context.loaded,
    comments: canRead ? note?.comments : undefined,
    canRead,
    canWrite,
    readOnly,
    isCurrent,
    writable: () => isCurrent() && permissions.current.canWrite,
    save: async (comments: ArtifactComment[]) => {
      if (!isCurrent()) throw new ArtifactCommentOperationRetired();
      if (!permissions.current.canWrite)
        throw new Error(t("Commenting isn’t available with view-only access."));
      await context.update(a, { comments });
      if (!isCurrent()) throw new ArtifactCommentOperationRetired();
    },
  };
}
/** Records that an artifact was opened (the Artifacts list's "Viewed"). */
export function useMarkArtifactViewed() {
  const context = useContext(Context);
  return (a: Artifact) => context.update(a, { viewed: true });
}
/** Every note, for lists that sort or label many artifacts at once. */
export function useArtifactNotes() {
  return useContext(Context).notes;
}
/** False until the profile's notes (saved names, open times) have been read. */
export function useArtifactNotesLoaded() {
  return useContext(Context).loaded;
}
/** Cards in a transcript need the conversation identity before an artifact is opened. */
export const ArtifactConversation = createContext<string | undefined>(
  undefined,
);
