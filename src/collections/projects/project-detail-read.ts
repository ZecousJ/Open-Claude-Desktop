import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../../../shared/types";
import type {
  ProjectAccessAPI,
  ProjectCreationCapabilities,
  ProjectReadResult,
} from "../../../shared/project-access";
import { useSettingsRequestScope } from "../../settings/useSettingsRequestScope";
import type { Project } from "../../../shared/types";
import type { ProjectCatalogRead } from "../../composer/useProjectCatalogState";

export type ProjectDetailRead =
  | { status: "list" }
  | { status: "ready"; project: Project }
  | { status: "pending" }
  | { status: "failed"; retrying: boolean; retry(): void }
  | { status: "missing"; retry(): void }
  | { status: "forbidden"; retry(): void };

/** Keep a requested place independent from list contents. A failed collection
 * read cannot establish that an absent project was deleted or forbidden.
 * Legacy snapshots have no per-project permission outcome; the authoritative
 * hook below is used when the bridge supports the separate read contract. */
export function projectDetailRead(
  requestedId: string | undefined,
  projects: Project[],
  read: ProjectCatalogRead,
): ProjectDetailRead {
  if (!requestedId) return { status: "list" };
  const project = projects.find((value) => value.id === requestedId);
  if (project) return { status: "ready", project };
  if (read.status === "failed" || read.failed)
    return {
      status: "failed",
      retrying: read.status === "pending",
      retry: read.retry,
    };
  if (read.status === "pending") return { status: "pending" };
  return { status: "missing", retry: read.retry };
}

/** Reads remain tied to the rendered account, bridge, controller and request. */
export function useProjectDetailRead(
  requestedId: string | undefined,
  projects: Project[],
  catalog: ProjectCatalogRead,
): ProjectDetailRead {
  const requests = useSettingsRequestScope();
  const bridge = requests.capture().bridge as
    (DesktopAPI & Partial<ProjectAccessAPI>) | undefined;
  const enabled = !!requestedId && typeof bridge?.readProject === "function";
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    owner: number;
    id: string;
    value?: ProjectReadResult;
    failed: boolean;
    pending?: boolean;
  }>();
  const selected = useRef(requestedId);
  selected.current = requestedId;
  const generation = useRef(0);
  const retry = () => {
    if (requests.capture().current() && selected.current === requestedId)
      setAttempt((value) => value + 1);
  };
  useEffect(() => {
    if (!enabled || !requestedId || !bridge?.readProject) return;
    const request = requests.capture();
    const serial = ++generation.current;
    setResult((previous) =>
      previous?.owner === requests.key &&
      previous.id === requestedId &&
      (previous.failed || previous.value?.status === "ready")
        ? { ...previous, pending: true }
        : undefined,
    );
    void bridge
      .readProject(requestedId)
      .then((value) => {
        if (!request.current() || serial !== generation.current) return;
        if (!validProjectRead(value, requestedId))
          throw new Error("Invalid project response.");
        setResult({
          owner: requests.key,
          id: requestedId,
          value,
          failed: false,
        });
      })
      .catch(() => {
        if (request.current() && serial === generation.current)
          setResult({ owner: requests.key, id: requestedId, failed: true });
      });
    return () => {
      generation.current++;
    };
  }, [requestedId, requests.key, enabled, attempt, projects]);
  if (!enabled || !requestedId)
    return projectDetailRead(requestedId, projects, catalog);
  if (result?.owner !== requests.key || result.id !== requestedId)
    return { status: "pending" };
  if (result.failed)
    return { status: "failed", retrying: result.pending === true, retry };
  if (result.value?.status === "ready")
    return { status: "ready", project: result.value.project };
  if (result.value?.status === "forbidden")
    return { status: "forbidden", retry };
  return { status: "missing", retry };
}

function validProjectRead(
  value: unknown,
  id: string,
): value is ProjectReadResult {
  const result = value as ProjectReadResult | undefined;
  if (!result || !["ready", "missing", "forbidden"].includes(result.status))
    return false;
  if (result.status !== "ready") return true;
  return (
    !!result.project &&
    result.project.id === id &&
    typeof result.project.name === "string" &&
    typeof result.project.description === "string" &&
    typeof result.project.instructions === "string" &&
    Number.isFinite(result.project.createdAt)
  );
}

const legacyCapabilities: ProjectCreationCapabilities = {
  routing: "classic",
  contextFiles: false,
  contextText: false,
  localFolders: false,
  educationSuggestions: false,
};
function validCapabilities(
  value: unknown,
): value is ProjectCreationCapabilities {
  const capabilities = value as ProjectCreationCapabilities | undefined;
  return (
    !!capabilities &&
    ["classic", "unified", "legacy-local"].includes(capabilities.routing) &&
    [
      capabilities.contextFiles,
      capabilities.contextText,
      capabilities.localFolders,
      capabilities.educationSuggestions,
    ].every((flag) => typeof flag === "boolean")
  );
}
export function useProjectCreationCapabilities(enabled = true) {
  const requests = useSettingsRequestScope();
  const bridge = requests.capture().bridge as
    (DesktopAPI & Partial<ProjectAccessAPI>) | undefined;
  const available =
    enabled && typeof bridge?.projectCreationCapabilities === "function";
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    owner: number;
    capabilities?: ProjectCreationCapabilities;
    failed: boolean;
  }>();
  useEffect(() => {
    if (!available || !bridge?.projectCreationCapabilities) return;
    const request = requests.capture();
    let live = true;
    setResult(undefined);
    void bridge
      .projectCreationCapabilities()
      .then((value) => {
        if (!live || !request.current()) return;
        if (!validCapabilities(value))
          throw new Error("Invalid project creation capabilities.");
        setResult({ owner: requests.key, capabilities: value, failed: false });
      })
      .catch(() => {
        if (live && request.current())
          setResult({ owner: requests.key, failed: true });
      });
    return () => {
      live = false;
    };
  }, [requests.key, available, attempt]);
  const shown = result?.owner === requests.key ? result : undefined;
  return {
    status:
      !available || shown?.capabilities
        ? ("ready" as const)
        : shown?.failed
          ? ("failed" as const)
          : ("pending" as const),
    capabilities: available ? shown?.capabilities : legacyCapabilities,
    retry: () => {
      if (requests.capture().current()) setAttempt((value) => value + 1);
    },
    capture: requests.capture,
    key: requests.key,
  };
}
