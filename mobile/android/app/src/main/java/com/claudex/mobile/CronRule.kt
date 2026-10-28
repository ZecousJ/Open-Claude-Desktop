package com.claudex.mobile

/**
 * The five-field cron expressions a task's Custom schedule takes: a port of the service's `shared/cron.ts` (numeric fields
 * only, 0 for Sunday, and nothing that runs more than once an hour), so the phone refuses what the service would refuse.
 */
internal object CronRule {
    enum class Problem { INVALID, SUB_HOURLY, NUMERIC_ONLY, SUNDAY_IS_ZERO }

    private val bounds = listOf(0 to 59, 0 to 23, 1 to 31, 1 to 12, 0 to 6)
    private val part = Regex("^(\\*|\\d+(?:-\\d+)?)(?:/(\\d+))?$")

    private fun field(text: String, bound: Pair<Int, Int>): List<Int>? {
        val values = sortedSetOf<Int>()
        for (piece in text.split(",")) {
            val match = part.find(piece) ?: return null
            val stepText = match.groups[2]?.value
            val step = if (stepText == null) 1 else stepText.toIntOrNull() ?: return null
            if (step < 1) return null
            var from = bound.first
            var to = bound.second
            if (match.groupValues[1] != "*") {
                val range = match.groupValues[1].split("-")
                from = range[0].toIntOrNull() ?: return null
                to = if (range.size > 1) range[1].toIntOrNull() ?: return null else if (stepText == null) from else bound.second
            }
            if (from < bound.first || to > bound.second || from > to) return null
            var value = from
            while (value <= to) { values.add(value); value += step }
        }
        return values.toList()
    }

    private fun parts(expression: String) = expression.trim().split(Regex("\\s+"))

    fun problem(expression: String): Problem? {
        val parts = parts(expression)
        if (parts.size != 5) return Problem.INVALID
        if (parts.any { Regex("[A-Za-z?]|#").containsMatchIn(it) }) return Problem.NUMERIC_ONLY
        if (parts[4].split(",").any { it.split("/")[0].split("-").contains("7") }) return Problem.SUNDAY_IS_ZERO
        val parsed = parts.mapIndexed { index, text -> field(text, bounds[index]) }
        if (parsed.any { it.isNullOrEmpty() }) return Problem.INVALID
        if (parsed[0]!!.size > 1) return Problem.SUB_HOURLY
        return null
    }

    /** The service's own `frequency` for a cron rule: hourly when its hour field is open, otherwise daily. */
    fun frequency(expression: String): String = if (problem(expression) == null && field(parts(expression)[1], bounds[1])!!.size == 24) "hourly" else "daily"

    /** "M H * * d,d" for a time of day on some weekdays (Sunday = 0): what a rule saved as chosen days reads as. */
    fun forDays(time: String, days: List<Int>): String {
        val (hours, minutes) = time.split(":").map { it.toIntOrNull() ?: 0 }.let { it.getOrElse(0) { 0 } to it.getOrElse(1) { 0 } }
        val list = days.toSortedSet().toList()
        return "$minutes $hours * * ${if (list.size == 7 || list.isEmpty()) "*" else list.joinToString(",")}"
    }

    /** A simple expression read back as a time of day on some weekdays; null for anything that fires more often or on dates. */
    fun asDays(expression: String): Pair<String, List<Int>>? {
        if (problem(expression) != null) return null
        val parts = parts(expression)
        val minutes = field(parts[0], bounds[0])!!; val hours = field(parts[1], bounds[1])!!
        if (minutes.size != 1 || hours.size != 1 || !parts[2].startsWith("*") || field(parts[3], bounds[3])!!.size != 12) return null
        return "%02d:%02d".format(hours[0], minutes[0]) to field(parts[4], bounds[4])!!
    }
}
