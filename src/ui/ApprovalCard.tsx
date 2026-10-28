import { Suspense, useContext, useMemo, useRef, useState } from "react";
import { AppContext } from "../app/AppContext";
import { codeSessionSettings } from "../../shared/code-session-permissions";
import { modeAllowed, permissionModeOf } from "../../shared/client-policy";
import { ExternalLink } from "./glyphs";
import type { Approval, Conversation } from "../../shared/types";
import {
  allowsAlways,
  alwaysDisabledReason,
  approvalItem,
  approvalKind,
  approvalResponse,
  browserApproval,
  browserApprovalResponse,
  commandTitle,
  fileChangeTitle,
  permissionTitle,
  workflowApproval,
  branchSetupApproval,
  type ApprovalChoice,
} from "../approval/approval-model";
import { WorkflowApprovalCard } from "../approval/WorkflowApprovalCard";
import {
  elicitationContent,
  elicitationFields,
  type FormValues,
} from "../approval/elicitation-form";
import {
  ApprovalActions,
  useApprovalShortcuts,
  type ApprovalHandlers,
} from "../approval/ApprovalActions";
import {
  CommandBody,
  FileChangeBody,
  PermissionsBody,
} from "../approval/ApprovalBody";
import { ElicitationFields } from "../approval/ElicitationFields";
import { RequestDetails } from "../approval/RequestDetails";
import { lazyPiece } from "./lazy-piece";
import { usePolicy } from "../policy/PolicyContext";
import { alwaysScope, mcpToolApproval } from "../../shared/mcp-tool-approval";
import { coworkFolderRequest } from "../../shared/cowork-folder-request";

// The question card loads with the first question.
const QuestionsCard = lazyPiece(
  () => import("../approval/QuestionsCard"),
  "QuestionsCard",
);
const BranchSetupCard = lazyPiece(
  () => import("../approval/BranchSetupCard"),
  "BranchSetupCard",
);
const FolderAccessDialog = lazyPiece(
  () => import("../cowork/FolderAccessDialog"),
  "FolderAccessDialog",
);

/**
 * Pending Codex request docked above the composer: command, file edit, extra
 * permissions, MCP form or URL, or agent questions. Each button sends the
 * matching protocol response.
 */
