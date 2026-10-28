import { useId } from "react";
import type { FormField, FormValues } from "./elicitation-form";
import { SelectField } from "../settings/controls";

/** Schema-driven inputs for an MCP elicitation form. */
export function ElicitationFields({
  fields,
  values,
  onChange,
}: {
  fields: FormField[];
  values: FormValues;
  onChange: (name: string, value: FormValues[string]) => void;
}) {
  // Unique per card, so two pending forms never share input ids.
  const form = useId();
  return (
    <div className="approval-fields">
      {fields.map((field) => {
        const value = values[field.name] ?? field.initial;
        const id = `${form}-${field.name}`;
        const label = (
          <span className="approval-field-label">
            {field.label}
            {field.required && (
              <span className="approval-required" aria-label="required">
                {" "}
                *
              </span>
            )}
          </span>
        );
        const note = field.description && (
          <span className="approval-field-note">{field.description}</span>
        );
        if (field.type === "boolean")
          return (
            <label className="approval-field approval-check" key={field.name}>
              <input
                type="checkbox"
                className="cx-check-input"
                checked={Boolean(value)}
                onChange={(e) => onChange(field.name, e.target.checked)}
              />
              <span>
                {label}
                {note}
              </span>
            </label>
          );
        if (field.type === "multi") {
          const list = Array.isArray(value) ? value : [];
          return (
            <fieldset className="approval-field" key={field.name}>
              <legend>{label}</legend>
              {note}
              <div className="approval-options">
                {field.options.map((option) => (
                  <label className="approval-check" key={option.value}>
                    <input
                      type="checkbox"
                      className="cx-check-input"
                      checked={list.includes(option.value)}
                      onChange={(e) =>
                        onChange(
                          field.name,
                          e.target.checked
                            ? [...list, option.value]
                            : list.filter((v) => v !== option.value),
                        )
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          );
        }
        if (field.type === "enum")
          return (
            <div className="approval-field approval-select" key={field.name}>
              {label}
              {note}
              <SelectField<string>
                label={field.label}
                value={String(value ?? "")}
                placeholder="Choose…"
                options={[
                  ...(field.required ? [] : [{ value: "", label: "None" }]),
                  ...field.options,
                ]}
                onChange={(next) => onChange(field.name, next)}
              />
            </div>
          );
        return (
          <label className="approval-field" key={field.name} htmlFor={id}>
            {label}
            {note}
            <input
              id={id}
              className="approval-input"
              type={
                field.type === "number" || field.type === "integer"
                  ? "number"
                  : field.format === "email"
                    ? "email"
                    : field.format === "uri"
                      ? "url"
                      : field.format === "date"
                        ? "date"
                        : field.format === "date-time"
                          ? "datetime-local"
                          : "text"
              }
              step={field.type === "integer" ? 1 : undefined}
              min={field.minimum}
              max={field.maximum}
              value={String(value)}
              onChange={(e) => onChange(field.name, e.target.value)}
            />
          </label>
        );
      })}
    </div>
  );
}
