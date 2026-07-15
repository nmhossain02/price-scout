package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/nmhossain02/price-scout/internal/config"
	"github.com/nmhossain02/price-scout/internal/domain"
	"github.com/nmhossain02/price-scout/internal/events"
	"github.com/nmhossain02/price-scout/internal/metrics"
	"github.com/nmhossain02/price-scout/internal/queue"
	"github.com/nmhossain02/price-scout/internal/store"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Server struct {
	config    config.Config
	store     *store.Store
	queue     *queue.Client
	events    *events.Broker
	metrics   *metrics.Metrics
	logger    *slog.Logger
	validator TargetValidator
	router    chi.Router
}

const eventsPath = "/api/v1/events"

func New(cfg config.Config, repository *store.Store, workQueue *queue.Client, broker *events.Broker, telemetry *metrics.Metrics, logger *slog.Logger) *Server {
	server := &Server{
		config: cfg, store: repository, queue: workQueue, events: broker,
		metrics: telemetry, logger: logger,
		validator: TargetValidator{FixtureOrigin: cfg.FixtureOrigin},
	}
	server.router = server.routes()
	return server
}

func (s *Server) Handler() http.Handler { return s.router }

func (s *Server) routes() chi.Router {
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.RealIP)
	router.Use(middleware.Recoverer)
	router.Use(timeoutExceptEvents(30 * time.Second))
	router.Use(s.cors)
	router.Use(s.instrument)
	router.Get("/healthz", s.health)
	router.Get("/readyz", s.ready)
	router.Handle("/metrics", promhttp.HandlerFor(s.metrics.Registry, promhttp.HandlerOpts{}))

	router.Route("/api/v1", func(api chi.Router) {
		api.Post("/monitors", s.createMonitor)
		api.Get("/monitors", s.listMonitors)
		api.Get("/monitors/{monitorID}", s.getMonitor)
		api.Post("/monitors/{monitorID}/confirm", s.confirmMonitor)
		api.Patch("/monitors/{monitorID}", s.patchMonitor)
		api.Post("/monitors/{monitorID}/checks", s.enqueueCheck)
		api.Post("/monitors/{monitorID}/reviews/{revisionID}/accept", s.acceptRevision)
		api.Post("/monitors/{monitorID}/reviews/{revisionID}/reject", s.rejectRevision)
		api.Get("/executions/{executionID}", s.getExecution)
		api.Get("/artifacts/{artifactID}", s.getArtifact)
		api.Get("/events", s.streamEvents)
	})

	router.Route("/internal/v1", func(internal chi.Router) {
		internal.Use(s.workerAuthentication)
		internal.Get("/executions/{executionID}/input", s.executionInput)
		internal.Post("/executions/{executionID}/result", s.executionResult)
	})
	s.mountWeb(router)
	return router
}

func timeoutExceptEvents(timeout time.Duration) func(http.Handler) http.Handler {
	limited := middleware.Timeout(timeout)
	return func(next http.Handler) http.Handler {
		limitedHandler := limited(next)
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			if request.URL.Path == eventsPath {
				next.ServeHTTP(response, request)
				return
			}
			limitedHandler.ServeHTTP(response, request)
		})
	}
}

