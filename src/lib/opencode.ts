import { showToast, Toast, Clipboard, getPreferenceValues } from "@raycast/api"
import { ensureServer, ServerNotRunningError, OpenCodeNotInstalledError } from "./server-manager"
import { OpenCodeClientV1 } from "./opencode-v1"
import { OpenCodeClientV2 } from "./opencode-v2"
import {
  Agent,
  Command,
  HealthResponse,
  Message,
  MessagePart,
  Model,
  Provider,
  ProviderResponse,
  Session,
} from "./types"

export * from "./types"

interface Preferences {
  defaultProject?: string
  handoffMethod: "terminal" | "desktop"
  autoStartServer: boolean
}

export interface OpenCodeClient {
  health(): Promise<HealthResponse>
  listSessions(): Promise<Session[]>
  createSession(title?: string): Promise<Session>
  getSession(sessionId: string): Promise<Session>
  deleteSession(sessionId: string): Promise<boolean>
  getSessionMessages(sessionId: string, limit?: number): Promise<Message[]>
  sendPrompt(
    sessionId: string,
    text: string,
    options: {
      agent?: string
      model: { providerID: string; modelID: string }
    }
  ): Promise<Message>
  abortSession(sessionId: string): Promise<boolean>
  listAgents(): Promise<Agent[]>
  listCommands(): Promise<Command[]>
  listProviders(): Promise<ProviderResponse>
  setDirectory(directory: string): void
}

let clientInstance: OpenCodeClient | null = null
let clientKey: string | null = null
let serverUrl: string | null = null

export async function getClient(directory?: string): Promise<OpenCodeClient> {
  const preferences = getPreferenceValues<Preferences>()

  try {
    const server = await ensureServer(preferences.autoStartServer)
    serverUrl = server.url

    const effectiveDir = directory || preferences.defaultProject
    const key = `${server.url}|${server.version}|${effectiveDir ?? ""}`

    if (!clientInstance || clientKey !== key) {
      clientInstance =
        server.version === "v2"
          ? new OpenCodeClientV2(server.url, effectiveDir, server.password)
          : new OpenCodeClientV1(server.url, effectiveDir)
      clientKey = key

      for (const warning of server.warnings ?? []) {
        await showToast({ style: Toast.Style.Success, title: "OpenCode", message: warning })
      }
    }

    return clientInstance
  } catch (error) {
    if (error instanceof ServerNotRunningError) {
      await showToast({
        style: Toast.Style.Failure,
        title: "OpenCode server not running",
        message: "Run 'opencode serve' to start, or launch OpenChamber",
        primaryAction: {
          title: "Copy Command",
          onAction: () => Clipboard.copy("opencode serve"),
        },
      })
    } else if (error instanceof OpenCodeNotInstalledError) {
      await showToast({
        style: Toast.Style.Failure,
        title: "OpenCode not installed",
        message: "Install from opencode.ai",
        primaryAction: {
          title: "Copy Install Command",
          onAction: () => Clipboard.copy("curl -fsSL https://opencode.ai/install | bash"),
        },
      })
    }
    throw error
  }
}

export function getServerUrl(): string | null {
  return serverUrl
}

export function resetClient(): void {
  clientInstance = null
  clientKey = null
}

export { OpenCodeClientV1, OpenCodeClientV2 }
export type { MessagePart, Model, Provider, ProviderResponse }
