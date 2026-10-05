import {
  Agent,
  Command,
  HealthResponse,
  Message,
  MessagePart,
  Provider,
  ProviderResponse,
  Session,
} from "./types"

export class OpenCodeClientV1 {
  private baseUrl: string
  private directory?: string

  constructor(baseUrl: string, directory?: string) {
    this.baseUrl = baseUrl
    this.directory = directory
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | undefined>
  ): Promise<T> {
    const url = new URL(path, this.baseUrl)

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
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.directory ? { "x-opencode-directory": this.directory } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`HTTP ${response.status}: ${text}`)
    }

    return response.json() as Promise<T>
  }

  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/global/health")
  }

  async listSessions(): Promise<Session[]> {
    return this.request<Session[]>("GET", "/session")
  }

  async createSession(title?: string): Promise<Session> {
    return this.request<Session>("POST", "/session", { title })
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.request<Session>("GET", `/session/${sessionId}`)
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.request<boolean>("DELETE", `/session/${sessionId}`)
  }

  async getSessionMessages(sessionId: string, limit?: number): Promise<Message[]> {
    return this.request<Message[]>("GET", `/session/${sessionId}/message`, undefined, {
      limit: limit?.toString(),
    })
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    options: {
      agent?: string
      model: { providerID: string; modelID: string }
    }
  ): Promise<Message> {
    return this.request<Message>("POST", `/session/${sessionId}/message`, {
      parts: [{ type: "text", text }],
      agent: options.agent,
      model: options.model,
    })
  }

  async abortSession(sessionId: string): Promise<boolean> {
    return this.request<boolean>("POST", `/session/${sessionId}/abort`)
  }

  async listAgents(): Promise<Agent[]> {
    return this.request<Agent[]>("GET", "/agent")
  }

  async listCommands(): Promise<Command[]> {
    return this.request<Command[]>("GET", "/command")
  }

  async listProviders(): Promise<ProviderResponse> {
    return this.request<ProviderResponse>("GET", "/provider")
  }

  setDirectory(directory: string): void {
    this.directory = directory
  }
}

export type { MessagePart, Provider }
