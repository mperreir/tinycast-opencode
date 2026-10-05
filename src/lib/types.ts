export type ApiVersion = "v1" | "v2"

export interface Session {
  id: string
  projectID: string
  directory: string
  title: string
  version?: string
  time: {
    created: number
    updated: number
  }
  share?: {
    url: string
  }
}

export interface Agent {
  name: string
  description?: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
}

export interface Command {
  name: string
  description?: string
}

export interface MessagePart {
  type: string
  id?: string
  text?: string
  [key: string]: unknown
}

export interface Message {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
  }
  parts: MessagePart[]
}

export interface HealthResponse {
  healthy: boolean
  version: string
}

export interface Model {
  id: string
  providerID: string
  name: string
}

export interface Provider {
  id: string
  name: string
  models: Record<string, Model>
}

export interface ProviderResponse {
  all: Provider[]
  default: {
    providerID: string
    modelID: string
  }
}

export type ServerSource = "openchamber" | "service" | "stored" | "default" | "discovered" | "started"

export interface ServerConnection {
  url: string
  port: number
  version: ApiVersion
  versionString?: string
  password?: string
  source: ServerSource
  warnings?: string[]
}
