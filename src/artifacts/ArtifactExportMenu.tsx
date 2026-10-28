import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Download,
  Users,
  File,
  Upload,
  Check,
  Clock,
  ChevronRight,
} from "../ui/glyphs";
import { currentLocale, formatText, t } from "../i18n";
import { RelativeTime } from "../ui/RelativeTime";
import type { Artifact } from "../ui/ArtifactTypes";
import {
  documentCloudLabels,
  type DocumentConnector,
} from "../../shared/artifact-document";
import "./file-viewer-panel.css";

/** Document exports and host fallback. */
export function ArtifactExportMenu({
  onDownload,
  nudge,
  document = false,
  busy = false,
  onDocumentExport,
  onCloudExport,
  presentation = false,
  onPresentationExport,
}: {
  onDownload: () => void;
  nudge?: ReactNode;
  document?: boolean;
  busy?: boolean;
  onDocumentExport?: (format: "docx" | "pdf" | "md") => void;
  onCloudExport?: (connector: DocumentConnector) => void;
  presentation?: boolean;
  onPresentationExport?: () => void;
}) {
  const [connectors, setConnectors] = useState<DocumentConnector[]>([]);
  useEffect(() => {
    let live = true;
    if (document && window.desktop.artifactDocumentConnectors)
      void window.desktop
        .artifactDocumentConnectors()
        .then((value) => {
          if (live) setConnectors(value);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [document]);
  return (
    <ArtifactSubmenu
      label="Export"
      icon={<Download size={15} />}
      footer={nudge}
      items={[
        {
          key: "download",
          label: "Download",
          icon: <Download size={15} />,
          onSelect: onDownload,
          disabled: busy,
        },
        ...(presentation && onPresentationExport
          ? [
              {
                key: "pptx",
                label: t("PowerPoint"),
                icon: <File size={15} />,
                disabled: busy,
                onSelect: onPresentationExport,
              },
            ]
          : []),
        ...(document && onDocumentExport
          ? (
              [
                ["docx", "Word (.docx)"],
                ["pdf", "PDF (.pdf)"],
                ["md", "Markdown (.md)"],
              ] as const
            ).map(([format, label]) => ({
              key: format,
              label: t(label),
              icon: <File size={15} />,
              disabled: busy,
              onSelect: () => onDocumentExport(format),
            }))
          : []),
        ...(document && onCloudExport
          ? connectors.map((connector) => ({
              key: `${connector.service}:${connector.server}`,
              label: t(documentCloudLabels[connector.service]),
              icon: <Upload size={15} />,
              disabled: busy,
              onSelect: () => onCloudExport(connector),
            }))
          : []),
      ]}
    />
  );
}

/** Host versions submenu and rows. */
export function ArtifactVersionMenu({
  count,
  shown,
  onChoose,
  history,
}: {
  count: number;
  shown: number;
  onChoose: (version: number) => void;
  history?: Artifact[];
}) {
  return (
    <ArtifactSubmenu
      label={t("Version history")}
      icon={<Clock size={15} />}
      count={count}
      spokenCount={formatText(
        count === 1
          ? "Version history, 1 version"
          : "Version history, {count} versions",
        { count },
      )}
      testId="frame-title-menu-versions"
      versions
      items={Array.from({ length: count }, (_, index) => {
        const version = count - index;
        const artifact = history?.[version - 1];
        return {
          key: String(version),
          label:
            artifact?.name ??
            formatText("Version {number}", { number: version }),
          noTranslate: Boolean(artifact),
          description: artifact ? (
            <>
              {formatText("Version {number}", { number: version })}
              {artifact.updatedAt !== undefined && (
                <>
                  {" "}
                  ·{" "}
                  <RelativeTime
                    createdAt={artifact.updatedAt}
                    relativeFormat="narrow"
                  />
                </>
              )}
              {version === shown && (
                <>
                  {" "}
                  ·{" "}
                  <span className="artifact-version-current">
                    {t("Current")}
                  </span>
                </>
              )}
            </>
          ) : undefined,
          checked: artifact ? undefined : version === shown,
          current: artifact ? version === shown : undefined,
          onSelect: () => onChoose(version),
        };
      })}
    />
  );
}

/** Public-link export copy. */
export function ArtifactExportNudge({
  shared,
  busy,
  onShare,
}: {
  shared: boolean;
  busy: boolean;
  onShare: () => void;
}) {
  return (
    <div
      className="artifact-export-nudge"
      role="group"
      aria-label={t("Sending this to someone?")}
    >
      <Users size={16} aria-hidden="true" />
      <div>
        <div className="artifact-export-nudge-copy">
          <h3>{t("Sending this to someone?")}</h3>
          <p>
            {t(
              "Share the link instead of a file and they will always have the latest changes.",
            )}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={onShare}
        >
          {t(shared ? "Copy public link" : "Share and copy link")}
        </button>
      </div>
    </div>
  );
}

export interface SubmenuItem {
  key: string;
  label: string;
  description?: ReactNode;
  title?: string;
  noTranslate?: boolean;
  current?: boolean;
  testId?: string;
  describedBy?: string;
  icon?: ReactNode;
  /** The current choice, marked with a check. */
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * A title-menu row that opens a submenu beside it on hover, on click or on
 * ArrowRight (Export, Switch artifact). `count` shows before the arrow.
 */
export function ArtifactSubmenu({
  label,
  icon,
  count,
  items,
  footer,
  header,
  versions,
  spokenCount,
  storage,
  describedBy,
  hint,
  trailing,
  testId,
}: {
  label: string;
  icon: ReactNode;
  count?: number;
  items: SubmenuItem[];
  footer?: ReactNode;
  header?: ReactNode;
  versions?: boolean;
  spokenCount?: string;
  storage?: boolean;
  describedBy?: string;
  hint?: string;
  trailing?: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    submenu = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const firstItem = () =>
    submenu.current?.querySelector<HTMLButtonElement>("button") ?? null;
  function clear() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }
  function show(focus = false) {
    clear();
    if (focus) {
      focusOnOpen.current = true;
      const first = firstItem();
      if (first) {
        first.focus();
        focusOnOpen.current = false;
      }
    }
    setOpen(true);
  }
  function close(focus = false) {
    clear();
    focusOnOpen.current = false;
    setOpen(false);
    if (focus) trigger.current?.focus();
  }
  useEffect(() => () => clear(), []);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      if (!root.current || !submenu.current) return;
      const bounds = root.current.getBoundingClientRect();
      const gap =
        parseFloat(
          getComputedStyle(root.current).getPropertyValue(
            "--artifact-submenu-gap",
          ),
        ) || 0;
      setLeft(
        bounds.right + gap + submenu.current.offsetWidth >
          window.innerWidth - 8,
      );
    }
    place();
    // Keyboard entry is focused before the first paint, avoiding a plain-row flash.
    if (focusOnOpen.current) {
      firstItem()?.focus();
      focusOnOpen.current = false;
    }
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  return (
    <div
      ref={root}
      className="artifact-export-entry"
      onPointerEnter={() => show()}
      onPointerLeave={() => {
        clear();
        timer.current = setTimeout(() => setOpen(false), 100);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) close();
      }}
      onKeyDown={(e) => {
        if (
          e.key === "ArrowRight" &&
          document.activeElement === trigger.current
        ) {
          e.preventDefault();
          e.stopPropagation();
          show(true);
        }
        if (open && (e.key === "ArrowLeft" || e.key === "Escape")) {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={trigger}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={spokenCount}
        aria-describedby={describedBy}
        data-testid={testId}
        onClick={() => show(true)}
      >
        {icon}
        {label}
        {count !== undefined && (
          <span className="artifact-submenu-count">
            {new Intl.NumberFormat(currentLocale()).format(count)}
          </span>
        )}
        {hint && <span className="artifact-submenu-count">{hint}</span>}
        <ChevronRight
          className={
            count === undefined && hint === undefined
              ? "artifact-submenu-arrow"
              : "artifact-submenu-arrow after-count"
          }
          size={13}
        />
        {trailing}
      </button>
      {open && (
        <div
          ref={submenu}
          className="artifact-chrome-menu artifact-export-submenu"
          data-left={left}
          data-list={count !== undefined}
          data-versions={versions || undefined}
          data-storage={storage || undefined}
          data-export-nudge={footer ? true : undefined}
          role="menu"
          aria-label={label}
        >
          {header}
          {items.map((item) => (
            <button
              key={item.key}
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              data-current={item.current || undefined}
              data-testid={item.testId}
              aria-describedby={item.describedBy}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.icon}
              <span className="artifact-submenu-label">
                <span data-no-translate={item.noTranslate || undefined}>
                  {item.label}
                </span>
                {item.description && (
                  <span className="artifact-version-detail">
                    {item.description}
                  </span>
                )}
              </span>
              {item.checked && (
                <Check className="artifact-submenu-check" size={13} />
              )}
            </button>
          ))}
          {footer}
        </div>
      )}
    </div>
  );
}
