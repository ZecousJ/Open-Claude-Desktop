import { WorkingKnot } from "./WorkingKnot";

/** What the Chat status row's mark shows: thinking or a tool running. */
export type ClayMotion = "breathe" | "tumble";

/** The working mark of Chat's status row, 20px. */
export function ClayMark({ motion = "breathe" }: { motion?: ClayMotion }) {
  return <WorkingKnot kind={motion} />;
}
