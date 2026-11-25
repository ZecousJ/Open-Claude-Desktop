package com.claudex.mobile

import com.claudex.core.Mode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AppLinkTest {
    @Test fun aChatLinkOpensThatConversation() {
        assertEquals(AppLink.Chat("abc_1"), AppLinks.parse("claudex://chat/abc_1"))
        assertEquals(AppLink.Chat("abc_1"), AppLinks.parse("https://claudex.zecous.cn/conversation/abc_1"))
        assertEquals(AppLink.Chat("abc_1"), AppLinks.parse("claudex://claude.ai/chat/abc_1"))
        assertNull(AppLinks.parse("https://claude.ai/chat/abc_1"))
        assertNull(AppLinks.parse("claudex://chat/../secret"))
    }

    @Test fun aNewLinkOnlyFillsTheComposer() {
        assertEquals(AppLink.Composer(Mode.CHAT, "hello"), AppLinks.parse("claudex://new?q=hello"))
        assertEquals(AppLink.Composer(Mode.COWORK, "plan"), AppLinks.parse("https://claudex.zecous.cn/cowork/new?q=plan"))
        assertEquals(AppLink.Composer(Mode.CODE, null), AppLinks.parse("claudex://code/new"))
        assertNull(AppLinks.parse("claudex://code/new?ssh_host=example"))
        assertEquals(AppLink.Project("proj_1"), AppLinks.parse("claudex://project/proj_1"))
        assertEquals(AppLink.Chat("sess_1"), AppLinks.parse("claudex://code/continue?session=sess_1"))
    }
}