func (s *Server) createMonitor(response http.ResponseWriter, request *http.Request) {
	var body struct {
		URL             string `json:"url"`
		Intent          string `json:"intent"`
		IntervalMinutes int    `json:"intervalMinutes"`
	}
	if !decodeJSON(response, request, &body) {
		return
	}
	if strings.TrimSpace(body.Intent) == "" || len(body.Intent) > 2000 {
		writeError(response, http.StatusBadRequest, "intent must contain 1 to 2000 characters")
		return
	}
	canonicalURL, err := s.validator.Validate(request.Context(), body.URL)
	if err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	if body.IntervalMinutes == 0 {
		body.IntervalMinutes = s.config.DefaultInterval
	}
	if body.IntervalMinutes < s.config.MinInterval || body.IntervalMinutes > 525600 {
		writeError(response, http.StatusBadRequest, fmt.Sprintf("intervalMinutes must be between %d and 525600", s.config.MinInterval))
		return
	}
	monitor, execution, err := s.store.CreateMonitor(request.Context(), store.CreateMonitorParams{
		URL: canonicalURL, Intent: strings.TrimSpace(body.Intent), IntervalMinutes: body.IntervalMinutes,
		Traceparent: request.Header.Get("traceparent"),
	})
	if err != nil {
		s.internalError(response, "create monitor", err)
		return
	}
	s.events.Publish("monitor.created", map[string]any{"monitorId": monitor.ID, "executionId": execution.ID})
	writeJSON(response, http.StatusAccepted, map[string]any{"monitor": monitor, "execution": execution})
}

func (s *Server) listMonitors(response http.ResponseWriter, request *http.Request) {
	limit := boundedInteger(request.URL.Query().Get("limit"), 50, 1, 200)
	offset := boundedInteger(request.URL.Query().Get("offset"), 0, 0, 1000000)
	items, err := s.store.ListMonitors(request.Context(), limit, offset)
	if err != nil {
		s.internalError(response, "list monitors", err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"items": items, "limit": limit, "offset": offset})
}

func (s *Server) getMonitor(response http.ResponseWriter, request *http.Request) {
	id, ok := pathUUID(response, request, "monitorID")
	if !ok {
		return
	}
	detail, err := s.store.GetMonitorDetail(request.Context(), id)
	if err != nil {
		s.storeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, detail)
}

func (s *Server) confirmMonitor(response http.ResponseWriter, request *http.Request) {
	monitorID, ok := pathUUID(response, request, "monitorID")
	if !ok {
		return
	}
	var body struct {
		RevisionID uuid.UUID       `json:"revisionId"`
		Condition  json.RawMessage `json:"condition"`
	}
	if !decodeJSON(response, request, &body) {
		return
	}
	if body.RevisionID == uuid.Nil || !validJSONObject(body.Condition) {
		writeError(response, http.StatusBadRequest, "revisionId and a JSON object condition are required")
		return
	}
	if err := validatePriceCondition(body.Condition); err != nil {
		writeError(response, http.StatusBadRequest, err.Error())
		return
	}
	monitor, err := s.store.ConfirmMonitor(request.Context(), monitorID, store.ConfirmMonitorParams{RevisionID: body.RevisionID, Condition: body.Condition})
	if err != nil {
		s.storeError(response, err)
		return
	}
	s.events.Publish("monitor.confirmed", map[string]any{"monitorId": monitorID, "revisionId": body.RevisionID})
	writeJSON(response, http.StatusOK, monitor)
}

func (s *Server) patchMonitor(response http.ResponseWriter, request *http.Request) {
	monitorID, ok := pathUUID(response, request, "monitorID")
	if !ok {
		return
	}
	var body struct {
		IntervalMinutes *int            `json:"intervalMinutes"`
		Condition       json.RawMessage `json:"condition"`
		Action          string          `json:"action"`
	}
	if !decodeJSON(response, request, &body) {
		return
	}
	if body.IntervalMinutes != nil && (*body.IntervalMinutes < s.config.MinInterval || *body.IntervalMinutes > 525600) {
		writeError(response, http.StatusBadRequest, "intervalMinutes is outside the allowed range")
		return
	}
	if len(body.Condition) > 0 && !validJSONObject(body.Condition) {
		writeError(response, http.StatusBadRequest, "condition must be a JSON object")
		return
	}
	if len(body.Condition) > 0 {
		if err := validatePriceCondition(body.Condition); err != nil {
			writeError(response, http.StatusBadRequest, err.Error())
			return
		}
	}
	monitor, err := s.store.PatchMonitor(request.Context(), monitorID, store.PatchMonitorParams{
		IntervalMinutes: body.IntervalMinutes, Condition: body.Condition, Action: body.Action,
	})
	if err != nil {
		s.storeError(response, err)
		return
	}
	s.events.Publish("monitor.updated", map[string]any{"monitorId": monitorID})
	writeJSON(response, http.StatusOK, monitor)
}

