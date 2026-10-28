import type { ChatEffort, Settings } from "../../../shared/types";
import type { Choice } from "../controls";

export const sandboxChoices: Choice<Settings["sandbox"]>[] = [
  { value: "workspace-write", label: "Workspace write" },
  { value: "read-only", label: "Read only" },
];

export const effortChoices: Choice<ChatEffort>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra" },
  { value: "max", label: "Max" },
];
