package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"
)

type TargetValidator struct {
	FixtureOrigin string
	Resolver      *net.Resolver
}

func (v TargetValidator) Validate(ctx context.Context, raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", errors.New("url must be an absolute HTTP(S) URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("url scheme must be http or https")
	}
	if parsed.Hostname() == "" || parsed.User != nil {
		return "", errors.New("url must have a host and no embedded credentials")
	}
	if port := parsed.Port(); port != "" && port != "80" && port != "443" && !v.isFixture(parsed) {
		return "", errors.New("url uses a disallowed port")
	}
	parsed.Fragment = ""
	if v.isFixture(parsed) {
		return parsed.String(), nil
	}
	host := parsed.Hostname()
	if literal := net.ParseIP(host); literal != nil {
		return "", errors.New("url host must not be an IP literal")
	}
	resolver := v.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	addresses, err := resolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return "", fmt.Errorf("resolve url host: %w", err)
	}
	if len(addresses) == 0 {
		return "", errors.New("url host has no addresses")
	}
	for _, address := range addresses {
		if unsafeIP(address) {
			return "", errors.New("url resolves to a private or reserved address")
		}
	}
	return parsed.String(), nil
}

func (v TargetValidator) isFixture(target *url.URL) bool {
	fixture, err := url.Parse(v.FixtureOrigin)
	if err != nil || fixture.Scheme == "" || fixture.Host == "" {
		return false
	}
	return strings.EqualFold(target.Scheme, fixture.Scheme) && strings.EqualFold(target.Host, fixture.Host)
}

var deniedTargetPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func unsafeIP(ip net.IP) bool {
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	address = address.Unmap()
	if address.IsLoopback() || address.IsPrivate() || address.IsLinkLocalUnicast() ||
		address.IsUnspecified() || address.IsMulticast() {
		return true
	}
	for _, prefix := range deniedTargetPrefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}