func (s *Server) enqueueCheck(response http.ResponseWriter, request *http.Request) {
	monitorID, ok := pathUUID(response, request, "monitorID")
	if !ok {
		return
	}
	idempotencyKey := strings.TrimSpace(request.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" || len(idempotencyKey) > 200 {
		writeError(response, http.StatusBadRequest, "Idempotency-Key header is required and must be at most 200 characters")
		return
	}
	execution, created, err := s.store.EnqueueCheck(request.Context(), monitorID, idempotencyKey, request.Header.Get("traceparent"))
	if err != nil {
		s.storeError(response, err)
		return
	}
	if created {
		s.events.Publish("execution.queued", map[string]any{"monitorId": monitorID, "executionId": execution.ID})
	}
	writeJSON(response, http.StatusAccepted, map[string]any{"execution": execution, "created": created})
}

func (s *Server) acceptRevision(response http.ResponseWriter, request *http.Request) {
	s.reviewRevision(response, request, true)
}

func (s *Server) rejectRevision(response http.ResponseWriter, request *http.Request) {
	s.reviewRevision(response, request, false)
}

func (s *Server) reviewRevision(response http.ResponseWriter, request *http.Request, accept bool) {
	monitorID, ok := pathUUID(response, request, "monitorID")
	if !ok {
		return
	}
	revisionID, ok := pathUUID(response, request, "revisionID")
	if !ok {
		return
	}
	monitor, err := s.store.ReviewRevision(request.Context(), monitorID, revisionID, accept)
	if err != nil {
		s.storeError(response, err)
		return
	}
	eventType := "revision.rejected"
	if accept {
		eventType = "revision.accepted"
	}
	s.events.Publish(eventType, map[string]any{"monitorId": monitorID, "revisionId": revisionID})
	writeJSON(response, http.StatusOK, monitor)
}

func (s *Server) getExecution(response http.ResponseWriter, request *http.Request) {
	id, ok := pathUUID(response, request, "executionID")
	if !ok {
		return
	}
	detail, err := s.store.GetExecutionDetail(request.Context(), id)
	if err != nil {
		s.storeError(response, err)
		return
	}
	for index := range detail.Artifacts {
		detail.Artifacts[index].URL = "/api/v1/artifacts/" + detail.Artifacts[index].ID.String()
	}
	writeJSON(response, http.StatusOK, detail)
}

func (s *Server) executionInput(response http.ResponseWriter, request *http.Request) {
	id, ok := pathUUID(response, request, "executionID")
	if !ok {
		return
	}
	input, err := s.store.GetExecutionInput(request.Context(), id)
	if err != nil {
		s.storeError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, input)
}

func (s *Server) executionResult(response http.ResponseWriter, request *http.Request) {
	id, ok := pathUUID(response, request, "executionID")
	if !ok {
		return
	}
	var result domain.ExecutionResult
	if !decodeJSON(response, request, &result) {
		return
	}
	if len(result.Plan) > 0 && !json.Valid(result.Plan) {
		writeError(response, http.StatusBadRequest, "plan must be valid JSON")
		return
	}
	execution, accepted, err := s.store.ApplyResult(request.Context(), id, result)
	if err != nil {
		if errors.Is(err, store.ErrInvalidResult) {
			writeError(response, http.StatusBadRequest, err.Error())
			return
		}
		s.storeError(response, err)
		return
	}
	if accepted {
		s.metrics.ExecutionResults.WithLabelValues(string(execution.Kind), execution.State).Inc()
		if isTransientRetryResult(execution, result) {
			outcome := "requeued"
			if execution.Attempt >= s.config.ExecutionMaxAttempts {
				outcome = "terminal"
			}
			s.metrics.ExecutionRetries.WithLabelValues(
				string(execution.Kind), result.FailureClassification, outcome,
			).Inc()
		}
		s.events.Publish("execution.completed", map[string]any{"monitorId": execution.MonitorID, "executionId": execution.ID, "state": execution.State})
	}
	writeJSON(response, http.StatusOK, map[string]any{"execution": execution, "accepted": accepted})
}

