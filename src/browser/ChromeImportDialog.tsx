import { useEffect, useState } from "react";
import type {
  ChromeImportAPI,
  ChromeImportProfile,
  ChromeImportSite,
  ImportedChromeLogin,
} from "../../shared/chrome-import";
import { formatText, t } from "../i18n";
import { Button, SettingsModal } from "../settings/controls";
import "./chrome-import.css";

const sharedOfferKey = "claudex.chromeImportSharedOfferHidden";
function sharedOfferHidden() {
  try {
    return localStorage.getItem(sharedOfferKey) === "true";
  } catch {
    return false;
  }
}
function hideSharedOffer() {
  try {
    localStorage.setItem(sharedOfferKey, "true");
  } catch {
    // Asked again next time.
  }
}

/** The most sites one import brings over. */
const siteCap = 1000;

const sensitiveLabels = {
  financial: "Bank or payments",
  email: "Email",
  identity: "Sign-in provider",
} as const;

/** What went wrong, in the original's words. */
function errorText(error: string, browser: string) {
  switch (error) {
    case "no_chrome":
      return formatText(
        "Couldn’t find {browser}’s saved cookies on this computer.",
        { browser },
      );
    case "read_failed":
      return formatText(
        "Couldn’t read {browser}’s data. Quit {app} and try again.",
        { browser, app: browser },
      );
    case "expired":
      return t("That took a while. Confirm again.");
    case "presence_timed_out":
      return `${t("No confirmation within 2 minutes, so nothing was imported. Try again.")} ${t("If the pop-up is still open, close it first. It may be behind this window.")}`;
    case "remove_failed":
      return t("Couldn’t remove that site. Try again.");
    case "invalid_sites":
      return t("Couldn’t import those sites. Try again.");
    default:
      return formatText("Couldn’t import your {browser} cookies. Try again.", {
        browser,
      });
  }
}

