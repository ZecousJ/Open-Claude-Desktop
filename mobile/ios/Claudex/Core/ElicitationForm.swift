import Foundation

/// An MCP elicitation `requestedSchema` (a flat object of primitives) as form fields and back: the same
/// rules as the web card (`src/approval/elicitation-form.ts`). `tests/fixtures/elicitation-form-cases.json`
/// holds the cases the web, this Core and the Android app all pass. The JSON here is decoded into
/// unordered maps, so the field order is the engine's `claudexFieldOrder` (the schema's property order).
public enum ElicitationForm {
    public enum FieldType: Sendable, Equatable { case string, number, integer, boolean, choice, multi }
    public struct Option: Equatable, Sendable { public let value: String; public let label: String }
    public enum Value: Equatable, Sendable { case text(String), flag(Bool), list([String]) }

    public struct Field: Equatable, Sendable, Identifiable {
        public var id: String { name }
        public let name: String
        public let label: String
        public let description: String?
        public let type: FieldType
        public let required: Bool
        public let options: [Option]
        public let format: String?
        public let minimum: Double?
        public let maximum: Double?
        public let minLength: Int?
        public let maxLength: Int?
        public let initial: Value
    }

    /// What is wrong with the values: the kind, the field's label and the limit it broke. The phone words
    /// each kind in its own language.
    public enum Problem: Error, Equatable, Sendable {
        case required(String), chooseOne(String), number(String), integer(String)
        case minimum(String, Double), maximum(String, Double), minLength(String, Int), maxLength(String, Int)
        case email(String), uri(String), dateTime(String)
    }

    /// The form fields of a `requestedSchema`; [order] is the schema's property order when known.
    public static func fields(schema: JSONValue, order: [String]? = nil) -> [Field] {
        guard let properties = schema["properties"].object else { return [] }
        let required = Set((schema["required"].array ?? []).compactMap(\.string))
        let names = (order ?? []).filter { properties[$0] != nil } + properties.keys.filter { !(order ?? []).contains($0) }.sorted()
        return names.map { name in
            let field = properties[name] ?? .null
            let choices = options(field)
            let type: FieldType =
                field["type"].string == "array" ? .multi
                : !choices.isEmpty ? .choice
                : field["type"].string == "boolean" ? .boolean
                : field["type"].string == "integer" ? .integer
                : field["type"].string == "number" ? .number : .string
            let initial: Value
            switch type {
            case .boolean: initial = .flag(field["default"].bool ?? false)
            case .multi: initial = .list((field["default"].array ?? []).map(display))
            default: initial = .text(field["default"] == .null ? "" : display(field["default"]))
            }
            return Field(name: name, label: field["title"] == .null ? name : display(field["title"]),
                         description: field["description"].string, type: type, required: required.contains(name),
                         options: choices, format: field["format"].string,
                         minimum: field["minimum"].number, maximum: field["maximum"].number,
                         minLength: field["minLength"].integer, maxLength: field["maxLength"].integer, initial: initial)
        }
    }

    private static func options(_ schema: JSONValue) -> [Option] {
        if let list = schema["oneOf"].array {
            return list.map { Option(value: display($0["const"]), label: display($0["title"] == .null ? $0["const"] : $0["title"])) }
        }
        if let list = schema["enum"].array {
            let names = schema["enumNames"].array
            return list.enumerated().map { index, value in
                let name = names.flatMap { index < $0.count ? $0[index] : nil }
                return Option(value: display(value), label: display(name.map { $0 == .null ? value : $0 } ?? value))
            }
        }
        let items = schema["items"]
        if items != .null { return options(items["anyOf"] != .null ? .object(["oneOf": items["anyOf"]]) : items) }
        return []
    }

    /// JavaScript's `String(value)` for the JSON values a schema holds.
    static func display(_ value: JSONValue) -> String {
        switch value {
        case .string(let v): v
        case .number(let v): format(v)
        case .bool(let v): v ? "true" : "false"
        case .null: "null"
        default: ""
        }
    }

    /// A number as JavaScript prints it: 3, 2.5, never 3.0.
    public static func format(_ number: Double) -> String {
        if number.rounded() == number, abs(number) < 1e15 { return String(Int64(number)) }
        return "\(number)"
    }

    /// The content of an accepted form, or the first problem with the values.
    public static func content(_ fields: [Field], values: [String: Value]) -> Result<JSONValue, Problem> {
        var content: [String: JSONValue] = [:]
        for field in fields {
            let value = values[field.name] ?? field.initial
            let label = field.label
            switch field.type {
            case .boolean:
                if case .flag(let on) = value { content[field.name] = .bool(on) } else { content[field.name] = .bool(false) }
                continue
            case .multi:
                var list: [String] = []
                if case .list(let chosen) = value { list = chosen }
                if field.required && list.isEmpty { return .failure(.chooseOne(label)) }
                if !list.isEmpty { content[field.name] = .array(list.map(JSONValue.string)) }
                continue
            default: break
            }
            var raw = ""
            if case .text(let typed) = value { raw = typed }
            let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty {
                if field.required { return .failure(.required(label)) }
                continue
            }
            if field.type == .number || field.type == .integer {
                guard let number = Double(text), number.isFinite, field.type != .integer || number.rounded() == number else {
                    return .failure(field.type == .integer ? .integer(label) : .number(label))
                }
                if let minimum = field.minimum, number < minimum { return .failure(.minimum(label, minimum)) }
                if let maximum = field.maximum, number > maximum { return .failure(.maximum(label, maximum)) }
                content[field.name] = .number(number)
                continue
            }
            let length = text.utf16.count
            if let minLength = field.minLength, length < minLength { return .failure(.minLength(label, minLength)) }
            if let maxLength = field.maxLength, length > maxLength { return .failure(.maxLength(label, maxLength)) }
            if field.format == "email", text.range(of: "^[^\\s@]+@[^\\s@]+$", options: .regularExpression) == nil { return .failure(.email(label)) }
            if field.format == "uri", text.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) == nil { return .failure(.uri(label)) }
            if field.format == "date-time" {
                guard let iso = isoDateTime(text) else { return .failure(.dateTime(label)) }
                content[field.name] = .string(iso)
                continue
            }
            content[field.name] = .string(text)
        }
        return .success(.object(content))
    }

    /// A date and time (ISO 8601 with `Z` or an offset, or a date alone as midnight UTC) as `toISOString()` writes it.
    static func isoDateTime(_ text: String) -> String? {
        let formats: [ISO8601DateFormatter.Options] = [
            [.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime], [.withFullDate],
        ]
        for options in formats {
            let reader = ISO8601DateFormatter()
            reader.formatOptions = options
            if let date = reader.date(from: text) {
                let writer = ISO8601DateFormatter()
                writer.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return writer.string(from: date)
            }
        }
        return nil
    }

    /// The page a URL request opens: http or https only.
    public static func openablePage(_ url: String?) -> URL? {
        guard let url, let page = URL(string: url), let scheme = page.scheme?.lowercased(), scheme == "http" || scheme == "https",
              page.host != nil else { return nil }
        return page
    }
}
