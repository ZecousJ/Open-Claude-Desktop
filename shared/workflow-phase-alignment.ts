/** Assign unknown path-prefix groups only when exact named phases make their position unambiguous. */
export function alignWorkflowPhaseNames(
  planned: string[],
  observed: string[],
): Map<string, string> {
  const mapping = new Map<string, string>();
  if (!planned.length || !observed.length) return mapping;
  const anchors: Array<{ observed: number; planned: number }> = [
    { observed: -1, planned: -1 },
  ];
  for (let index = 0; index < observed.length; index++) {
    const matched = planned.findIndex(
      (name) => name.toLowerCase() === observed[index].toLowerCase(),
    );
    if (matched >= 0) anchors.push({ observed: index, planned: matched });
  }
  if (anchors.length === 1) return mapping;
  anchors.push({ observed: observed.length, planned: planned.length });
  if (
    anchors.some(
      (anchor, index) =>
        index > 0 && anchor.planned <= anchors[index - 1].planned,
    )
  )
    return mapping;
  for (let index = 1; index < anchors.length; index++) {
    const before = anchors[index - 1],
      after = anchors[index];
    const observedGap = after.observed - before.observed - 1,
      plannedGap = after.planned - before.planned - 1;
    if (observedGap === plannedGap)
      for (let offset = 1; offset <= observedGap; offset++)
        mapping.set(
          observed[before.observed + offset],
          planned[before.planned + offset],
        );
  }
  return mapping;
}