func isTransientRetryResult(execution domain.Execution, result domain.ExecutionResult) bool {
	return result.Status == "failed" &&
		(execution.Kind == domain.ExecutionCompile || execution.Kind == domain.ExecutionRepair) &&
		(result.FailureClassification == "transient_infrastructure" || result.FailureClassification == "rate_limited")
}

func (s *Server) getArtifact(response http.ResponseWriter, request *http.Request) {
	id, ok := pathUUID(response, request, "artifactID")
	if !ok {
		return
	}
	artifact, err := s.store.GetArtifact(request.Context(), id)
	if err != nil {
		s.storeError(response, err)
		return
	}
	cleanKey := filepath.Clean(artifact.StorageKey)
	if filepath.IsAbs(cleanKey) || cleanKey == ".." || strings.HasPrefix(cleanKey, ".."+string(filepath.Separator)) {
		writeError(response, http.StatusNotFound, "artifact not found")
		return
	}
	root, err := filepath.Abs(s.config.ArtifactRoot)
	if err != nil {
		s.internalError(response, "resolve artifact root", err)
		return
	}
	path := filepath.Join(root, cleanKey)
	if !strings.HasPrefix(path, root+string(filepath.Separator)) {
		writeError(response, http.StatusNotFound, "artifact not found")
		return
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
		writeError(response, http.StatusNotFound, "artifact not found")
		return
	}
	response.Header().Set("Content-Type", artifact.ContentType)
	response.Header().Set("Cache-Control", "private, max-age=300")
	http.ServeFile(response, request, resolved)
}

func (s *Server) streamEvents(response http.ResponseWriter, request *http.Request) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "streaming is unavailable")
		return
	}
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("X-Accel-Buffering", "no")
	channel, unsubscribe := s.events.Subscribe()
	defer unsubscribe()
	s.metrics.SSEConnections.Inc()
	defer s.metrics.SSEConnections.Dec()
	fmt.Fprint(response, ": connected\n\n")
	flusher.Flush()
	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case payload := <-channel:
			fmt.Fprintf(response, "event: update\ndata: %s\n\n", payload)
			flusher.Flush()
		case <-keepalive.C:
			fmt.Fprint(response, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) ready(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeError(response, http.StatusServiceUnavailable, "postgres unavailable")
		return
	}
	if err := s.queue.Ping(ctx); err != nil {
		writeError(response, http.StatusServiceUnavailable, "nats unavailable")
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) workerAuthentication(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		received := []byte(request.Header.Get("X-Worker-Token"))
		expected := []byte(s.config.WorkerToken)
		if len(received) != len(expected) || subtle.ConstantTimeCompare(received, expected) != 1 {
			writeError(response, http.StatusUnauthorized, "invalid worker token")
			return
		}
		next.ServeHTTP(response, request)
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Origin") == s.config.AllowedOrigin {
			response.Header().Set("Access-Control-Allow-Origin", s.config.AllowedOrigin)
			response.Header().Set("Vary", "Origin")
			response.Header().Set("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, traceparent")
			response.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
		}
		if request.Method == http.MethodOptions {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(response, request)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusWriter) Flush() {
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (writer *statusWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func (writer *statusWriter) WriteHeader(status int) {
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (s *Server) instrument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		started := time.Now()
		writer := &statusWriter{ResponseWriter: response, status: http.StatusOK}
		next.ServeHTTP(writer, request)
		route := chi.RouteContext(request.Context()).RoutePattern()
		if route == "" {
			route = "unmatched"
		}
		s.metrics.HTTPRequests.WithLabelValues(request.Method, route, strconv.Itoa(writer.status)).Inc()
		s.metrics.HTTPDuration.WithLabelValues(request.Method, route).Observe(time.Since(started).Seconds())
	})
}

