import { Menu } from "../../ui/Menu";
import { connectorAllowed } from "../../../shared/client-policy-rules";
import { linearMcpUrl } from "../../../shared/linear-api";
import type { MenuPosition } from "../../ui/Menu";
import type { ConnectorOperation } from "../connector-owner";
import type { ClientPolicy } from "../../../shared/client-policy";
import type { ConnectorSuggestion } from "../../../shared/connector-links";
import type { CatalogueConnector } from "../../../shared/connectors-catalogue";

/** What AddConnectorMenu needs from ConnectorsView.tsx. */
export interface ConnectorsPart1Props {
  addButton: React.RefObject<HTMLButtonElement | null>;
  addMenu: MenuPosition;
  editing: boolean;
  linearConnected: boolean;
  local: boolean;
  onError: (error: unknown) => void;
  owner: {
    key: number;
    current: () => boolean;
    capture(channel?: string | undefined): ConnectorOperation;
  };
  policy: ClientPolicy;
  refusal:
    | "Custom connectors aren’t available for this account."
    | "MCP servers can be changed once Claudex reaches your service."
    | "Your administrator has turned off adding MCP servers."
    | undefined;
  setAddMenu: React.Dispatch<React.SetStateAction<MenuPosition | undefined>>;
  setAdding: React.Dispatch<React.SetStateAction<boolean>>;
  setAllListed: React.Dispatch<React.SetStateAction<boolean>>;
  setConfirmedSuggestion: React.Dispatch<
    React.SetStateAction<ConnectorSuggestion | undefined>
  >;
  setConnectorDefaults: React.Dispatch<
    React.SetStateAction<CatalogueConnector | undefined>
  >;
  setLinearOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setView: React.Dispatch<React.SetStateAction<"yours" | "discover">>;
}

export function AddConnectorMenu({
  addButton,
  addMenu,
  editing,
  linearConnected,
  local,
  onError,
  owner,
  policy,
  refusal,
  setAddMenu,
  setAdding,
  setAllListed,
  setConfirmedSuggestion,
  setConnectorDefaults,
  setLinearOpen,
  setView,
}: ConnectorsPart1Props) {
  return (
    <Menu
      label="Add connector"
      size="regular"
      width={200}
      position={addMenu}
      anchors={[addButton]}
      onClose={() => setAddMenu(undefined)}
      entries={[
        {
          label: "Browse connectors",
          onSelect: () => {
            setView("discover");
            setAllListed(false);
          },
        },
        ...(editing &&
        connectorAllowed(policy, "Linear", { url: linearMcpUrl }) &&
        !linearConnected
          ? [
              {
                label: "Connect Linear",
                onSelect: () => setLinearOpen(true),
              },
            ]
          : []),
        {
          label: "Add custom connector",
          disabled: !editing,
          title: refusal,
          onSelect: () => {
            setConfirmedSuggestion(undefined);
            setConnectorDefaults(undefined);
            setAdding(true);
          },
        },
        ...(editing && local
          ? [
              {
                label: "Edit config",
                onSelect: () => {
                  if (!owner.current()) return;
                  const operation = owner.capture("edit-config");
                  void operation.bridge.openMcpConfig().catch((error) => {
                    if (operation.current()) onError(error);
                  });
                },
              },
            ]
          : []),
      ]}
    />
  );
}
