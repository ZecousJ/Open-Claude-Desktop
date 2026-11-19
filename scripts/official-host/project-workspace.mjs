import { Do as useState, ho as useContext, io as createContext, qa as jsx } from "./vendor-frame-iz8L1jC9.js";
import { jg as useGet } from "./shared-l-p-m-w-1-O9prfPUL.js";
import { ce as useAccount, ClaudexProjectAccount } from "./shared-l-p-m-w-2-BMCa56Vr.js";

const SelectionContext = createContext(null);
const emptyWorkspaces = [];
const projectChats = new Map();

export function rememberClaudexProjectChat(accountUuid, conversationUuid) {
  projectChats.set(conversationUuid, accountUuid);
}

export function isClaudexProjectChat(accountUuid, conversationUuid) {
  return !!accountUuid && projectChats.get(conversationUuid) === accountUuid;
}

export function ClaudexProjectChatRoute({ conversationUuid, pending, children }) {
  const { account, activeOrganization } = useAccount();
  const accountUuid = account?.uuid;
  const organizationUuid = activeOrganization?.uuid;
  const enabled = !!(organizationUuid && account?.claudex_project_workspaces?.length &&
    !isClaudexProjectChat(accountUuid, conversationUuid));
  const lookup = useGet(enabled
    ? `/api/organizations/${organizationUuid}/chat_conversations/${encodeURIComponent(conversationUuid)}?claudex_project_binding=1`
    : null, {
    queryKey: ["claudex_project_chat", accountUuid, organizationUuid, conversationUuid],
    enabled,
    retry: false,
    staleTime: Infinity,
    meta: { noToast: true },
  });

  if (enabled && lookup.isPending) return pending;
  if (enabled && lookup.data?.claudex_project_organization_uuid)
    rememberClaudexProjectChat(accountUuid, conversationUuid);
  return children;
}

export function ClaudexProjectSelection({ children }) {
  const [selection, select] = useState(null);
  return jsx(SelectionContext.Provider, { value: { selection, select }, children });
}

function useSelection() {
  const state = useContext(SelectionContext);
  const { account } = useAccount();
  const workspaces = account?.claudex_project_workspaces ?? emptyWorkspaces;
  const selected = state?.selection?.accountUuid === account?.uuid ? state?.selection?.uuid : undefined;
  return {
    workspaces,
    workspace: workspaces.find(({ uuid }) => uuid === selected),
    select: (uuid) => state?.select({ accountUuid: account?.uuid, uuid }),
  };
}

export function useClaudexProjectMenu(intl, onSelect) {
  const { workspaces, workspace, select } = useSelection();
  if (!workspaces.length) return;

  const personal = intl.formatMessage({ defaultMessage: "Personal", id: "NDx+B0BTac" });
  const label = intl.formatMessage({ defaultMessage: "Switch organization", id: "0lmKIf9uGH" });
  return {
    key: "project-organization",
    icon: "Organization",
    label: `${label}: ${workspace?.name ?? personal}`,
    items: [{ name: personal }, ...workspaces].map(({ uuid, name }) => ({
      label: name,
      checked: workspace?.uuid === uuid,
      checkedRole: "radio",
      onSelect: () => {
        if (workspace?.uuid === uuid) return;
        select(uuid);
        onSelect("mine");
      },
    })),
  };
}

export function ClaudexProjectScope({ projectUuid, pending, renderError, children }) {
  const { account, activeOrganization } = useAccount();
  const { workspaces, workspace: selected } = useSelection();
  const enabled = !!projectUuid && workspaces.length > 0;
  const lookup = useGet(enabled ? `/api/claudex/project-organizations/resolve/${encodeURIComponent(projectUuid)}` : null, {
    queryKey: ["claudex_project_organization", account?.uuid, projectUuid],
    enabled,
    retry: false,
    meta: { noToast: true },
  });

  if (enabled && lookup.isPending) return pending;
  if (enabled && lookup.isError && lookup.error.statusCode !== 404) return renderError(lookup.refetch);

  const workspace = projectUuid
    ? workspaces.find(({ uuid }) => uuid === lookup.data?.organization_uuid)
    : selected;
  if (enabled && lookup.isSuccess && !workspace) return renderError(lookup.refetch);

  return jsx(ClaudexProjectAccount, { workspace, children }, `${account?.uuid}:${workspace?.uuid ?? activeOrganization?.uuid}`);
}
