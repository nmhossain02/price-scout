package events

import (
	"encoding/json"
	"sync"
	"time"
)

type Event struct {
	Type string    `json:"type"`
	At   time.Time `json:"at"`
	Data any       `json:"data,omitempty"`
}

type Broker struct {
	mu          sync.RWMutex
	subscribers map[chan []byte]struct{}
}

func New() *Broker {
	return &Broker{subscribers: make(map[chan []byte]struct{})}
}

func (b *Broker) Subscribe() (<-chan []byte, func()) {
	channel := make(chan []byte, 32)
	b.mu.Lock()
	b.subscribers[channel] = struct{}{}
	b.mu.Unlock()
	return channel, func() {
		b.mu.Lock()
		if _, ok := b.subscribers[channel]; ok {
			delete(b.subscribers, channel)
			close(channel)
		}
		b.mu.Unlock()
	}
}

func (b *Broker) Publish(eventType string, data any) {
	payload, err := json.Marshal(Event{Type: eventType, At: time.Now().UTC(), Data: data})
	if err != nil {
		return
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	for subscriber := range b.subscribers {
		select {
		case subscriber <- payload:
		default:
			// A slow console must not block control-plane writes.
		}
	}
}
