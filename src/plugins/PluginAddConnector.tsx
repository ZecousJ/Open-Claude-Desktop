import AddConnectorDialog from "../settings/tabs/AddConnectorDialog";
import { useMcpServerList } from "../settings/tabs/Developer";

export function PluginAddConnector({
  onError,
  onClose,
  onAdded,
}: {
  onError: (error: unknown) => void;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { value } = useMcpServerList(onError);
  const servers = value?.servers ?? [];
  return (
    <AddConnectorDialog
      existingNames={servers.map((server) => server.displayName ?? server.name)}
      existingIds={servers.map((server) => server.name)}
      onClose={onClose}
      onAdded={onAdded}
    />
  );
}
