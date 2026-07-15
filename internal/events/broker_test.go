package events

import (
	"encoding/json"
	"testing"
	"time"
)

func TestBrokerPublishesAndUnsubscribes(t *testing.T) {
	broker := New()
	channel, unsubscribe := broker.Subscribe()
	broker.Publish("monitor.created", map[string]string{"monitorId": "m-1"})
	select {
	case payload := <-channel:
		var event Event
		if err := json.Unmarshal(payload, &event); err != nil {
			t.Fatal(err)
		}
		if event.Type != "monitor.created" {
			t.Fatalf("event type = %q", event.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("event was not published")
	}
	unsubscribe()
}
