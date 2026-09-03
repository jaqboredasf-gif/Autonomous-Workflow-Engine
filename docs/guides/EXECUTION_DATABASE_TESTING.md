# Execution Database Testing Guide

This guide explains how to start, stop, and reset the local Postgres execution database for AWE integration testing.

## Overview

The execution database harness provides a **disposable, localhost-only Postgres 16 instance** for testing AWE's durable execution layer and repository adapters.

- **Credentials**: Synthetic local credentials only (never production)
- **Network**: Localhost (127.0.0.1) only, not accessible from other machines
- **Data**: Stored in a Docker volume, persistent across container restarts
- **Healthcheck**: Automated readiness probe via `pg_isready`

## Quick Start

### Start the Database

```bash
bash scripts/execution-db-start.sh
```

Output:
```
Starting execution database...
Waiting for database to be healthy...
✓ Database is healthy and ready

Database credentials:
  Host: localhost
  Port: 5432
  Database: awe_execution
  User: awe_dev

Connection string:
  postgresql://awe_dev:[REDACTED]@localhost:5432/awe_execution
```

### Check Status

```bash
bash scripts/execution-db-status.sh
```

### Stop the Database

```bash
bash scripts/execution-db-stop.sh
```

Stops and removes the container. Data persists in the volume.

### Reset the Database

```bash
bash scripts/execution-db-reset.sh
```

**WARNING**: Destroys all local data. Use only when you need a clean slate.

The script prompts for confirmation and waits 5 seconds before proceeding.

## Environment Variables

### For Local Integration Testing

Copy the example environment file:

```bash
cp .env.execution-test.example .env.execution-test
source .env.execution-test
```

The file contains:

```bash
export DATABASE_URL=postgresql://awe_dev:[REDACTED]@localhost:5432/awe_execution
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=awe_execution
export POSTGRES_USER=awe_dev
export POSTGRES_PASSWORD=dev_local_only_do_not_use_in_production
```

### For Claude Code

When running integration tests in Claude Code, use:

```
postgresql://awe_dev:dev_local_only_do_not_use_in_production@localhost:5432/awe_execution
```

Or set the environment variable:

```bash
export DATABASE_URL=postgresql://awe_dev:dev_local_only_do_not_use_in_production@localhost:5432/awe_execution
```

## Docker Compose Configuration

The harness is defined in `compose.execution-db.yml`:

- **Image**: `postgres:16-alpine` (lightweight, ~40MB)
- **Port**: `127.0.0.1:5432:5432` (localhost only)
- **Volume**: `awe-execution-db-data` (persistent, auto-created)
- **Network**: `awe-local` (bridge network)
- **Healthcheck**: Runs `pg_isready` every 2 seconds, up to 10 retries

## Verification Checklist

After starting, verify:

1. **Container is running**:
   ```bash
   docker ps --filter "name=awe-execution-db"
   ```

2. **Database is healthy**:
   ```bash
   bash scripts/execution-db-status.sh
   ```

3. **Can connect via psql** (if installed):
   ```bash
   psql -U awe_dev -d awe_execution -h localhost -c "SELECT 1;"
   ```
   Password: `dev_local_only_do_not_use_in_production`

4. **Port is not in use** before starting:
   ```bash
   lsof -i :5432
   ```

## Troubleshooting

### Port 5432 Already in Use

If port 5432 is already in use (e.g., local Postgres), either:

1. Stop the conflicting service
2. Edit `compose.execution-db.yml` to use a different port (e.g., `127.0.0.1:5433:5432`)

### Database Won't Become Healthy

Check logs:

```bash
docker logs awe-execution-db
```

Common causes:
- Port conflict
- Insufficient disk space
- Docker daemon not running

### Container Exits Immediately

```bash
docker inspect awe-execution-db
docker logs awe-execution-db
```

### Lost Connection After Container Restart

Data persists, but you may need to reconnect. Restart:

```bash
docker compose -f compose.execution-db.yml restart execution-db
```

## Integration Test Workflow

1. **Start the database**:
   ```bash
   bash scripts/execution-db-start.sh
   ```

2. **Source environment** (optional):
   ```bash
   source .env.execution-test
   ```

3. **Run integration tests** (e.g., in Claude Code or directly):
   ```bash
   DATABASE_URL="postgresql://awe_dev:dev_local_only_do_not_use_in_production@localhost:5432/awe_execution" \
   node scripts/test-execution-integration.mjs
   ```

4. **Clean up** when done:
   ```bash
   bash scripts/execution-db-stop.sh
   ```

## Notes

- **No migrations are run** by default. Schema is managed by application code.
- **Synthetic credentials only** — never production data.
- **Localhost-only** — not exposed on the network.
- **Disposable** — designed to be easily reset and destroyed.
- **Development only** — do not use in CI/CD or production.

## Files

- `compose.execution-db.yml` — Docker Compose configuration
- `scripts/execution-db-start.sh` — Start the database
- `scripts/execution-db-stop.sh` — Stop the database
- `scripts/execution-db-reset.sh` — Reset the database (destroy data)
- `scripts/execution-db-status.sh` — Check status
- `.env.execution-test.example` — Example environment variables
