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

const POLL_INTERVAL_MS = 1500
const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000

interface V2Session {
  id: string
  projectID?: string
  title?: string
  location?: { directory?: string }
  version?: string
  time?: { created?: number; updated?: number; idle?: number }
  share?: { url?: string }
}

interface V2Message {
  id: string
  type?: string
  time?: { created?: number; streamed?: number }
  content?: MessagePart[]
}

interface V2Agent {
  id: string
  name?: string
  description?: string
  mode?: string
  hidden?: boolean
}

interface V2Model {
  id: string
  modelID?: string
  providerID?: string
  name?: string
}

interface V2Provider {
  id: string
  name?: string
}

interface V2Envelope<T> {
  data?: T
  [key: string]: unknown
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mapSession(session: V2Session, fallbackDirectory?: string): Session {
  return {
    id: session.id,
    projectID: session.projectID ?? "",
    directory: session.location?.directory ?? fallbackDirectory ?? "",
    title: session.title ?? "",
    version: session.version,
    time: {
      created: session.time?.created ?? 0,
      updated: session.time?.updated ?? session.time?.idle ?? 0,
    },
    share: session.share?.url ? { url: session.share.url } : undefined,
  }
}

function mapMessage(sessionId: string, message: V2Message): Message {
  return {
    info: {
      id: message.id,
      sessionID: sessionId,
      role: message.type === "user" ? "user" : "assistant",
    },
    parts: message.content ?? [],
  }
}

export class OpenCodeClientV2 {
  private baseUrl: string
  private directory?: string
  private password?: string

