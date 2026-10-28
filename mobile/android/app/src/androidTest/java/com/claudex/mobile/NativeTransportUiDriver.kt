package com.claudex.mobile

import android.app.Instrumentation
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/** Real native touches and accessibility text input, with no Compose test rule or test clock. */
internal class NativeTransportUiDriver(private val instrumentation: Instrumentation) {
    private val packageName = "com.claudex.mobile"
    private val hitObservations = ArrayDeque<JSONObject>()
    private val revealObservations = ArrayDeque<JSONObject>()
    fun hitEvidence() = JSONArray(hitObservations.map { JSONObject(it.toString()) })
    fun revealEvidence() = JSONArray(revealObservations.map { JSONObject(it.toString()) })
    private fun labels(node: AccessibilityNodeInfo): Set<String> = buildSet {
        node.text?.toString()?.split('\n')?.map(String::trim)?.filter(String::isNotEmpty)?.forEach(::add)
        node.contentDescription?.toString()?.takeIf(String::isNotBlank)?.let(::add)
        node.hintText?.toString()?.takeIf(String::isNotBlank)?.let(::add)
    }
    private fun nodes(): List<AccessibilityNodeInfo> {
        val root = instrumentation.uiAutomation.rootInActiveWindow ?: return emptyList()
        if (root.packageName?.toString() != packageName) return emptyList()
        val output = mutableListOf<AccessibilityNodeInfo>()
        fun visit(node: AccessibilityNodeInfo, depth: Int) {
            if (output.size >= 300 || depth > 25) return
            // getChild/rootInActiveWindow may return cached Compose bounds after scrolling.
            if (!node.refresh()) return
            output += node
            for (index in 0 until minOf(node.childCount, 100)) node.getChild(index)?.let { visit(it, depth + 1) }
        }
        visit(root, 0)
        return output
    }
    private fun matches(node: AccessibilityNodeInfo, label: String, description: Boolean): Boolean =
        if (description) node.contentDescription?.toString() == label else label in labels(node)
    private fun bounds(node: AccessibilityNodeInfo) = Rect().also(node::getBoundsInScreen)
    private fun visible(node: AccessibilityNodeInfo): Boolean = node.isVisibleToUser && bounds(node).let { it.width() > 0 && it.height() > 0 }
    private data class HitGeometry(val target: Rect, val clip: Rect, val safe: Boolean, val evidence: JSONObject)
    private fun hitGeometry(node: AccessibilityNodeInfo, label: String): HitGeometry {
        check(node.refresh()) { "Native target '$label' became obsolete before geometry read" }
        val target = bounds(node)
        val root = instrumentation.uiAutomation.rootInActiveWindow
        check(root != null && root.refresh()) { "Native root became obsolete before geometry read" }
        val rootBounds = root?.let(::bounds) ?: Rect()
        val clip = Rect(rootBounds)
        val ancestors = JSONArray()
        var current: AccessibilityNodeInfo? = node
        var depth = 0
        var positiveBounds = 0
        var ancestorsVisible = true
        while (current != null && depth < 30) {
            val ancestor = current
            check(ancestor.refresh()) { "Native ancestor of '$label' became obsolete before geometry read" }
            val rect = bounds(ancestor)
            val positive = rect.width() > 0 && rect.height() > 0
            ancestors.put(JSONObject().put("depth", depth).put("class", ancestor.className?.toString()?.take(120))
                .put("bounds", rect.toShortString()).put("positive", positive).put("visible", ancestor.isVisibleToUser))
            if (positive) {
                positiveBounds++
                if (!ancestor.isVisibleToUser) ancestorsVisible = false
                if (!clip.intersect(rect)) clip.setEmpty()
            }
            // Zero-size structural accessibility nodes supply no useful clipping rectangle.
            current = ancestor.parent
            depth++
        }
        val safe = root?.packageName?.toString() == packageName && current == null &&
            rootBounds.width() > 0 && rootBounds.height() > 0 && positiveBounds > 0 && ancestorsVisible &&
            visible(node) && effectiveEnabled(node) && !clip.isEmpty && clip.contains(target)
        val evidence = JSONObject().put("label", label).put("sampleElapsedMs", SystemClock.elapsedRealtime())
            .put("target", target.toShortString()).put("root", rootBounds.toShortString()).put("effectiveClip", clip.toShortString())
            .put("centerX", target.exactCenterX()).put("centerY", target.exactCenterY()).put("safe", safe)
            .put("refreshedFromView", true).put("ancestorLimitReached", current != null).put("ancestors", ancestors)
        return HitGeometry(target, clip, safe, evidence)
    }
    private fun safeHitBounds(node: AccessibilityNodeInfo, label: String): Rect {
        val geometry = hitGeometry(node, label)
        if (hitObservations.size >= 16) hitObservations.removeFirst()
        hitObservations.addLast(geometry.evidence)
        check(geometry.safe) { "Native '$label' is clipped/obstructed or has no safe target: target=${geometry.target.toShortString()}, clip=${geometry.clip.toShortString()}" }
        return geometry.target
    }
    private fun clickOwner(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var current: AccessibilityNodeInfo? = node
        repeat(8) {
            val candidate = current ?: return null
            if (candidate.packageName?.toString() != packageName) return null
            if (candidate.isClickable || candidate.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK }) return candidate
            current = candidate.parent
        }
        return null
    }
    private fun effectiveEnabled(node: AccessibilityNodeInfo): Boolean {
        var current: AccessibilityNodeInfo? = node
        repeat(30) {
            val value = current ?: return true
            if (!value.isEnabled) return false
            current = value.parent
        }
        error("Native accessibility ancestor depth exceeds fixture bound")
    }
    private fun candidates(label: String, description: Boolean) = nodes().filter { visible(it) && matches(it, label, description) }
        .mapNotNull(::clickOwner).filter(::visible).distinctBy { bounds(it).toShortString() + ":" + it.className }
    fun hasText(label: String): Boolean = nodes().any { visible(it) && label in labels(it) }
    fun assertAbsent(label: String, description: Boolean = false) {
        check(nodes().none { visible(it) && matches(it, label, description) }) { "Expected no visible native '$label'" }
    }
    fun assertEnabled(label: String, enabled: Boolean, description: Boolean = false) {
        val candidates = nodes().filter { visible(it) && matches(it, label, description) }
            .map { clickOwner(it) ?: it }.distinctBy { bounds(it).toShortString() + ":" + it.className }
        check(candidates.size == 1) { "Expected one native '$label' target, found ${candidates.size}" }
        check(effectiveEnabled(candidates.single()) == enabled) { "Unexpected enabled state for '$label'" }
    }
    fun touch(label: String, description: Boolean = false) {
        val until = SystemClock.elapsedRealtime() + 20_000
        var current = emptyList<AccessibilityNodeInfo>()
        while (SystemClock.elapsedRealtime() < until) {
            current = candidates(label, description)
            check(current.size <= 1) { "Native action '$label' is ambiguous: ${current.size} visible targets" }
            if (current.size == 1 && effectiveEnabled(current.single())) break
            Thread.sleep(50)
        }
        check(current.size == 1) { "Native action '$label' ambiguous/unavailable: ${current.size} visible targets" }
        val node = current.single()
        check(effectiveEnabled(node)) { "Native '$label' is disabled through its ancestor chain" }
        val rect = safeHitBounds(node, label)
        touchPoint(rect.exactCenterX(), rect.exactCenterY())
    }
    /** Reveal a present exact vertical-list target; the caller still performs a fresh real touch. */
    fun revealForTouch(label: String, description: Boolean = false) {
        val deadline = SystemClock.elapsedRealtime() + 8_000
        val record = JSONObject().put("label", label).put("deadlineMs", 8_000).put("maxActions", 4)
        val attempts = JSONArray()
        record.put("attempts", attempts)
        if (revealObservations.size >= 4) revealObservations.removeFirst()
        revealObservations.addLast(record)
        fun exactTarget(): AccessibilityNodeInfo {
            while (SystemClock.elapsedRealtime() < deadline) {
                val found = candidates(label, description)
                check(found.size <= 1) { "Native reveal '$label' is ambiguous: ${found.size}" }
                if (found.size == 1) return found.single().also {
                    check(effectiveEnabled(it)) { "Native reveal '$label' is disabled" }
                }
                Thread.sleep(50)
            }
            error("Native reveal '$label' has no present exact target before deadline")
        }
        try {
            repeat(4) { attempt ->
                check(SystemClock.elapsedRealtime() < deadline) { "Native reveal '$label' deadline exceeded" }
                val target = exactTarget()
                val before = hitGeometry(target, label)
                record.put("latestGeometry", before.evidence)
                if (before.safe) { record.put("fullyRevealed", true); return }
                val show = AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id
                var actionNode = target
                var action = show
                var name = "ACTION_SHOW_ON_SCREEN"
                var viewport: HitGeometry? = null
                if (target.actionList.none { it.id == show }) {
                    var ancestor = target.parent
                    var depth = 0
                    while (ancestor != null && depth < 30 && !ancestor.isScrollable) {
                        check(ancestor.packageName?.toString() == packageName) { "Native reveal left the app ancestor chain" }
                        ancestor = ancestor.parent
                        depth++
                    }
                    val scroll = checkNotNull(ancestor) { "Native reveal '$label' has no scrollable ancestor" }
                    check(depth < 30 && scroll.packageName?.toString() == packageName && visible(scroll) && effectiveEnabled(scroll)) {
                        "Native reveal '$label' has no eligible nearest scrollable ancestor"
                    }
                    actionNode = scroll
                    viewport = hitGeometry(scroll, "nearest scrollable ancestor of $label")
                    val clip = viewport.clip
                    check(!clip.isEmpty && before.target.left >= clip.left && before.target.right <= clip.right) {
                        "Native reveal '$label' requires an unambiguous vertical clip"
                    }
                    val down = before.target.bottom > clip.bottom && before.target.top >= clip.top
                    val up = before.target.top < clip.top && before.target.bottom <= clip.bottom
                    check(down || up) { "Native reveal '$label' has no unambiguous vertical direction" }
                    action = if (down) AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
                        else AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
                    name = if (down) "ACTION_SCROLL_DOWN" else "ACTION_SCROLL_UP"
                    check(scroll.actionList.any { it.id == action }) { "Nearest scrollable ancestor does not advertise $name" }
                }
                val observation = JSONObject().put("attempt", attempt + 1).put("before", before.evidence)
                    .put("action", name).put("actionId", action).put("actionNode", actionMetadata(actionNode))
                    .put("scrollViewport", viewport?.evidence ?: JSONObject.NULL)
                attempts.put(observation)
                val accepted = actionNode.performAction(action)
                observation.put("accepted", accepted)
                check(accepted) { "Native reveal '$label' rejected $name" }
                // Accessibility actions may schedule an ordinary animated scroll. Requery the
                // exact target and every ancestor clip; never reuse a pre-scroll hit rectangle.
                val settleUntil = minOf(deadline, SystemClock.elapsedRealtime() + 1_500)
                var previousGeometry: String? = null
                var safeSince = 0L
                while (SystemClock.elapsedRealtime() < settleUntil) {
                    Thread.sleep(50)
                    val after = hitGeometry(exactTarget(), label)
                    observation.put("after", after.evidence)
                    record.put("latestGeometry", after.evidence)
                    val signature = after.target.toShortString() + ":" + after.clip.toShortString()
                    if (after.safe && signature == previousGeometry) {
                        if (safeSince == 0L) safeSince = SystemClock.elapsedRealtime()
                        if (SystemClock.elapsedRealtime() - safeSince >= 200) {
                            record.put("fullyRevealed", true); return
                        }
                    } else safeSince = 0L
                    previousGeometry = signature
                }
            }
            error("Native reveal '$label' remained clipped after four actions")
        } catch (failure: Throwable) {
            record.put("fullyRevealed", false).put("failure", failure.toString().take(1_000))
            throw failure
        }
    }
    private fun actionMetadata(node: AccessibilityNodeInfo) = JSONObject()
        .put("class", node.className?.toString()).put("bounds", bounds(node).toShortString())
        .put("scrollable", node.isScrollable).put("actionCount", node.actionList.size)
        .put("actions", JSONArray(node.actionList.take(32).map { action ->
            JSONObject().put("id", action.id).put("label", action.label?.toString()?.take(120))
        }))
    fun input(label: String, value: String, description: Boolean = false) = fill(label, value, description, touchFirst = true)
    fun syntheticLoginInput(label: String, value: String) {
        check(hasText("欢迎使用 Claudex")) { "Synthetic auth setup must remain on the original login page" }
        check((label == "邮箱地址" && value == LoopbackTransportFixture.EMAIL) ||
            (label == "账户密码" && value == LoopbackTransportFixture.PASSWORD)) { "Only fixed fixture credentials are allowed" }
        fill(label, value, description = false, touchFirst = false)
    }
    fun syntheticLoginContinue() {
        check(hasText("欢迎使用 Claudex")) { "Synthetic auth action must remain on the original login page" }
        val deadline = SystemClock.elapsedRealtime() + 20_000
        var found = emptyList<AccessibilityNodeInfo>()
        while (SystemClock.elapsedRealtime() < deadline) {
            found = candidates("继续", description = false)
            check(found.size <= 1) { "Synthetic login Continue is ambiguous" }
            if (found.size == 1 && effectiveEnabled(found.single())) break
            Thread.sleep(50)
        }
        check(found.size == 1 && effectiveEnabled(found.single())) { "Synthetic login Continue is unavailable/disabled" }
        val node = found.single()
        safeHitBounds(node, "synthetic login Continue ACTION_CLICK; not touch acceptance")
        check(node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) { "Original login Continue handler rejected accessibility action" }
    }
    private fun fill(label: String, value: String, description: Boolean, touchFirst: Boolean) {
        val all = nodes()
        // Require an exact self/hint/ancestor label, or an exact visible label inside this
        // editable's bounded descendant tree. No field index or spatial fallback is allowed.
        val matching = all.filter { visible(it) && matches(it, label, description) }
        fun hasDescendantLabel(editable: AccessibilityNodeInfo): Boolean {
            var visited = 0
            fun visit(node: AccessibilityNodeInfo, depth: Int): Boolean {
                if (depth > 5 || visited >= 32 || node.packageName?.toString() != packageName) return false
                visited++
                // A nested editable owns its own labels; do not associate them with an outer field.
                if (depth > 0 && node.isEditable) return false
                if (depth > 0 && visible(node) && matches(node, label, description)) return true
                for (index in 0 until minOf(node.childCount, 32)) {
                    val child = node.getChild(index) ?: continue
                    if (visit(child, depth + 1)) return true
                }
                return false
            }
            return visit(editable, 0)
        }
        fun labelled(node: AccessibilityNodeInfo): Boolean {
            if (matches(node, label, description) || hasDescendantLabel(node)) return true
            var parent = node.parent
            repeat(5) {
                val p = parent ?: return false
                if (matching.any { it == p }) return true
                parent = p.parent
            }
            return false
        }
        val fields = all.filter { it.isEditable && visible(it) && labelled(it) }.distinctBy { bounds(it).toShortString() }
        check(fields.size == 1) { "Native editable '$label' ambiguous/unavailable: ${fields.size} labelled fields" }
        val field = fields.single()
        check(effectiveEnabled(field))
        val rect = safeHitBounds(field, if (touchFirst) label else "synthetic login $label ACTION_SET_TEXT; no focus/touch")
        if (touchFirst) touchPoint(rect.exactCenterX(), rect.exactCenterY())
        check(field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        })) { "Native accessibility text input rejected '$label'" }
    }
    fun touchPoint(x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        for ((action, time) in listOf(MotionEvent.ACTION_DOWN to now, MotionEvent.ACTION_UP to now + 60)) {
            val event = MotionEvent.obtain(now, time, action, x, y, 0)
            try { event.source = InputDevice.SOURCE_TOUCHSCREEN; instrumentation.sendPointerSync(event) }
            finally { event.recycle() }
        }
    }
    fun hierarchy(): JSONObject {
        val root = instrumentation.uiAutomation.rootInActiveWindow
        if (root?.packageName?.toString() != packageName) return JSONObject().put("targetWindowActive", false).put("activePackage", root?.packageName?.toString())
        val all = nodes()
        val emitted = all.take(100)
        return JSONObject().put("targetWindowActive", true).put("nodeCount", all.size).put("truncated", all.size > 100)
            .put("nodes", JSONArray(emitted.mapIndexed { index, node -> JSONObject().put("index", index)
                .put("parentIndex", emitted.indexOf(node.parent).takeIf { it >= 0 } ?: JSONObject.NULL)
                .put("childCount", node.childCount)
                .put("childIndices", JSONArray((0 until minOf(node.childCount, 100)).mapNotNull { childIndex ->
                    node.getChild(childIndex)?.let { child -> emitted.indexOf(child).takeIf { it >= 0 } }
                }))
                .put("class", node.className?.toString())
                .put("scrollable", node.isScrollable).put("actionMetadata", actionMetadata(node))
                .put("text", if (node.isPassword) "<password omitted>" else node.text?.toString()?.take(256))
                .put("description", node.contentDescription?.toString()?.take(256)).put("hint", node.hintText?.toString()?.take(256)).put("bounds", bounds(node).toShortString())
                .put("visible", node.isVisibleToUser).put("enabled", node.isEnabled).put("effectiveEnabled", effectiveEnabled(node)).put("editable", node.isEditable).put("clickable", node.isClickable) }))
    }
}
