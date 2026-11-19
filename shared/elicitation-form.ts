/** MCP elicitation `requestedSchema` (flat object of primitives) as form fields and back. */
export type FieldType =
  "string" | "number" | "integer" | "boolean" | "enum" | "multi";
export interface FormField {
  name: string;
  label: string;
  description?: string;
  type: FieldType;
  required: boolean;
  options: { value: string; label: string }[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  initial: string | boolean | string[];
}

function options(schema: any): FormField["options"] {
  if (Array.isArray(schema?.oneOf))
    return schema.oneOf.map((o: any) => ({
      value: String(o.const),
      label: String(o.title ?? o.const),
    }));
  if (Array.isArray(schema?.enum))
    return schema.enum.map((value: unknown, i: number) => ({
      value: String(value),
      label: String(schema.enumNames?.[i] ?? value),
    }));
  const items = schema?.items;
  if (items) return options(items.anyOf ? { oneOf: items.anyOf } : items);
  return [];
}

export function elicitationFields(schema: any): FormField[] {
  const properties =
    schema && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set<string>(
    Array.isArray(schema?.required) ? schema.required : [],
  );
  return Object.entries<any>(properties).map(([name, field]) => {
    const choices = options(field);
    const type: FieldType =
      field?.type === "array"
        ? "multi"
        : choices.length
          ? "enum"
          : field?.type === "boolean"
            ? "boolean"
            : field?.type === "integer"
              ? "integer"
              : field?.type === "number"
                ? "number"
                : "string";
    const initial =
      type === "boolean"
        ? Boolean(field?.default)
        : type === "multi"
          ? Array.isArray(field?.default)
            ? field.default.map(String)
            : []
          : field?.default == null
            ? ""
            : String(field.default);
    return {
      name,
      label: String(field?.title ?? name),
      description:
        typeof field?.description === "string" ? field.description : undefined,
      type,
      required: required.has(name),
      options: choices,
      format: field?.format,
      minimum: field?.minimum,
      maximum: field?.maximum,
      minLength: field?.minLength,
      maxLength: field?.maxLength,
      initial,
    };
  });
}

export type FormValues = Record<string, string | boolean | string[]>;

/**
 * What is wrong with a form's values: the kind and the field's label (and the
 * limit it broke). The desktop words it in English (`problemMessage`); the
 * phones word the same kinds in their own languages
 * (tests/fixtures/elicitation-form-cases.json holds the cases all three pass).
 */
export type FormProblem =
  | { kind: "required" | "email" | "uri" | "dateTime"; label: string }
  | { kind: "chooseOne" | "number" | "integer"; label: string }
  | {
      kind: "minimum" | "maximum" | "minLength" | "maxLength";
      label: string;
      limit: number;
    };

export function problemMessage(problem: FormProblem): string {
  const { label } = problem;
  switch (problem.kind) {
    case "required":
      return `${label} is required.`;
    case "chooseOne":
      return `Choose at least one option for ${label}.`;
    case "integer":
      return `${label} must be a whole number.`;
    case "number":
      return `${label} must be a number.`;
    case "minimum":
      return `${label} must be at least ${problem.limit}.`;
    case "maximum":
      return `${label} must be at most ${problem.limit}.`;
    case "minLength":
      return `${label} needs at least ${problem.limit} characters.`;
    case "maxLength":
      return `${label} allows at most ${problem.limit} characters.`;
    case "email":
      return `${label} must be an email address.`;
    case "uri":
      return `${label} must be a URL.`;
    case "dateTime":
      return `${label} must be a date and time.`;
  }
}

/** Content for an accepted elicitation, or the first problem with the values. */
export function elicitationResult(
  fields: FormField[],
  values: FormValues,
): { content: Record<string, unknown> } | { problem: FormProblem } {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name] ?? field.initial;
    const label = field.label;
    if (field.type === "boolean") {
      content[field.name] = Boolean(value);
      continue;
    }
    if (field.type === "multi") {
      const list = Array.isArray(value) ? value : [];
      if (field.required && !list.length)
        return { problem: { kind: "chooseOne", label } };
      if (list.length) content[field.name] = list;
      continue;
    }
    const text = String(value).trim();
    if (!text) {
      if (field.required) return { problem: { kind: "required", label } };
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      const number = Number(text);
      if (
        !Number.isFinite(number) ||
        (field.type === "integer" && !Number.isInteger(number))
      )
        return { problem: { kind: field.type, label } };
      if (field.minimum != null && number < field.minimum)
        return {
          problem: { kind: "minimum", label, limit: field.minimum },
        };
      if (field.maximum != null && number > field.maximum)
        return {
          problem: { kind: "maximum", label, limit: field.maximum },
        };
      content[field.name] = number;
      continue;
    }
    if (field.minLength != null && text.length < field.minLength)
      return {
        problem: { kind: "minLength", label, limit: field.minLength },
      };
    if (field.maxLength != null && text.length > field.maxLength)
      return {
        problem: { kind: "maxLength", label, limit: field.maxLength },
      };
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+$/.test(text))
      return { problem: { kind: "email", label } };
    if (field.format === "uri" && !/^[a-z][a-z0-9+.-]*:/i.test(text))
      return { problem: { kind: "uri", label } };
    if (field.format === "date-time") {
      const time = new Date(text);
      if (Number.isNaN(time.getTime()))
        return { problem: { kind: "dateTime", label } };
      content[field.name] = time.toISOString();
      continue;
    }
    content[field.name] = text;
  }
  return { content };
}

/** Content for an accepted elicitation, or the first problem to show under the form. */
export function elicitationContent(
  fields: FormField[],
  values: FormValues,
): { content: Record<string, unknown> } | { error: string } {
  const result = elicitationResult(fields, values);
  return "problem" in result
    ? { error: problemMessage(result.problem) }
    : result;
}
