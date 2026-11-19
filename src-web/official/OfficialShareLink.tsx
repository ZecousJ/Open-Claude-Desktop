import { useEffect, useState, type ReactNode } from "react";
import { WebBoot } from "../../src/boot/BootShell";
import type { WebBridge } from "../bridge";
import { readOfficialShareAddress } from "./share-link";

export function OfficialShareLink({
  bridge,
  accountId,
  shareId,
  children,
}: {
  bridge: WebBridge;
  accountId: string;
  shareId: string;
  children: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const activation = bridge.auth.activationIdentity;
    const current = () =>
      active &&
      activation !== undefined &&
      bridge.auth.activationIdentity === activation &&
      bridge.auth.current?.account.id === accountId;
    if (current()) {
      void readOfficialShareAddress(
        bridge.officialUiRead,
        shareId,
        location.origin,
      )
        .then((address) => {
          if (current()) location.replace(address);
        })
        .catch(() => {
          if (current()) setFailed(true);
        });
    }
    return () => {
      active = false;
    };
  }, [accountId, bridge, shareId]);
  return failed ? children : <WebBoot />;
}
