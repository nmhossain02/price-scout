package httpapi

import (
	"context"
	"net"
	"testing"
)

func TestTargetValidatorRejectsUnsafeTargets(t *testing.T) {
	validator := TargetValidator{}
	tests := []string{
		"file:///etc/passwd",
		"http://127.0.0.1/product",
		"https://8.8.8.8/product",
		"http://169.254.169.254/latest/meta-data",
		"http://[::1]/product",
		"https://user:password@example.com/product",
		"https://8.8.8.8:8443/product",
	}
	for _, target := range tests {
		t.Run(target, func(t *testing.T) {
			if _, err := validator.Validate(context.Background(), target); err == nil {
				t.Fatalf("expected %q to be rejected", target)
			}
		})
	}
}

func TestUnsafeIPRejectsSpecialUseNetworks(t *testing.T) {
	unsafe := []string{
		"0.1.2.3",
		"100.64.0.1",
		"192.0.0.8",
		"192.0.2.10",
		"192.88.99.1",
		"198.18.0.1",
		"198.51.100.20",
		"203.0.113.30",
		"240.0.0.1",
		"2001:db8::1",
		"100::1",
	}
	for _, raw := range unsafe {
		t.Run(raw, func(t *testing.T) {
			if !unsafeIP(net.ParseIP(raw)) {
				t.Fatalf("special-use address %s was accepted", raw)
			}
		})
	}
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if unsafeIP(net.ParseIP(raw)) {
			t.Fatalf("public address %s was rejected", raw)
		}
	}
}

func TestTargetValidatorAllowsConfiguredFixture(t *testing.T) {
	validator := TargetValidator{FixtureOrigin: "http://fixture:4173"}
	got, err := validator.Validate(context.Background(), "http://fixture:4173/product/demo#reviews")
	if err != nil {
		t.Fatalf("configured fixture was rejected: %v", err)
	}
	if got != "http://fixture:4173/product/demo" {
		t.Fatalf("canonical URL = %q", got)
	}
}

func TestValidatePriceCondition(t *testing.T) {
	valid := []byte(`{"priceBelowMinor":10000,"currency":"USD","requireInStock":true,"requestedVariant":{"color":"black"}}`)
	if err := validatePriceCondition(valid); err != nil {
		t.Fatalf("valid condition rejected: %v", err)
	}
	for _, raw := range [][]byte{
		[]byte(`{"currency":"USD","requireInStock":true}`),
		[]byte(`{"priceBelowMinor":100,"currency":"usd","requireInStock":true}`),
		[]byte(`{"priceBelowMinor":100,"currency":"JPY","requireInStock":true}`),
		[]byte(`{"priceBelowMinor":100,"currency":"USD"}`),
	} {
		if err := validatePriceCondition(raw); err == nil {
			t.Fatalf("invalid condition accepted: %s", raw)
		}
	}
}
