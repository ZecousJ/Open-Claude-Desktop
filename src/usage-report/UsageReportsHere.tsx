import { Suspense } from "react";
import { lazyPiece } from "../ui/lazy-piece";
import type { Conversation, Turn } from "../../shared/types";
import { CodeUserMessage } from "../transcript/CodeUserMessage";
import type { PostedUsageReport } from "./usage-report-store";

/** The card and its styles load with the first report. */
const UsageReportCard = lazyPiece(
  () => import("./UsageReportCard"),
  "UsageReportCard",
);
// /status's Session info card, likewise.
const SessionInfoCard = lazyPiece(
  () => import("../session-info/SessionInfoCard"),
  "SessionInfoCard",
);

/**
 * Usage reports and Session info cards posted at this point of a Code
 * transcript: each is the "/usage" or "/status" prompt and its card under it,
 * as the live app's client rows show them.
 */
export function UsageReportsHere({
  conversation,
  reports,
}: {
  conversation: Conversation;
  reports: PostedUsageReport[];
}) {
  if (!reports.length) return null;
  return (
    <>
      {reports.map((report) => {
        const prompt: Turn = {
          id: report.id,
          prompt: report.kind === "status" ? "/status" : "/usage",
          attachments: [],
          items: [],
          status: "completed",
          createdAt: report.at,
        };
        return (
          <div key={report.id} className="usage-report-turn">
            <CodeUserMessage turn={prompt} />
            <div className="assistant-message">
              <div className="assistant-content">
                <Suspense fallback={null}>
                  {report.kind === "status" ? (
                    <SessionInfoCard conversation={conversation} />
                  ) : (
                    <UsageReportCard
                      conversation={conversation}
                      posted={report.at}
                    />
                  )}
                </Suspense>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
