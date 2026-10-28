import { useEffect, useRef, useState } from "react";
import { GitBranch, ChevronDown } from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { Attachment } from "../../shared/types";
import type { GitHubRepository, GitHubStatus } from "../../shared/github-api";
import { api } from "../desktop-api";
import { GithubMark } from "../ui/GithubMark";
import { useHost } from "../host/HostContext";
import { useT } from "../i18n";
import { Modal } from "../ui/Controls";
import { RepositoryMenu } from "./RepositoryMenu";
import { BranchMenu } from "./repository-menu-parts";
import "./chat-github.css";

// Repository-only Chat linking.
export function ChatGitHubDialog({
  onClose,
  onAttach,
}: {
  onClose: () => void;
  onAttach: (attachment: Attachment) => void;
}) {
  useT();
  const host = useHost();
  const [status, setStatus] = useState<GitHubStatus>();
  const [repository, setRepository] = useState<GitHubRepository>();
  const [branch, setBranch] = useState("");
  const [menu, setMenu] = useState<"repository" | "branch">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const repoAnchor = useRef<HTMLButtonElement>(null);
  const branchAnchor = useRef<HTMLButtonElement>(null);
  const refresh = () =>
    api
      .githubStatus()
      .then(setStatus)
      .catch(() => setError("Something went wrong. You can try again."));
  useEffect(() => {
    let live = true;
    void api
      .githubStatus()
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch(() => {
        if (live) setError("Something went wrong. You can try again.");
      });
    return () => {
      live = false;
    };
  }, []);
  const attach = async () => {
    if (!repository || !branch || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      onAttach(await api.linkChatGitHubRepository(repository.fullName, branch));
      onClose();
    } catch {
      setError("Something went wrong. You can try again.");
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add content from GitHub"
      className="chat-github-dialog"
      onClose={() => (menu ? setMenu(undefined) : onClose())}
      disablePointerDismissal
    >
      <p className="chat-github-description">
        Pick a repository and branch to link in this chat
      </p>
      <div className="chat-github-picker">
        <div className="chat-github-toolbar">
          <GithubMark />
          <div className="popover-anchor">
            <button
              className="secondary"
              ref={repoAnchor}
              disabled={host.kind === "desktop" && !status?.connected}
              onClick={() =>
                setMenu(menu === "repository" ? undefined : "repository")
              }
              aria-haspopup="menu"
              aria-expanded={menu === "repository"}
            >
              <span data-no-translate={repository ? "" : undefined}>
                {repository?.fullName ?? "Select a repository"}
              </span>
              <ChevronDown size={16} />
            </button>
            {menu === "repository" && (
              <RepositoryMenu
                status={status}
                left={0}
                anchor={repoAnchor}
                chosen={repository?.fullName}
                noRepository={false}
                allowDisconnect={false}
                onStatus={setStatus}
                onClose={() => setMenu(undefined)}
                onChoose={(repo) => {
                  setRepository(repo);
                  setBranch(repo?.defaultBranch ?? "");
                  setMenu(undefined);
                }}
              />
            )}
          </div>
          {repository && (
            <div className="popover-anchor">
              <button
                className="secondary"
                ref={branchAnchor}
                onClick={() =>
                  setMenu(menu === "branch" ? undefined : "branch")
                }
                aria-haspopup="menu"
                aria-expanded={menu === "branch"}
              >
                <GitBranch size={16} />
                <span data-no-translate>{branch}</span>
                <ChevronDown size={16} />
              </button>
              {menu === "branch" && (
                <BranchMenu
                  repository={repository.fullName}
                  defaultBranch={repository.defaultBranch}
                  current={branch}
                  left={0}
                  anchor={branchAnchor}
                  onClose={() => setMenu(undefined)}
                  onChoose={(value) => {
                    setBranch(value.name);
                    setMenu(undefined);
                  }}
                />
              )}
            </div>
          )}
          <button
            className="primary"
            disabled={!repository || !branch || busy}
            onClick={() => void attach()}
          >
            {busy && <Spinner inheritColor size={16} className="spin" />}Add
            repository
          </button>
        </div>
        <div className="chat-github-body">
          {error ? (
            <div role="alert">
              <p>{error}</p>
              <button
                className="secondary"
                onClick={() => {
                  setError(undefined);
                  void refresh();
                }}
              >
                Retry
              </button>
            </div>
          ) : host.kind === "desktop" && status && !status.connected ? (
            <div>
              <p>Sign in to GitHub with gh auth login.</p>
              <button className="secondary" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          ) : (
            <p>
              Pick a repository and branch — Claudex reads it through the GitHub
              connector when it needs it. Nothing is downloaded now, and sending
              is never blocked.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
