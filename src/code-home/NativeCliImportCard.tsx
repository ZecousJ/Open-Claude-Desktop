import { Suspense, useContext, useEffect, useRef, useState } from "react";
import { AppContext } from "../app/AppContext";
import { useHost } from "../host/HostContext";
import { formatText, t } from "../i18n";
import { lazyPiece } from "../ui/lazy-piece";
import { AppIcon } from "../ui/app-icon";
import { CodeHomeSuggestionsSlot } from "./CodeHomeSuggestionsSlot";
import { StartCardRow, StartCardRows, startRowOrder } from "./StartCardRows";
import "./native-cli-import-card.css";

const CliImportDialog = lazyPiece(
  () => import("../settings/CliImportDialog"),
  "CliImportDialog",
);

/** Only the local desktop can discover sessions stored on this computer. */
export function NativeCliImportCard() {
  const host = useHost();
  const app = useContext(AppContext);
  return host.kind === "desktop" && host.capabilities.localCode ? (
    <LocalCliImportCard key={app?.accountId ?? "local"} />
  ) : null;
}

function LocalCliImportCard() {
  const app = useContext(AppContext);
  const slot = useContext(CodeHomeSuggestionsSlot);
  const [count, setCount] = useState<number>();
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const account = app?.accountId;
  useEffect(() => setDismissed(false), [account]);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      const request = ++generation.current;
      void Promise.resolve()
        .then(() => window.desktop.probeImportableCliSessions())
        .then((result: unknown) => {
          if (
            !result ||
            typeof result !== "object" ||
            !("count" in result) ||
            !Number.isSafeInteger(result.count) ||
            (result.count as number) < 0
          )
            throw new Error(t("Couldn’t import sessions"));
          if (live && request === generation.current)
            setCount(result.count as number);
        })
        .catch((error: unknown) => {
          if (!live || request !== generation.current) return;
          setCount(undefined);
          app?.report(error);
        });
    };
    setCount(undefined);
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
    };
  }, [account, revision]);
  return (
    <>
      {!dismissed && count !== undefined && count > 0 && (
        <StartCardRows slot={slot}>
          <StartCardRow
            className="native-cli-import-card"
            rowClassName="native-cli-import-action"
            dismissClassName="native-cli-import-dismiss"
            order={startRowOrder.cliImport}
            icon={<AppIcon name="CommandLine" size={16} />}
            title={formatText(
              count === 1
                ? "Import 1 Claude Code CLI session"
                : "Import {count} Claude Code CLI sessions",
              { count },
            )}
            detail={t("found on this computer")}
            end="spacer"
            dismissLabel={t("Dismiss the Claude Code CLI import")}
            onPress={() => setOpen(true)}
            onDismiss={() => setDismissed(true)}
          />
        </StartCardRows>
      )}
      {open && (
        <Suspense fallback={null}>
          <CliImportDialog
            onClose={() => {
              setOpen(false);
              setRevision((value) => value + 1);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
