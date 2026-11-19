/** Refresh original conversation queries when the desktop cloud snapshot changes. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const hostListUpdatesRevision = "claudex-conversation-list-updates-v4";
export const hostListUpdatesTarget = "shared-l-p-m-w-5-BDZb5dJN.js";
export const projectInstructionsTarget = "c9b54eb90-DUtJeN_L.js";
export const hostListUpdatesInputHashes = {
  [hostListUpdatesTarget]: "36603ed7aabec44c982747b06481ac62f80e16b5a361102589829a9b11c213a0",
  [projectInstructionsTarget]: "4ee8c2fe43aeb9787ad723f068d1aa6b932f8761e427a080a74d883bc7b69fe6",
};
export const hostListUpdatesOriginalHashes = {
  [hostListUpdatesTarget]: "2c70fd09fd96d0898776ebda7cec08b47ff15ec1035c3fdd5ea17a34631b2351",
  [projectInstructionsTarget]: hostListUpdatesInputHashes[projectInstructionsTarget],
};
export const projectInstructionsDraftHook = `function claudexUseProjectInstructions(saved, liveDraft, protectedDraft) {
  const [draft, setDraft] = n(saved), previousSaved = r(saved);
  c(() => {
    const previous = previousSaved.current;
    previousSaved.current = saved;
    if (liveDraft) {
      if (protectedDraft?.current !== true && liveDraft.current !== protectedDraft?.current && liveDraft.current === previous) {
        liveDraft.current = saved;
        setDraft(saved);
      }
    } else {
      setDraft(current => current === previous ? saved : current);
    }
  }, [saved, liveDraft, protectedDraft]);
  return [draft, setDraft];
}
`;
export const listUpdatesEffect = `function claudexObserveConversationLists(queryClient, orgUuid, target = window) {
  if (!orgUuid || typeof target.__claudexConversationListsRevision !== "number") return;
  const filters = [
    { queryKey: ["chat_conversation_list", { orgUuid }] },
    { queryKey: ["served-recents-search", orgUuid] },
    { queryKey: ["conversation_search_v2", { orgUuid }] },
    { queryKey: ["project_list", { orgUuid }] },
    { queryKey: ["project_list_v2", { orgUuid }] },
    { queryKey: ["projects_count", { orgUuid }] },
    { queryKey: ["project", { orgUuid }] },
    { queryKey: ["project_list_conversations", { orgUuid }] },
    { queryKey: ["sessions_api_list_sessions", { orgUuid }] },
    { queryKey: ["sessions_api_get_session", { orgUuid }] },
    { queryKey: ["trigger-sessions", { orgUuid }] },
    { queryKey: ["trigger-sessions-rollup", { orgUuid }] },
    { queryKey: ["cc-project-grouping-sessions", orgUuid] },
    { queryKey: ["epitaxy-sidebar-ath"] },
  ];
  let active = true, running = false, requested = 0, handled = 0;
  const refresh = async () => {
    if (running) return;
    running = true;
    try {
      while (active && requested > handled) {
        const version = requested;
        await Promise.all(filters.map(filter => queryClient.cancelQueries(filter)));
        if (!active) return;
        await Promise.all(filters.map(filter => queryClient.invalidateQueries(filter)));
        handled = version;
      }
    } finally { running = false; }
  };
  const changed = () => {
    requested = target.__claudexConversationListsRevision;
    void refresh().catch(() => console.warn("Claudex conversation lists could not be refreshed."));
  };
  target.addEventListener("claudex:conversation-lists-invalidated", changed);
  changed();
  return () => { active = false; target.removeEventListener("claudex:conversation-lists-invalidated", changed); };
}
`;
export const hostListUpdatesRules = [
  { file: hostListUpdatesTarget, name: "desktop-list-update-consumer", before: "function vB() {", after: `${listUpdatesEffect}\nfunction vB() {` },
  { file: hostListUpdatesTarget, name: "original-shell-list-subscription", before: "    D;\n  return (\n    J5($, 8, C, x, v, i, b, y, g, c, o, _, p, S, e, n, l, u, f, r)", after: "    D;\n  k_(() => claudexObserveConversationLists(e, v), [e, v]);\n  return (\n    J5($, 8, C, x, v, i, b, y, g, c, o, _, p, S, e, n, l, u, f, r)" },
  { file: projectInstructionsTarget, name: "saved-project-instructions-draft", before: "function Be(e) {", after: `${projectInstructionsDraftHook}\nfunction Be(e) {` },
  { file: projectInstructionsTarget, name: "closed-instructions-follow-saved-value", before: "    [C, w] = n(f.prompt_template),\n    T = r(C),", after: "    T = r(f.prompt_template),\n    protectedDraft = r(void 0),\n    [C, w] = claudexUseProjectInstructions(f.prompt_template, T, protectedDraft)," },
  {
    file: projectInstructionsTarget,
    name: "wait-for-project-instructions-save",
    before: `                if (!(t === void 0 || E || k.current)) {
                  if (!u) {
                    ((k.current = !0),
                      w(T.current),
                      l(),
                      R({ prompt_template: e }).catch((e) => {
                        (z(f.uuid), B(e));
                      }));
                    return;
                  }
                  D(!0);
                  try {
                    (await R({ prompt_template: e }), D(!1), w(T.current), u(), l());
                  } catch (e) {
                    let t = e;
                    (D(!1), B(t));
                  }
                }`,
    after: `                if (t === void 0 || E || k.current) return;
                k.current = !0;
                protectedDraft.current = !0;
                D(!0);
                try {
                  await R({ prompt_template: e });
                  protectedDraft.current = T.current === e ? void 0 : T.current;
                  w(T.current);
                  u?.();
                  l();
                } catch (error) {
                  protectedDraft.current = T.current;
                  w(T.current);
                  z(f.uuid);
                  B(error);
                } finally {
                  k.current = !1;
                  D(!1);
                }`,
  },
  { file: projectInstructionsTarget, name: "pristine-instructions-editor-follows-saved-value", before: "    [y, b] = n(t),\n    x = r.length > 0", after: "    [y, b] = claudexUseProjectInstructions(t),\n    x = r.length > 0" },
];
const sha = text => createHash("sha256").update(text).digest("hex");
export function deriveOfficialUiHostListUpdatesModule(file, source) {
  if (!Object.hasOwn(hostListUpdatesInputHashes, file)) return source;
  if (sha(source) !== hostListUpdatesInputHashes[file]) throw Error("Pinned list-update input mismatch");
  for (const rule of hostListUpdatesRules.filter(rule => rule.file === file)) {
    if (source.split(rule.before).length !== 2) throw Error("Pinned list-update anchor mismatch: " + rule.name);
    source = source.replace(rule.before, rule.after);
  }
  return source;
}
export function applyOfficialUiHostListUpdates(directory) {
  const modules = Object.keys(hostListUpdatesInputHashes).map(file => {
    const location = path.join(fs.realpathSync(directory), file);
    if (location.split(path.sep).includes(".restore") || !fs.lstatSync(location).isFile())
      throw Error("List updates require an assembled module");
    const output = deriveOfficialUiHostListUpdatesModule(file, fs.readFileSync(location, "utf8"));
    fs.writeFileSync(location, output);
    return { file, originalSha256: hostListUpdatesOriginalHashes[file], inputSha256: hostListUpdatesInputHashes[file], outputSha256: sha(output), rules: hostListUpdatesRules.filter(rule => rule.file === file).map(rule => rule.name) };
  });
  return { revision: hostListUpdatesRevision, modules };
}