func (s *Server) mountWeb(router chi.Router) {
	index := filepath.Join(s.config.WebRoot, "index.html")
	if _, err := os.Stat(index); err != nil {
		router.Get("/", func(response http.ResponseWriter, _ *http.Request) {
			writeJSON(response, http.StatusOK, map[string]string{"name": "Price Scout API", "version": "v1"})
		})
		return
	}
	files := http.FileServer(http.Dir(s.config.WebRoot))
	router.Get("/*", func(response http.ResponseWriter, request *http.Request) {
		if isReservedServicePath(request.URL.Path) {
			writeError(response, http.StatusNotFound, "route not found")
			return
		}
		requested := filepath.Join(s.config.WebRoot, filepath.Clean(request.URL.Path))
		if info, err := os.Stat(requested); err == nil && !info.IsDir() {
			files.ServeHTTP(response, request)
			return
		}
		http.ServeFile(response, request, index)
	})
}

func isReservedServicePath(path string) bool {
	for _, prefix := range []string{"/api", "/internal", "/healthz", "/readyz", "/metrics"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}

func decodeJSON(response http.ResponseWriter, request *http.Request, destination any) bool {
	request.Body = http.MaxBytesReader(response, request.Body, 1<<20)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeError(response, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(response, http.StatusBadRequest, "request body must contain one JSON object")
		return false
	}
	return true
}

func validJSONObject(raw json.RawMessage) bool {
	if !json.Valid(raw) {
		return false
	}
	var object map[string]any
	return json.Unmarshal(raw, &object) == nil && object != nil
}

func validatePriceCondition(raw json.RawMessage) error {
	var condition struct {
		PriceBelowMinor  int64             `json:"priceBelowMinor"`
		Currency         string            `json:"currency"`
		RequireInStock   *bool             `json:"requireInStock"`
		RequestedVariant map[string]string `json:"requestedVariant"`
	}
	if err := json.Unmarshal(raw, &condition); err != nil {
		return errors.New("condition must be a JSON object")
	}
	if condition.PriceBelowMinor <= 0 {
		return errors.New("condition.priceBelowMinor must be a positive integer in minor currency units")
	}
	supportedCurrencies := map[string]bool{"USD": true, "CAD": true, "EUR": true, "GBP": true, "AUD": true}
	if !supportedCurrencies[condition.Currency] {
		return errors.New("condition.currency must be one of USD, CAD, EUR, GBP, or AUD; v1 supports two-decimal currencies only")
	}
	if condition.RequireInStock == nil {
		return errors.New("condition.requireInStock is required")
	}
	for key, value := range condition.RequestedVariant {
		if strings.TrimSpace(key) == "" || strings.TrimSpace(value) == "" {
			return errors.New("condition.requestedVariant keys and values cannot be empty")
		}
	}
	return nil
}

func pathUUID(response http.ResponseWriter, request *http.Request, name string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(request, name))
	if err != nil {
		writeError(response, http.StatusBadRequest, name+" must be a UUID")
		return uuid.Nil, false
	}
	return id, true
}

func boundedInteger(raw string, fallback, minimum, maximum int) int {
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return fallback
	}
	return value
}

func (s *Server) storeError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(response, http.StatusNotFound, "resource not found")
	case errors.Is(err, store.ErrConflict):
		writeError(response, http.StatusConflict, "resource state does not allow this operation")
	default:
		s.internalError(response, "database operation", err)
	}
}

func (s *Server) internalError(response http.ResponseWriter, operation string, err error) {
	s.logger.Error(operation, "error", err)
	writeError(response, http.StatusInternalServerError, "internal server error")
}

func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]any{"error": map[string]any{"status": status, "message": message}})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
