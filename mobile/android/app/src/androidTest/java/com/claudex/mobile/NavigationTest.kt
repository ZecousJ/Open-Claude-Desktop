package com.claudex.mobile

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Compiled for the FINAL redesign. Execution requires a functioning emulator/device. */
class NavigationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun openSidebar() { compose.onNodeWithContentDescription("打开侧边栏").performClick() }
    private fun navigate(label: String) { openSidebar(); compose.onNode(hasText(label) and hasClickAction()).performClick() }

    @Test fun sidebarReachesAllPrimaryDestinations() {
        assumeTrue(BuildConfig.DEMO_MODE)
        compose.onNodeWithText("今天想探索什么？").assertIsDisplayed()
        navigate("项目"); compose.onNodeWithText("搜索项目").assertExists()
        navigate("代码"); compose.onNodeWithText("在云端工作区中执行任务").assertExists()
        navigate("资料库"); compose.onNodeWithText("对话中创建的内容").assertExists()
        navigate("协作"); compose.onNodeWithText("一起完成工作").assertExists()
    }
    @Test fun sidebarCloseKeepsComposerDraft() {
        assumeTrue(BuildConfig.DEMO_MODE)
        compose.onNodeWithContentDescription("消息输入框").performTextInput("关闭后保留")
        openSidebar(); compose.onNodeWithContentDescription("关闭侧边栏").performClick()
        compose.onNodeWithText("关闭后保留").assertExists()
    }
    @Test fun historyOpensExistingConversation() {
        assumeTrue(BuildConfig.DEMO_MODE)
        openSidebar(); compose.onNode(hasText("移动端体验方案") and hasClickAction()).performClick()
        compose.onNodeWithText("先把三件事做好", substring = true).assertExists()
        openSidebar(); compose.onNodeWithText("搜索对话").assertExists()
    }
    @Test fun modelSheetDismissalKeepsDraft() {
        assumeTrue(BuildConfig.DEMO_MODE)
        compose.onNodeWithContentDescription("消息输入框").performTextInput("保留这条草稿")
        compose.onNodeWithContentDescription("选择模型与推理强度").performClick()
        compose.onNodeWithText("选择模型").assertIsDisplayed()
        compose.onNodeWithContentDescription("关闭选择模型").performClick()
        compose.onNodeWithText("保留这条草稿").assertExists()
    }
    @Test fun attachmentCancelDoesNotSend() {
        assumeTrue(BuildConfig.DEMO_MODE)
        compose.onNodeWithContentDescription("消息输入框").performTextInput("附件取消后保留")
        compose.onNodeWithContentDescription("添加附件").performClick()
        compose.onNodeWithText("选择文件").assertExists()
        compose.onNodeWithText("照片图库").assertExists()
        compose.onNodeWithContentDescription("关闭添加附件").performClick()
        compose.onNodeWithText("附件取消后保留").assertExists()
    }
    @Test fun settingsAreReachedFromSidebarAccount() {
        assumeTrue(BuildConfig.DEMO_MODE)
        openSidebar(); compose.onNodeWithContentDescription("设置").performClick()
        compose.onNodeWithText("自定义指令").assertExists()
        compose.onNodeWithText("套餐与用量").performClick()
        compose.onNodeWithText("示例套餐").assertExists()
    }
    @Test fun projectEditorCancelPreservesProjectList() {
        assumeTrue(BuildConfig.DEMO_MODE)
        navigate("项目")
        compose.onNodeWithContentDescription("新建项目").performClick()
        compose.onNodeWithText("项目名称").performTextInput("不应创建")
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("不应创建").assertDoesNotExist()
        compose.onNodeWithText("Claudex 移动体验").assertExists()
    }
    @Test fun replyEditCancelAndProjectDeleteCancelPreserveData() {
        assumeTrue(BuildConfig.DEMO_MODE)
        openSidebar(); compose.onNode(hasText("移动端体验方案") and hasClickAction()).performClick()
        compose.onNodeWithContentDescription("编辑提问").performScrollTo().performClick()
        compose.onNodeWithText("提问内容").performTextReplacement("Cancelled edit")
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("Cancelled edit").assertDoesNotExist()
        navigate("项目"); compose.onNode(hasText("Claudex 移动体验") and hasClickAction()).performClick()
        compose.onNodeWithContentDescription("删除项目").performClick()
        compose.onNodeWithText("删除项目？").assertExists()
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithText("Claudex 移动体验").assertExists()
    }
    @Test fun serverManagementInDemoCannotMutateRealAccount() {
        assumeTrue(BuildConfig.DEMO_MODE)
        openSidebar(); compose.onNodeWithContentDescription("设置").performClick()
        compose.onNodeWithText("记忆").performScrollTo().performClick()
        compose.onNodeWithText("本地演示不读取或更改账户记忆；此功能需要真实账户").assertExists()
        compose.onNode(hasText("编辑") and hasClickAction()).assertIsNotEnabled()
    }
}
