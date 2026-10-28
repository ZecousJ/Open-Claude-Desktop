package com.claudex.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.*
import kotlinx.coroutines.launch

class MainActivity: ComponentActivity() {
    private val model: AppViewModel by viewModels {
        (application as? AppViewModelFactoryOwner)?.appViewModelFactory
            ?: defaultViewModelProviderFactory
    }
    /** Simplified Chinese is the app's default language; a per-app language chosen in Android settings
     *  (API 33+, res/xml/locales_config.xml) wins. Official copy stays in values/ (English). */
    override fun attachBaseContext(newBase: android.content.Context) {
        val chosen = if (android.os.Build.VERSION.SDK_INT >= 33)
            newBase.getSystemService(android.app.LocaleManager::class.java)?.applicationLocales?.isEmpty == false else false
        if (chosen) { super.attachBaseContext(newBase); return }
        val config = android.content.res.Configuration(newBase.resources.configuration)
        config.setLocale(java.util.Locale.SIMPLIFIED_CHINESE)
        // Dates and numbers formatted outside Compose (DateFormat, String.format) follow the app language too.
        java.util.Locale.setDefault(java.util.Locale.SIMPLIFIED_CHINESE)
        super.attachBaseContext(newBase.createConfigurationContext(config))
    }
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); UserText.install(this); enableEdgeToEdge(); setContent { ClaudexApp(model) } }
    override fun onStop() { super.onStop(); model.onBackground() }
    override fun onStart() { super.onStart(); model.onForeground() }
}
internal val LocalOpenSidebar = staticCompositionLocalOf<() -> Unit> { {} }
@Composable fun ClaudexApp(vm: AppViewModel) {
    val setting by vm.theme.collectAsStateWithLifecycle()
    val dark = setting == "dark" || (setting == "system" && isSystemInDarkTheme())
    val view = androidx.compose.ui.platform.LocalView.current
    SideEffect { (view.context as? android.app.Activity)?.window?.let { window -> androidx.core.view.WindowCompat.getInsetsController(window, view).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark } } }
    ClaudexTheme(dark) {
        val c = Claude.colors
        val nav = rememberNavController()
        val signedIn by vm.signedIn.collectAsStateWithLifecycle()
        val initialRoute = remember { if (BuildConfig.DEMO_MODE || vm.signedIn.value) "home" else "login" }
        val entry by nav.currentBackStackEntryAsState()
        val route = entry?.destination?.route ?: "home"
        val chatRoute = route in setOf("home", "conversation/{id}", "sending/{id}")
        var selectedChat by remember { mutableStateOf<String?>(null) }
        val currentChat = if (chatRoute) { if (route == "conversation/{id}") entry?.arguments?.getString("id") else null } else selectedChat
        SideEffect { if (chatRoute) selectedChat = currentChat }
        // NavHost installs its graph after the initial composition. Auth can emit before that;
        // wait for a real entry rather than reading nav.graph from the first signed-out effect.
        LaunchedEffect(signedIn, entry != null, vm.api.sessionGeneration) {
            if (!BuildConfig.DEMO_MODE && !signedIn && entry != null && route !in listOf("login", "verify")) {
                nav.navigate("login") { popUpTo(nav.graph.id) { inclusive = true }; launchSingleTop = true }
            }
        }
        val drawer = rememberDrawerState(DrawerValue.Closed)
        val scope = rememberCoroutineScope()
        val authentication = route in listOf("login", "verify")
        LaunchedEffect(authentication) { if (authentication) drawer.close() }
        fun firstSendReplacement(from: String?, to: String?) =
            (from == "home" && to == "sending/{id}") ||
            (from == "sending/{id}" && to == "conversation/{id}")
        // In-app update: checked once a launch; a newer APK is offered in a dialog.
        val appContext = androidx.compose.ui.platform.LocalContext.current.applicationContext
        val updater = remember { AppUpdater(appContext, vm.api) }
        LaunchedEffect(Unit) { updater.check() }
        val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
        androidx.compose.runtime.DisposableEffect(lifecycle) {
            val observer = androidx.lifecycle.LifecycleEventObserver { _, event -> if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) updater.resume() }
            lifecycle.addObserver(observer); onDispose { lifecycle.removeObserver(observer) }
        }
        val updateMessage by updater.message.collectAsStateWithLifecycle()
        val updateText = updateMessage?.let { androidx.compose.ui.res.stringResource(it) }
        LaunchedEffect(updateText) { updateText?.let { vm.error.value = it; updater.message.value = null } }
        AppUpdateDialog(updater)
        val snack = remember { SnackbarHostState() }
        val error by vm.error.collectAsStateWithLifecycle()
        LaunchedEffect(error) { error?.let { snack.showSnackbar(it, duration = SnackbarDuration.Long); vm.error.value = null } }
        CompositionLocalProvider(LocalOpenSidebar provides { if (!authentication) scope.launch { drawer.open() } }, LocalAppUpdater provides updater) {
        // Official drawer: opened only from the menu button; once open it can be swiped closed; 32
        // % black scrim; bg-200 sheet 240–360 dp with 16 dp end corners.
        ModalNavigationDrawer(
            drawerState = drawer, gesturesEnabled = !authentication && drawer.isOpen, scrimColor = Color.Black.copy(alpha = .32f),
            drawerContent = {
                ModalDrawerSheet(drawerContainerColor = c.bg200, drawerContentColor = c.text300, drawerTonalElevation = 0.dp,
                    drawerShape = RoundedCornerShape(topEnd = 16.dp, bottomEnd = 16.dp),
                    modifier = Modifier.widthIn(min = 240.dp, max = 360.dp).fillMaxHeight(), windowInsets = WindowInsets(0, 0, 0, 0)) {
                    SidebarContent(vm, nav, route) { scope.launch { drawer.close() } }
                }
            }
        ) {
        Scaffold(containerColor = c.bg100, contentColor = c.text100, snackbarHost = { ClaudeSnackbarHost(snack) }) { padding ->
            Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            if (chatRoute || route == "history" || route in sheetRoutes)
                ChatSurface(vm, nav, currentChat, active = chatRoute)
            NavHost(nav, startDestination = initialRoute, modifier = Modifier.fillMaxSize(),
                // First-send stages replace the same canvas; child-file transitions stay unchanged.
                enterTransition = { if (firstSendReplacement(initialState.destination.route, targetState.destination.route)) EnterTransition.None else fadeIn(ClaudeMotion.screen()) },
                exitTransition = { if (firstSendReplacement(initialState.destination.route, targetState.destination.route)) ExitTransition.None else if (targetState.destination.route in sheetRoutes) ExitTransition.KeepUntilTransitionsFinished else fadeOut(ClaudeMotion.screen()) },
                popEnterTransition = { if (initialState.destination.route in sheetRoutes) EnterTransition.None else fadeIn(ClaudeMotion.screen()) }) {
                composable("home") { }
                composable("sending/{id}") { }
                composable("history") { HistoryScreen(vm, nav) }
                composable("conversation/{id}") { }
                composable("login") { LoginScreen(vm, nav) }
                composable("verify") { VerifyScreen(vm, nav) }
                composable("work") { WorkScreen(vm, nav) }
                composable("cowork") { CoworkScreen(vm, nav) }
                composable("project/{id}") { ProjectScreen(vm, nav, it.arguments?.getString("id").orEmpty()) }
                composable("project/{id}/knowledge") { ProjectKnowledgeScreen(vm, nav, it.arguments?.getString("id").orEmpty()) }
                composable("project-new") { CreateProjectScreen(vm, nav) }
                composable("code") { CodeScreen(vm, nav) }
                composable("code-new") { RepositoryConversationScreen(vm, nav) }
                composable("device/{id}") { DeviceConversationsScreen(vm, nav, it.arguments?.getString("id").orEmpty()) }
                composable("deviceNew/{device}") { DeviceNewSessionScreen(vm, nav, it.arguments?.getString("device").orEmpty()) }
                composable("deviceConversation/{device}/{id}") { DeviceConversationScreen(vm, nav, it.arguments?.getString("device").orEmpty(), it.arguments?.getString("id").orEmpty()) }
                composable("task/{id}") { TaskScreen(vm, nav, it.arguments?.getString("id").orEmpty()) }
                composable("diff/{id}") { DiffScreen(vm, nav, it.arguments?.getString("id").orEmpty()) }
                composable("library") { LibraryScreen(vm, nav) }
                composable("conversationArtifact/{conversationId}/{id}", enterTransition = { sheetIn }, popExitTransition = { sheetOut }) { SheetSurface { ArtifactScreen(vm, nav, it.arguments?.getString("id").orEmpty(), it.arguments?.getString("conversationId")) } }
                composable("artifact/{id}", enterTransition = { sheetIn }, popExitTransition = { sheetOut }) { SheetSurface { ArtifactScreen(vm, nav, it.arguments?.getString("id").orEmpty()) } }
                composable("generated/{conversationId}/{fileId}", enterTransition = { sheetIn }, popExitTransition = { sheetOut }) { SheetSurface { GeneratedFileScreen(vm, nav, it.arguments?.getString("conversationId").orEmpty(), it.arguments?.getString("fileId").orEmpty()) } }
                composable("attachment/{id}", enterTransition = { sheetIn }, popExitTransition = { sheetOut }) { SheetSurface { AttachmentScreen(vm, nav, it.arguments?.getString("id").orEmpty()) } }
                composable("routines") { RoutinesScreen(vm, nav) }
                composable("routine/{id}") { RoutineScreen(vm, nav, it.arguments?.getString("id").orEmpty()) }
                composable("routine-edit/{id}") { RoutineEditorScreen(vm, nav, it.arguments?.getString("id").orEmpty()) }
                composable("memory") { MemoryScreen(vm, nav) }
                composable("api-groups") { ApiGroupsScreen(vm, nav) }
                composable("settings") { SettingsScreen(vm, nav) }
                composable("usage") { UsageScreen(vm, nav) }
                composable("usage/transactions") { TransactionsScreen(vm, nav) }
                composable("settings/profile") { ProfileScreen(vm, nav) }
                composable("settings/billing") { BillingScreen(vm, nav) }
                composable("settings/notifications") { NotificationSettingsScreen(vm, nav) }
                composable("settings/sharing") { SharingScreen(vm, nav) }
                composable("settings/shared-links") { SharedLinksScreen(vm, nav) }
                composable("status") { StatusScreen(vm, nav) }
            }
        }
        }
        }
        // Mount on opening, after the current page's lifecycle has registered navigation callbacks.
        // Keeping a disabled Activity-level callback mounted lets newer page callbacks win instead.
        if (drawer.isOpen) {
            BackHandler { scope.launch { drawer.close() } }
        }
        }
    }
}

/**
 * Files, artifacts and attachments come up from the bottom like a sheet and
 * go back down, on a spring with no overshoot (owner, 2026-10-04; the web's
 * phone file viewer moves the same way).
 */
private val sheetRoutes = setOf("conversationArtifact/{conversationId}/{id}", "artifact/{id}", "generated/{conversationId}/{fileId}", "attachment/{id}")
private val sheetSpring = spring<IntOffset>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)
private val sheetIn = slideInVertically(sheetSpring) { it }
private val sheetOut = slideOutVertically(sheetSpring) { it }

/** Opaque, so the screen under the moving sheet never shows through it. */
@Composable private fun SheetSurface(content: @Composable () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = Claude.colors.bg100, contentColor = Claude.colors.text100) { content() }
}
