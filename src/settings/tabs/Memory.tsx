import { helpUrl } from "../../../shared/help-links";
import { Suspense, useState, type ReactNode } from "react";
import { ChevronRight } from "../../ui/glyphs";
import type { ClientPolicy } from "../../../shared/client-policy";
import type { MemoryPrefs, MemoryStatus } from "../../../shared/memory-api";
import { globalScope, memoryText, useMemory } from "../../memory/useMemory";
import { usePolicy } from "../../policy/PolicyContext";
import { RelativeTime } from "../../ui/RelativeTime";
import { Button, Row, Section, Toggle } from "../controls";
import type { TabProps } from "../context";
import "../../memory/memory.css";
import { lazyPiece } from "../../ui/lazy-piece";

/** Rows Settings search finds on this page. */
export { memoryLabels as searchLabels } from "./desktop-labels";

export type MemoryDialog = "edit" | "import" | "turn-off";

// Manage memory and its styles load when the memory row is opened.
const ManageMemoryDialog = lazyPiece(
  () => import("../../memory/ManageMemoryDialog"),
  "ManageMemoryDialog",
);

// Import memory reuses Manage memory's view, so it loads with it.
const MemoryImportDialog = lazyPiece(
  () => import("../../memory/MemoryImportDialog"),
  "MemoryImportDialog",
);

// The Turn off memory dialog and its styles load when a switch is turned off.
const TurnOffMemoryDialog = lazyPiece(
  () => import("./TurnOffMemoryDialog"),
  "TurnOffMemoryDialog",
);

/**
 * What the page shows: nothing while the status is read, a plain
 * explanation when the service has no memory (no switches), else the
 * switches (read-only when offline or turned off by the administrator).
 */
export function memoryView(status: MemoryStatus | undefined) {
  if (!status) return { kind: "loading" as const };
  if (status.reason === "unsupported")
    return { kind: "unavailable" as const, message: memoryText.unsupported };
  if (status.reason === "server")
    return { kind: "unavailable" as const, message: memoryText.server };
  return {
    kind: "switches" as const,
    offline: status.reason === "offline",
    policyOff: status.reason === "policy",
  };
}

/**
 * Whether a switch can be changed: memory is usable (not offline, not
 * turned off) and the policy allows it. Turning a switch off stays
 * possible while the policy forbids turning it on.
 */
export function switchEnabled(status: MemoryStatus, key: keyof MemoryPrefs) {
  if (status.reason) return false;
  return status.allowed[key] || status.prefs[key];
}

/** Whether a switch shows the administrator's wording instead of its own. */
export const switchLocked = (status: MemoryStatus, key: keyof MemoryPrefs) =>
  status.reason === "policy" || !status.allowed[key];

/**
 * The administrator's Learn more link for memory: one whose label names
 * memory (policy links carry no id). Without one the words are left out
 * rather than shown as a dead link.
 */
export function memoryLearnMore(links: ClientPolicy["links"]) {
  const url = links.learnMore.find((link) =>
    /\bmemory\b/i.test(link.label),
  )?.url;
  if (url) {
    try {
      if (
        !/(^|\.)(claude\.(com|ai)|anthropic\.com)$/i.test(new URL(url).hostname)
      )
        return url;
    } catch {}
  }
  return helpUrl("memory");
}

/** Whether the memory row and Import show: Generate is on. */
export const showsMemoryRows = (status: MemoryStatus) =>
  status.prefs.generate && (status.available || status.reason === "offline");

const switchRows: {
  key: keyof MemoryPrefs;
  label: string;
  description: string;
}[] = [
  {
    key: "searchChats",
    label: "Search and reference chats",
    description: "Allow Claudex to search for relevant details in past chats.",
  },
  {
    key: "generate",
    label: "Generate memory from chats",
    description: "Allow Claudex to generate memory from your chats.",
  },
];

/**
 * Memory: the two switches exactly as the original, then, while Generate is
 * on, the live "View and manage memory" row and Import memory. Memory is reset,
 * as in the original, by turning Generate off and choosing Reset memory. An
 * administrator's lock disables a switch and says so; offline shows the cached
 * switches read-only; a service without memory shows only why.
 */
