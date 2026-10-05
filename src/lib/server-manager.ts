import { spawn, exec } from "child_process"
import { promisify } from "util"
import { LocalStorage } from "@raycast/api"
import { existsSync } from "fs"
import { randomBytes } from "crypto"
import { homedir } from "os"
import path from "path"
import { ApiVersion, ServerConnection } from "./types"
import { findManagedInstances, findServiceRegistration, findAppServerPort } from "./openchamber"
import { listListeningTcpSockets, recoverPasswordForPort, ListeningSocket } from "./credentials"

const execAsync = promisify(exec)

const STORAGE_KEY_PORT = "opencode-server-port"
const STORAGE_KEY_PASSWORD = "opencode-server-password"
const DEFAULT_PORT = 4096
const PORT_RANGE_START = 19000
const PORT_RANGE_END = 19999

interface ProbeResult {
  ok: boolean
  unauthorized?: boolean
  version?: string
}

function authHeader(password: string): Record<string, string> {
  return {
    Authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
  }
}

async function probeV2(baseUrl: string, password?: string): Promise<ProbeResult> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)

    const response = await fetch(`${baseUrl}/api/info`, {
      headers: {
        Accept: "application/json",
        ...(password ? authHeader(password) : {}),
      },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (response.status === 401) {
      return { ok: false, unauthorized: true }
    }
    if (!response.ok) {
      return { ok: false }
    }

    const data = (await response.json()) as { version?: string }
    return data.version ? { ok: true, version: data.version } : { ok: false }
  } catch {
    return { ok: false }
  }
}

async function probeV1(baseUrl: string): Promise<ProbeResult> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)

    const response = await fetch(`${baseUrl}/global/health`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) {
      return { ok: false }
    }

    const data = (await response.json()) as { healthy: boolean; version: string }
    return data.healthy ? { ok: true, version: data.version } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/**
 * Probe a v2 endpoint, recovering the password from the listening
 * process environment when it answers 401. Works for any server started
 * with OPENCODE_SERVER_PASSWORD (manual serve, OpenChamber, desktop app).
 */
async function probeV2WithRecovery(
  baseUrl: string,
  port: number,
  portToPid: Map<number, number>,
  password?: string
): Promise<{ result: ProbeResult; password?: string }> {
  let result = await probeV2(baseUrl, password)
  if (!result.ok && result.unauthorized) {
    const recovered = await recoverPasswordForPort(port, portToPid)
    if (recovered && recovered !== password) {
      result = await probeV2(baseUrl, recovered)
      if (result.ok) {
        return { result, password: recovered }
      }
    }
  }
  return { result, password }
}

/**
 * Detect which API major version a server speaks.
 * V2 serves its web UI (HTML) on unknown paths, so a failed JSON parse
 * means the endpoint is not the one we expected.
 */
export async function detectApiVersion(baseUrl: string, password?: string): Promise<ApiVersion | null> {
  const v2 = await probeV2(baseUrl, password)
  if (v2.ok) {
    return "v2"
  }
  const v1 = await probeV1(baseUrl)
  if (v1.ok) {
    return "v1"
  }
  return null
}

async function isPortInUse(port: number): Promise<boolean> {
  const baseUrl = `http://localhost:${port}`
  const v2 = await probeV2(baseUrl)
  if (v2.ok || v2.unauthorized) {
    return true
  }
  const v1 = await probeV1(baseUrl)
  return v1.ok
}

async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (!(await isPortInUse(port))) {
      return port
    }
  }
  throw new Error(`No available ports in range ${start}-${end}`)
}

/**
 * Find opencode servers running on any port (e.g. a manual
 * `opencode serve` in a terminal), newest process first.
 * Ports 401-protected without a recoverable password are reported
 * as unreachable.
 */
async function findRunningOpencodeServer(
  sockets: ListeningSocket[],
  portToPid: Map<number, number>,
  triedPorts: Set<number>,
  unreachablePorts: number[]
): Promise<ServerConnection | null> {
  const candidates = sockets
    .filter((socket) => socket.command === "opencode" || socket.command.endsWith("/opencode"))
    .filter((socket) => !triedPorts.has(socket.port))
    .sort((a, b) => b.pid - a.pid)

  for (const socket of candidates) {
    triedPorts.add(socket.port)
    const baseUrl = `http://127.0.0.1:${socket.port}`
    const { result, password } = await probeV2WithRecovery(baseUrl, socket.port, portToPid)
    if (result.ok) {
      return connectionFromPort(socket.port, "v2", "discovered", password, result.version)
    }
    if (result.unauthorized) {
      unreachablePorts.push(socket.port)
      continue
    }
    const v1 = await probeV1(baseUrl)
    if (v1.ok) {
      return connectionFromPort(socket.port, "v1", "discovered", undefined, v1.version)
    }
  }
  return null
}

