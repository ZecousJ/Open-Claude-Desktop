import { useContext } from "react";
import { AppContext } from "../app/AppContext";
import { useHost } from "../host/HostContext";
import { UsageOverview } from "./UsageOverview";

/** Claudex's existing local statistics remain available outside the default home. */
export default function CodeUsageSettings() {
  const host = useHost();
  const app = useContext(AppContext);
  return host.kind === "desktop" && host.capabilities.localCode && app ? (
    <UsageOverview conversations={app.snapshot.conversations} />
  ) : null;
}
