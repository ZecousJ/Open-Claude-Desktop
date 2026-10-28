import { useT } from "../i18n";
import { useEffect, useState } from "react";
import type { Mode, Turn } from "../../shared/types";
import { checkConnectionNow, useStreamConnection } from "../app/connection";
import { ReplyBanner } from "./ReplyBanner";

/** What has arrived of a turn, to tell whether anything came since. */
function progress(turn: Turn) {
  const last = turn.items.at(-1);
  return `${turn.status}:${turn.items.length}:${last?.text?.length ?? 0}:${last?.status ?? ""}`;
}

/**
 * Under a running reply when the stream it arrives on went down: a neutral
 * notice (ReplyBanner, as the original's) saying "Connection lost. Claudex may
 * still be working on this response." with Check now. The words follow what
 * Check now found: before any check it is still "Connection lost", a check that
 * found no reply says "No reply yet. …", one that could not reach the service
 * says "Couldn’t check for a reply. …". Check now reads the whole state again,
 * its label giving way to a spinner meanwhile. The notice goes as soon as the
 * reply moves on.
 */
export function TurnConnectionNotice({
  turn,
  mode = "chat",
}: {
  turn: Turn;
  mode?: Mode;
}) {
  const t = useT();
  const { connected } = useStreamConnection();
  const now = progress(turn);
  const [stalledAt, setStalledAt] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<"unchecked" | "no_reply" | "failed">(
    "unchecked",
  );
  useEffect(() => {
    if (!connected) setStalledAt((value) => value ?? now);
  }, [connected, now]);
  useEffect(() => {
    if (connected && stalledAt !== undefined && stalledAt !== now) {
      setStalledAt(undefined);
      setVerdict("unchecked");
    }
  }, [connected, stalledAt, now]);
  if (turn.status !== "inProgress" || stalledAt === undefined) return null;
  return (
    <div className="turn-connection-notice">
      <ReplyBanner
        mode={mode}
        buttons={[
          {
            label: t("Check now"),
            busy: checking,
            onClick: () => {
              setChecking(true);
              setVerdict("unchecked");
              void checkConnectionNow()
                .then(() => setVerdict("no_reply"))
                .catch(() => setVerdict("failed"))
                .finally(() => setChecking(false));
            },
          },
        ]}
      >
        {t(
          verdict === "failed"
            ? "Couldn’t check for a reply. Check again in a moment. Claudex may still be working on this response."
            : verdict === "no_reply"
              ? "No reply yet. Claudex may still be working on this response."
              : "Connection lost. Claudex may still be working on this response.",
        )}
      </ReplyBanner>
    </div>
  );
}
