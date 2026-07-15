package queue

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/nmhossain02/price-scout/internal/store"
	"github.com/nats-io/nats.go"
)

const StreamName = "SCOUT_WORK"

type Client struct {
	connection *nats.Conn
	jetstream  nats.JetStreamContext
}

func Connect(url string) (*Client, error) {
	connection, err := nats.Connect(url,
		nats.Name("price-scout-control-plane"),
		nats.Timeout(5*time.Second),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("connect to nats: %w", err)
	}
	jetstream, err := connection.JetStream()
	if err != nil {
		connection.Close()
		return nil, fmt.Errorf("open jetstream: %w", err)
	}
	client := &Client{connection: connection, jetstream: jetstream}
	if err := client.ensureStream(); err != nil {
		connection.Close()
		return nil, err
	}
	return client, nil
}

func (c *Client) ensureStream() error {
	_, err := c.jetstream.StreamInfo(StreamName)
	if err == nil {
		return nil
	}
	if !errors.Is(err, nats.ErrStreamNotFound) {
		return fmt.Errorf("inspect jetstream: %w", err)
	}
	_, err = c.jetstream.AddStream(&nats.StreamConfig{
		Name:        StreamName,
		Description: "Price Scout compile, check, and repair work",
		Subjects:    []string{"scout.monitor.*"},
		Retention:   nats.WorkQueuePolicy,
		Storage:     nats.FileStorage,
		Duplicates:  10 * time.Minute,
		MaxAge:      7 * 24 * time.Hour,
	})
	if err != nil && !errors.Is(err, nats.ErrStreamNameAlreadyInUse) {
		return fmt.Errorf("create jetstream: %w", err)
	}
	return nil
}

func (c *Client) PublishOutbox(ctx context.Context, message store.OutboxMessage) error {
	natsMessage := nats.NewMsg(message.Subject)
	natsMessage.Data = message.Payload
	natsMessage.Header.Set(nats.MsgIdHdr, fmt.Sprintf("outbox-%d", message.ID))
	if _, err := c.jetstream.PublishMsg(natsMessage, nats.Context(ctx)); err != nil {
		return fmt.Errorf("publish %s: %w", message.Subject, err)
	}
	return nil
}

func (c *Client) Ping(ctx context.Context) error {
	if c.connection.IsClosed() {
		return errors.New("nats connection is closed")
	}
	return c.connection.FlushWithContext(ctx)
}

func (c *Client) Close() {
	if c.connection != nil {
		c.connection.Drain()
		c.connection.Close()
	}
}
