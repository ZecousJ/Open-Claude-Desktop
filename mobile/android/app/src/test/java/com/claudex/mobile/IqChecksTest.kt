package com.claudex.mobile

import kotlin.test.Test
import kotlin.test.assertTrue

class IqChecksTest {
    @Test fun thePolicyGoesFirst() {
        val page = iqPage("<!DOCTYPE html><html><head lang=\"zh\"><title>x</title></head><body><svg/></body></html>")
        assertTrue(page.startsWith("<!DOCTYPE html><html><head lang=\"zh\"><meta http-equiv=\"Content-Security-Policy\""))
        assertTrue(page.contains("default-src 'none'"))
        val bare = iqPage("<svg/>")
        assertTrue(bare.startsWith("<meta http-equiv=\"Content-Security-Policy\"") && bare.endsWith("<svg/>"))
    }
}