export function ApprovalCard({
  approval,
  conversation,
  frontmost,
  mac,
  onError,
}: {
  approval: Approval;
  conversation?: Conversation;
  /** Only the first pending request answers keyboard shortcuts. */
  frontmost: boolean;
  mac: boolean;
  onError: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<FormValues>({});
  const [problem, setProblem] = useState<string>();
  const policy = usePolicy();
  const kind = approvalKind(approval);
  const p = approval.params ?? {};
  const url = kind === "elicitation" && p.mode === "url";
  const fields = useMemo(
    () =>
      kind === "elicitation" && !url
        ? elicitationFields(p.requestedSchema)
        : [],
    [kind, url, p.requestedSchema],
  );
  // Claude's Browser tools ask with a form of one choice; the card shows it as buttons (R8-G).
  const browser = useMemo(() => browserApproval(approval), [approval]);
  // The Workflow tool's "Run workflow?" has its own card.
  const workflow = useMemo(() => workflowApproval(approval), [approval]);
  const branchSetup = useMemo(() => branchSetupApproval(approval), [approval]);
  // A connector tool's approval is asked in the official words.
  const tool = useMemo(() => mcpToolApproval(approval), [approval]);
  const item =
    kind === "fileChange" ? approvalItem(approval, conversation) : undefined;
  async function send(result: unknown) {
    setBusy(true);
    try {
      await window.desktop.approve(approval.id, result);
    } catch (e) {
      onError(e);
      setBusy(false);
    }
  }
  // The request is accepted only once the page really opened (http/https only).
  async function openPage() {
    setBusy(true);
    try {
      await window.desktop.openExternal(p.url);
    } catch (e) {
      onError(e);
      setBusy(false);
      return;
    }
    await send({ action: "accept", content: null, _meta: null });
  }
  function choose(choice: ApprovalChoice) {
    if (busy) return;
    if (browser || workflow) return void send(browserApprovalResponse(choice));
    // A connector tool's approval has no form: the buttons are the answer.
    if (tool) return void send(approvalResponse(approval, choice));
    if (kind === "elicitation" && choice !== "deny") {
      if (url) return void openPage();
      const result = elicitationContent(fields, values);
      if ("error" in result) return setProblem(result.error);
      return void send({
        action: "accept",
        content: result.content,
        _meta: null,
      });
    }
    void send(approvalResponse(approval, choice));
  }
  // More allow options ▸ Allow and switch to Auto: a Code session's command,
  // edit or permission request while the session is not in Auto.
  const app = useContext(AppContext);
  const scopedCode =
    app?.snapshot.host?.capabilities?.codeSessionPermissions === true &&
    !(
      conversation?.scheduledRun &&
      conversation.scheduledPermission !== undefined
    );
  const codeSettings = app
    ? codeSessionSettings(
        app.snapshot.settings,
        scopedCode ? conversation?.codePermissionMode : undefined,
      )
    : undefined;
  const offersAuto =
    app != null &&
    conversation?.mode === "code" &&
    !browser &&
    !workflow &&
    !tool &&
    (kind === "command" || kind === "fileChange" || kind === "permissions") &&
    modeAllowed(policy, "auto") &&
    permissionModeOf(codeSettings!, conversation.cwd) !== "auto";
  const handlers: ApprovalHandlers = {
    deny: kind === "questions" ? undefined : () => choose("deny"),
    always: allowsAlways(approval, policy) ? () => choose("always") : undefined,
    alwaysDisabledReason: allowsAlways(approval, policy)
      ? undefined
      : alwaysDisabledReason(approval, policy),
    once: () => choose("once"),
    switchToAuto: offersAuto
      ? () => {
          choose("once");
          if (!app || !conversation) return;
          const patch = {
            codeSandbox: "workspace-write",
            autoAcceptEdits: false,
            codePlanMode: false,
          } as const;
          const change = scopedCode
            ? import("../app/code-permission-state").then(
                ({ setSessionCodePermission }) =>
                  setSessionCodePermission(
                    app,
                    { ...codeSettings!, ...patch },
                    conversation,
                  ),
              )
            : app.updatePreference(patch);
          void change.catch(onError);
        }
      : undefined,
  };
  const folderRequest = coworkFolderRequest(approval, conversation);
  const folderCard = Boolean(folderRequest && allowsAlways(approval, policy));
  useApprovalShortcuts(
    frontmost && !busy && kind !== "questions" && !folderCard && !branchSetup,
    handlers,
    mac,
  );
  if (folderRequest && folderCard)
    return (
      <Suspense fallback={null}>
        <FolderAccessDialog
          folder={folderRequest.paths[0]}
          paths={folderRequest.paths}
          reason={folderRequest.reason}
          name=""
          platform=""
          addition
          busy={busy}
          keyboardEnabled={frontmost}
          onCancel={() => choose("deny")}
          onAllow={() => choose("always")}
        />
      </Suspense>
    );
  if (branchSetup)
    return (
      <Suspense fallback={null}>
        <BranchSetupCard
          suggested={branchSetup.suggested}
          busy={busy}
          onContinue={(content) =>
            void send({ action: "accept", content, _meta: null })
          }
        />
      </Suspense>
    );
  const title =
    kind === "command"
      ? commandTitle(p)
      : kind === "fileChange"
        ? fileChangeTitle(item, p.grantRoot)
        : kind === "permissions"
          ? permissionTitle(p.permissions)
          : browser
            ? browser.title
            : tool
              ? // "Allow Claude to use {label}?" with the connector before
                // the tool, as its row names it.
                `Allow Claudex to use ${[tool.connector ?? tool.server, tool.title?.replace(/_+/g, " ")].filter(Boolean).join(": ") || "this tool"}?`
              : kind === "elicitation"
                ? url
                  ? `${p.serverName ?? "A connector"} wants you to open a page`
                  : `${p.serverName ?? "A connector"} needs more information`
                : "Claudex has a question";
  if (workflow)
    return (
      <WorkflowApprovalCard
        name={workflow.name}
        managed={workflow.managed}
        handlers={handlers}
        busy={busy}
        mac={mac}
      />
    );
  if (kind === "questions")
    return (
      <section
        className="approval-card question-card"
        aria-label={title}
        data-kind={kind}
        aria-busy={busy || undefined}
      >
        <Suspense fallback={null}>
          <QuestionsCard
            questions={p.questions ?? []}
            busy={busy}
            frontmost={frontmost}
            mac={mac}
            onSubmit={(answers) => void send({ answers })}
          />
        </Suspense>
      </section>
    );
  return (
    <section
      className="approval-card approval-request"
      aria-label={title}
      data-kind={kind}
      aria-busy={busy || undefined}
    >
      <h3 className="approval-title">{title}</h3>
      <RequestDetails>
        {kind === "command" && <CommandBody params={p} />}
        {kind === "fileChange" && (
          <FileChangeBody
            approval={approval}
            item={item}
            cwd={conversation?.cwd}
          />
        )}
        {kind === "permissions" && <PermissionsBody params={p} />}
        {browser && (
          <>
            {browser.code && (
              <pre className="approval-code">{browser.code}</pre>
            )}
            {browser.lines.map((line, index) => (
              <p className="approval-text" key={index}>
                {line}
              </p>
            ))}
          </>
        )}
        {tool && (
          <>
            {tool.rows.map((row, index) => (
              <p className="approval-text" key={index}>
                {row.label}: {row.value}
              </p>
            ))}
          </>
        )}
        {kind === "elicitation" && !browser && !tool && (
          <>
            {p.message && <p className="approval-text">{p.message}</p>}
            {url && p.url && <pre className="approval-code">{p.url}</pre>}
            {!url && (
              <ElicitationFields
                fields={fields}
                values={values}
                onChange={(name, value) => {
                  setProblem(undefined);
                  setValues((current) => ({ ...current, [name]: value }));
                }}
              />
            )}
          </>
        )}
        {problem && (
          <p className="approval-problem" role="alert">
            {problem}
          </p>
        )}
      </RequestDetails>
      <ApprovalActions
        handlers={handlers}
        busy={busy}
        mac={mac}
        alwaysLabel={
          browser?.always ??
          (tool && alwaysScope(tool) === "session"
            ? "Allow for this session"
            : undefined)
        }
        onceLabel={
          browser
            ? browser.once
            : tool
              ? "Allow once"
              : kind === "elicitation" && !url
                ? "Submit"
                : url
                  ? "Open page"
                  : "Allow once"
        }
        onceIcon={
          url ? <ExternalLink size={13} strokeWidth={1.75} /> : undefined
        }
      />
    </section>
  );
}
