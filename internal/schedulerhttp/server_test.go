package schedulerhttp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

type fakePinger struct{ err error }

func (p fakePinger) Ping(context.Context) error { return p.err }

func TestHealthAndReadiness(t *testing.T) {
	handler := New(fakePinger{}, fakePinger{}, prometheus.NewRegistry())
	for _, path := range []string{"/healthz", "/readyz"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d", path, response.Code)
		}
	}
}

func TestReadinessReportsDependencyFailure(t *testing.T) {
	handler := New(fakePinger{}, fakePinger{err: errors.New("offline")}, prometheus.NewRegistry())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "nats") {
		t.Fatalf("unexpected readiness response: %d %s", response.Code, response.Body.String())
	}
}

func TestMetricsUsesSchedulerRegistry(t *testing.T) {
	registry := prometheus.NewRegistry()
	counter := prometheus.NewCounter(prometheus.CounterOpts{Name: "scout_test_scheduler_total", Help: "test"})
	registry.MustRegister(counter)
	counter.Add(3)
	handler := New(fakePinger{}, fakePinger{}, registry)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "scout_test_scheduler_total 3") {
		t.Fatalf("scheduler metric missing: %d %s", response.Code, response.Body.String())
	}
}