export function MemoryTab({ onError }: TabProps) {
  const memory = useMemory(onError);
  const learnMore = memoryLearnMore(usePolicy().links);
  const [dialog, setDialog] = useState<MemoryDialog>();
  return (
    <MemoryPage
      status={memory.status}
      learnMore={learnMore}
      onPrefs={memory.setPrefs}
      onDialog={setDialog}
    >
      {dialog === "edit" && (
        <Suspense fallback={null}>
          <ManageMemoryDialog
            scope={globalScope}
            readOnly={!memory.status?.available}
            initial={memory.status?.global ?? undefined}
            onClose={() => setDialog(undefined)}
            onChanged={() => void memory.reload()}
          />
        </Suspense>
      )}
      {dialog === "import" && (
        <Suspense fallback={null}>
          <MemoryImportDialog
            onClose={() => setDialog(undefined)}
            onChanged={() => void memory.reload()}
          />
        </Suspense>
      )}
      {dialog === "turn-off" && (
        <Suspense fallback={null}>
          <TurnOffMemoryDialog
            canReset={!!memory.status?.available}
            onPause={() => memory.setPrefs({ generate: false })}
            onReset={(status) => {
              memory.update(status);
              memory.setPrefs({ generate: false });
            }}
            onClose={() => setDialog(undefined)}
          />
        </Suspense>
      )}
    </MemoryPage>
  );
}

/** The page for a status; the tests render it directly. */
export function MemoryPage({
  status,
  learnMore,
  onPrefs,
  onDialog,
  children,
}: {
  status: MemoryStatus | undefined;
  learnMore?: string;
  onPrefs: (change: Partial<MemoryPrefs>) => void;
  onDialog: (dialog: MemoryDialog) => void;
  children?: ReactNode;
}) {
  const view = memoryView(status);
  const link = learnMore && (
    <>
      {" "}
      <button
        type="button"
        className="memory-learn-more"
        onClick={() => void window.desktop.openExternal(learnMore)}
      >
        Learn more
      </button>
    </>
  );
  return (
    <>
      <Section title="Memory" headingLevel={2}>
        {/* Without memory on the service: the original's two switches, off and
           disabled, with why. */}
        {view.kind === "unavailable" &&
          switchRows.map((row) => (
            <Row key={row.key} label={row.label} description={row.description}>
              <Toggle
                label={row.label}
                checked={false}
                unavailable={view.message}
              />
            </Row>
          ))}
        {view.kind === "switches" &&
          status &&
          switchRows.map((row) => (
            <Row
              key={row.key}
              label={row.label}
              description={
                switchLocked(status, row.key) ? (
                  memoryText.switchDisabled
                ) : (
                  <>
                    {row.description}
                    {link}
                  </>
                )
              }
            >
              <Toggle
                label={row.label}
                checked={status.prefs[row.key]}
                disabled={!switchEnabled(status, row.key)}
                onChange={(checked) =>
                  // Turning memory off asks whether to pause or reset it.
                  row.key === "generate" && !checked
                    ? onDialog("turn-off")
                    : onPrefs({ [row.key]: checked })
                }
              />
            </Row>
          ))}
        {view.kind === "switches" && view.offline && (
          <p className="memory-note" role="status">
            {memoryText.offline}
          </p>
        )}
        {status && showsMemoryRows(status) && (
          <MemoryRows status={status} onDialog={onDialog} />
        )}
      </Section>
      {children}
    </>
  );
}

function MemoryRows({
  status,
  onDialog,
}: {
  status: MemoryStatus;
  onDialog: (dialog: MemoryDialog) => void;
}) {
  const doc = status.global;
  const offline = !status.available;
  return (
    <>
      {/* A full-width "View and manage memory · Updated …" button with a caret
         that opens the memory, or a still "Chat memory · No memory yet". */}
      {doc?.content.trim() ? (
        <button
          type="button"
          className="memory-manage"
          onClick={() => onDialog("edit")}
        >
          <span className="memory-manage-text">
            <span>View and manage memory</span>
            <span className="memory-manage-meta">
              {" · "}
              {status.synthesizing ? (
                "Updating…"
              ) : (
                <>
                  Updated <RelativeTime createdAt={doc.updatedAt} />
                </>
              )}
            </span>
          </span>
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : (
        <div className="memory-manage empty">
          <span className="memory-manage-text">
            <span>Chat memory</span>
            <span className="memory-manage-meta">
              {" · "}
              {status.synthesizing ? "Updating…" : "No memory yet"}
            </span>
          </span>
        </div>
      )}
      <Row
        label="Import memory"
        description="Bring in memory from another AI assistant."
      >
        <Button disabled={offline} onClick={() => onDialog("import")}>
          Import
        </Button>
      </Row>
    </>
  );
}