  constructor(baseUrl: string, directory?: string, password?: string) {
    this.baseUrl = baseUrl
    this.directory = directory
    this.password = password
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    }
    if (this.password) {
      headers["Authorization"] = "Basic " + Buffer.from(`opencode:${this.password}`).toString("base64")
    }
    return headers
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | undefined>
  ): Promise<T> {
    const url = new URL(`/api${path}`, this.baseUrl)

    if (this.directory) {
      url.searchParams.set("directory", this.directory)
    }

    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) {
          url.searchParams.set(key, value)
        }
      }
    }

    const response = await fetch(url.toString(), {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    // Some routes (switchModel, delete, ...) answer with an empty body
    const text = await response.text()
    if (!text) {
      return undefined as T
    }

    const json = JSON.parse(text) as V2Envelope<T> | T
    if (json && typeof json === "object" && !Array.isArray(json) && "data" in (json as object)) {
      return (json as V2Envelope<T>).data as T
    }
    return json as T
  }

  async health(): Promise<HealthResponse> {
    const info = await this.request<{ version?: string }>("GET", "/info")
    return { healthy: true, version: info?.version ?? "" }
  }

  async listSessions(): Promise<Session[]> {
    const data = await this.request<V2Session[]>("GET", "/session", undefined, {
      limit: "200",
      order: "desc",
      parentID: "null",
    })
    return (data ?? []).map((session) => mapSession(session, this.directory))
  }

  async createSession(title?: string): Promise<Session> {
    const body: Record<string, unknown> = {}
    if (title) {
      body.title = title
    }
    if (this.directory) {
      body.location = { directory: this.directory }
    }
    const data = await this.request<V2Session>("POST", "/session", body)
    return mapSession(data, this.directory)
  }

  async getSession(sessionId: string): Promise<Session> {
    const data = await this.request<V2Session>("GET", `/session/${sessionId}`)
    return mapSession(data, this.directory)
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    await this.request<unknown>("DELETE", `/session/${sessionId}`)
    return true
  }

  async getSessionMessages(sessionId: string, limit?: number): Promise<Message[]> {
    const data = await this.request<V2Message[]>("GET", `/session/${sessionId}/message`, undefined, {
      limit: limit?.toString(),
      order: "asc",
    })
    return (data ?? []).map((message) => mapMessage(sessionId, message))
  }

  private async switchAgent(sessionId: string, agent: string): Promise<void> {
    const agents = await this.request<V2Agent[]>("GET", "/agent").catch(() => [] as V2Agent[])
    const match = agents.find(
      (a) => a.id === agent || a.name === agent || a.id.toLowerCase() === agent.toLowerCase()
    )
    const agentId = match ? match.id : agent
    await this.request<unknown>("POST", `/session/${sessionId}/agent`, { agent: agentId })
  }

  private async switchModel(
    sessionId: string,
    model: { providerID: string; modelID: string }
  ): Promise<void> {
    await this.request<unknown>("POST", `/session/${sessionId}/model`, {
      model: { id: model.modelID, providerID: model.providerID },
    })
  }

  private async isSessionActive(sessionId: string): Promise<boolean> {
    const data = await this.request<Record<string, { type: string }>>("GET", "/session/active")
    return data ? sessionId in data : false
  }

  // V2 prompts are admitted asynchronously; wait for the session to go
  // idle, then read back the final assistant message
  private async waitForAssistantResponse(sessionId: string): Promise<Message> {
    const startedAt = Date.now()
    const deadline = startedAt + RESPONSE_TIMEOUT_MS
    let sawActive = false

    while (Date.now() < deadline) {
      const active = await this.isSessionActive(sessionId).catch(() => false)
      if (active) {
        sawActive = true
      } else if (sawActive) {
        const messages = await this.getSessionMessages(sessionId, 20)
        const assistants = messages.filter((m) => m.info.role === "assistant")
        const withText = assistants.find((m) =>
          m.parts.some((p) => p.type === "text" && (p.text ?? "").length > 0)
        )
        const fallback = assistants[assistants.length - 1]
        if (withText) {
          return withText
        }
        if (fallback) {
          return fallback
        }
      } else if (Date.now() - startedAt > 30000) {
        const data = await this.request<V2Message[]>("GET", `/session/${sessionId}/message`, undefined, {
          limit: "10",
          order: "desc",
        })
        const fresh = (data ?? []).filter((m) => (m.time?.created ?? 0) >= startedAt - 5000)
        const assistants = fresh.filter((m) => m.type === "assistant")
        if (assistants.length > 0) {
          return mapMessage(sessionId, assistants[0])
        }
        throw new Error("Prompt was not accepted by the server")
      }
      await sleep(POLL_INTERVAL_MS)
    }

    throw new Error("Timed out waiting for the assistant response")
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    options: {
      agent?: string
      model: { providerID: string; modelID: string }
    }
  ): Promise<Message> {
    if (options.agent) {
      await this.switchAgent(sessionId, options.agent)
    }
    await this.switchModel(sessionId, options.model)
    await this.request<unknown>("POST", `/session/${sessionId}/prompt`, { text })
    return this.waitForAssistantResponse(sessionId)
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const data = await this.request<{ interrupted?: boolean }>("POST", `/session/${sessionId}/interrupt`)
    return data?.interrupted ?? true
  }

  async listAgents(): Promise<Agent[]> {
    const data = await this.request<V2Agent[]>("GET", "/agent")
    return (data ?? []).map((agent) => ({
      name: agent.name ?? agent.id,
      description: agent.description,
      mode: (agent.mode as Agent["mode"]) ?? "primary",
      hidden: agent.hidden,
    }))
  }

  async listCommands(): Promise<Command[]> {
    const data = await this.request<Command[]>("GET", "/command")
    return data ?? []
  }

  async listProviders(): Promise<ProviderResponse> {
    const [providers, models, defaultModel] = await Promise.all([
      this.request<V2Provider[]>("GET", "/provider").catch(() => [] as V2Provider[]),
      this.request<V2Model[]>("GET", "/model").catch(() => [] as V2Model[]),
      this.request<V2Model>("GET", "/model/default").catch(() => undefined),
    ])

    const all: Provider[] = (providers ?? []).map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
      models: {},
    }))
    const byId = new Map(all.map((provider) => [provider.id, provider]))

    for (const model of models ?? []) {
      if (!model.providerID || !model.modelID) {
        continue
      }
      let provider = byId.get(model.providerID)
      if (!provider) {
        provider = { id: model.providerID, name: model.providerID, models: {} }
        all.push(provider)
        byId.set(provider.id, provider)
      }
      provider.models[model.modelID] = {
        id: model.id ?? model.modelID,
        providerID: model.providerID,
        name: model.name ?? model.modelID,
      }
    }

    all.sort((a, b) => a.name.localeCompare(b.name))

    return {
      all,
      default: {
        providerID: defaultModel?.providerID ?? "",
        modelID: defaultModel?.id ?? defaultModel?.modelID ?? "",
      },
    }
  }

  setDirectory(directory: string): void {
    this.directory = directory
  }
}

export type { MessagePart, Model }
