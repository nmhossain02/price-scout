package httpapi

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestTimeoutExceptEventsKeepsSSEConnected(t *testing.T) {
	router := chi.NewRouter()
	router.Use(timeoutExceptEvents(20 * time.Millisecond))
	router.Get(eventsPath, func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(response, ": connected\n\n")
		response.(http.Flusher).Flush()
		select {
		case <-time.After(75 * time.Millisecond):
			fmt.Fprint(response, "event: update\ndata: survived\n\n")
		case <-request.Context().Done():
			return
		}
	})

	server := httptest.NewServer(router)
	defer server.Close()
	response, err := server.Client().Get(server.URL + eventsPath)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "data: survived") {
		t.Fatalf("SSE stream was canceled by request timeout: status=%d body=%q", response.StatusCode, body)
	}
}

func TestTimeoutExceptEventsStillLimitsOtherRoutes(t *testing.T) {
	router := chi.NewRouter()
	router.Use(timeoutExceptEvents(10 * time.Millisecond))
	router.Get("/slow", func(_ http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/slow", nil))
	if response.Code != http.StatusGatewayTimeout {
		t.Fatalf("ordinary route status = %d, want %d", response.Code, http.StatusGatewayTimeout)
	}
}