/**
 * Find the opencode binary on the system.
 * PATH first, so a user-managed installation (e.g. the one shipped with
 * OpenChamber) wins over the legacy install locations.
 */
async function findOpencodeBinary(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("which opencode")
    const binPath = stdout.trim().split("\n")[0]
    if (binPath && existsSync(binPath)) {
      return binPath
    }
  } catch {
    // Not in PATH
  }

  const home = homedir()
  const possiblePaths = [
    path.join(home, ".opencode", "bin", "opencode"),
    path.join(home, ".local", "bin", "opencode"),
    path.join(home, ".bun", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    path.join(home, "bin", "opencode"),
  ]

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p
    }
  }

  return null
}

async function readBinaryVersion(opencodePath: string): Promise<ApiVersion> {
  try {
    const { stdout } = await execAsync(`"${opencodePath}" --version`)
    const match = stdout.match(/v?(\d+)\./)
    if (match && Number(match[1]) >= 2) {
      return "v2"
    }
  } catch {
    // Fall through
  }
  return "v1"
}

/**
 * Start the OpenCode server on a given port.
 * V2 servers require a password; we generate one and hand it to the
 * process through OPENCODE_SERVER_PASSWORD so the client can use it.
 */
async function startServer(opencodePath: string, port: number, password?: string): Promise<void> {
  const env = { ...process.env }
  if (password) {
    delete env.OPENCODE_PASSWORD
    env.OPENCODE_SERVER_PASSWORD = password
  }

  const serverProcess = spawn(opencodePath, ["serve", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    env,
  })
  serverProcess.unref()

  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const dialect = await detectApiVersion(`http://localhost:${port}`, password)
    if (dialect) {
      return
    }
  }

  throw new Error("Server failed to start within 10 seconds")
}

async function storeConnection(connection: ServerConnection): Promise<void> {
  await LocalStorage.setItem(STORAGE_KEY_PORT, connection.port)
  if (connection.password) {
    await LocalStorage.setItem(STORAGE_KEY_PASSWORD, connection.password)
  } else {
    await LocalStorage.removeItem(STORAGE_KEY_PASSWORD)
  }
}

function connectionFromPort(
  port: number,
  version: ApiVersion,
  source: ServerConnection["source"],
  password?: string,
  versionString?: string
): ServerConnection {
  return {
    url: `http://localhost:${port}`,
    port,
    version,
    versionString,
    password,
    source,
  }
}

/**
 * Ensure an OpenCode server is available, discovering an existing one
 * (OpenChamber-managed, v2 background service, OpenChamber proxy, stored,
 * default port, any running opencode process) before starting our own.
 */
