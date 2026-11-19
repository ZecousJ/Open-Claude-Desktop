import type { Conversation } from "../../../shared/types";

export const isLocalCodeSession = (c: Conversation) =>
  c.mode === "code" &&
  !c.cloudHosted &&
  !c.cloudEnvironmentId &&
  (!c.environment || c.environment.kind === "local") &&
  !!c.cwd;

export const isWslCodeSession = (c: Conversation) =>
  c.mode === "code" &&
  !c.incognito &&
  !c.cloudHosted &&
  !c.cloudEnvironmentId &&
  c.environment?.kind === "wsl" &&
  !!c.cwd;

export const isOwnedCloudCodeSession = (c: Conversation, owner: string) =>
  c.mode === "code" &&
  !c.incognito &&
  !c.cloudHosted &&
  c.environment?.kind !== "ssh" &&
  c.environment?.kind !== "wsl" &&
  (!c.sessionAuthors || c.sessionAuthors.ownerAccountUuid === owner);
