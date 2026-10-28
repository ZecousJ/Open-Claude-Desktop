import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";

export interface ComposerSendLease {
  owns(): boolean;
  finish(): void;
}
/** UI busy marks belong to their conversation/draft and to one operation.
 * Visiting B does not discard A's pending mark; finishing A cannot clear B
 * or a later operation in A. Nothing here changes the backend protocol. */
export function useComposerSending(place: string) {
  const tickets = useRef(new Map<string, symbol>());
  const mounted = useRef(true);
  const [, redraw] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      tickets.current.clear();
    };
  }, []);
  const beginComposerSend = useCallback((): ComposerSendLease => {
    const ticket = Symbol();
    tickets.current.set(place, ticket);
    redraw((value) => value + 1);
    const owns = () => mounted.current && tickets.current.get(place) === ticket;
    return {
      owns,
      finish() {
        if (!owns()) return;
        tickets.current.delete(place);
        redraw((value) => value + 1);
      },
    };
  }, [place]);
  const setSending = useCallback(
    (value: SetStateAction<boolean>) => {
      const next =
        typeof value === "function" ? value(tickets.current.has(place)) : value;
      if (next) {
        if (!tickets.current.has(place)) tickets.current.set(place, Symbol());
      } else tickets.current.delete(place);
      redraw((current) => current + 1);
    },
    [place],
  );
  return { sending: tickets.current.has(place), setSending, beginComposerSend };
}
