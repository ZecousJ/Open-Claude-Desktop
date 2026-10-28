package core

import (
	"regexp"
	"strconv"
	"strings"
)

// VersionPattern is the accepted desktop / release version syntax: one to
// four numeric parts, an optional pre-release and optional build metadata
// ("1.4.0", "1.4.0-beta.2", "0.2.8+claudex.1").
var VersionPattern = regexp.MustCompile(`^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$`)

// ValidVersion reports whether v matches VersionPattern and is at most 32
// characters (the X-Claudex-Version limit).
func ValidVersion(v string) bool {
	return len(v) <= 32 && VersionPattern.MatchString(v)
}

type version struct {
	nums []int64
	pre  []string
}

func parseVersion(v string) (version, bool) {
	v = strings.TrimSpace(v)
	if !VersionPattern.MatchString(v) {
		return version{}, false
	}
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i] // build metadata never affects precedence
	}
	var out version
	if i := strings.IndexByte(v, '-'); i >= 0 {
		out.pre = strings.Split(v[i+1:], ".")
		v = v[:i]
	}
	for _, part := range strings.Split(v, ".") {
		n, err := strconv.ParseInt(part, 10, 64)
		if err != nil {
			return version{}, false
		}
		out.nums = append(out.nums, n)
	}
	return out, true
}

// CompareVersions compares by semantic-version precedence: numeric parts
// left to right (missing parts are 0), a pre-release sorts before the release
// (1.2.0-beta.1 < 1.2.0), pre-release identifiers compare numerically or
// lexically, build metadata (+claudex.3) is ignored. It returns -1, 0 or 1.
// An invalid version sorts before every valid one; two invalid versions
// compare as strings.
func CompareVersions(a, b string) int {
	va, okA := parseVersion(a)
	vb, okB := parseVersion(b)
	switch {
	case !okA && !okB:
		return sign(strings.Compare(a, b))
	case !okA:
		return -1
	case !okB:
		return 1
	}
	for i := 0; i < len(va.nums) || i < len(vb.nums); i++ {
		var x, y int64
		if i < len(va.nums) {
			x = va.nums[i]
		}
		if i < len(vb.nums) {
			y = vb.nums[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(va.pre) == 0 && len(vb.pre) == 0:
		return 0
	case len(va.pre) == 0:
		return 1
	case len(vb.pre) == 0:
		return -1
	}
	for i := 0; i < len(va.pre) && i < len(vb.pre); i++ {
		if c := comparePreIdent(va.pre[i], vb.pre[i]); c != 0 {
			return c
		}
	}
	return sign(len(va.pre) - len(vb.pre))
}

func comparePreIdent(a, b string) int {
	na, errA := strconv.ParseUint(a, 10, 64)
	nb, errB := strconv.ParseUint(b, 10, 64)
	switch {
	case errA == nil && errB == nil:
		if na == nb {
			return 0
		}
		if na < nb {
			return -1
		}
		return 1
	case errA == nil:
		return -1 // numeric identifiers sort before alphanumeric ones
	case errB == nil:
		return 1
	}
	return sign(strings.Compare(a, b))
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}
