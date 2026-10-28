/**
 * Chat and Cowork home greetings. Only sentences seen in the The time-of-day
 * greeting with the user's name, "Back at it, <name>", "Let’s noodle", and in
 * the evening "Evening, how are things?" and "Evening thoughts", and in the
 * afternoon "Afternoon, <name>".
 */
export function timeOfDayGreeting(hour: number) {
  return hour >= 5 && hour < 12
    ? "Good morning"
    : hour >= 12 && hour < 17
      ? "Good afternoon"
      : "Good evening";
}

/** Every greeting a home view can show at this hour, for this name. */
export function greetingChoices(name: string, hour: number) {
  const who = name.trim();
  const opening = timeOfDayGreeting(hour);
  return [
    who ? `${opening}, ${who}` : opening,
    // Without a name these greetings have nobody to address.
    ...(who && opening === "Good afternoon" ? [`Afternoon, ${who}`] : []),
    ...(who ? [`Back at it, ${who}`] : []),
    "Let’s noodle",
    ...(opening === "Good evening"
      ? ["Evening, how are things?", "Evening thoughts"]
      : []),
  ];
}

/** Pick one greeting for a home view; `roll` is a number in [0, 1) so callers can keep the choice stable. */
export function homeGreeting(name: string, hour: number, roll: number) {
  const choices = greetingChoices(name, hour);
  const index = Math.min(
    choices.length - 1,
    Math.max(0, Math.floor(roll * choices.length)),
  );
  return choices[index];
}
