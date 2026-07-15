package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/nmhossain02/price-scout/internal/config"
)

func TestWebFallbackDoesNotHideUnknownServiceRoutes(t *testing.T) {
	webRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(webRoot, "index.html"), []byte("<h1>Price Scout console</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := &Server{config: config.Config{WebRoot: webRoot}}
	router := chi.NewRouter()
	server.mountWeb(router)

	for _, path := range []string{
		"/api/v1/not-a-route",
		"/internal/v1/not-a-route",
		"/healthz/details",
		"/readyz/details",
		"/metrics/extra",
	} {
		t.Run(path, func(t *testing.T) {
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
			if response.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", response.Code)
			}
			if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
				t.Fatalf("content type = %q, want structured JSON error", contentType)
			}
			body, _ := io.ReadAll(response.Body)
			if !strings.Contains(string(body), `"status":404`) {
				t.Fatalf("body = %q, want structured 404", body)
			}
		})
	}

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/monitors/client-side-route", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Price Scout console") {
		t.Fatalf("SPA route did not receive index: status=%d body=%q", response.Code, response.Body.String())
	}
}
