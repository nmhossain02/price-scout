package schedulerhttp

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type pinger interface {
	Ping(context.Context) error
}

func New(database, queue pinger, registry *prometheus.Registry) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(response http.ResponseWriter, _ *http.Request) {
		writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(response http.ResponseWriter, request *http.Request) {
		ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		if err := database.Ping(ctx); err != nil {
			writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "dependency": "postgres"})
			return
		}
		if err := queue.Ping(ctx); err != nil {
			writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "dependency": "nats"})
			return
		}
		writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	return mux
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
