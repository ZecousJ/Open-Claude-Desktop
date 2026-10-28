import { useLocale, t } from "../../i18n";
import {
  quietTimeOptions,
  quietWeekdays,
  reminderChoices,
} from "../time-options";
import { preference, type QuietHours } from "../../../shared/settings-extras";
import { Row, Section } from "../controls";
import { Dropdown } from "../Dropdown";
import type { TabProps } from "../context";
import "../../focus/focus.css";

/** Rows Settings search finds on this page. */
export { timeLabels as searchLabels } from "./desktop-labels";

/**
 * Settings → Time and focus: Break reminders, an hours and a minutes menu ("–"
 * until chosen); Quiet hours, seven 32px day circles, S to S. The From and To
 * menus under the days are Claudex's (the original's were not opened: that
 * changes the account).
 */
export function TimeAndFocusTab({ settings, save }: TabProps) {
  const locale = useLocale();
  const days = quietWeekdays(locale);
  const times = quietTimeOptions(locale);
  const hourChoices = reminderChoices(locale, "hour", [1, 2, 3, 4, 5, 6, 7, 8]);
  const minuteChoices = reminderChoices(locale, "minute", [0, 15, 30, 45]);
  const total = preference(settings, "breakReminderMinutes");
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const quiet = preference(settings, "quietHours");
  const setBreak = (h: number, m: number) =>
    save({ breakReminderMinutes: h * 60 + m });
  const setQuiet = (patch: Partial<QuietHours>) =>
    save({ quietHours: { ...quiet, ...patch } });
  return (
    <Section title="Time and focus">
      <div className="focus-page">
        {/* The two menus sit under the description, 112px each, 12px apart. */}
        <Row
          label="Break reminders"
          description="Get a nudge to take a break from Claudex. You can snooze or adjust anytime."
          stacked
        >
          <span className="focus-break-menus">
            <Dropdown
              label="Hours"
              bordered
              width={112}
              value={total ? String(hours || "") : ""}
              options={hourChoices}
              onChange={(value) => setBreak(Number(value || 0), minutes)}
            />
            <Dropdown
              label="Minutes"
              bordered
              width={112}
              value={total ? String(minutes) : ""}
              options={minuteChoices}
              onChange={(value) =>
                setBreak(hours, value === "" ? 0 : Number(value))
              }
            />
          </span>
        </Row>
        <Row
          label="Quiet hours"
          description="Set time limits for Claudex. You can dismiss or adjust anytime."
          stacked
        >
          <div className="focus-quiet">
            <div className="focus-days" role="group" aria-label="Quiet days">
              {days.map((day, index) => {
                const on = quiet.days.includes(index);
                return (
                  <button
                    key={index}
                    type="button"
                    aria-label={day.full}
                    aria-pressed={on}
                    onClick={() =>
                      setQuiet({
                        days: on
                          ? quiet.days.filter((d) => d !== index)
                          : [...quiet.days, index].sort(),
                      })
                    }
                  >
                    {day.short}
                  </button>
                );
              })}
            </div>
            {quiet.days.length > 0 && (
              <div className="focus-times">
                <span>{t("From")}</span>
                <Dropdown
                  label="From"
                  bordered
                  width={120}
                  value={quiet.start}
                  options={times}
                  onChange={(start) => setQuiet({ start })}
                />
                <span>{t("To")}</span>
                <Dropdown
                  label="To"
                  bordered
                  width={120}
                  value={quiet.end}
                  options={times}
                  onChange={(end) => setQuiet({ end })}
                />
              </div>
            )}
          </div>
        </Row>
      </div>
    </Section>
  );
}
