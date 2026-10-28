package geoip

import "testing"

func TestLookup(t *testing.T) {
	for ip, want := range map[string]Location{
		"8.8.8.8":         {Country: "United States", Region: "California"},
		"1.1.1.1":         {Country: "Australia", Region: "Queensland", City: "Brisbane"},
		"114.114.114.114": {Country: "中国", Region: "江苏省", City: "南京市"},
		"223.5.5.5":       {Country: "中国", Region: "浙江省", City: "杭州市"},
	} {
		t.Run(ip, func(t *testing.T) {
			got := Lookup(ip)
			if got != want {
				t.Fatalf("got %+v, want %+v", got, want)
			}
		})
	}
}

func TestRegionFormats(t *testing.T) {
	for input, want := range map[string]Location{
		"US|0|California|Mountain View|Google": {Country: "US", Region: "California", City: "Mountain View"},
		"US|West|0|0|0":                        {Country: "US", Region: "West"},
		"0|0|0|0|0":                            {},
		"invalid":                              {},
	} {
		if got := parseRegion(input); got != want {
			t.Errorf("%q: got %+v, want %+v", input, got, want)
		}
	}
}

func TestNonPublicAddresses(t *testing.T) {
	for _, ip := range []string{"", "bad", "127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.1.1", "0.0.0.0", "255.255.255.255", "224.0.0.1", "::1", "2001:4860:4860::8888", "::ffff:8.8.8.8"} {
		if got := Lookup(ip); got != (Location{}) {
			t.Errorf("%s: got %+v", ip, got)
		}
	}
}
