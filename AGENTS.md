# AGENTS.md — openfox-headroom

Paths relative to `openfox-plugins/openfox-headroom/`.

## Purpose

OpenFox context compression plugin via Headroom: automatic compression pipeline, prompt cache protection, transparent fail-open, and integrated dashboard modal.

## Stack

- TypeScript, ESM, tsup, vitest 3.x
- peerDep: `openfox` (not specified)

## Commands

```bash
npm run build      # tsup
npm test           # vitest run --passWithNoTests
npm run typecheck  # tsc --noEmit
```

## Project Map

```
src/
├── index.ts        # Plugin entry point (register, transforms, RPCs)
├── client.ts       # HeadroomClient (Headroom client)
└── index.test.ts   # Unit tests
```

## Where to Look What

- **Modify Headroom client** → `src/client.ts`
- **Add a setting** → `src/index.ts` (SETTINGS_SCHEMA)
- **Add an RPC** → `src/index.ts`

## Conventions

- `apiVersion: 2`, capabilities: `transforms`, `settings`, `rpc`, `ui`
- ESM build only via tsup
- `openfox` is externalized (provided by host)

## Cross-Project Dependencies

**Consumes**: `openfox/plugin` (PluginRegistry, PluginContext).

**Consumed by**: OpenFox (loaded as plugin).

**Touchpoints**:

- `src/index.ts` (register)
- `src/client.ts` (HeadroomClient)

## Known Gotchas

- `dist/index.js` is the entry point loaded by OpenFox, not `src/`.
- Headroom proxy must be running (default `http://127.0.0.1:8787`).
- Fail-open if proxy is unreachable (transparent fallback).
- 5s polling for header button status.
- Auto-start on OpenFox startup.

## Do Not Read / Do Not Touch

- `node_modules/`, `dist/`, `.git/`

## Further Reading

- [README.md](README.md) — overview

---

> After any change affecting structure, a command, a convention, an inter-project contract, or a primary flow, update this file in the same commit. If any information here is inaccurate, fix it.
