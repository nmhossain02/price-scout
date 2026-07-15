package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/nmhossain02/price-scout/migrations"
	"github.com/pressly/goose/v3"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrConflict      = errors.New("conflict")
	ErrInvalidResult = errors.New("invalid execution result")
)

type Store struct {
	pool                 *pgxpool.Pool
	alertChannels        []string
	maxExecutionAttempts int
}

type Options struct {
	AlertChannels        []string
	MaxExecutionAttempts int
}

func Open(ctx context.Context, databaseURL string, options Options) (*Store, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	config.ConnConfig.RuntimeParams["application_name"] = "price-scout"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	channels := make([]string, 0, len(options.AlertChannels))
	for _, channel := range options.AlertChannels {
		if channel == "webhook" || channel == "discord" {
			channels = append(channels, channel)
		}
	}
	maxExecutionAttempts := options.MaxExecutionAttempts
	if maxExecutionAttempts < 1 {
		maxExecutionAttempts = 3
	}
	return &Store{
		pool: pool, alertChannels: channels, maxExecutionAttempts: maxExecutionAttempts,
	}, nil
}

func (s *Store) Close() { s.pool.Close() }

func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

func (s *Store) Pool() *pgxpool.Pool { return s.pool }

func Migrate(ctx context.Context, databaseURL string) error {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open migration database: %w", err)
	}
	defer db.Close()
	lockConnection, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer lockConnection.Close()
	if _, err := lockConnection.ExecContext(ctx, `SELECT pg_advisory_lock(731947215)`); err != nil {
		return fmt.Errorf("lock migrations: %w", err)
	}
	defer lockConnection.ExecContext(context.Background(), `SELECT pg_advisory_unlock(731947215)`)
	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set migration dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db, "."); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	return nil
}

func translateError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
