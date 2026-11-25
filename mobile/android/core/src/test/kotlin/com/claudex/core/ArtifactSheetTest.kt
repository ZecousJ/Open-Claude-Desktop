package com.claudex.core

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ArtifactSheetTest {
    private fun file(path: String, digest: String?, content: String? = "x", blob: Boolean = false, state: String = "ready") =
        GeneratedFile("f-$digest", path.substringAfterLast('/'), state, digest = digest, content = content, blob = blob, language = "html", path = path)
    private fun turn(id: String, vararg files: GeneratedFile) = Turn(id, "p", items = listOf(Item("i-$id", "fileChange", generatedFiles = files.toList())))

    @Test fun oneVersionPerWriteOfTheFile() {
        val turns = listOf(
            turn("1", file("/w/a.html", "d1"), file("/w/b.html", "b1")),
            turn("2", file("/w/a.html", "d1")),
            turn("3", file("/w/a.html", "d2")),
            turn("4", file("/w/a.html", "d3", state = "pending"), file("/w/b.html", "b2")),
        )
        // A rewrite that changed nothing counts once; a file not ready yet is no version.
        assertEquals(listOf<String?>("d1", "d2"), ArtifactVersions.of(turns, "/w/a.html").map { it.digest })
        assertEquals(listOf<String?>("b1", "b2"), ArtifactVersions.of(turns, "/w/b.html").map { it.digest })
    }

    @Test fun aFileWithoutAPathOrAReadableSnapshotHasNoVersions() {
        assertEquals(0, ArtifactVersions.of(listOf(turn("1", file("", "d1"))), "").size)
        assertEquals(0, ArtifactVersions.of(listOf(turn("1", file("/a", "d1", content = null))), "/a").size)
        assertEquals(1, ArtifactVersions.of(listOf(turn("1", file("/a", "d1", content = null, blob = true))), "/a").size)
        assertEquals(0, ArtifactVersions.of(listOf(turn("1", file("/a", null, content = null, blob = true))), "/a").size)
    }

    @Test fun aTextArtifactBecomesTitleDotExtension() {
        assertEquals("Quarterly report.html", ArtifactProjectFile.name("Quarterly report", null, "html"))
        assertEquals("Logo.svg", ArtifactProjectFile.name("Logo", null, "svg"))
        assertEquals("Notes.md", ArtifactProjectFile.name("Notes", null, "markdown"))
        assertEquals("App.tsx", ArtifactProjectFile.name("App", null, "react"))
        assertEquals("Flow.mermaid", ArtifactProjectFile.name("Flow", null, "mermaid"))
        assertEquals("Run.py", ArtifactProjectFile.name("Run", null, "python"))
        assertEquals("Odd.txt", ArtifactProjectFile.name("Odd", null, "cobol"))
        assertEquals("notes.md", ArtifactProjectFile.name("notes.md", "notes.md", "text"))
        assertEquals("Plan v1.2.html", ArtifactProjectFile.name("Plan v1.2", null, "html"))
        assertEquals("Artifact.html", ArtifactProjectFile.name("  ", null, "html"))
    }

    @Test fun aBinaryArtifactCannotBeCopiedToAProject() {
        assertNull(ArtifactProjectFile.name("Photo", "photo.png", "", blob = true))
    }

    @Test fun aCommentIsTheWebsMessageWithTheSelectionQuoted() {
        val prompt = ArtifactComment.prompt("Plan \"A\"", " Make it shorter ", "line one\nline two", "/w/plan.md", "d9", "ignored")
        assertEquals("Comment on artifact \"Plan 'A'\":\n> line one\n> line two\n\nMake it shorter\n\nFile: /w/plan.md\nSnapshot: d9", prompt)
        // The web reads the card back with this pattern.
        val match = Regex("^Comment on artifact \"([^\"\n]*)\":\n([\\s\\S]*?)\n\n(?:File: |Artifact content:\n)").find(prompt)
        assertEquals("Plan 'A'", match?.groupValues?.get(1))
        assertEquals("> line one\n> line two\n\nMake it shorter", match?.groupValues?.get(2))
        assertEquals("Comment on artifact \"x\":\n> q\n\nc\n\nArtifact content:\nbody", ArtifactComment.prompt("x", "c", "q", null, null, "body"))
    }
}
