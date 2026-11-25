package com.claudex.mobile

import android.os.SystemClock
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FirstSendDraftTest {
    @Test fun firstSendKeepsFollowupDraftWhenAcknowledged() {
        assumeTrue(BuildConfig.DEMO_MODE)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var vm: AppViewModel
            scenario.onActivity {
                vm = ViewModelProvider(it)[AppViewModel::class.java]
                vm.draft.value = "首轮中文消息"
                vm.send(null, pending = {}) {}
                vm.draft.value = "等待回包时输入的追问"
            }
            val deadline = SystemClock.elapsedRealtime() + 10_000
            while (vm.pendingSend.value?.resultId == null && SystemClock.elapsedRealtime() < deadline) {
                SystemClock.sleep(50)
            }
            assertTrue(vm.pendingSend.value?.resultId != null)
            scenario.onActivity {
                vm.switchDraft(requireNotNull(vm.pendingSend.value?.resultId), null)
                assertEquals("等待回包时输入的追问", vm.draft.value)
                vm.switchDraft(null, null)
                assertEquals("", vm.draft.value)
            }
        }
    }
    @Test fun rejectedFirstSendKeepsDraftForManualRetry() {
        assumeTrue(BuildConfig.DEMO_MODE)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var vm: AppViewModel
            val prompt = "首发失败后保留的中文草稿"
            var initialIds = emptySet<String>()
            scenario.onActivity {
                vm = ViewModelProvider(it)[AppViewModel::class.java]
                initialIds = vm.snapshot.value.conversations.map { chat -> chat.id }.toSet()
                vm.draft.value = " \n "
                vm.send(null, pending = {}) {}
                assertEquals(null, vm.pendingSend.value)
                (vm.repository as com.claudex.core.DemoRepository).failNextSend = true
                vm.draft.value = prompt
                vm.send(null, pending = {}) {}
            }
            val rejectedBy = SystemClock.elapsedRealtime() + 10_000
            while (vm.busy.value && SystemClock.elapsedRealtime() < rejectedBy) SystemClock.sleep(50)
            scenario.onActivity {
                assertTrue(vm.pendingSend.value?.failure != null)
                assertEquals(initialIds, vm.snapshot.value.conversations.map { chat -> chat.id }.toSet())
                assertEquals(prompt, vm.draft.value)
                vm.send(null, pending = {}) {}
            }
            val confirmedBy = SystemClock.elapsedRealtime() + 10_000
            while (vm.busy.value && SystemClock.elapsedRealtime() < confirmedBy) SystemClock.sleep(50)
            val chat = vm.snapshot.value.conversations.single { it.id !in initialIds }
            assertEquals(prompt, chat.turns.single().prompt)
            assertEquals(chat.id, vm.pendingSend.value?.resultId)
        }
    }

}
