import { Suspense } from "react";
import { lazyPiece } from "../ui/lazy-piece";
import { useSpinOffWindows } from "./spin-off-store";

/** The windows and their styles load with the first spun-off task. */
const SpinOffWindows = lazyPiece(() => import("./SpinOffWindows"));

/** Where Spin off a new task's windows float (spin-off-store.ts). */
export function SpinOffSlot() {
  const windows = useSpinOffWindows();
  if (!windows.length) return null;
  return (
    <Suspense fallback={null}>
      <SpinOffWindows />
    </Suspense>
  );
}
