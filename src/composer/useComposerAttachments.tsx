import { useEffect, useRef } from "react";
import { fastModeState } from "./code/code-fast-mode";
import { surface } from "../../shared/host";
import { useTypeToFocus } from "./type-to-focus";
import { bashRefusal } from "./Composer";
import { maxAttachmentsFor, attachmentLimitNotice } from "./attachment-limits";
import type { Attachment, Mode } from "../../shared/types";
import { addPastedText, addFile, pastesAsCard } from "./attachment-input";
import { t } from "../i18n";
import type { ClipboardEvent } from "react";
import { attachmentRefusal } from "../../shared/client-policy-rules";
import type { FileDropScope } from "./useFileDrop";
import { useFileDrop } from "./useFileDrop";
import type { AppController } from "../app/AppContext";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import type { ComposerField } from "./composer-field";
import type { PendingAttachment } from "./Attachments";
import type { ClientPolicy } from "../../shared/client-policy";
import type { VoicePhase } from "../voice/useVoiceMode";

/** What useComposerAttachments needs from useComposerActions.tsx. */
export interface UseComposerAttachmentsKit {
  appContext: AppController | undefined;
  attachments: Attachment[];
  attachmentsAllowed: boolean;
  bash: boolean;
  catalog: ModelCatalog | null;
  codeHomeDraft: boolean;
  composer: React.RefObject<ComposerField | null>;
  currentDraft: React.RefObject<string>;
  draftIdentity: string;
  mode: Mode;
  model: string;
  narrow: boolean;
  notify: (message: string) => void;
  openSettingsTab: (tab: string) => void;
  pending: PendingAttachment[];
  pickFiles: () => Promise<void>;
  platform: NodeJS.Platform;
  policy: ClientPolicy;
  report: (error: unknown) => void;
  setAddMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setEffortOpenRequest: React.Dispatch<React.SetStateAction<number>>;
  setModel: (name: string) => void;
  setModelMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setPending: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
  setPermissionOpenRequest: React.Dispatch<React.SetStateAction<number>>;
  updateRequired: boolean;
  voicePhase: VoicePhase;
}

