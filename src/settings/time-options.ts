/** Localized labels only: persisted days and HH:mm values never change locale. */
export function quietTimeOptions(locale: string) {
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return Array.from({ length: 48 }, (_, index) => {
    const hour = Math.floor(index / 2);
    const minute = index % 2 ? 30 : 0;
    return {
      value: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      label: formatter.format(new Date(Date.UTC(2000, 0, 2, hour, minute))),
    };
  });
}

export function quietWeekdays(locale: string) {
  const short = new Intl.DateTimeFormat(locale, {
    weekday: "narrow",
    timeZone: "UTC",
  });
  const full = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    timeZone: "UTC",
  });
  // 2000-01-02 is Sunday. Storage uses Sunday=0, regardless of the display locale.
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(2000, 0, 2 + index));
    return { short: short.format(date), full: full.format(date) };
  });
}

export function reminderChoices(
  locale: string,
  unit: "hour" | "minute",
  values: number[],
) {
  const format = new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
  });
  return [
    { value: "", label: "–" },
    ...values.map((value) => ({
      value: String(value),
      label: format.format(value),
    })),
  ];
}
