# `rebuild/client`

TypeScript + PixiJS browser client target (render/input layer).

## Phase 1 controls

- Move: Arrow keys or WASD.
- Only walking inputs are sent to server (`WalkInput`).
- Optional prediction can be enabled with `?predict=1` in the URL.

## Run

```bash
npm ci
npm run dev
```

## Build / test

```bash
npm ci
npm run build
npm test
```

If `npm run build` fails with `TS2688: Cannot find type definition file for 'node'`,
dependencies were not fully installed. Re-run `npm ci` in `rebuild/client/` to restore
`@types/node` and other dev dependencies before building.
