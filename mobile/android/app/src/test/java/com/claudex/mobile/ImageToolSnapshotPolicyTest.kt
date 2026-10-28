package com.claudex.mobile

import com.claudex.core.Item
import com.claudex.core.Conversation
import com.claudex.core.Turn
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ImageToolSnapshotPolicyTest {
    private val digest = "a".repeat(64)
    @Test fun historicalImageToolProducesCanonicalDescriptorForItsOwnEntry() {
        val item = Item("synthetic-item", "imageGeneration", rawJson = JSONObject().put("savedPath", "synthetic/picture.png").toString())
        val request = ImageToolSnapshotPolicy.request(item)!!
        val file = ImageToolSnapshotPolicy.descriptor(request, JSONObject().put("digest", digest).put("mime", "image/png").put("bytes", 123))!!
        assertEquals("image-tool:synthetic-item:$digest", file.id)
        assertEquals(request.path, file.path)
        assertEquals("image/png", file.mime)
        assertTrue(file.blob)
        assertFalse(ImageToolSnapshotPolicy.matches(item.copy(rawJson = JSONObject().put("savedPath", "other.png").toString()), request))
    }
    @Test fun aPictureLargerThanAnInlineThumbnailIsAdmitted() {
        val request = ImageToolRequest("synthetic", "image.png", false)
        assertNotNull(ImageToolSnapshotPolicy.descriptor(request, JSONObject().put("digest", digest).put("mime", "image/png").put("bytes", 2_573_330)))
    }
    @Test fun unsupportedOrOversizedSnapshotsAreNotAdmitted() {
        val request = ImageToolRequest("synthetic", "image.png", false)
        for (raw in listOf(JSONObject().put("digest", digest).put("mime", "image/svg+xml").put("bytes", 10), JSONObject().put("digest", digest).put("mime", "image/png").put("bytes", 64 * 1024 * 1024 + 1), JSONObject().put("digest", "bad").put("mime", "image/png").put("bytes", 10)))
            assertNull(ImageToolSnapshotPolicy.descriptor(request, raw))
    }
    @Test fun ordinaryTurnUpdatesRetainOnlyMatchingCapturedDescriptors() {
        val item = Item("synthetic-item", "imageGeneration", rawJson = JSONObject().put("savedPath", "image.png").toString())
        val file = ImageToolSnapshotPolicy.descriptor(ImageToolSnapshotPolicy.request(item)!!, JSONObject().put("digest", digest).put("mime", "image/png").put("bytes", 10))!!
        fun c(i: Item) = Conversation("c", "synthetic", providerId = "synthetic", model = "synthetic", turns = listOf(Turn("t", "test", items = listOf(i))))
        val before = c(item.copy(generatedFiles = listOf(file)))
        assertEquals(listOf(file), ImageToolSnapshotPolicy.retainCapturedImages(before, c(item)).turns[0].items[0].generatedFiles)
        val changed = item.copy(rawJson = JSONObject().put("savedPath", "other.png").toString())
        assertTrue(ImageToolSnapshotPolicy.retainCapturedImages(before, c(changed)).turns[0].items[0].generatedFiles.isEmpty())
        val authoritative = file.copy(id = "server", digest = "b".repeat(64))
        assertEquals(listOf(authoritative), ImageToolSnapshotPolicy.retainCapturedImages(before, c(item.copy(generatedFiles = listOf(authoritative)))).turns[0].items[0].generatedFiles)
    }
}