export async function ensureServer(autoStart: boolean = true): Promise<ServerConnection> {
  const sockets = await listListeningTcpSockets()
  const portToPid = new Map(sockets.map((socket) => [socket.port, socket.pid]))
  const triedPorts = new Set<number>()
  const unreachablePorts: number[] = []

  // 1. OpenChamber-managed opencode instances
  const managed = await findManagedInstances()
  for (const instance of managed) {
    triedPorts.add(instance.port)
    const result = await probeV2(`http://127.0.0.1:${instance.port}`, instance.password)
    if (result.ok) {
      const connection = connectionFromPort(
        instance.port,
        "v2",
        "openchamber",
        instance.password,
        result.version
      )
      await storeConnection(connection)
      return connection
    }
  }

  // 2. v2 background service registration (TUI, desktop app, --service)
  const service = await findServiceRegistration()
  if (service) {
    triedPorts.add(service.port)
    const result = await probeV2(`http://127.0.0.1:${service.port}`, service.password)
    if (result.ok) {
      const connection = connectionFromPort(service.port, "v2", "service", service.password, result.version)
      await storeConnection(connection)
      return connection
    }
  }

  // 3. OpenChamber app server (proxies the API without a password)
  const appPort = await findAppServerPort()
  if (appPort) {
    triedPorts.add(appPort)
    const result = await probeV2(`http://127.0.0.1:${appPort}`)
    if (result.ok) {
      const connection = connectionFromPort(appPort, "v2", "openchamber", undefined, result.version)
      await storeConnection(connection)
      return connection
    }
  }

  // 4. Stored connection from a previous run
  const storedPort = await LocalStorage.getItem<number>(STORAGE_KEY_PORT)
  if (storedPort && !triedPorts.has(storedPort)) {
    triedPorts.add(storedPort)
    const storedPassword = await LocalStorage.getItem<string>(STORAGE_KEY_PASSWORD)
    const baseUrl = `http://localhost:${storedPort}`
    const { result, password } = await probeV2WithRecovery(baseUrl, storedPort, portToPid, storedPassword)
    if (result.ok) {
      const connection = connectionFromPort(storedPort, "v2", "stored", password, result.version)
      await storeConnection(connection)
      return connection
    }
    if (result.unauthorized) {
      unreachablePorts.push(storedPort)
    }
    const v1 = await probeV1(baseUrl)
    if (v1.ok) {
      const connection = connectionFromPort(storedPort, "v1", "stored")
      return connection
    }
  }

  // 5. Default port (manual `opencode serve`)
  if (!triedPorts.has(DEFAULT_PORT)) {
    triedPorts.add(DEFAULT_PORT)
    const baseUrl = `http://localhost:${DEFAULT_PORT}`
    const { result, password } = await probeV2WithRecovery(baseUrl, DEFAULT_PORT, portToPid)
    if (result.ok) {
      const connection = connectionFromPort(DEFAULT_PORT, "v2", "default", password, result.version)
      await storeConnection(connection)
      return connection
    }
    if (result.unauthorized) {
      unreachablePorts.push(DEFAULT_PORT)
    }
    const v1 = await probeV1(baseUrl)
    if (v1.ok) {
      const connection = connectionFromPort(DEFAULT_PORT, "v1", "default")
      await storeConnection(connection)
      return connection
    }
  }

  // 6. opencode servers running on any other port (manual serve in a terminal)
  const running = await findRunningOpencodeServer(sockets, portToPid, triedPorts, unreachablePorts)
  if (running) {
    await storeConnection(running)
    return running
  }

  // 7. Start our own server
  if (!autoStart) {
    throw new ServerNotRunningError()
  }

  const opencodePath = await findOpencodeBinary()
  if (!opencodePath) {
    throw new OpenCodeNotInstalledError()
  }

  const binaryVersion = await readBinaryVersion(opencodePath)
  const port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END)
  const password = binaryVersion === "v2" ? randomBytes(32).toString("base64url") : undefined
  await startServer(opencodePath, port, password)

  const connection = connectionFromPort(port, binaryVersion, "started", password)
  if (unreachablePorts.length > 0) {
    connection.warnings = [
      `OpenCode v2 server(s) on port ${unreachablePorts.join(", ")} require a password we cannot recover. ` +
        "Starting our own server instead. To connect to yours directly, restart it with " +
        "OPENCODE_SERVER_PASSWORD=... set, or use 'opencode service start'.",
    ]
  }
  await storeConnection(connection)
  return connection
}

/**
 * Get the current server URL without starting a new server
 */
export async function getServerUrl(): Promise<string | null> {
  const portToPid = new Map(
    (await listListeningTcpSockets()).map((socket) => [socket.port, socket.pid])
  )

  const storedPort = await LocalStorage.getItem<number>(STORAGE_KEY_PORT)
  if (storedPort) {
    const storedPassword = await LocalStorage.getItem<string>(STORAGE_KEY_PASSWORD)
    const { result } = await probeV2WithRecovery(`http://localhost:${storedPort}`, storedPort, portToPid, storedPassword)
    if (result.ok) {
      return `http://localhost:${storedPort}`
    }
    if ((await probeV1(`http://localhost:${storedPort}`)).ok) {
      return `http://localhost:${storedPort}`
    }
  }

  const defaultUrl = `http://localhost:${DEFAULT_PORT}`
  const { result } = await probeV2WithRecovery(defaultUrl, DEFAULT_PORT, portToPid)
  if (result.ok) {
    return defaultUrl
  }
  if ((await probeV1(defaultUrl)).ok) {
    return defaultUrl
  }

  return null
}

// Custom error classes
export class ServerNotRunningError extends Error {
  constructor() {
    super("OpenCode server is not running")
    this.name = "ServerNotRunningError"
  }
}

export class OpenCodeNotInstalledError extends Error {
  constructor() {
    super("OpenCode is not installed. Install with: curl -fsSL https://opencode.ai/install | bash")
    this.name = "OpenCodeNotInstalledError"
  }
}
