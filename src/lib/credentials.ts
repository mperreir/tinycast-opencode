import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

export interface ListeningSocket {
  command: string
  pid: number
  port: number
}

/**
 * List all local TCP listeners in a single lsof call.
 * The COMMAND column is truncated to 9 characters by lsof ("OpenChamb").
 */
export async function listListeningTcpSockets(): Promise<ListeningSocket[]> {
  const sockets: ListeningSocket[] = []
  try {
    const { stdout } = await execAsync("lsof -nP -iTCP -sTCP:LISTEN")
    for (const line of stdout.split("\n")) {
      const match = line.match(/^(\S+)\s+(\d+)\b.*\bTCP\s+\S+:(\d+) \(LISTEN\)/)
      if (match) {
        sockets.push({ command: match[1], pid: Number(match[2]), port: Number(match[3]) })
      }
    }
  } catch {
    // lsof unavailable
  }
  return sockets
}

/**
 * Read the OpenCode server password from a process environment.
 * Servers started with a password env var expose it in their environment,
 * readable for same-user processes. The server resolves OPENCODE_PASSWORD
 * first, falling back to OPENCODE_SERVER_PASSWORD - mirror that precedence.
 */
export async function passwordFromProcess(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(`ps eww -p ${pid}`)
    for (const key of ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]) {
      for (const line of stdout.split("\n")) {
        const match = line.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`))
        if (match) {
          return match[1]
        }
      }
    }
  } catch {
    // Process environment is not readable
  }
  return undefined
}

/**
 * Recover the password of the process listening on a port, if it has one.
 */
export async function recoverPasswordForPort(
  port: number,
  portToPid: Map<number, number>
): Promise<string | undefined> {
  const pid = portToPid.get(port)
  if (!pid) {
    return undefined
  }
  return passwordFromProcess(pid)
}
