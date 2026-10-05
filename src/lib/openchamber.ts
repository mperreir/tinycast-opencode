import { existsSync, readFileSync, readdirSync } from "fs"
import { homedir } from "os"
import path from "path"
import { listListeningTcpSockets, passwordFromProcess } from "./credentials"

export interface OpenChamberInstance {
  port: number
  pid: number
  password?: string
}

interface ManagedManifest {
  pid?: number
  port?: number
  binary?: string
  runtime?: string
}

interface ServiceRegistration {
  id?: string
  version?: string
  url?: string
  pid?: number
  password?: string
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function managedOpencodeDir(): string {
  return path.join(homedir(), ".config", "openchamber", "managed-opencode")
}

// OpenChamber writes one manifest per opencode instance it launches
export async function findManagedInstances(): Promise<OpenChamberInstance[]> {
  const dir = managedOpencodeDir()
  if (!existsSync(dir)) {
    return []
  }

  let files: string[]
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"))
  } catch {
    return []
  }

  const instances: OpenChamberInstance[] = []
  for (const file of files) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, file), "utf-8")) as ManagedManifest
      if (!manifest.pid || !manifest.port) {
        continue
      }
      if (!isProcessAlive(manifest.pid)) {
        continue
      }
      const password = await passwordFromProcess(manifest.pid)
      instances.push({ port: manifest.port, pid: manifest.pid, password })
    } catch {
      continue
    }
  }
  return instances
}

// v2 background service registrations, in order of preference:
// - service.json: written by `opencode serve --service` (TUI, desktop app, OpenChamber)
// - service-local.json: the desktop app's "local" server channel
function serviceRegistrationPaths(): string[] {
  const home = homedir()
  return [
    path.join(home, ".local", "state", "opencode", "service.json"),
    path.join(home, "Library", "Application Support", "OpenCode", "opencode", "service-local.json"),
  ]
}

export async function readServiceRegistration(file: string): Promise<OpenChamberInstance | null> {
  if (!existsSync(file)) {
    return null
  }
  try {
    const registration = JSON.parse(readFileSync(file, "utf-8")) as ServiceRegistration
    if (!registration.url || !registration.pid) {
      return null
    }
    if (!isProcessAlive(registration.pid)) {
      return null
    }
    const port = Number(new URL(registration.url).port)
    if (!port) {
      return null
    }
    return { port, pid: registration.pid, password: registration.password }
  } catch {
    return null
  }
}

export async function findServiceRegistration(): Promise<OpenChamberInstance | null> {
  for (const file of serviceRegistrationPaths()) {
    const registration = await readServiceRegistration(file)
    if (registration) {
      return registration
    }
  }
  return null
}

// The OpenChamber app itself listens on a random port and proxies the
// opencode API without requiring a password
export async function findAppServerPort(): Promise<number | null> {
  const sockets = await listListeningTcpSockets()
  const match = sockets.find((socket) => socket.command.startsWith("OpenChamb"))
  return match?.port ?? null
}
