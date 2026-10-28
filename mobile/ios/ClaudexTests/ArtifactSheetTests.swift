import Foundation
import XCTest
#if SWIFT_PACKAGE
@testable import ClaudexCore
#else
@testable import Claudex
#endif

final class ArtifactSheetTests: XCTestCase {
    private func file(_ path: String, _ digest: String?, content: String? = "x", blob: Bool = false, state: String = "ready") -> JSONValue {
        var fields: [String: JSONValue] = ["id": .string("f-\(digest ?? "none")"), "name": .string((path as NSString).lastPathComponent), "path": .string(path),
                                           "language": .string("html"), "state": .string(state), "blob": .bool(blob)]
        if let digest { fields["digest"] = .string(digest) }
        if let content { fields["content"] = .string(content) }
        return .object(fields)
    }
    private func turn(_ id: String, _ files: JSONValue...) throws -> Turn {
        try JSONValue.object(["id": .string(id), "prompt": .string("p"), "attachments": .array([]), "status": .string("completed"), "createdAt": .number(1),
                              "items": .array([.object(["id": .string("i-\(id)"), "type": .string("commandExecution"), "generatedFiles": .array(files)])])]).decode(Turn.self)
    }

    func testOneVersionPerWriteOfTheFile() throws {
        let turns = [
            try turn("1", file("/w/a.html", "d1"), file("/w/b.html", "b1")),
            try turn("2", file("/w/a.html", "d1")),
            try turn("3", file("/w/a.html", "d2")),
            try turn("4", file("/w/a.html", "d3", state: "pending"), file("/w/b.html", "b2")),
        ]
        // A rewrite that changed nothing counts once; a file not ready yet is no version.
        XCTAssertEqual(ArtifactVersions.of(turns: turns, path: "/w/a.html").map(\.digest), ["d1", "d2"])
        XCTAssertEqual(ArtifactVersions.of(turns: turns, path: "/w/b.html").map(\.digest), ["b1", "b2"])
    }

    func testAFileWithoutAPathOrAReadableSnapshotHasNoVersions() throws {
        XCTAssertTrue(ArtifactVersions.of(turns: [try turn("1", file("", "d1"))], path: "").isEmpty)
        XCTAssertTrue(ArtifactVersions.of(turns: [try turn("1", file("/a", "d1", content: nil))], path: "/a").isEmpty)
        XCTAssertEqual(ArtifactVersions.of(turns: [try turn("1", file("/a", "d1", content: nil, blob: true))], path: "/a").count, 1)
        XCTAssertTrue(ArtifactVersions.of(turns: [try turn("1", file("/a", nil, content: nil, blob: true))], path: "/a").isEmpty)
    }

    func testATextArtifactBecomesTitleDotExtension() {
        XCTAssertEqual(ArtifactProjectFile.name(title: "Quarterly report", filename: nil, language: "html"), "Quarterly report.html")
        XCTAssertEqual(ArtifactProjectFile.name(title: "Logo", filename: nil, language: "svg"), "Logo.svg")
        XCTAssertEqual(ArtifactProjectFile.name(title: "Notes", filename: nil, language: "markdown"), "Notes.md")
        XCTAssertEqual(ArtifactProjectFile.name(title: "App", filename: nil, language: "react"), "App.tsx")
        XCTAssertEqual(ArtifactProjectFile.name(title: "Flow", filename: nil, language: "mermaid"), "Flow.mermaid")
        XCTAssertEqual(ArtifactProjectFile.name(title: "Run", filename: nil, language: "python"), "Run.py")
        XCTAssertEqual(ArtifactProjectFile.name(title: "Odd", filename: nil, language: "cobol"), "Odd.txt")
        XCTAssertEqual(ArtifactProjectFile.name(title: "notes.md", filename: "notes.md", language: "text"), "notes.md")
        XCTAssertEqual(ArtifactProjectFile.name(title: "Plan v1.2", filename: nil, language: "html"), "Plan v1.2.html")
        XCTAssertEqual(ArtifactProjectFile.name(title: "  ", filename: nil, language: "html"), "Artifact.html")
        XCTAssertNil(ArtifactProjectFile.name(title: "Photo", filename: "photo.png", language: "", blob: true))
    }

    func testACommentIsTheWebsMessageWithTheSelectionQuoted() throws {
        let prompt = ArtifactComment.prompt(name: "Plan \"A\"", comment: " Make it shorter ", selection: "line one\nline two", path: "/w/plan.md", digest: "d9", content: "ignored")
        XCTAssertEqual(prompt, "Comment on artifact \"Plan 'A'\":\n> line one\n> line two\n\nMake it shorter\n\nFile: /w/plan.md\nSnapshot: d9")
        // The web reads the card back with this pattern.
        let pattern = try NSRegularExpression(pattern: "^Comment on artifact \"([^\"\\n]*)\":\\n([\\s\\S]*?)\\n\\n(?:File: |Artifact content:\\n)")
        let match = try XCTUnwrap(pattern.firstMatch(in: prompt, range: NSRange(prompt.startIndex..., in: prompt)))
        XCTAssertEqual((prompt as NSString).substring(with: match.range(at: 1)), "Plan 'A'")
        XCTAssertEqual((prompt as NSString).substring(with: match.range(at: 2)), "> line one\n> line two\n\nMake it shorter")
        XCTAssertEqual(ArtifactComment.prompt(name: "x", comment: "c", selection: "q", path: nil, digest: nil, content: "body"), "Comment on artifact \"x\":\n> q\n\nc\n\nArtifact content:\nbody")
    }
}
