import { useEffect, useRef, useState } from "react";
import type { FeedbackHistoryItem } from "../../../shared/privacy-data-api";
import type { PrivacyOwner } from "../privacy-owner";
import { Button, SettingsModal } from "../controls";
import { currentLocale, t, useLocale } from "../../i18n";
import { privacyBridge, useDataPage } from "./page-state";
import { ArrowLeft, RotateCcw } from "../../ui/glyphs";
import { AppIcon } from "../../ui/app-icon";
import { LoadingRows } from "../privacy-subpage";

export default function FeedbackManager({
  owner,
  onBack,
  onError,
}: {
  owner: PrivacyOwner;
  onBack(): void;
  onError(error: unknown): void;
}) {
  useLocale();
  const data = useDataPage(
    owner,
    (cursor) =>
      privacyBridge(owner).feedbackHistory(cursor ? { cursor } : undefined),
    onError,
  );
  const [confirm, setConfirm] = useState<FeedbackHistoryItem>();
  const [pending, setPending] = useState(false),
    [failure, setFailure] = useState<string>();
  const alive = useRef(true),
    locked = useRef(false),
    backRef = useRef<HTMLDivElement>(null),
    back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function withdraw() {
    if (!confirm || locked.current || !owner.current()) return;
    const id = confirm.id;
    locked.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      await privacyBridge(owner).withdrawFeedback(id);
      if (!alive.current || !owner.current()) return;
      data.remove(id);
      setConfirm(undefined);
      // The removed row's trigger cannot receive focus on dialog dismissal.
      back.current?.focus();
    } catch (error) {
      if (!alive.current || !owner.current()) return;
      setFailure(error instanceof Error ? error.message : String(error));
      onError(error);
    } finally {
      locked.current = false;
      if (alive.current && owner.current()) setPending(false);
    }
  }
  const items = data.page?.items;
  return (
    <div ref={backRef} className="privacy-feedback">
      {/*
       * Live Privacy → Your feedback: a ghost Back icon beside the title, one
       * footnote, then Date · Rating · Reason · Surface · Chat · Withdraw.
       */}
      <div className="privacy-feedback-head">
        <button
          ref={back}
          type="button"
          className="privacy-feedback-back"
          aria-label={t("Back")}
          onClick={onBack}
        >
          <ArrowLeft size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <h2>{t("Your feedback")}</h2>
      </div>
      <p className="privacy-feedback-note">
        {t("Withdrawing removes feedback you’ve given.")}
      </p>
      {data.error && !items?.length ? (
        <p className="privacy-subpage-state">
          {t("Couldn’t load your feedback. Refresh and try again.")}
        </p>
      ) : items && !items.length && !data.page?.nextCursor ? (
        <p className="privacy-subpage-state">{t("No feedback found")}</p>
      ) : (
        <table
          className="privacy-feedback-table"
          aria-label={t("Your feedback")}
          aria-busy={data.busy || undefined}
        >
          <thead>
            <tr>
              <th>{t("Date")}</th>
              <th className="center">{t("Rating")}</th>
              <th>{t("Reason")}</th>
              <th>{t("Surface")}</th>
              <th>{t("Chat")}</th>
              <th className="center">{t("Withdraw")}</th>
            </tr>
          </thead>
          <tbody>
            {!items ? (
              <LoadingRows cells={6} />
            ) : (
              items.map((item) => {
                const rating = t(
                  item.rating === "up" ? "Thumbs up" : "Thumbs down",
                );
                const reason = [...item.categories, item.comment]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <tr key={item.id}>
                    <td className="date">
                      {new Date(item.createdAt).toLocaleDateString(
                        currentLocale(),
                        { year: "numeric", month: "long", day: "numeric" },
                      )}
                    </td>
                    <td className="center">
                      <span
                        className="privacy-feedback-rating"
                        role="img"
                        aria-label={rating}
                        title={rating}
                      >
                        <AppIcon
                          name={
                            item.rating === "up" ? "ThumbsUp" : "ThumbsDown"
                          }
                          size={18}
                          aria-hidden="true"
                        />
                      </span>
                    </td>
                    <td className="reason">
                      {reason ? (
                        <span title={reason} data-no-translate>
                          {reason}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="surface">Claudex</td>
                    <td className="muted">—</td>
                    <td className="center">
                      <button
                        type="button"
                        className="privacy-feedback-withdraw"
                        onClick={() => {
                          setFailure(undefined);
                          setConfirm(item);
                        }}
                        disabled={pending}
                        aria-label={t("Withdraw feedback")}
                      >
                        <RotateCcw size={20} strokeWidth={1.75} />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}
      {data.page?.nextCursor && (
        <div className="privacy-feedback-more">
          <Button
            onClick={() => void data.reload(data.page?.nextCursor)}
            disabled={data.busy}
          >
            {t("Show more")}
          </Button>
        </div>
      )}
      {confirm && (
        <SettingsModal
          title="Withdraw feedback?"
          variant="confirm"
          confirmFocus="cancel"
          onClose={() => {
            if (!locked.current) setConfirm(undefined);
          }}
        >
          <p>
            {t(
              "This removes your feedback, including any conversation excerpt sent with it. It does not delete your chat.",
            )}
          </p>
          {failure && <p role="alert">{failure}</p>}
          <div className="button-row">
            <Button onClick={() => setConfirm(undefined)} disabled={pending}>
              {t("Cancel")}
            </Button>
            <Button danger onClick={() => void withdraw()} disabled={pending}>
              {t(pending ? "Withdrawing…" : "Withdraw")}
            </Button>
          </div>
        </SettingsModal>
      )}
    </div>
  );
}
