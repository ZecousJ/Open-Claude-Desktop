import { useContext, useEffect, useRef, useState } from "react";
import type { Conversation } from "../../shared/types";
import {
  pendingTitleOffer,
  type TitleOfferResponse,
} from "../../shared/title-offers";
import { AppContext } from "../app/AppContext";
import { api } from "../desktop-api";
import { useT } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import "./title-offer.css";

// Card structure and resolved rows. Its secret:* copy is not in the capture.
export function TitleOfferCard({
  conversation,
  onError,
}: {
  conversation: Conversation;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const app = useContext(AppContext);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const locked = useRef(false);
  const restoreFocus = useRef(false);
  const summary = useRef<HTMLButtonElement>(null);
  const pending = pendingTitleOffer(conversation);
  const offer = conversation.titleOffer;
  useEffect(() => {
    if (!pending && restoreFocus.current) {
      restoreFocus.current = false;
      summary.current?.focus();
    }
  }, [pending]);
  if (!offer) return null;
  const respond = async (action: TitleOfferResponse["action"]) => {
    if (locked.current || !pending) return;
    locked.current = true;
    restoreFocus.current = true;
    setBusy(true);
    try {
      const updated = await api.updateConversation(conversation.id, {
        titleOfferResponse: { at: offer.at, action },
      });
      app?.upsert(updated);
    } catch (error) {
      restoreFocus.current = false;
      onError(error);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  if (!pending) {
    const accepted =
      offer.state === "accepted" || conversation.title === offer.proposedTitle;
    const kept = offer.state === "kept" || offer.state === "suppressed";
    // The live transcript's step row: "Renamed session" muted, the title in the
    // primary ink, a 14px CaretRight at the row's end that turns when open;
    // opening shows the old title and the new one.
    return (
      <div className="title-offer-resolved">
        <button
          ref={summary}
          type="button"
          className="title-offer-row"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="title-offer-row-label">
            {t(
              accepted ? "Renamed session" : kept ? "Kept title" : "New title",
            )}
            {(conversation.titleOffersSuppressed ||
              offer.state === "suppressed") &&
              ` · ${t("Don't suggest again")}`}
          </span>
          <span className="title-offer-row-title" data-no-translate>
            {kept
              ? (offer.titleAtOffer ?? conversation.title)
              : offer.proposedTitle}
          </span>
          <AppIcon
            name="CaretRight"
            size={14}
            className="title-offer-row-caret"
            data-open={open || undefined}
          />
        </button>
        {open && (
          <div className="title-offer-row-detail" data-no-translate>
            {offer.titleAtOffer} → {offer.proposedTitle}
          </div>
        )}
      </div>
    );
  }
  return (
    <section
      className="title-offer"
      role="group"
      aria-label={t("New title")}
      aria-busy={busy}
    >
      <div className="title-offer-body">
        <div className="title-offer-heading">{t("Rename session")}</div>
        <div className="title-offer-proposal">
          <p>{t("New title")}</p>
          <div className="title-offer-title" data-no-translate>
            {offer.proposedTitle}
          </div>
        </div>
      </div>
      <div className="title-offer-actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => void respond("keep")}
        >
          {t("Dismiss")}
        </button>
        <button
          type="button"
          className="title-offer-accept"
          disabled={busy}
          onClick={() => void respond("accept")}
        >
          {t("Accept")}
        </button>
      </div>
    </section>
  );
}
