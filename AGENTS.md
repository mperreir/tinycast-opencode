# AGENTS.md - AI Coding Assistant Guidelines

This document provides context for AI coding assistants working on this codebase.

## Project Overview

A Raycast extension for OpenCode - an AI coding assistant. The extension provides quick access to OpenCode from Raycast with session management, full-text search, and terminal handoff.

## Tech Stack

- **Runtime**: Raycast Extension (React + Node.js)
- **Language**: TypeScript (strict mode)
- **Package Manager**: bun (preferred) or npm
- **Build**: Raycast CLI (`ray build`)
- **Search**: FlexSearch for session indexing

## Project Structure

```
src/
  ask.tsx              # Main "Ask OpenCode" command - question input, response display
  sessions.tsx         # Session list with search, delete, handoff actions
  projects.tsx         # Recent projects picker
  
  hooks/
    useOpenCode.ts     # Core hook - connects to OpenCode server, manages sessions
    useProviders.ts    # Fetches available AI providers/models
    useProjects.ts     # Persists recently used project directories
    useSessionSearch.ts # FlexSearch indexing with LocalStorage caching
    usePathAutocomplete.ts # @path autocomplete with filesystem traversal
    
  lib/
    opencode.ts        # Client facade - picks the v1 or v2 client after server discovery
    opencode-v1.ts     # OpenCode v1 API client (legacy routes, no auth)
    opencode-v2.ts     # OpenCode v2 API client (/api routes, Basic auth, normalized shapes)
    openchamber.ts     # Discovers OpenChamber-managed opencode instances (manifests, service.json, app proxy)
    credentials.ts     # Generic password recovery (lsof port->pid map, ps eww process env)
    types.ts           # Normalized API types shared by both clients
    handoff.ts         # Terminal app launchers (Ghostty, iTerm, etc.)
    server-manager.ts  # Locates/auto-starts the OpenCode server and caches its port + password
```

## Key Patterns

### Raycast API Usage

```typescript
import { List, ActionPanel, Action, showToast, Toast, getPreferenceValues } from "@raycast/api"
```

- Use `getPreferenceValues<T>()` for typed preferences
- Use `showToast()` for user feedback
- Use `showHUD()` for quick confirmations
- Use `LocalStorage` for persistent caching

### OpenCode API

The extension talks to the OpenCode server through `getClient()` in `lib/opencode.ts`, a facade that returns a v1 or v2 client depending on the server's API version. Both clients normalize responses to the shared types in `lib/types.ts`, so hooks never see API differences.

Server discovery (`ensureServer()` in `server-manager.ts`, in order):
1. **OpenChamber-managed instances** - reads `~/.config/openchamber/managed-opencode/*.json` (`{pid, port}`), checks the pid is alive, extracts `OPENCODE_SERVER_PASSWORD` from the process env (`ps eww`)
2. **v2 background service** - reads `~/.local/state/opencode/service.json` (`{url, pid, password}`); used by the TUI, the official desktop app, and OpenChamber. Also checks the desktop app's `service-local.json` channel
3. **OpenChamber app proxy** - finds the port the OpenChamber app listens on via `lsof`; it proxies the v2 API without a password
4. **Stored connection** - `LocalStorage` keys `opencode-server-port` / `opencode-server-password`; a 401 triggers password recovery from the listening process env
5. **Default port 4096** - same 401 recovery
6. **Running opencode processes** - any `opencode` listener on any port (manual `opencode serve` in a terminal), found via the `lsof` port→pid map, with the same 401→`ps eww` recovery
7. **Auto-start** - spawns `opencode serve --port <free port in 19000-19999>`; for v2 binaries a random `OPENCODE_SERVER_PASSWORD` is generated and injected

**Password recovery** (`credentials.ts`): one `lsof -nP -iTCP -sTCP:LISTEN` call builds a port→pid map; a v2 endpoint answering 401 gets its password from the listening process environment (`ps eww`, same-user only) via `OPENCODE_SERVER_PASSWORD`/`OPENCODE_PASSWORD`. This is the universal mechanism - it works for any server started with that env var. A plain `opencode serve` with no env var generates an ephemeral random password that no tool can recover (the official web UI uses interactive pairing for it); in that case the extension auto-starts its own server and shows an info toast explaining why.

API version detection (`detectApiVersion()`): v2 is identified by `GET /api/info` returning JSON (v2 serves its web UI HTML on unknown paths, so v1 routes fail JSON parsing); v1 by `GET /global/health`.

V1 client routes: `/global/health`, `/session`, `/session/:id/message`, `/agent`, `/command`, `/provider` (no auth).

V2 client routes (all under `/api`, `Authorization: Basic opencode:<password>`, responses wrapped in `{data}`):
- `health()` - `GET /api/info`
- `listSessions()` - `GET /api/session?limit=200&order=desc&parentID=null`
- `createSession(title?)` - `POST /api/session` with `{title, location: {directory}}`
- `getSession(id)` / `deleteSession(id)` - `GET|DELETE /api/session/:id`
- `getSessionMessages(id, limit?)` - `GET /api/session/:id/message`
- `sendPrompt(id, text, {agent, model})` - `POST /api/session/:id/agent` + `/model` + `/prompt`, then polls `/api/session/active` until the session is idle (v2 prompts are async)
- `abortSession(id)` - `POST /api/session/:id/interrupt`
- `listAgents()` / `listCommands()` - `GET /api/agent`, `GET /api/command`
- `listProviders()` - builds the v1 provider shape from flat `GET /api/provider` + `GET /api/model`

