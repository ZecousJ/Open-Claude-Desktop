package com.claudex.mobile

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ImageModelPolicyTest {
    @Test fun existingRunnerContractUsesSingleModelArgument() = runTest {
        val methods = mutableListOf<String>()
        val api = ManagementApi { method, args -> methods += method; assertEquals(listOf("gpt-image-2.5"), args.toList()); JSONObject().put("images", JSONObject().put("selected", args[0])) }
        assertEquals("gpt-image-2.5", api.setImageModel("gpt-image-2.5").getJSONObject("images").getString("selected"))
        for (model in listOf("", "bad model", "m".repeat(201))) try { api.setImageModel(model); fail() } catch (_: IllegalArgumentException) {}
        assertEquals(listOf("setImageModel"), methods)
    }
    @Test fun selectorRequiresActuallyOfferedModelAndMissingMetadataIsEmpty() {
        val groups = JSONObject("""{"images":{"models":[{"id":"offered","name":"Fixture"},{"id":"bad model"}]}}""")
        assertEquals(1, ImageModelPolicy.choices(groups).size)
        ImageModelPolicy.requireOffered(groups, "offered")
        try { ImageModelPolicy.requireOffered(groups, "other"); fail() } catch (_: IllegalArgumentException) {}
        assertTrue(ImageModelPolicy.choices(null).isEmpty())
    }
}
