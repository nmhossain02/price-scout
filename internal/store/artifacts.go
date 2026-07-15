package store

import (
	"context"

	"github.com/google/uuid"
	"github.com/nmhossain02/price-scout/internal/domain"
)

func (s *Store) GetArtifact(ctx context.Context, id uuid.UUID) (domain.Artifact, error) {
	var artifact domain.Artifact
	err := s.pool.QueryRow(ctx, `SELECT id, execution_id, kind, storage_key, content_type,
        COALESCE(sha256,''), COALESCE(size_bytes,0), created_at FROM artifacts WHERE id=$1`, id).Scan(
		&artifact.ID, &artifact.ExecutionID, &artifact.Kind, &artifact.StorageKey,
		&artifact.ContentType, &artifact.SHA256, &artifact.SizeBytes, &artifact.CreatedAt,
	)
	return artifact, translateError(err)
}
