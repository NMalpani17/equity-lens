/** Pure helpers for the Reports page. */
import { describeReset, formatTimestampDate } from "./format";
import type { ReportView } from "./reportsApi";

/** Why generating isn't possible right now, in the user's terms. */
export function blockedMessage(view: ReportView): string | null {
  switch (view.blockedReason) {
    case "demo":
      return "Demo accounts can view reports. Sign up to generate one.";
    case "in_progress":
      return "This report is being generated. It will appear here when it's ready.";
    case "fresh":
      return view.regenerateAvailableAt
        ? `This report is up to date. You can regenerate it on ${formatTimestampDate(
            view.regenerateAvailableAt,
          )}.`
        : "This report is up to date.";
    case "daily_limit":
      return `You've generated today's ${view.usage.limit} reports. More ${describeReset(
        view.usage.resetsAt,
      )}.`;
    case "global_limit":
      return "Report generation has reached its daily capacity. Try again tomorrow.";
    default:
      return null;
  }
}