export function useComposerAttachments(kit: UseComposerAttachmentsKit) {
  const {
    appContext,
    attachments,
    attachmentsAllowed,
    bash,
    catalog,
    codeHomeDraft,
    composer,
    currentDraft,
    draftIdentity,
    mode,
    model,
    narrow,
    notify,
    openSettingsTab,
    pending,
    pickFiles,
    platform,
    policy,
    report,
    setAddMenu,
    setAttachments,
    setEffortOpenRequest,
    setModel,
    setModelMenu,
    setPending,
    setPermissionOpenRequest,
    updateRequired,
    voicePhase,
  } = kit;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModelMenu(false);
        setAddMenu(false);
      }
      // ⌘U alone.
      if (
        event.key.toLowerCase() === "u" &&
        (platform === "darwin" ? event.metaKey : event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.defaultPrevented &&
        attachmentsAllowed &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        if (event.repeat) return;
        setAddMenu(false);
        chooseFiles();
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [mode, platform, pickFiles, report, attachmentsAllowed, bash]);
  // The session rail's Settings rows open these pickers (session-rail).
  useEffect(() => {
    if (mode !== "code") return;
    const listener = (event: Event) => {
      const menu = (event as CustomEvent<string>).detail;
      setAddMenu(false);
      if (menu === "model") {
        if (codeHomeDraft) setEffortOpenRequest(0);
        setModelMenu(true);
      } else if (menu === "effort") {
        setModelMenu(codeHomeDraft);
        setEffortOpenRequest((value) => value + 1);
      } else if (menu === "permissions") {
        if (codeHomeDraft) setEffortOpenRequest(0);
        setModelMenu(false);
        setPermissionOpenRequest((value) => value + 1);
      }
    };
    window.addEventListener("claudex:composer-menu", listener);
    return () => window.removeEventListener("claudex:composer-menu", listener);
  }, [mode, codeHomeDraft]);
  // ⌥⌘F (Ctrl+Alt+F elsewhere) turns Fast mode on or off where the model has a
  // fast tier; otherwise it opens the model menu, whose Fast mode row says why.
  const toggleFastKey = useRef(() => {});
  toggleFastKey.current = () => {
    const state = fastModeState(catalog, model);
    if (state.available) setModel(state.target);
    else {
      if (codeHomeDraft) setEffortOpenRequest(0);
      setModelMenu(true);
    }
  };
  // ⇧⌘I opens Code's model menu, ⇧⌘E its effort selector and ⇧⌘M its permission
  // mode menu. Heard before the window's own ⇧⌘I (Incognito) so that Code keeps
  // the key; the web leaves Ctrl+Shift+I to the browser's developer tools.
  useEffect(() => {
    if (mode !== "code") return;
    const listener = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      // ⇧⌘M (the app) or ⌥⌘M opens the permission mode menu. Read by the
      // physical key: Option changes the letter.
      const modifier = platform === "darwin" ? event.metaKey : event.ctrlKey;
      if (
        event.code === "KeyF" &&
        modifier &&
        event.altKey &&
        !event.shiftKey &&
        !(platform === "darwin" ? event.ctrlKey : event.metaKey) &&
        !event.isComposing &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        setAddMenu(false);
        toggleFastKey.current();
        return;
      }
      if (
        event.code === "KeyM" &&
        modifier &&
        !event.isComposing &&
        (event.altKey
          ? !event.shiftKey
          : event.shiftKey && surface !== "web") &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        setAddMenu(false);
        if (codeHomeDraft) setEffortOpenRequest(0);
        setModelMenu(false);
        setPermissionOpenRequest((value) => value + 1);
        return;
      }
      if (
        (key !== "i" && key !== "e") ||
        !event.shiftKey ||
        event.altKey ||
        event.isComposing ||
        !(platform === "darwin" ? event.metaKey : event.ctrlKey) ||
        (key === "i" && surface === "web" && platform !== "darwin") ||
        document.querySelector('[role="dialog"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      setAddMenu(false);
      if (key === "i") {
        if (codeHomeDraft) setEffortOpenRequest(0);
        setModelMenu(true);
      } else {
        setModelMenu(codeHomeDraft);
        setEffortOpenRequest((value) => value + 1);
      }
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [mode, platform, codeHomeDraft]);

  // ⇧⌘. opens or closes the Chat and Cowork model menu.
  useEffect(() => {
    if (mode === "code") return;
    const listener = (event: KeyboardEvent) => {
      if (
        event.code !== "Period" ||
        !event.shiftKey ||
        event.altKey ||
        event.isComposing ||
        !(platform === "darwin"
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey) ||
        document.querySelector('[role="dialog"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      setAddMenu(false);
      setModelMenu((open) => !open);
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [mode, platform]);
  // Typing or pasting where nothing editable has the focus writes in the
  // composer (src/composer/type-to-focus.ts).
  useTypeToFocus(composer, true);

  /** Adds pasted or dropped files, each through the attachment rules. */
  const addFiles = async (files: File[], pastedText?: string) => {
    if (bash) return notify(bashRefusal);
    const limit = maxAttachmentsFor(mode);
    const room = limit - attachments.length - pending.length;
    // A batch that would go over the limit is refused with the limit's
    // sentence, whole, never trimmed in silence.
    if (
      room <= 0 ||
      files.length + (pastedText ? 1 : 0) > room ||
      (!files.length && !pastedText)
    ) {
      if (files.length || pastedText) notify(attachmentLimitNotice(limit));
      return;
    }
    const jobs: {
      key: string;
      name: string;
      image?: boolean;
      preview?: string;
      run: () => Promise<Attachment>;
    }[] = [
      ...(pastedText
        ? [
            {
              key: `pasted-${Date.now()}`,
              name: "Pasted text",
              run: () => addPastedText(pastedText),
            },
          ]
        : []),
      ...files.map((file, index) => ({
        key: `${file.name}-${file.size}-${Date.now()}-${index}`,
        name: file.name || "Pasted image",
        image: file.type.startsWith("image/"),
        preview: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined,
        run: () => addFile(file),
      })),
    ];
    await runAttachJobs(jobs);
  };
  /** Runs attachment jobs, showing each as pending until it is attached. */
  const runAttachJobs = async (
    jobs: {
      key: string;
      name: string;
      image?: boolean;
      preview?: string;
      run: () => Promise<Attachment>;
    }[],
  ) => {
    const limit = maxAttachmentsFor(mode);
    const identity = draftIdentity;
    setPending((value) => [...value, ...jobs]);
    await Promise.all(
      jobs.map(async (job) => {
        try {
          const added = await job.run();
          if (identity === currentDraft.current)
            setAttachments((value) => [...value, added].slice(0, limit));
        } catch (error) {
          report(error);
        } finally {
          if (job.preview) URL.revokeObjectURL(job.preview);
          setPending((value) => value.filter((item) => item.key !== job.key));
        }
      }),
    );
  };
  /** Picks files to attach; Bash mode takes none. */
  const chooseFiles = () => {
    if (voicePhase !== "off") return notify(t("End the voice session first"));
    if (bash) return notify(bashRefusal);
    void pickFiles().catch(report);
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length) {
      event.preventDefault();
      if (!attachmentsAllowed)
        return notify(t("Your administrator has turned off attachments"));
      void addFiles(files);
      return;
    }
    const pasted = event.clipboardData.getData("text/plain");
    // Text the attachment rules would refuse (no .txt, or too large) pastes as text.
    // Bash mode pastes plain text, never a card.
    if (
      !bash &&
      pastesAsCard(pasted) &&
      !attachmentRefusal(
        "Pasted text.txt",
        new TextEncoder().encode(pasted).byteLength,
        policy,
      )
    ) {
      event.preventDefault();
      void addFiles([], pasted);
    }
  };
  // A file drag anywhere in the window shows the drop overlay; with no side
  // panel the whole window takes the drop, beside one only the composer does
  // (the original's page and card drop scopes).
  const frame = useRef<HTMLDivElement>(null);
  const dropScope: FileDropScope = narrow ? "card" : "page";
  const dropState = useFileDrop(frame, {
    scope: dropScope,
    // With attachments off the zone is not armed: no overlay, no drop.
    enabled: !updateRequired && attachmentsAllowed,
    onDrop: (data) => {
      // Folders arrive as empty files without a type; they can't be attached.
      const files = Array.from(data.files).filter(
        (file) => file.size > 0 || file.type,
      );
      if (files.length < data.files.length)
        notify(t("Folders can't be attached. Drop files instead."));
      void addFiles(files);
    },
  });

  const openSkillsSettings = (view: "yours" | "discover") => {
    if (!appContext) {
      openSettingsTab("skills");
      return;
    }
    const { accountId, controllerScope, activeId, draftSession, mode } =
      appContext;
    const bridge = window.desktop;
    void import("../settings/skills-navigation")
      .then(({ requestSettingsSkillsView }) => {
        const current = appContext.currentController
          ? appContext.currentController.current
          : appContext;
        if (
          !current ||
          current.accountId !== accountId ||
          current.controllerScope !== controllerScope ||
          current.activeId !== activeId ||
          (!activeId && current.draftSession !== draftSession) ||
          current.mode !== mode ||
          window.desktop !== bridge
        )
          return;
        requestSettingsSkillsView(accountId, view, bridge);
        openSettingsTab("skills");
      })
      .catch(report);
  };
  return {
    chooseFiles,
    openSkillsSettings,
    dropScope,
    dropState,
    frame,
    onPaste,
    runAttachJobs,
  } as const;
}
