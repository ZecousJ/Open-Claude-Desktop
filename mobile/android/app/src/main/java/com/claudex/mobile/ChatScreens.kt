@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.claudex.mobile

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController

private fun validEmail(value: String) = Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$").matches(value.trim())

/**
 * Sign-in in the official Welcome layout: mark, serif title, the email
 * field with its trailing submit button. Claudex signs in with email + password (then 2FA when the
 * account has it), and registers with an emailed code — so the password is a second field in the same
 * style. Google sign-in and magic links are left out: the service has neither.
 */
@Composable fun LoginScreen(vm: AppViewModel, nav: NavHostController) {
    val c = Claude.colors
    val email by vm.email.collectAsStateWithLifecycle(); val busy by vm.busy.collectAsStateWithLifecycle(); val stage by vm.authStage.collectAsStateWithLifecycle()
    var password by remember { mutableStateOf("") }
    var passwordStep by rememberSaveable { mutableStateOf(false) }
    var invalid by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(stage) { if (stage == "twoFactor" || stage == "register") nav.navigate("verify") { launchSingleTop = true } }
    BackHandler(passwordStep) { password = ""; passwordStep = false }
    fun submitEmail() { if (validEmail(email)) { invalid = false; passwordStep = true } else invalid = true }
    fun submitPassword() { val transient = password; password = ""; vm.login(transient) { nav.navigate("home") { popUpTo("login") { inclusive = true } } } }

    val configuration = LocalConfiguration.current
    val compact = configuration.screenHeightDp < 480 * maxOf(configuration.fontScale, 1f)
    val density = LocalDensity.current
    val keyboardUp = WindowInsets.ime.getBottom(density) > with(density) { 150.dp.roundToPx() }
    val heroScale by animateFloatAsState(if (keyboardUp) .65f else 1f, ClaudeMotion.screen(), label = "heroScale")

    Box(Modifier.fillMaxSize().background(c.bg100).imePadding(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 600.dp).fillMaxWidth().fillMaxHeight().padding(horizontal = 24.dp)
            .then(if (compact) Modifier.verticalScroll(rememberScrollState()) else Modifier), horizontalAlignment = Alignment.CenterHorizontally) {
            if (passwordStep) Box(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                ClaudeIconButton(AppGlyphs.arrowLeft, stringResource(R.string.generic_back_button_content_description), { password = ""; passwordStep = false }, tint = c.text100)
            }
            // Hero: square, min(width × 0.6, 280 dp), shrinking to 0.65 while the keyboard is up.
            BoxWithConstraints(Modifier.padding(top = if (passwordStep) 0.dp else 24.dp).fillMaxWidth().then(if (compact) Modifier else Modifier.weight(1f)), contentAlignment = Alignment.Center) {
                val side = minOf(maxWidth * .6f, 280.dp).let { if (!compact) minOf(it, maxHeight) else it }
                ClaudexMark(side, Modifier.graphicsLayer { scaleX = heroScale; scaleY = heroScale }, stringResource(R.string.claudex_mark_description))
            }
            Spacer(Modifier.height(16.dp))
            Text(stringResource(R.string.animated_login_welcome_title), Modifier.fillMaxWidth(), style = Claude.type.screenTitle.copy(fontWeight = FontWeight.Light),
                color = c.text100, textAlign = TextAlign.Center)
            Spacer(Modifier.height(24.dp))
            if (BuildConfig.DEMO_MODE) {
                Notice(stringResource(R.string.claudex_demo_notice))
                Spacer(Modifier.height(16.dp))
                ClaudeButton(stringResource(R.string.claudex_demo_continue), { nav.navigate("home") { popUpTo("login") { inclusive = true } } }, size = ButtonSize.Large, fillWidth = true)
            } else {
                LoginField(email, { vm.email.value = it.trim(); invalid = false; if (passwordStep) { passwordStep = false; password = "" } },
                    stringResource(R.string.login_welcome_email_placeholder), KeyboardType.Email,
                    submitLabel = stringResource(R.string.claudex_login_continue_with_email_a11y), showSubmit = !passwordStep && email.isNotBlank(), busy = false, onSubmit = ::submitEmail)
                if (invalid) Text(stringResource(R.string.login_welcome_email_error_invalid_email), Modifier.fillMaxWidth().padding(top = 8.dp, start = 4.dp), style = Claude.type.body13, color = c.dangerText)
                if (passwordStep) {
                    Spacer(Modifier.height(12.dp))
                    LoginField(password, { password = it }, stringResource(R.string.claudex_login_password_placeholder), KeyboardType.Password, password = true,
                        submitLabel = stringResource(R.string.generic_button_continue), showSubmit = password.isNotEmpty() || busy, busy = busy, onSubmit = { if (!busy && password.isNotBlank()) submitPassword() }, autoFocus = true)
                }
                Spacer(Modifier.height(12.dp))
                ClaudeButton(stringResource(R.string.claudex_login_create_account), { password = ""; if (validEmail(email)) vm.sendCode() else invalid = true },
                    variant = ButtonVariant.Borderless, size = ButtonSize.Small, enabled = !busy, contentColor = c.text500)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** Login text field: 12 dp corners, single line, with the filled 12 dp submit button
 *  (text-100 fill, bg-100 arrow 18 dp) once there is text; a spinner while submitting. */
@Composable private fun LoginField(value: String, onValueChange: (String) -> Unit, placeholder: String, type: KeyboardType, submitLabel: String,
    showSubmit: Boolean, busy: Boolean, onSubmit: () -> Unit, password: Boolean = false, autoFocus: Boolean = false) {
    val c = Claude.colors
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(autoFocus) { if (autoFocus) runCatching { focus.requestFocus() } }
    ClaudeTextField(value, onValueChange, Modifier.fillMaxWidth().focusRequester(focus), placeholder = placeholder,
        shape = Claude.shapes.field, container = c.bg000, border = c.border300,
        keyboardOptions = KeyboardOptions(keyboardType = type, imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { onSubmit() }),
        visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        trailing = if (!showSubmit) null else ({
            Box(Modifier.padding(end = 8.dp, top = 8.dp, bottom = 8.dp).size(36.dp).clip(Claude.shapes.field).background(c.text100)
                .clickable(enabled = !busy, role = Role.Button, onClick = onSubmit).semantics { contentDescription = submitLabel }, contentAlignment = Alignment.Center) {
                if (busy) ClaudeSpinner(SpinnerSize.XSmall, color = c.bg100) else Icon(AppGlyphs.arrowRight, null, Modifier.size(18.dp), tint = c.bg100)
            }
        }))
}
/**
 * Code entry in the official MagicLinkSent layout: 52 dp top, "Enter the code we sent to your
 * email" + Code field, the address it went to, "Change email address" in the link colour. Registration
 * also sets the account password here; 2FA asks for the authenticator code instead.
 */
@Composable fun VerifyScreen(vm: AppViewModel, nav: NavHostController) {
    val c = Claude.colors
    val stage by vm.authStage.collectAsStateWithLifecycle(); val email by vm.email.collectAsStateWithLifecycle(); val busy by vm.busy.collectAsStateWithLifecycle(); val cooldown by vm.resendSeconds.collectAsStateWithLifecycle()
    var code by remember { mutableStateOf("") }; var password by remember { mutableStateOf("") }
    val twoFactor = stage == "twoFactor"
    fun leave() { vm.cancelVerification(); nav.popBackStack() }
    BackHandler { leave() }
    fun submit() { val secret = password; password = ""; vm.verify(code, secret) { nav.navigate("home") { popUpTo("login") { inclusive = true } } }; code = "" }
    val canSubmit = !busy && code.length == 6 && (twoFactor || password.length >= 8)
    Column(Modifier.fillMaxSize().background(c.bg100).imePadding()) {
        ClaudeTopBar(TopBarNavigation.Back(::leave))
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).widthIn(max = 600.dp).align(Alignment.CenterHorizontally).padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(52.dp))
            AnimatedContent(twoFactor, transitionSpec = { fadeIn(ClaudeMotion.screen()) togetherWith fadeOut(ClaudeMotion.screen()) }, label = "Magic Link Code Input Transition") { factor ->
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(stringResource(if (factor) R.string.claudex_login_two_factor_prompt else R.string.login_magic_link_enter_code), Modifier.padding(bottom = 12.dp),
                        style = Claude.type.body13Strong, color = c.text100)
                    val codeLabel = stringResource(R.string.claudex_login_code_a11y)
                    ClaudeTextField(code, { code = it.filter(Char::isDigit).take(6) }, Modifier.fillMaxWidth().semantics { contentDescription = codeLabel },
                        placeholder = stringResource(R.string.login_magic_link_code_placeholder), shape = Claude.shapes.field, container = c.bg000, border = c.border300,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = if (factor) ImeAction.Done else ImeAction.Next),
                        keyboardActions = KeyboardActions(onDone = { if (canSubmit) submit() }))
                    if (!factor) ClaudeTextField(password, { password = it }, Modifier.fillMaxWidth(), placeholder = stringResource(R.string.claudex_login_set_password_placeholder),
                        shape = Claude.shapes.field, container = c.bg000, border = c.border300, visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { if (canSubmit) submit() }))
                    ClaudeButton(stringResource(R.string.claudex_login_verify_button), ::submit, size = ButtonSize.Large, fillWidth = true, enabled = canSubmit, loading = busy)
                }
            }
            Spacer(Modifier.height(24.dp))
            if (!twoFactor) {
                val template = stringResource(R.string.login_magic_link_sent_to)
                Text(buildAnnotatedString {
                    val at = template.indexOf("^1")
                    if (at < 0) append(template) else { append(template.substring(0, at)); pushStyle(SpanStyle(fontWeight = FontWeight.Bold)); append(email); pop(); append(template.substring(at + 2)) }
                }, Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 12.dp), style = Claude.type.body15, color = c.text100, textAlign = TextAlign.Center)
                ClaudeButton(if (cooldown > 0) stringResource(R.string.claudex_login_resend_in, cooldown) else stringResource(R.string.claudex_login_resend_code), vm::sendCode,
                    variant = ButtonVariant.Borderless, size = ButtonSize.Small, enabled = !busy && cooldown == 0, contentColor = c.text500)
            }
            Spacer(Modifier.height(16.dp))
            Text(stringResource(if (twoFactor) R.string.claudex_login_back_to_sign_in else R.string.login_magic_link_change_email_button),
                Modifier.clip(Claude.shapes.r8).clickable(role = Role.Button, onClick = ::leave).padding(horizontal = 8.dp, vertical = 6.dp),
                style = Claude.type.body13Strong, color = c.accentSecondary200)
            Spacer(Modifier.height(36.dp))
        }
    }
}