```typescript
const client = await getClient()
const sessions = await client.listSessions()
const messages = await client.getSessionMessages(sessionId, limit)
```

### Terminal Handoff

The `handoff.ts` module launches terminals with session commands:

```typescript
export type TerminalApp = "default" | "ghostty" | "iterm" | "warp" | "alacritty" | "kitty" | "terminal" | "hyper"

await handoffToOpenCode(sessionId, "terminal", workingDir, terminalApp)
```

Each terminal has a specific launch strategy (AppleScript, CLI flags, etc.).

The "desktop" method opens the official OpenCode desktop app via its `opencode://open-project` URL scheme, falling back to copying the CLI command if the app is not installed.

### OpenChamber Handoff

The `handoffToOpenChamber()` function opens a session in OpenChamber, which exposes no deep links and ships no CLI:

```typescript
await handoffToOpenChamber("web")      // open the app's web UI in the browser
await handoffToOpenChamber("desktop")  // launch/activate the OpenChamber app
```

- **web** - finds the port the OpenChamber app listens on (`findAppServerPort()` in `openchamber.ts`) and opens `http://127.0.0.1:<port>` in the default browser. The app's web UI reads no session parameter from the URL, so it opens at the root and the user picks the session in the sidebar. If the app is not running it is launched first, then the port is polled for up to 10 s.
- **desktop** - runs `open -a OpenChamber`; the app window is the same web UI.

### Session Search

FlexSearch indexes sessions progressively:

```typescript
const { searchText, setSearchText, filteredSessions, isIndexing } = useSessionSearch(sessions)
```

- Indexes title + directory + last 10 message texts
- Caches to LocalStorage with timestamp validation
- Re-indexes when session `updated` timestamp changes

## Preferences Schema

Defined in `package.json`:

| Name | Type | Description |
|------|------|-------------|
| `defaultProject` | directory | Default working directory |
| `handoffMethod` | dropdown | "terminal" or "desktop" |
| `terminalApp` | dropdown | Terminal app selection |
| `autoStartServer` | checkbox | Auto-start OpenCode server |

## Common Tasks

### Adding a New Terminal

1. Add to `TerminalApp` type in `handoff.ts`
2. Add config to `TERMINAL_CONFIGS` with `openCommand` function
3. Add dropdown option in `package.json` preferences

### Adding a New Command

1. Create new `.tsx` file in `src/`
2. Add command entry in `package.json` under `commands`
3. Export default React component

### Modifying Search Behavior

Edit `useSessionSearch.ts`:
- `BATCH_SIZE` controls indexing chunks
- `MESSAGES_TO_INDEX` controls depth
- `buildSearchText()` controls what gets indexed

## Code Style

- No comments unless explaining complex algorithms
- Self-documenting function and variable names
- Prefer early returns over nested conditionals
- Use async/await over .then() chains
- Type all function parameters and return values

## Testing

```bash
# Type check
npx tsc --noEmit

# Run in dev mode
bun run dev
# Then test in Raycast
```

## Common Gotchas

1. **Raycast environment**: Extensions run in sandboxed Node.js, not browser
2. **execAsync for terminals**: Use `child_process.exec` with proper escaping
3. **AppleScript escaping**: Double-escape quotes for osascript commands
4. **LocalStorage limits**: Raycast LocalStorage has size limits - index selectively
5. **Server connection**: `getClient()` requires the OpenCode server; `ensureServer()` discovers an existing one (OpenChamber-managed, v2 service, stored port, 4096) before auto-starting on a free port in `19000-19999` (stored in `opencode-server-port` + `opencode-server-password` in LocalStorage). Never hardcode a URL.
6. **V2 authentication**: the v2 API requires `Authorization: Basic opencode:<password>`. The password comes from the discovered source (process env, `service.json`, or generated at auto-start). The OpenChamber app proxy needs no password.
7. **V2 shapes differ from v1**: sessions carry `location.directory` (not `directory`), messages are flat `{id, type, content[]}` (not `{info, parts}`), providers/models are flat lists. The v2 client normalizes all of this to the v1 shapes in `types.ts` - keep it that way.
8. **Unreachable v2 servers**: a plain `opencode serve` started without `OPENCODE_SERVER_PASSWORD` uses an ephemeral random password that no external tool can recover (the official web UI uses interactive pairing for it). Discovery reports such ports as unreachable, the extension falls back to auto-start, and an info toast tells the user how to make their server reachable.

## Dependencies

Core:
- `@raycast/api` - Raycast extension framework
- `@raycast/utils` - Utility hooks
- `flexsearch` - Full-text search indexing

Dev:
- `typescript` - Type checking
- `eslint` - Linting via Raycast config
