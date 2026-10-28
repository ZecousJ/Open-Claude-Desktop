import { Suspense, useEffect, useRef, useState } from "react";
import type { Conversation, Mode } from "../../shared/types";
import {
  needsCacheConfirmation,
  type CacheChangeKind,
} from "../../shared/cowork-cache";
import { lazyPiece } from "../ui/lazy-piece";

const loadCacheChangeDialog = () => import("./CacheChangeDialog");
const CacheChangeDialog = lazyPiece(loadCacheChangeDialog);
type Pending = {
  kind: CacheChangeKind;
  targetLabel: string;
  resolve: (confirmed: boolean) => void;
};

export function useCacheChange(mode: Mode, conversation?: Conversation) {
  const [pending, setPending] = useState<Pending>();
  const current = useRef<Pending>(undefined);
  const finish = (confirmed: boolean) => {
    current.current?.resolve(confirmed);
    current.current = undefined;
    setPending(undefined);
  };
  useEffect(() => {
    setPending(undefined);
    return () => {
      current.current?.resolve(false);
      current.current = undefined;
    };
  }, [conversation?.id, mode]);
  return {
    confirmChange: (kind: CacheChangeKind, targetLabel: string) => {
      if (!needsCacheConfirmation(mode, conversation))
        return Promise.resolve(true);
      current.current?.resolve(false);
      return new Promise<boolean>((resolve) => {
        const request = { kind, targetLabel, resolve };
        current.current = request;
        setPending(request);
        void loadCacheChangeDialog().catch(() => {
          if (current.current !== request) return;
          current.current = undefined;
          setPending(undefined);
          resolve(false);
        });
      });
    },
    dialog: pending && (
      <Suspense fallback={null}>
        <CacheChangeDialog
          kind={pending.kind}
          targetLabel={pending.targetLabel}
          onClose={() => finish(false)}
          onConfirm={() => finish(true)}
        />
      </Suspense>
    ),
  };
}
