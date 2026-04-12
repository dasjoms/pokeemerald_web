# Rebuild Development Paths (Old vs V2)

This repo currently contains **two** rebuild workspaces:

- `rebuild/` — existing rebuild implementation and scripts.
- `rebuild/v2/` — fresh-start scaffolding for restart work.

## Where active development should happen

Unless a task explicitly targets legacy rebuild behavior, new restart development should be done in:

- `rebuild/v2/server`
- `rebuild/v2/client`
- `rebuild/v2/shared`

## Running the existing rebuild path

- Server: `cd rebuild/server && cargo run`
- Client: `cd rebuild/client && npm run dev`

## Running the fresh-start v2 path

- Server: `cd rebuild/v2/server && cargo run`
- Client: `cd rebuild/v2/client && npm install && npm run dev`

### Optional environment overrides

- `V2_ASSET_ROOT` (default: `../../assets` from each v2 package)
- `V2_SERVER_BIND_ADDR` (default: `127.0.0.1:4100`)

By default, `rebuild/v2` reads extracted assets from `rebuild/assets`.
