package policy

import "testing"

func TestWebSearchDefaultOffForOldDesktops(t *testing.T) {
	cases := []struct {
		platform, version string
		off               bool
	}{
		{"darwin", "0.0.21", true},
		{"win32", "0.0.9", true},
		{"darwin", "", true},
		{"darwin", "0.0.22", false},
		{"win32", "0.1.0", false},
		{"", "", false},
		{"web", "", false},
		{"android", "0.5.0", false},
	}
	for _, tc := range cases {
		if got := webSearchDefaultBreaksCode(tc.platform, tc.version); got != tc.off {
			t.Errorf("%s %s: got %v, want %v", tc.platform, tc.version, got, tc.off)
		}
	}
}
