import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { t, tf } from "../i18n";
import { BackIcon, CloseIcon } from "../ui/icons";
import { desktopPlatform } from "../auth/desktopDownload";
import { parseApps, type AppDownloads } from "./apps";
import "./downloads.css";

/**
 * The web app's downloads page at /downloads, after claude.ai/downloads: the
 * Desktop card and the Mobile card (Android now, iOS once it is on TestFlight).
 * It stands alone, signed in or not, and reads GET /api/v1/claudex/apps. The
 * cards keep the original's frames, type and rows; its marketing pictures under
 * each card are left out.
 */
export function DownloadsPage() {
  const [apps, setApps] = useState<AppDownloads | null>();
  const [qr, setQr] = useState(false);
  // The title and cards come in 50ms after the page mounts (the original's
  // entrance: the title rises 12px, the cards 16px, 80ms apart).
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 50);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    document.title = `${t("Apps and extensions")} - Claudex`;
    let live = true;
    fetch("/api/v1/claudex/apps", {
      credentials: "omit",
      headers: { Accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => live && setApps(parseApps(body)))
      .catch(() => live && setApps(null));
    return () => {
      live = false;
    };
  }, []);
  const platform = desktopPlatform(navigator);
  const phone = !platform;
  const android = /Android/i.test(navigator.userAgent);
  const desktop = apps?.desktop;
  const mac = desktop?.downloads["darwin-arm64"];
  const windows = desktop?.downloads["win32-x64"];
  // This computer's installer, as the original's single button; a phone or
  // another system sees each one there is.
  const installers = [
    { id: "darwin", url: mac, label: t("Download for macOS") },
    { id: "win32", url: windows, label: t("Download for Windows") },
  ].filter((i) => i.url);
  const own = installers.filter((i) => i.id === platform);
  const shown = own.length ? own : installers;
  return (
    <div className="dl" data-entered={entered || undefined}>
      <header className="dl-header">
        <a className="dl-back" href="/">
          <BackIcon />
          <span>{t("Apps and extensions")}</span>
        </a>
      </header>
      <main className="dl-main">
        <h2 className="dl-title">
          {t("Do more with Claudex, everywhere you work")}
        </h2>
        <div className="dl-grid">
          <Card
            index={0}
            title={t("Desktop")}
            description={t(
              "Chat, cowork, and code in one app. Claudex works with your files, apps, and browser tabs.",
            )}
          >
            <div className="dl-buttons">
              {shown.map((i) => (
                <a
                  key={i.id}
                  className="dl-button u-press"
                  href={i.url}
                  download
                >
                  {i.label}
                </a>
              ))}
              {apps !== undefined && !shown.length && (
                <span className="dl-button" aria-disabled="true">
                  {t("Coming soon")}
                </span>
              )}
            </div>
          </Card>
          <Card
            index={1}
            title={t("Mobile")}
            description={t(
              "Chat on the go, and send work to the Code sessions on your computer from your phone.",
            )}
          >
            <div className="dl-rows">
              <Row icon={<AppleIcon />} name="iOS">
                {apps?.ios ? (
                  <a className="dl-button u-press" href={apps.ios.url}>
                    {t("Download")}
                  </a>
                ) : (
                  <span className="dl-button" aria-disabled="true">
                    {t("Coming soon")}
                  </span>
                )}
              </Row>
              <Row icon={<AndroidIcon />} name="Android">
                {apps?.android ? (
                  phone && android ? (
                    <a
                      className="dl-button u-press"
                      href={apps.android.url}
                      download
                    >
                      {t("Download")}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="dl-button u-press"
                      onClick={() => setQr(true)}
                    >
                      {t("Download")}
                    </button>
                  )
                ) : (
                  <span className="dl-button" aria-disabled="true">
                    {t("Coming soon")}
                  </span>
                )}
              </Row>
            </div>
          </Card>
        </div>
      </main>
      {qr && apps?.android && (
        <AndroidDialog
          url={apps.android.url}
          version={apps.android.version}
          onClose={() => setQr(false)}
        />
      )}
    </div>
  );
}

function Card({
  index,
  title,
  description,
  children,
}: {
  index: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="dl-card"
      style={{ "--dl-index": index } as React.CSSProperties}
    >
      <div className="dl-card-inner">
        <h3>{title}</h3>
        <p className="dl-card-text">{description}</p>
        {children}
      </div>
    </section>
  );
}

function Row({
  icon,
  name,
  children,
}: {
  icon: React.ReactNode;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div className="dl-row">
      <div className="dl-row-name">
        <span className="dl-row-icon">{icon}</span>
        <span>{name}</span>
      </div>
      {children}
    </div>
  );
}

/** The original's "Take Claude on the go": a QR code of the APK and its link. */
function AndroidDialog({
  url,
  version,
  onClose,
}: {
  url: string;
  version: string;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M" })
      .then((svg) => {
        if (live)
          setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => setSrc(undefined));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      live = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [url, onClose]);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dl-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dl-dialog-title"
      >
        <button
          type="button"
          className="dl-dialog-close"
          aria-label={t("Close")}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        <h2 id="dl-dialog-title">{t("Take Claudex on the go")}</h2>
        <div className="dl-dialog-box">
          <div className="dl-qr" role="img" aria-label={t("QR code")}>
            {src && <img src={src} alt="" width={180} height={180} />}
          </div>
          <a className="dl-dialog-button" href={url} download>
            <AndroidIcon />
            {t("Download Android app")}
          </a>
          {version && (
            <p className="dl-dialog-version">
              {tf("Version {version}", { version })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Phosphor android-logo-fill, the original's Android glyph. */
function AndroidIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M207.06,80.67c-.74-.74-1.49-1.46-2.24-2.17l24.84-24.84a8,8,0,0,0-11.32-11.32l-26,26a111.43,111.43,0,0,0-128.55.19L37.66,42.34A8,8,0,0,0,26.34,53.66L51.4,78.72A113.38,113.38,0,0,0,16,161.13V184a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V160A111.25,111.25,0,0,0,207.06,80.67ZM92,160a12,12,0,1,1,12-12A12,12,0,0,1,92,160Zm72,0a12,12,0,1,1,12-12A12,12,0,0,1,164,160Z" />
    </svg>
  );
}

/** The original's apple-icon.svg (black, or white in dark, at 80%). */
function AppleIcon() {
  return (
    <svg
      className="dl-apple"
      width="20"
      height="20"
      viewBox="0 0 814 1000"
      aria-hidden="true"
    >
      <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z" />
    </svg>
  );
}
