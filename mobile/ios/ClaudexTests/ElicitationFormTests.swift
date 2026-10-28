import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

/// The cases the web card, this Core and the Android app all pass
/// (`tests/fixtures/elicitation-form-cases.json`, read by `tests/elicitation-form-cases.test.ts` too).
final class ElicitationFormTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("tests/fixtures/elicitation-form-cases.json"))
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    private func value(_ json: JSONValue) -> ElicitationForm.Value {
        if let flag = json.bool { return .flag(flag) }
        if let list = json.array { return .list(list.compactMap(\.string)) }
        return .text(json.string ?? "")
    }

    private func problem(_ json: JSONValue) -> ElicitationForm.Problem? {
        let label = json["label"].string ?? ""
        let limit = json["limit"].number ?? 0
        switch json["kind"].string {
        case "required": return .required(label)
        case "chooseOne": return .chooseOne(label)
        case "number": return .number(label)
        case "integer": return .integer(label)
        case "minimum": return .minimum(label, limit)
        case "maximum": return .maximum(label, limit)
        case "minLength": return .minLength(label, Int(limit))
        case "maxLength": return .maxLength(label, Int(limit))
        case "email": return .email(label)
        case "uri": return .uri(label)
        case "dateTime": return .dateTime(label)
        default: return nil
        }
    }

    func testTheSharedCases() throws {
        let cases = try fixture()["cases"].array ?? []
        XCTAssertGreaterThan(cases.count, 5)
        for item in cases {
            let name = item["name"].string ?? "?"
            let expectedFields = item["fields"].array ?? []
            let order = expectedFields.compactMap { $0["name"].string }
            let fields = ElicitationForm.fields(schema: item["schema"], order: order)
            XCTAssertEqual(fields.map(\.name), order, name)
            for (index, expected) in expectedFields.enumerated() where index < fields.count {
                let field = fields[index], label = "\(name).\(field.name)"
                XCTAssertEqual(field.label, expected["label"].string, label)
                XCTAssertEqual(field.description, expected["description"].string, label)
                XCTAssertEqual(field.required, expected["required"].bool, label)
                let type: ElicitationForm.FieldType? = switch expected["type"].string {
                case "string": .string; case "number": .number; case "integer": .integer; case "boolean": .boolean
                case "enum": .choice; case "multi": .multi; default: nil }
                XCTAssertEqual(field.type, type, label)
                XCTAssertEqual(field.initial, value(expected["initial"]), label)
                if let options = expected["options"].array {
                    XCTAssertEqual(field.options.map { [$0.value, $0.label] }, options.map { ($0.array ?? []).compactMap(\.string) }, label)
                }
                for (key, actual) in [("format", field.format.map(JSONValue.string)),
                                      ("minimum", field.minimum.map(JSONValue.number)), ("maximum", field.maximum.map(JSONValue.number)),
                                      ("minLength", field.minLength.map { JSONValue.number(Double($0)) }),
                                      ("maxLength", field.maxLength.map { JSONValue.number(Double($0)) })] where expected[key] != .null || actual != nil {
                    XCTAssertEqual(actual ?? .null, expected[key], "\(label).\(key)")
                }
            }
            for attempt in item["attempts"].array ?? [] {
                var values: [String: ElicitationForm.Value] = [:]
                for (key, json) in attempt["values"].object ?? [:] { values[key] = value(json) }
                let result = ElicitationForm.content(fields, values: values)
                if attempt["problem"] != .null {
                    guard case .failure(let found) = result else { XCTFail("\(name): expected a problem for \(values)"); continue }
                    XCTAssertEqual(found, problem(attempt["problem"]), "\(name): \(values)")
                } else {
                    guard case .success(let content) = result else { XCTFail("\(name): unexpected \(result) for \(values)"); continue }
                    XCTAssertEqual(content, attempt["content"], "\(name): \(values)")
                }
            }
        }
    }

    func testFieldsKeepTheEnginesOrderAndTheRestSorted() {
        let schema: JSONValue = .object(["properties": .object(["b": .object([:]), "a": .object([:]), "c": .object([:])])])
        XCTAssertEqual(ElicitationForm.fields(schema: schema, order: ["c", "b", "gone"]).map(\.name), ["c", "b", "a"])
        XCTAssertEqual(ElicitationForm.fields(schema: schema).map(\.name), ["a", "b", "c"])
        XCTAssertTrue(ElicitationForm.fields(schema: .null).isEmpty)
    }

    func testNumbersPrintAsJavaScriptDoes() {
        XCTAssertEqual(ElicitationForm.format(3), "3")
        XCTAssertEqual(ElicitationForm.format(2.5), "2.5")
        XCTAssertEqual(ElicitationForm.format(-0.5), "-0.5")
    }
}
