import { useEffect, useRef, useState } from "react";
import { Globe, Link2, Lock, ShieldCheck, ChevronDown } from "../ui/glyphs";
import type { ArtifactShareInput } from "../../shared/types";
import type {
  ArtifactSharingState,
  ShareAccess,
} from "../../shared/sharing-api";
import { currentLocale, formatText, t, useT } from "../i18n";
import { Modal } from "../ui/Controls";
import { Menu, type MenuPosition } from "../ui/Menu";
import { Toggle } from "../settings/controls";
import "./artifact-share-dialog.css";

export function artifactVersionLabel(number: number, createdAt: number) {
  return formatText("Version {number} — {date}", {
    number,
    date: new Date(createdAt).toLocaleDateString(currentLocale(), {
      month: "short",
      day: "numeric",
    }),
  });
}

/** Access and version sharing. */
export function ArtifactShareDialog({
  input,
  latestInput = input,
  access = false,
  onClose,
  onChanged,
  onError,
}: {
  input: ArtifactShareInput;
  latestInput?: ArtifactShareInput;
  access?: boolean;
  onClose(): void;
  onChanged(): void;
  onError(error: unknown): void;
}) {
  useT();
  const [state, setState] = useState<ArtifactSharingState>();
  const [automatic, setAutomatic] = useState(false);
  const [selection, setSelection] = useState("latest");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [didShare, setDidShare] = useState(false);
  const [address, setAddress] = useState("");
  const [role, setRole] = useState<"view" | "comment" | "edit">("view");
  const [notifyPeople, setNotifyPeople] = useState(true);
  const [message, setMessage] = useState("");
  const [menu, setMenu] = useState<MenuPosition>();
  const versionButton = useRef<HTMLButtonElement>(null);
  const audienceButton = useRef<HTMLButtonElement>(null);
  const [audienceMenu, setAudienceMenu] = useState<MenuPosition>();
  const live = useRef(true);
  const operation = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setDidShare(false);
    void window.desktop
      .artifactShareState(input)
      .then((value) => {
        if (current) {
          setState(value);
          setAutomatic(value.autoUpdate);
        }
      })
      .catch(onError);
    return () => {
      current = false;
    };
  }, [input.identity, input.language, input.content]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const shared = state?.share?.status === "active";
  const audience: ShareAccess =
    state?.share?.access ?? (shared ? "link" : "invited");
  const versions = state?.versions ?? [];
  const selected = versions.find((version) => version.version === selection);
  const link = selection === "latest" ? state?.share : selected?.share;
  const label =
    selection === "latest"
      ? t("Latest published version")
      : selected
        ? artifactVersionLabel(
            versions.indexOf(selected) + 1,
            selected.share.createdAt,
          )
        : t("This version");
  async function run(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (live.current) onError(error);
    } finally {
      operation.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function share(copy: boolean) {
    const value = await window.desktop.shareArtifact(
      copy ? input : latestInput,
      automatic,
    );
    if (!live.current) return;
    setState(value);
    setDidShare(true);
    onChanged();
    if (copy && value.share) {
      await window.desktop.copyText(value.share.url);
      if (live.current) setCopied(true);
    }
  }
  return (
    <Modal
      title={t(
        access
          ? "Share artifact"
          : shared
            ? "Artifact shared"
            : "Share artifact",
      )}
      onClose={onClose}
    >
      <div
        className={`artifact-version-share${access ? " artifact-people-share" : ""}`}
        aria-busy={busy || !state}
      >
        {access && (
          <>
            <form
              className="artifact-share-invite"
              onSubmit={(event) => {
                event.preventDefault();
                const email = address.trim();
                if (!email) return;
                void run(async () => {
                  const value = shared
                    ? state
                    : await window.desktop.shareArtifact(
                        input,
                        automatic,
                        "invited",
                      );
                  if (!value?.share) return;
                  const result = await window.desktop.inviteToArtifact(
                    value.share.id,
                    email,
                    { role, notify: notifyPeople, message: message.trim() },
                  );
                  if (live.current) {
                    setState({ ...value, share: result.share });
                    setAddress("");
                    onChanged();
                  }
                });
              }}
            >
              <input
                type="email"
                required
                aria-label={t("Add people by email")}
                placeholder={t("Add people by email")}
                value={address}
                disabled={busy || !state}
                onChange={(event) => setAddress(event.target.value)}
              />
              <button
                className="secondary"
                disabled={busy || !state || !address.trim()}
              >
                {t("Invite")}
              </button>
            </form>
            <div className="artifact-share-role">
              <ShieldCheck size={16} aria-hidden="true" />
              <label>
                <span>{t("Role")}</span>
                <select
                  value={role}
                  onChange={(event) =>
                    setRole(event.target.value as typeof role)
                  }
                >
                  <option value="view">{t("Can view")}</option>
                  <option value="comment">{t("Can comment")}</option>
                  <option value="edit">{t("Can edit")}</option>
                </select>
              </label>
            </div>
            <label className="artifact-share-notify">
              <input
                type="checkbox"
                checked={notifyPeople}
                onChange={(event) => setNotifyPeople(event.target.checked)}
              />
              <span>
                <strong>{t("Notify people")}</strong>
                <small>
                  {t("They’ll get an email with a link to this artifact.")}
                </small>
              </span>
            </label>
            <label className="artifact-share-message">
              <span>{t("Message for the email")}</span>
              <textarea
                value={message}
                maxLength={300}
                placeholder={t("Add a message")}
                onChange={(event) => setMessage(event.target.value)}
              />
              <small>{message.length}/300</small>
            </label>
            {!!state?.share?.invites?.length && (
              <section
                className="artifact-share-people"
                aria-label={t("People with access")}
              >
                <h3>{t("People with access")}</h3>
                {state.share.invites.map((email) => (
                  <div className="artifact-share-person" key={email}>
                    <span data-no-translate>{email}</span>
                    <select
                      aria-label={t("Role")}
                      value={state.share!.inviteRoles?.[email] ?? "edit"}
                      disabled={busy}
                      onChange={(event) => {
                        const nextRole = event.target.value as
                          "view" | "comment" | "edit";
                        void run(async () => {
                          const result = await window.desktop.inviteToArtifact(
                            state.share!.id,
                            email,
                            { role: nextRole, notify: false },
                          );
                          if (live.current) {
                            setState({ ...state, share: result.share });
                            onChanged();
                          }
                        });
                      }}
                    >
                      <option value="view">{t("Can view")}</option>
                      <option value="comment">{t("Can comment")}</option>
                      <option value="edit">{t("Can edit")}</option>
                    </select>
                    <button
                      className="secondary"
                      disabled={busy}
                      aria-label={formatText("Remove {address}", {
                        address: email,
                      })}
                      onClick={() =>
                        void run(async () => {
                          const share =
                            await window.desktop.removeArtifactInvite(
                              state.share!.id,
                              email,
                            );
                          if (live.current) {
                            setState({ ...state, share });
                            onChanged();
                          }
                        })
                      }
                    >
                      {t("Remove")}
                    </button>
                  </div>
                ))}
              </section>
            )}
            <h3 className="artifact-share-access-heading">
              {t("General access")}
            </h3>
          </>
        )}
        <div className="artifact-version-card">
          {access ? (
            <>
              <button
                ref={audienceButton}
                className="artifact-share-audience"
                data-testid="share-sheet-audience"
                aria-label={t("General access")}
                aria-haspopup="menu"
                aria-expanded={!!audienceMenu}
                disabled={busy || !state}
                onClick={() => {
                  const bounds =
                    audienceButton.current?.getBoundingClientRect();
                  if (bounds)
                    setAudienceMenu({ left: bounds.left, top: bounds.bottom });
                }}
              >
                <span className="artifact-share-avatar">
                  {audience === "link" ? (
                    <Globe size={20} />
                  ) : (
                    <Lock size={20} />
                  )}
                </span>
                <span className="artifact-share-audience-text">
                  <strong>
                    {t(
                      audience === "link"
                        ? "Anyone with the link"
                        : "Only people invited",
                    )}
                  </strong>
                  <small>
                    {/* PublicLine and invitedLine. */}
                    {t(
                      audience === "link"
                        ? "People with the link can view, but not edit."
                        : "Only people with access can open the link.",
                    )}
                  </small>
                </span>
                <ChevronDown size={16} />
              </button>
              {audienceMenu && (
                <Menu
                  label={t("General access")}
                  position={audienceMenu}
                  width={
                    audienceButton.current?.getBoundingClientRect().width ?? 280
                  }
                  anchors={[audienceButton]}
                  entries={(["invited", "link"] as const).map((value) => ({
                    label: t(
                      value === "link"
                        ? "Anyone with the link"
                        : "Only people invited",
                    ),
                    icon:
                      value === "link" ? (
                        <Globe size={20} />
                      ) : (
                        <Lock size={20} />
                      ),
                    checked: audience === value,
                    onSelect: () => {
                      setAudienceMenu(undefined);
                      if (audience === value) return;
                      void run(async () => {
                        const state =
                          await window.desktop.setArtifactShareAccess(
                            input,
                            value,
                          );
                        if (live.current) {
                          setState(state);
                          onChanged();
                        }
                      });
                    },
                  }))}
                  onClose={() => setAudienceMenu(undefined)}
                />
              )}
            </>
          ) : (
            <div className="artifact-version-access">
              {shared ? <Globe size={20} /> : <Lock size={20} />}
              <div>
                <strong>{t(shared ? "Shared" : "Unshared")}</strong>
                <p>
                  {t(
                    shared
                      ? "Anyone with the link can view"
                      : "Only you have access",
                  )}
                </p>
              </div>
            </div>
          )}
          {shared && !access && (
            <>
              <div className="artifact-version-link">
                <span data-no-translate>{link?.url}</span>
                <button
                  className="secondary"
                  disabled={busy || !link}
                  onClick={() =>
                    void run(async () => {
                      if (!link) return;
                      await window.desktop.copyText(link.url);
                      if (live.current) setCopied(true);
                    })
                  }
                >
                  <Link2 size={16} />
                  {t(copied ? "Link copied" : "Copy link")}
                </button>
              </div>
              <button
                ref={versionButton}
                type="button"
                className="artifact-version-selector"
                aria-haspopup="menu"
                aria-expanded={!!menu}
                disabled={busy}
                onClick={() => {
                  const bounds = versionButton.current?.getBoundingClientRect();
                  if (bounds)
                    setMenu({ left: bounds.left, top: bounds.bottom });
                }}
              >
                {label}
                <ChevronDown size={14} />
              </button>
              {menu && (
                <Menu
                  label={label}
                  position={menu}
                  width={280}
                  anchors={[versionButton]}
                  entries={[
                    {
                      label: t("Latest published version"),
                      checked: selection === "latest",
                      onSelect: () => {
                        setSelection("latest");
                        setCopied(false);
                      },
                    },
                    ...[...versions].reverse().map((version) => ({
                      label: artifactVersionLabel(
                        versions.indexOf(version) + 1,
                        version.share.createdAt,
                      ),
                      noTranslate: true,
                      checked: selection === version.version,
                      onSelect: () => {
                        setSelection(version.version);
                        setCopied(false);
                      },
                    })),
                  ]}
                  onClose={() => setMenu(undefined)}
                />
              )}
            </>
          )}
        </div>
        {access ? (
          <div className="artifact-share-footer">
            <button
              className="secondary"
              disabled={busy || !state}
              onClick={() =>
                void run(async () => {
                  const value = shared
                    ? state
                    : await window.desktop.shareArtifact(
                        input,
                        false,
                        audience,
                      );
                  if (value?.share) {
                    await window.desktop.copyText(
                      value.share.access === "invited"
                        ? (value.share.inviteUrl ?? value.share.url)
                        : value.share.url,
                    );
                    if (live.current) {
                      setState(value);
                      setCopied(true);
                      onChanged();
                    }
                  }
                })
              }
            >
              <Link2 size={16} />
              {t(copied ? "Link copied" : "Copy link")}
            </button>
          </div>
        ) : (
          <>
            <div className="artifact-version-automatic">
              <div>
                <strong>{t("Automatically share updates")}</strong>
                <p>
                  {t(
                    "New versions will be shared automatically when this artifact changes.",
                  )}
                </p>
              </div>
              <Toggle
                label={t("Automatically share updates")}
                checked={automatic}
                disabled={busy || !state}
                onChange={(enabled) => {
                  if (!shared) {
                    setAutomatic(enabled);
                    return;
                  }
                  void run(async () => {
                    const value = await window.desktop.setArtifactAutoShare(
                      latestInput,
                      enabled,
                    );
                    if (live.current) {
                      setState(value);
                      setAutomatic(value.autoUpdate);
                      onChanged();
                    }
                  });
                }}
              />
            </div>
            {shared ? (
              <div className="artifact-version-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await window.desktop.unshareArtifact(input.identity);
                      const value =
                        await window.desktop.artifactShareState(input);
                      if (live.current) {
                        setState(value);
                        setAutomatic(false);
                        setCopied(false);
                        setSelection("latest");
                        onChanged();
                      }
                    })
                  }
                >
                  {t("Unshare")}
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void run(() => share(false))}
                >
                  {t(didShare ? "Shared" : "Share latest")}
                </button>
              </div>
            ) : (
              <div className="artifact-version-actions">
                <button
                  className="primary"
                  disabled={busy || !state}
                  onClick={() => void run(() => share(true))}
                >
                  {t("Share & copy link")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
