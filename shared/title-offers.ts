import type { Conversation } from "./types";

export interface TitleOffer {
  proposedTitle: string;
  at: number;
  titleAtOffer?: string;
  turnId?: string;
  state?: "offered" | "accepted" | "kept" | "suppressed";
}

export interface TitleOfferResponse {
  at: number;
  action: "accept" | "keep" | "suppress";
}

// Pending only while the original title still matches.
export function pendingTitleOffer(conversation: Conversation) {
  const offer = conversation.titleOffer;
  return Boolean(
    offer &&
    !conversation.titleOffersSuppressed &&
    (!offer.state || offer.state === "offered") &&
    (offer.titleAtOffer === undefined ||
      offer.titleAtOffer === conversation.title) &&
    offer.proposedTitle !== conversation.title,
  );
}

export function respondToTitleOffer(
  conversation: Conversation,
  response: TitleOfferResponse,
) {
  const offer = conversation.titleOffer;
  if (!offer || offer.at !== response.at || !pendingTitleOffer(conversation))
    return false;
  if (response.action === "accept") {
    conversation.title = offer.proposedTitle;
    offer.state = "accepted";
  } else {
    offer.state = response.action === "keep" ? "kept" : "suppressed";
    if (response.action === "suppress")
      conversation.titleOffersSuppressed = true;
  }
  return true;
}
