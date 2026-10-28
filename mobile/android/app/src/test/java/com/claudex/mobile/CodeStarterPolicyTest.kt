package com.claudex.mobile

import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CodeStarterPolicyTest {
    @Test fun suggestionsAreTheOfficialThree() {
        assertEquals(listOf("space-invaders", "flashcard-study", "todo-list"), CodeStarterPolicy.suggestions.map { it.id })
        assertEquals(listOf("🎮", "💬", "📝"), CodeStarterPolicy.suggestions.map { it.emoji })
        assertTrue(CodeStarterPolicy.suggestions.all { it.prompt.contains("index.html") })
    }

    @Test fun choosingMovesTheDraftButKeepsTypedText() {
        val first = CodeStarterPolicy.suggestions[0]
        val second = CodeStarterPolicy.suggestions[1]
        assertEquals(first.id, CodeStarterPolicy.next(null, first.id))
        assertNull(CodeStarterPolicy.next(first.id, first.id))
        assertEquals(first.prompt, CodeStarterPolicy.draftAfter("", first.id))
        assertEquals(second.prompt, CodeStarterPolicy.draftAfter(first.prompt, second.id))
        assertEquals("", CodeStarterPolicy.draftAfter(second.prompt, CodeStarterPolicy.OTHER))
        assertEquals("", CodeStarterPolicy.draftAfter(first.prompt, null))
        assertEquals("my own idea", CodeStarterPolicy.draftAfter("my own idea", first.id))
    }

    @Test fun startNeedsAChoiceAndAPrompt() {
        assertFalse(CodeStarterPolicy.canStart("build it", null))
        assertFalse(CodeStarterPolicy.canStart("  ", CodeStarterPolicy.OTHER))
        assertTrue(CodeStarterPolicy.canStart("build it", CodeStarterPolicy.OTHER))
    }

    @Test fun deviceDirectoriesAndModelsParse() {
        val directory = DeviceDirectory.from(JSONObject("""{"path":"/work/app","name":"app","sessions":2,"default":true}"""))
        assertEquals(DeviceDirectory("/work/app", "app", 2, true), directory)
        val models = DeviceModels.from(JSONObject("""{"models":[{"providerId":"p1","id":"gpt-5.5"},{"providerId":"p1","id":"mini"}],"default":{"providerId":"p1","id":"gpt-5.5"}}"""))
        assertEquals(2, models.models.size)
        assertEquals(DeviceModelOption("p1", "gpt-5.5"), models.default)
        assertNull(DeviceModels.from(JSONObject("""{"models":[]}""")).default)
        assertEquals(R.string.claudex_msg_folder_not_added, DeviceClient.messageRes(null, "This folder isn't added for your phone. Add it in Settings on the computer."))
    }
}
