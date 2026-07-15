FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.25-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY migrations/ ./migrations/
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/scout ./cmd/scout

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S -g 10001 scout && adduser -S -D -H -u 10001 -G scout scout && \
    mkdir -p /app/web /data/artifacts && chown -R scout:scout /app /data
COPY --from=build /out/scout /usr/local/bin/scout
COPY --from=web /src/web/dist/ /app/web/
USER scout
EXPOSE 8080
ENTRYPOINT ["scout"]
CMD ["api"]
