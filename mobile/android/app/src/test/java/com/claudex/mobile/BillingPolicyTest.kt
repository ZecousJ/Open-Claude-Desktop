package com.claudex.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BillingPolicyTest {
    @Test fun anAmountIsDollarsWithAtMostTwoDecimals() {
        assertEquals(20.0, BillingPolicy.parseAmount("20")!!, 0.0)
        assertEquals(20.5, BillingPolicy.parseAmount("$20.50")!!, 0.0)
        assertNull(BillingPolicy.parseAmount("20.555"))
        assertNull(BillingPolicy.parseAmount("100001"))
        assertEquals("$20", BillingPolicy.money(20.0, whole = true))
        assertEquals("$12.30", BillingPolicy.money(12.3))
    }

    @Test fun theSpendDocumentMustNameUsdAndARealReset() {
        val kept = BillingPolicy.spend(JSONObject("""{"limit_usd":20,"used_usd":1.5,"resets_at":"2026-12-01T00:00:00Z","currency":"USD"}"""))
        assertEquals(20.0, kept!!.limitUsd!!, 0.0)
        assertNull(BillingPolicy.spend(JSONObject("""{"limit_usd":null,"used_usd":1,"resets_at":"2026-12-01T00:00:00Z","currency":"EUR"}""")))
        assertNull(BillingPolicy.spend(JSONObject("""{"limit_usd":null,"used_usd":1,"resets_at":"tomorrow","currency":"USD"}""")))
        assertTrue(BillingPolicy.spend(JSONObject("""{"limit_usd":null,"used_usd":0,"resets_at":"2024-02-29T00:00:00Z","currency":"USD"}"""))!!.limitUsd == null)
        assertFalse(BillingPolicy.validReset("2025-02-29T00:00:00Z"))
    }

    @Test fun aRedeemCodeIsTheCharactersTheServiceIssued() {
        assertTrue(BillingPolicy.acceptsCode(" AB_12 "))
        assertFalse(BillingPolicy.acceptsCode("abc"))
        assertFalse(BillingPolicy.acceptsCode("../secret"))
        val redeemed = BillingPolicy.redeemed(JSONObject("""{"type":"balance","value":5,"validity_days":0}"""))
        assertEquals("balance", redeemed!!.type)
        assertEquals("missing", BillingPolicy.redeemProblem("REDEEM_CODE_NOT_FOUND"))
        assertNull(BillingPolicy.redeemProblem("OTHER"))
    }

    @Test fun cardCheckoutStaysOffUntilTheServiceServesIt() {
        val info = JSONObject("""{"methods":{"stripe":{"payment_type":"stripe","currency":"usd","single_min":1,"single_max":100},"alipay_direct":{"payment_type":"alipay_direct","currency":"CNY","single_min":10,"single_max":0}},"global_min":0,"global_max":0}""")
        assertEquals(listOf("alipay"), BillingPolicy.checkout(info, false)!!.methods.map { it.id })
        assertEquals(listOf("alipay", "stripe"), BillingPolicy.checkout(info, true)!!.methods.map { it.id })
        val alipay = BillingPolicy.checkout(info, false)!!.methods.first()
        assertEquals("low", BillingPolicy.amountProblem(5.0, alipay, 0.0, 0.0))
        assertNull(BillingPolicy.amountProblem(10.0, alipay, 0.0, 0.0))
    }

    @Test fun aPaymentPageMustBeHttpsAndASecretNeverJoinsTheUrl() {
        val page = JSONObject().put("pay_url", "http://pay.example/checkout")
        val refused = BillingPolicy.launch(page, false) as BillingPolicy.PayLaunch.Unavailable
        assertEquals("insecure", refused.reason)
        val opened = BillingPolicy.launch(JSONObject().put("pay_url", "https://pay.example/checkout"), false) as BillingPolicy.PayLaunch.Open
        assertEquals("https://pay.example/checkout", opened.url)
        val secret = BillingPolicy.launch(JSONObject().put("client_secret", "sekret").put("resume_token", "resume").put("order_id", 4), false) as BillingPolicy.PayLaunch.Unavailable
        assertEquals("desktop", secret.reason)
        val url = BillingPolicy.desktopPay("https://claudex.example", "abcdefghijklmnop")
        assertEquals("https://claudex.example/desktop-pay#t=abcdefghijklmnop", url)
        assertNull(BillingPolicy.desktopPay("http://claudex.example", "abcdefghijklmnop"))
    }
}
