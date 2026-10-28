`ip2region_v4.xdb` is the offline IPv4 → region database of
[ip2region](https://github.com/lionsoul2014/ip2region) (Apache-2.0),
downloaded 2026-10-16 (sha256 27ecba8c9a6d5e3b280aedbe7ee15c65372b179fbd0dad3845d8c608f2fcace1).
Lookups run in the service; no address leaves it.

This v3 IPv4 database stores `country|province|city|isp|country-code`.
The lookup also accepts the older `country|region|province|city|isp`
layout, omits `0` placeholders, and never includes ISP or IP in turn context.
