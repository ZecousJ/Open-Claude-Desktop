package com.claudex.mobile

import org.json.JSONObject
import kotlin.test.Test
import kotlin.test.assertEquals

class KnowledgePolicyTest {
    @Test fun listIsChecked() {
        val response = JSONObject("""{"code":0,"data":{"bases":[{"id":"huaner-tech","name":"幻尔科技知识库","description":"手册","available":true},{"id":"Bad Id","name":"x"},{"id":"no-name","name":" "}]}}""")
        assertEquals(listOf(KnowledgeBase("huaner-tech", "幻尔科技知识库", "手册", true)), KnowledgePolicy.list(response))
        assertEquals(emptyList(), KnowledgePolicy.list(JSONObject("{}")))
    }
    @Test fun conversationBasesAndToggles() {
        assertEquals(listOf("huaner-tech"), KnowledgePolicy.of("""{"knowledgeBases":["huaner-tech","huaner-tech","../x"]}"""))
        assertEquals(emptyList(), KnowledgePolicy.of(null))
        assertEquals(listOf("huaner-tech"), KnowledgePolicy.toggled(emptyList(), "huaner-tech"))
        assertEquals(emptyList(), KnowledgePolicy.toggled(listOf("huaner-tech"), "huaner-tech"))
    }
}
