package migrations

import "embed"

// FS contains the database migrations used by the API and migration command.
//
//go:embed *.sql
var FS embed.FS
