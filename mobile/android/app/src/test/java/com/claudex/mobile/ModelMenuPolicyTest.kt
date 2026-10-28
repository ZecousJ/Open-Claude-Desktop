package com.claudex.mobile

import com.claudex.core.ModelOption
import org.json.JSONObject
import kotlin.test.*

class ModelMenuPolicyTest {
    private fun provider(id: String, vararg models: String) = JSONObject().put("id", id).put("models", org.json.JSONArray(models.toList()))
    @Test fun catalogPreservesAllMainRowsAndPromotesCurrentMoreChoice() {
        val models = (0..5).map { ModelOption("gpt-$it", "GPT $it", "", "service", catalogued = true, inMore = it == 5, sort = it) }
        val choices = ModelMenuPolicy.choices(models, models.last())
        assertEquals(listOf("gpt-5", "gpt-0", "gpt-1", "gpt-2", "gpt-3", "gpt-4"), choices.quick.map { it.id })
        assertTrue(choices.more.isEmpty())
    }
    @Test fun catalogNamesPlacementEffortsAndProviderIdentitySurviveParsing() {
        val catalog = JSONObject("""{"items":[{"id":"deepseek-v4-flash","displayName":"DeepSeek V4 Flash","sort":2,"hidden":false,"efforts":["low","medium"],"defaultEffort":"medium"},{"id":"gpt-snapshot","displayName":"","sort":1,"hidden":true}]}""")
        val models = ModelMenuPolicy.models(listOf(provider("group-a", "deepseek-v4-flash"), provider("group-b", "gpt-snapshot", "uncatalogued")), catalog)
        assertEquals("gpt-snapshot", models.first().name)
        val deepseek = models.first { it.id == "deepseek-v4-flash" }
        assertEquals("DeepSeek V4 Flash", deepseek.name)
        assertEquals("group-a", deepseek.providerId)
        assertEquals(listOf("low", "medium"), deepseek.efforts)
        assertEquals("medium", deepseek.defaultEffort)
        assertEquals(listOf("gpt-snapshot", "uncatalogued"), ModelMenuPolicy.choices(models, deepseek).more.map { it.id })
    }
    @Test fun fallbackOffersEffortsAndDefaultModelAndExcludesDrawingModels() {
        val p = provider("service", "gpt-a", "gpt-image-1").put("model", "qwen-a")
        val models = ModelMenuPolicy.models(listOf(p), null)
        assertEquals(listOf("qwen-a", "gpt-a"), models.map { it.id })
        assertEquals(ModelMenuPolicy.efforts, models.first().efforts)
    }
    @Test fun vendorSwitchUsesOnlyAvailableMakersAndAcceptsNamespacedIds() {
        assertEquals("openai", ModelMenuPolicy.vendor("service/gpt-6.1-sol").id)
        assertEquals("xai", ModelMenuPolicy.vendor("composer-2").id)
        assertEquals("deepseek", ModelMenuPolicy.vendor("deepseek-v4-flash").id)
        assertEquals("other", ModelMenuPolicy.vendor("unknown").id)
    }
}
