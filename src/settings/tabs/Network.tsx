import { useEffect, useState } from "react";
import type { AppEnvironment } from "../../../shared/app-update-api";
import type { TabProps } from "../context";
import { t } from "../../i18n";
import "../network.css";

// Endpoint purposes:.
export function NetworkTab({ onError }: TabProps) {
  const [endpoints, setEndpoints] = useState<AppEnvironment["updateEndpoints"]>(
    [],
  );
  useEffect(() => {
    let current = true;
    const load = () =>
      window.desktop.appEnvironment().then(
        (environment) =>
          current && setEndpoints(environment.updateEndpoints ?? []),
        (error) => current && onError(error),
      );
    void load();
    const off = window.desktop.onEvent((event) => {
      if (event.type === "app-update") void load();
    });
    return () => {
      current = false;
      off();
    };
  }, []);
  return (
    <div className="desktop-page network-endpoints">
      <section>
        <h3>{t("Auto-updates")}</h3>
        {endpoints?.map((endpoint) => (
          <div className="network-endpoint" key={endpoint.url}>
            <code>{endpoint.url}</code>
            <span>{t(endpoint.purpose)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
