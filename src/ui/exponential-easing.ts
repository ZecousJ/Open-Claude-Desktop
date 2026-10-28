/** Same measured effort-curve sampling, shared without loading the canvas model. */
export function exponentialEasing(duration: number, tau: number, steps = 12) {
  const end = 1 - Math.exp(-duration / tau);
  const points: string[] = ["0"];
  for (let i = 1; i < steps; i++) {
    const u = (i / steps) ** 1.6;
    const value = (1 - Math.exp((-u * duration) / tau)) / end;
    points.push(`${value.toFixed(4)} ${(u * 100).toFixed(2)}%`);
  }
  points.push("1");
  return `linear(${points.join(", ")})`;
}
