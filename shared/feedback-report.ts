import type { ReplyFeedbackReport } from "./diagnostics-api";

export function feedbackReportComment(report: ReplyFeedbackReport) {
  const comment = (report.comment ?? "").trim();
  if (!report.categories?.includes("web_url")) return comment;
  let url: URL;
  try {
    url = new URL(report.reportUrl ?? "");
  } catch {
    throw Error("Enter a valid URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Enter a valid URL.");
  return `${url.href}\n\n${comment}`.slice(0, 4000);
}
