import type {
  FeedbackHistoryItem,
  UploadedFileItem,
} from "../../../shared/privacy-data-api";
import type { FixtureDomain } from "./index";

/** Explicit offline data only; this never calls or changes a collecting service. */
export const privacyDataFixture: FixtureDomain = {
  params: { privacyData: "some|empty|unsupported|error" },
  bridge({ params }) {
    const mode = params.get("privacyData");
    const items: FeedbackHistoryItem[] =
      mode === "some"
        ? [
            {
              id: "2a496130-1075-4fa0-8d26-8a27655a47c1",
              createdAt: "2026-10-18T10:00:00Z",
              rating: "down",
              categories: ["Other"],
              comment: "Synthetic preview feedback",
              hasExcerpt: true,
            },
          ]
        : [];
    const uploads: UploadedFileItem[] =
      mode === "some"
        ? [
            {
              id: "7f0c2b1e-4d5a-4c3b-9a8e-1b2c3d4e5f60/Quarterly report.xlsx",
              name: "Quarterly report.xlsx",
              bytes: 21_606,
              uploadedAt: Date.parse("2026-10-18T09:00:00Z"),
              surface: "chat",
              locations: [{ conversationId: "fixture-chat-1", title: "Quarterly report outline" }],
              storage: "managed-attachment",
            },
            {
              id: "3e2d1c0b-9a8f-4e7d-8c6b-5a4f3e2d1c0b/screenshot.png",
              name: "screenshot.png",
              bytes: 101_273,
              uploadedAt: Date.parse("2026-10-15T09:00:00Z"),
              surface: "code",
              locations: [],
              storage: "managed-attachment",
            },
          ]
        : [];
    const supported = Boolean(mode && mode !== "unsupported");
    const check = () => {
      if (!supported)
        throw Error(
          "This service does not support feedback history management.",
        );
      if (mode === "error")
        throw Error("Synthetic privacy management failure.");
    };
    return {
      privacyDataStatus: async () => ({
        feedback: supported
          ? { supported: true }
          : { supported: false, reason: "unsupported-service" },
        uploads: { supported: true },
      }),
      feedbackHistory: async () => {
        check();
        return { items: [...items] };
      },
      withdrawFeedback: async (id) => {
        check();
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) throw Error("This feedback no longer exists.");
        items.splice(index, 1);
        return { withdrawn: true };
      },
      uploadedFiles: async () => ({
        items: [...uploads],
        complete: false,
        scope: "managed-attachments",
        skipped: 0,
        truncated: false,
      }),
      deleteUploadedFile: async (id) => {
        const index = uploads.findIndex((item) => item.id === id);
        if (index < 0) throw Error("This file was already deleted. Refresh the list.");
        uploads.splice(index, 1);
        return { deleted: true };
      },
    };
  },
};
