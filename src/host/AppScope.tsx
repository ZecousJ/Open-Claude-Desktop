import type { ReactNode } from "react";
import { hostFor, surface } from "../../shared/host";
import { AppContext, type AppController } from "../app/AppContext";
import { HostContext } from "./HostContext";

/** Provides the window's controller and its host (useApp(), useHost()). */
export function AppScope({
  app,
  children,
}: {
  app: AppController;
  children: ReactNode;
}) {
  return (
    <HostContext.Provider value={app.host ?? hostFor(surface)}>
      <AppContext.Provider value={app}>{children}</AppContext.Provider>
    </HostContext.Provider>
  );
}
