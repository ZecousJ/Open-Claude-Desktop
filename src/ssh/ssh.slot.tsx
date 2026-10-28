/**
 * SSH environments' window-level dialogs (R9-S5): Add / Edit connection,
 * Choose a folder on a host, and the questions ssh asks while connecting
 * (askpass), which sit above everything else. Loaded by src/main.tsx
 * before the first render; its stylesheet comes after the app's own.
 */
import { registerOverlay } from "../app/AppOverlays";
import { Suspense } from "react";
import { t } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import { useApp } from "../app/AppContext";
import { AddSshHostDialog } from "./AddSshHostDialog";
import { RemoteFolderDialog } from "./RemoteFolderDialog";
import { SshPromptDialog } from "./SshPromptDialog";
import { chooseRemoteFolder, selectHost } from "./actions";
import { closeSshDialog, useSshDialog } from "./dialogs";
import {
  answerSshPrompt,
  connectSshHost,
  deleteSshHost,
  disconnectSshHost,
  saveSshHost,
  useSshHosts,
} from "./useSshHosts";
import "./ssh.css";

const SshLinkDialog = lazyPiece(
  () => import("./SshLinkDialog"),
  "SshLinkDialog",
);
const SshToolGrantsDialog = lazyPiece(
  () => import("./SshToolGrantsDialog"),
  "SshToolGrantsDialog",
);

function SshOverlays() {
  const app = useApp();
  const ssh = useSshHosts();
  const dialog = useSshDialog();
  const prompt = ssh.prompts[0];
  const promptHost = prompt && ssh.hosts.find((h) => h.id === prompt.hostId);
  const folderHost =
    dialog?.kind === "folder"
      ? ssh.hosts.find((h) => h.id === dialog.hostId)
      : undefined;
  return (
    <>
      {dialog?.kind === "tools" && (
        <Suspense fallback={null}>
          <SshToolGrantsDialog onClose={closeSshDialog} />
        </Suspense>
      )}
      {dialog?.kind === "link" && (
        <Suspense fallback={null}>
          <SshLinkDialog target={dialog.target} onClose={closeSshDialog} />
        </Suspense>
      )}
      {dialog?.kind === "host" && ssh.ready && (
        <AddSshHostDialog
          key={dialog.host?.id ?? "new"}
          host={dialog.host}
          suggestions={ssh.suggestions}
          onTest={(input) => window.desktop.sshTestHost(input)}
          onForgetHostKey={(input) => window.desktop.sshForgetHostKey(input)}
          onSave={async (input) => {
            const saved = await saveSshHost(input);
            app.notify(
              t(
                dialog.host
                  ? "SSH connection updated."
                  : "SSH connection added.",
              ),
            );
            if (dialog.select) void selectHost(saved, app.setCwd, app.report);
          }}
          onClose={closeSshDialog}
          onDelete={
            dialog.host
              ? async () => {
                  await deleteSshHost(dialog.host!.id);
                  closeSshDialog();
                  app.notify(t("SSH connection deleted."));
                }
              : undefined
          }
          onDisconnect={
            dialog.host && ssh.statuses[dialog.host.id]?.state === "ready"
              ? () => void disconnectSshHost(dialog.host!.id).catch(app.report)
              : undefined
          }
        />
      )}
      {folderHost && ssh.ready && (
        <RemoteFolderDialog
          key={folderHost.id}
          host={folderHost}
          status={ssh.statuses[folderHost.id]}
          list={(path) => window.desktop.sshListDirectory(folderHost.id, path)}
          onConnect={() => void connectSshHost(folderHost.id)}
          onChoose={(path) =>
            dialog?.kind === "folder" && dialog.onChoose
              ? dialog.onChoose(path)
              : chooseRemoteFolder(folderHost.id, path, app.setCwd)
          }
          onClose={closeSshDialog}
        />
      )}
      {prompt && (
        <SshPromptDialog
          key={prompt.id}
          prompt={prompt}
          label={promptHost?.label ?? "SSH host"}
          onAnswer={(answer) =>
            void answerSshPrompt(prompt.id, answer).catch(app.report)
          }
        />
      )}
    </>
  );
}

registerOverlay("ssh", SshOverlays);
