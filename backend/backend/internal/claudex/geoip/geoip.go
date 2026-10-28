package geoip

import (
	_ "embed"
	"net"
	"strings"
	"sync"

	"github.com/lionsoul2014/ip2region/binding/golang/xdb"
)

//go:embed ip2region_v4.xdb
var database []byte

// Location is the coarse region returned by the offline database.
type Location struct {
	City    string `json:"city"`
	Region  string `json:"region"`
	Country string `json:"country"`
}

var searcher = func() *xdb.Searcher {
	header, err := xdb.NewHeader(database)
	if err != nil {
		panic(err)
	}
	version, err := xdb.VersionFromHeader(header)
	if err != nil || version != xdb.IPv4 || header.RuntimePtrBytes != 4 {
		panic("invalid embedded IPv4 location database")
	}
	s, err := xdb.NewWithBuffer(version, database)
	if err != nil {
		panic(err)
	}
	return s
}()
var searchMu sync.Mutex

// Lookup returns coarse location for public IPv4 addresses only.
func Lookup(ip string) Location {
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil || strings.Contains(ip, ":") || parsed.To4() == nil || !parsed.IsGlobalUnicast() || parsed.IsPrivate() || parsed.IsLoopback() || parsed.IsLinkLocalUnicast() {
		return Location{}
	}
	searchMu.Lock()
	value, err := searcher.Search(parsed.String())
	searchMu.Unlock()
	if err != nil {
		return Location{}
	}
	return parseRegion(value)
}

func parseRegion(value string) Location {
	parts := strings.Split(value, "|")
	if len(parts) != 5 {
		return Location{}
	}
	clean := func(value string) string {
		value = strings.TrimSpace(value)
		if value == "0" {
			return ""
		}
		return value
	}
	if len(parts[4]) == 2 && parts[4][0] >= 'A' && parts[4][0] <= 'Z' && parts[4][1] >= 'A' && parts[4][1] <= 'Z' {
		return Location{Country: clean(parts[0]), Region: clean(parts[1]), City: clean(parts[2])}
	}
	region := clean(parts[2])
	if region == "" {
		region = clean(parts[1])
	}
	return Location{Country: clean(parts[0]), Region: region, City: clean(parts[3])}
}
