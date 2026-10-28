package com.claudex.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * The cases the web card, the iOS Core and this app all pass (`tests/fixtures/elicitation-form-cases.json`, read by
 * `tests/elicitation-form-cases.test.ts` and `ElicitationFormTests.swift` too).
 */
class ElicitationFormTest {
    private fun fixture() = JSONObject(File("../../../tests/fixtures/elicitation-form-cases.json").readText())

    private fun value(json: Any?): ElicitationForm.Value = when (json) {
        is Boolean -> ElicitationForm.Value.Flag(json)
        is JSONArray -> ElicitationForm.Value.Items((0 until json.length()).map { json.getString(it) })
        else -> ElicitationForm.Value.Text(json as? String ?: "")
    }

    private fun problem(json: JSONObject): ElicitationForm.Problem {
        val label = json.getString("label"); val limit = json.optDouble("limit", 0.0)
        return when (val kind = json.getString("kind")) {
            "required" -> ElicitationForm.Problem.Required(label)
            "chooseOne" -> ElicitationForm.Problem.ChooseOne(label)
            "number" -> ElicitationForm.Problem.Number(label)
            "integer" -> ElicitationForm.Problem.Integer(label)
            "minimum" -> ElicitationForm.Problem.Minimum(label, limit)
            "maximum" -> ElicitationForm.Problem.Maximum(label, limit)
            "minLength" -> ElicitationForm.Problem.MinLength(label, limit.toInt())
            "maxLength" -> ElicitationForm.Problem.MaxLength(label, limit.toInt())
            "email" -> ElicitationForm.Problem.Email(label)
            "uri" -> ElicitationForm.Problem.Uri(label)
            "dateTime" -> ElicitationForm.Problem.DateTime(label)
            else -> fail("unknown problem $kind")
        }
    }

    private fun sameJson(expected: Any?, actual: Any?, where: String) {
        when (expected) {
            is JSONObject -> {
                val found = actual as? JSONObject ?: fail("$where: not an object")
                assertEquals(expected.keys().asSequence().toSet(), found.keys().asSequence().toSet(), where)
                expected.keys().forEach { sameJson(expected.get(it), found.get(it), "$where.$it") }
            }
            is JSONArray -> {
                val found = actual as? JSONArray ?: fail("$where: not an array")
                assertEquals(expected.length(), found.length(), where)
                (0 until expected.length()).forEach { sameJson(expected.get(it), found.get(it), "$where[$it]") }
            }
            is Number -> assertEquals(expected.toDouble(), (actual as Number).toDouble(), 0.0, where)
            else -> assertEquals(expected, actual, where)
        }
    }

    @Test fun theSharedCases() {
        val cases = fixture().getJSONArray("cases")
        assertTrue(cases.length() > 5)
        for (index in 0 until cases.length()) {
            val item = cases.getJSONObject(index); val name = item.getString("name")
            val expectedFields = item.getJSONArray("fields")
            val order = (0 until expectedFields.length()).map { expectedFields.getJSONObject(it).getString("name") }
            val fields = ElicitationForm.fields(item.getJSONObject("schema"), order)
            assertEquals(order, fields.map { it.name }, name)
            for (position in order.indices) {
                val expected = expectedFields.getJSONObject(position); val field = fields[position]; val label = "$name.${field.name}"
                assertEquals(expected.getString("label"), field.label, label)
                assertEquals(expected.optString("description").takeIf { expected.has("description") }, field.description, label)
                assertEquals(expected.getBoolean("required"), field.required, label)
                val type = when (expected.getString("type")) {
                    "string" -> ElicitationForm.FieldType.Text; "number" -> ElicitationForm.FieldType.Number; "integer" -> ElicitationForm.FieldType.Integer
                    "boolean" -> ElicitationForm.FieldType.Boolean; "enum" -> ElicitationForm.FieldType.Choice; "multi" -> ElicitationForm.FieldType.Multi
                    else -> fail("unknown type")
                }
                assertEquals(type, field.type, label)
                assertEquals(value(expected.get("initial")), field.initial, label)
                expected.optJSONArray("options")?.let { options ->
                    assertEquals((0 until options.length()).map { options.getJSONArray(it).let { pair -> listOf(pair.getString(0), pair.getString(1)) } },
                        field.options.map { listOf(it.value, it.label) }, label)
                }
                assertEquals(expected.optString("format").takeIf { expected.has("format") }, field.format, label)
                assertEquals(expected.optDouble("minimum").takeIf { expected.has("minimum") }, field.minimum, label)
                assertEquals(expected.optDouble("maximum").takeIf { expected.has("maximum") }, field.maximum, label)
                assertEquals(expected.optInt("minLength").takeIf { expected.has("minLength") }, field.minLength, label)
                assertEquals(expected.optInt("maxLength").takeIf { expected.has("maxLength") }, field.maxLength, label)
            }
            val attempts = item.getJSONArray("attempts")
            for (attemptIndex in 0 until attempts.length()) {
                val attempt = attempts.getJSONObject(attemptIndex)
                val typed = attempt.getJSONObject("values")
                val values = typed.keys().asSequence().associateWith { value(typed.get(it)) }
                val result = ElicitationForm.content(fields, values)
                if (attempt.has("problem")) {
                    val invalid = result as? ElicitationForm.Result.Invalid ?: fail("$name: expected a problem for $typed")
                    assertEquals(problem(attempt.getJSONObject("problem")), invalid.problem, "$name: $typed")
                } else {
                    val content = result as? ElicitationForm.Result.Content ?: fail("$name: unexpected $result for $typed")
                    sameJson(attempt.getJSONObject("content"), content.content, "$name: $typed")
                }
            }
        }
    }

    @Test fun fieldsKeepTheEnginesOrderAndTheRestSorted() {
        val schema = JSONObject("""{"properties":{"b":{},"a":{},"c":{}}}""")
        assertEquals(listOf("c", "b", "a"), ElicitationForm.fields(schema, listOf("c", "b", "gone")).map { it.name })
        assertEquals(listOf("a", "b", "c"), ElicitationForm.fields(schema).map { it.name })
        assertTrue(ElicitationForm.fields(null).isEmpty())
        assertNotNull(ElicitationForm.fields(schema).firstOrNull())
    }

    @Test fun numbersPrintAsJavaScriptDoes() {
        assertEquals("3", ElicitationForm.format(3.0)); assertEquals("2.5", ElicitationForm.format(2.5)); assertEquals("-0.5", ElicitationForm.format(-0.5))
    }
}