// .
export function ChromeImportDialog({
  conversationId,
  api,
  persistent,
  touchId = false,
  onClose,
  useImported = false,
}: {
  conversationId: string;
  api: ChromeImportAPI;
  persistent: boolean;
  /** The confirmation is Touch ID (its waiting line says so). */
  touchId?: boolean;
  onClose(): void;
  useImported?: boolean;
}) {
  const [step, setStep] = useState<"setup" | "pick" | "manage" | "shared">(
    "setup",
  );
  const [sharedRoots, setSharedRoots] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ChromeImportProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [sites, setSites] = useState<ChromeImportSite[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [imported, setImported] = useState<ImportedChromeLogin[]>([]);
  const [ticket, setTicket] = useState("");
  const [filter, setFilter] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | false>(false);
  /** Reading the sites waits for the person's confirmation first. */
  const [confirming, setConfirming] = useState(false);
  const profile = profiles.find((entry) => entry.id === profileId);
  useEffect(() => {
    let active = true;
    void Promise.all([
      api.listChromeImportProfiles(),
      api.listImportedChromeLogins(conversationId),
      api.getChromeImportSharedOffer(conversationId),
    ])
      .then(([profiles, imported, shared]) => {
        if (!active) return;
        setProfiles(profiles);
        setProfileId(
          (profiles.find((entry) => entry.lastUsed) ?? profiles[0])?.id ?? "",
        );
        setImported(imported);
        if (shared.offer && (useImported || !sharedOfferHidden())) {
          setSharedRoots(shared.roots);
          setStep("shared");
        }
      })
      .catch(() => {
        if (active) setError("load_failed");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [api, conversationId, useImported]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "import_failed");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  const readSites = () =>
    run(async () => {
      setConfirming(true);
      const result = await api.listChromeImportSites(conversationId, profileId);
      setConfirming(false);
      if (!result.ok) throw new Error(result.error);
      setSites(result.sites);
      setTicket(result.ticket);
      setSelected(new Set());
      setStep("pick");
    });
  const bringOver = () =>
    run(async () => {
      const result = await api.importChromeLogins(
        conversationId,
        ticket,
        [...selected],
        keep,
      );
      if (!result.ok || !result.results.some((entry) => entry.imported > 0)) {
        setStep("setup");
        throw new Error("import_failed");
      }
      setImported(await api.listImportedChromeLogins(conversationId));
      setStep("manage");
      if (result.results.some((entry) => entry.failed > 0))
        setError("import_failed");
    });
  const remove = (roots: string[]) =>
    run(async () => {
      for (const root of roots)
        if (!(await api.removeImportedChromeLogins(conversationId, root)))
          throw new Error("remove_failed");
      setImported(await api.listImportedChromeLogins(conversationId));
    });
  const useShared = () =>
    run(async () => {
      if (!(await api.acceptChromeImportSharedOffer(conversationId, keep)))
        throw new Error("import_failed");
      setImported(await api.listImportedChromeLogins(conversationId));
      setStep("manage");
    });
  const toggle = (root: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  const filtered = sites.filter((site) =>
    site.root.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <SettingsModal
      title={
        step === "shared"
          ? "Use the cookies you already imported"
          : step === "setup"
            ? "Import cookies from your browser"
            : step === "pick"
              ? "Choose sites to bring over"
              : "Manage imported cookies"
      }
      className="chrome-import"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="chrome-import-content" aria-busy={busy}>
        {step === "shared" && (
          <>
            <p className="chrome-import-note">
              {sharedRoots.length > 1
                ? formatText(
                    sharedRoots.length === 2
                      ? "You imported cookies for {site} and {others} other site. Use them here too, so your sites open signed in."
                      : "You imported cookies for {site} and {others} other sites. Use them here too, so your sites open signed in.",
                    {
                      site: sharedRoots[0],
                      others: (sharedRoots.length - 1).toLocaleString(),
                    },
                  )
                : formatText(
                    "You imported cookies for {site}. Use them here too, so it opens signed in.",
                    { site: sharedRoots[0] ?? "" },
                  )}
            </p>
            {!persistent && (
              <label className="chrome-import-row">
                <input
                  type="checkbox"
                  checked={keep}
                  disabled={busy}
                  onChange={(event) => setKeep(event.target.checked)}
                />
                <span>{t("Keep me signed in between sessions")}</span>
              </label>
            )}
            {!persistent && (
              <p className="chrome-import-note">
                {t(
                  keep
                    ? "Sets Keep cookies to Shared for Code and Cowork"
                    : "Keeps you signed in until you quit the app.",
                )}
              </p>
            )}
          </>
        )}
        {step === "setup" && (
          <>
            <label className="chrome-import-source">
              <span>{t("From")}</span>
              <select
                aria-label={t("Choose a browser")}
                value={profileId}
                disabled={busy || !profiles.length}
                onChange={(event) => setProfileId(event.target.value)}
              >
                {!profiles.length && (
                  <option value="">{t("Choose a browser")}</option>
                )}
                {profiles.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.browserName} · {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="chrome-import-row">
              <input
                type="checkbox"
                checked={persistent || keep}
                disabled={busy || persistent}
                onChange={(event) => setKeep(event.target.checked)}
              />
              <span>{t("Keep me signed in between sessions")}</span>
            </label>
            <p className="chrome-import-note">
              {t(
                "You’ll confirm, then pick which sites to bring over. Nothing leaves this computer.",
              )}
            </p>
            {imported.length > 0 && (
              <Button disabled={busy} onClick={() => setStep("manage")}>
                {t("Manage imported cookies")}
              </Button>
            )}
          </>
        )}
        {step === "pick" && (
          <>
            <p className="chrome-import-note">
              {formatText(
                "Sites with cookies in your {browser} profile “{profile}”.",
                {
                  browser: profile?.browserName ?? "",
                  profile: profile?.name ?? "",
                },
              )}
            </p>
            <input
              aria-label={t("Filter sites")}
              placeholder={t("Filter sites")}
              value={filter}
              disabled={busy}
              onChange={(event) => setFilter(event.target.value)}
            />
            <label className="chrome-import-row">
              <input
                type="checkbox"
                disabled={busy || !filtered.length}
                checked={
                  filtered.length > 0 &&
                  filtered.every((site) => selected.has(site.root))
                }
                onChange={() =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    const all = filtered.every((site) => next.has(site.root));
                    for (const site of filtered) {
                      if (all) next.delete(site.root);
                      else next.add(site.root);
                    }
                    return next;
                  })
                }
              />
              <span>{t("Select all")}</span>
            </label>
            <ul className="chrome-import-sites">
              {filtered.map((site) => (
                <li key={site.root}>
                  <label className="chrome-import-row">
                    <input
                      type="checkbox"
                      checked={selected.has(site.root)}
                      disabled={busy}
                      onChange={() => toggle(site.root)}
                    />
                    <span>{site.root}</span>
                    {site.sensitive && (
                      <span className="chrome-import-tag">
                        {t(sensitiveLabels[site.sensitive])}
                      </span>
                    )}
                  </label>
                </li>
              ))}
              {!filtered.length && (
                <li className="chrome-import-note">{t("No sites match.")}</li>
              )}
            </ul>
            <p className="chrome-import-note">
              {formatText("{count} of {total} selected", {
                count: selected.size,
                total: sites.length,
              })}
              {selected.size > siteCap && (
                <>
                  {" · "}
                  {formatText("{cap} at most", {
                    cap: siteCap.toLocaleString(),
                  })}
                </>
              )}
            </p>
          </>
        )}
        {step === "manage" && (
          <>
            <p className="chrome-import-note">
              {t("Sites you’ve brought over into Claudex’s browser pane.")}
            </p>
            <ul className="chrome-import-managed">
              {imported.map((entry) => (
                <li className="chrome-import-row" key={entry.root}>
                  <span>{entry.root}</span>
                  <time
                    className="chrome-import-note"
                    dateTime={new Date(entry.importedAt).toISOString()}
                  >
                    {new Date(entry.importedAt).toLocaleDateString()}
                  </time>
                  <Button
                    disabled={busy}
                    aria-label={formatText("Remove {host}", {
                      host: entry.root,
                    })}
                    onClick={() => void remove([entry.root])}
                  >
                    {t("Remove")}
                  </Button>
                </li>
              ))}
            </ul>
            {imported.length > 1 && (
              <Button
                disabled={busy}
                onClick={() => void remove(imported.map((entry) => entry.root))}
              >
                {t("Remove all")}
              </Button>
            )}
          </>
        )}
        {confirming && (
          <p role="status" className="chrome-import-note">
            {t(
              touchId
                ? "Waiting for you to confirm with Touch ID."
                : "Waiting for you to confirm.",
            )}{" "}
            {t("Look for a pop-up. It may be behind this window.")}
          </p>
        )}
        {error && error !== "keychain_denied" && (
          <p role="alert" className="chrome-import-note">
            {errorText(error, profile?.browserName ?? "")}
          </p>
        )}
        <div className="chrome-import-actions">
          {step !== "setup" && step !== "shared" && (
            <Button
              disabled={busy}
              onClick={() => {
                setStep("setup");
                setError(false);
              }}
            >
              {t("Back")}
            </Button>
          )}
          {step === "shared" && (
            <button
              type="button"
              className="chrome-import-dismiss"
              disabled={busy}
              onClick={() => {
                hideSharedOffer();
                onClose();
              }}
            >
              {t("Don’t show again")}
            </button>
          )}
          <Button disabled={busy} onClick={onClose}>
            {t(
              step === "manage"
                ? "Done"
                : step === "shared"
                  ? "Not now"
                  : "Cancel",
            )}
          </Button>
          {step !== "manage" && (
            <Button
              primary
              disabled={
                busy ||
                (step === "shared"
                  ? !sharedRoots.length
                  : step === "setup"
                    ? !profileId
                    : !selected.size || selected.size > siteCap)
              }
              onClick={() =>
                void (step === "shared"
                  ? useShared()
                  : step === "setup"
                    ? readSites()
                    : bringOver())
              }
            >
              {t(step === "shared" ? "Use cookies here" : "Import")}
            </Button>
          )}
        </div>
      </div>
    </SettingsModal>
  );
}
