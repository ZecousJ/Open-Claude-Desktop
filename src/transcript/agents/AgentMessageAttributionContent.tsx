import type { Item } from "../../../shared/types";
import {
  agentMessageOrigin,
  agentMessageTitle,
} from "../../../shared/agent-messages";
import { formatText, t } from "../../i18n";
import "./agent-messages.css";

export default function AgentMessageAttributionContent({
  item,
}: {
  item: Item;
}) {
  if (item.notice === "agents_killed")
    return (
      <p className="agent-message-attribution">
        {t("All background agents stopped")}
      </p>
    );
  const origin = agentMessageOrigin(item);
  if (!origin) return null;
  return (
    <div className="agent-message-attribution" data-find-omitted="">
      <p>
        {formatText(agentMessageTitle(origin), { name: origin.name ?? "" })}
      </p>
      {origin.relayedAgent && (
        <p>
          {origin.relayedAgent.name === undefined ? (
            t("Sent by a subagent")
          ) : (
            <>
              {t("Agent: {name}").split("{name}")[0]}
              <bdi>{origin.relayedAgent.name}</bdi>
              {t("Agent: {name}").split("{name}")[1]}
            </>
          )}
        </p>
      )}
    </div>
  );
}
