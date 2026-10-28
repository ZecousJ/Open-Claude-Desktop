import { useEffect, useState } from "react";
import type { SharedChatContent } from "../../shared/sharing-api";
import { api } from "../desktop-api";
import ArtifactEditAccess from "../collections/shared/ArtifactEditAccess";

export default function ArtifactEditRequests({
  url,
  onError,
}: {
  url: string;
  onError: (error: unknown) => void;
}) {
  const token = url.split("/").at(-1) ?? "";
  const [chat, setChat] = useState<SharedChatContent>();
  useEffect(() => {
    let live = true;
    setChat(undefined);
    const load = () =>
      void api.readSharedChat(token).then(
        (chat) => {
          if (live) setChat(chat);
        },
        () => {},
      );
    load();
    const timer = setInterval(load, 30000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [token]);
  return chat?.editRequests?.length ? (
    <div className="publish-artifact">
      <ArtifactEditAccess
        token={token}
        chat={chat}
        onChanged={setChat}
        onError={onError}
      />
    </div>
  ) : null;
}
