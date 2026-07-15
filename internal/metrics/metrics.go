package metrics

import "github.com/prometheus/client_golang/prometheus"

type Metrics struct {
	Registry              *prometheus.Registry
	HTTPRequests          *prometheus.CounterVec
	HTTPDuration          *prometheus.HistogramVec
	ScheduledChecks       prometheus.Counter
	OutboxPublished       *prometheus.CounterVec
	ExecutionResults      *prometheus.CounterVec
	SSEConnections        prometheus.Gauge
	AlertDeliveries       *prometheus.CounterVec
	AlertDeliveryDuration *prometheus.HistogramVec
	ExecutionRecoveries   *prometheus.CounterVec
	ExecutionRetries      *prometheus.CounterVec
}

func New() *Metrics {
	registry := prometheus.NewRegistry()
	metrics := &Metrics{
		Registry: registry,
		HTTPRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "scout_http_requests_total", Help: "Control-plane HTTP requests.",
		}, []string{"method", "route", "status"}),
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "scout_http_request_duration_seconds", Help: "Control-plane HTTP latency.",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "route"}),
		ScheduledChecks: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "scout_scheduled_checks_total", Help: "Checks enqueued by the scheduler.",
		}),
		OutboxPublished: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "scout_outbox_published_total", Help: "Outbox messages published to JetStream.",
		}, []string{"subject"}),
		ExecutionResults: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "scout_execution_results_total", Help: "Worker results accepted by the control plane.",
		}, []string{"kind", "status"}),
		SSEConnections: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "scout_sse_connections", Help: "Open engineering-console SSE connections.",
		}),
		AlertDeliveries: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "scout_alert_deliveries_total", Help: "Alert delivery outcomes by channel.",
		}, []string{"channel", "outcome"}),
		AlertDeliveryDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "scout_alert_delivery_duration_seconds", Help: "Alert destination request latency.",
			Buckets: prometheus.DefBuckets,
		}, []string{"channel"}),
		ExecutionRecoveries: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "scout_execution_recoveries_total", Help: "Stale execution sweep outcomes.",
		}, []string{"kind", "outcome", "prior_state"}),
		ExecutionRetries: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "scout_execution_retries_total", Help: "Transient compile and repair result retry outcomes.",
		}, []string{"kind", "classification", "outcome"}),
	}
	registry.MustRegister(metrics.HTTPRequests, metrics.HTTPDuration, metrics.ScheduledChecks,
		metrics.OutboxPublished, metrics.ExecutionResults, metrics.SSEConnections,
		metrics.AlertDeliveries, metrics.AlertDeliveryDuration, metrics.ExecutionRecoveries)
	registry.MustRegister(metrics.ExecutionRetries)
	return metrics
}
