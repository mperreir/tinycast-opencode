import { useState, useEffect } from "react";
import { getServerUrl } from "../lib/server-manager";
import { homedir } from "os";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface Model {
  id: string;
  providerID: string;
  name: string;
}

export interface Provider {
  id: string;
  name: string;
  models: Record<string, Model>;
}

export interface FavoriteModel {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
}

export interface ProviderResponse {
  all: Provider[];
  default: Record<string, string>;
}

interface LocalModelConfig {
  recent: Array<{ providerID: string; modelID: string }>;
  favorite: Array<{ providerID: string; modelID: string }>;
}

function getLocalModelConfig(): LocalModelConfig | null {
  const possiblePaths = [
    join(homedir(), ".local", "state", "opencode", "model.json"),
    join(homedir(), "Library", "Application Support", "opencode", "model.json"),
  ];
  
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        return JSON.parse(content) as LocalModelConfig;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function parseJsonMaybe(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getConfiguredProviderIds(): Set<string> {
  const configured = new Set<string>();

  const configPaths = [
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(homedir(), "Library", "Application Support", "opencode", "opencode.jsonc"),
    join(homedir(), "Library", "Application Support", "opencode", "opencode.json"),
  ];

  for (const path of configPaths) {
    if (!existsSync(path)) continue;
    let stripped: string;
    try {
      stripped = readFileSync(path, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
    } catch {
      continue;
    }
    const parsed = parseJsonMaybe(stripped);
    if (!parsed) continue;
    const providers = parsed["provider"] as Record<string, unknown> | undefined;
    if (providers && typeof providers === "object") {
      for (const id of Object.keys(providers)) configured.add(id);
    }
  }

  const authPaths = [
    join(homedir(), ".local", "share", "opencode", "auth.json"),
    join(homedir(), "Library", "Application Support", "opencode", "auth.json"),
  ];

  for (const path of authPaths) {
    if (!existsSync(path)) continue;
    const parsed = parseJsonMaybe(readFileSync(path, "utf-8"));
    if (!parsed) continue;
    const accounts = (parsed["accounts"] as Record<string, unknown> | undefined)
      ?? parsed;
    for (const [id, value] of Object.entries(accounts)) {
      if (value && typeof value === "object" && Object.keys(value as object).length > 0) {
        configured.add(id);
      }
    }
    break;
  }

  return configured;
}

export function useProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [favorites, setFavorites] = useState<FavoriteModel[]>([]);
  const [recentModels, setRecentModels] = useState<FavoriteModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<{ providerID: string; modelID: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchProviders() {
      const server = await getServerUrl()
      const baseUrl = server || "http://localhost:4096"
      try {
        const response = await fetch(`${baseUrl}/provider`);
        if (!response.ok) {
          throw new Error(`Failed to fetch providers: ${response.statusText}`);
        }
        const data = (await response.json()) as ProviderResponse;
        const configuredProviderIds = getConfiguredProviderIds();
        const filteredProviders =
          configuredProviderIds.size > 0
            ? data.all.filter((p) => configuredProviderIds.has(p.id))
            : data.all;
        setProviders(filteredProviders);
        
        const localConfig = getLocalModelConfig();
        
        const resolveFavorites = (
          items: Array<{ providerID: string; modelID: string }> | undefined
        ): FavoriteModel[] => {
          if (!items) return [];
          return items
            .map((item) => {
              const provider = data.all.find((p) => p.id === item.providerID);
              if (!provider || !provider.models[item.modelID]) return null;
              return {
                providerID: item.providerID,
                providerName: provider.name,
                modelID: item.modelID,
                modelName: provider.models[item.modelID].name,
              };
            })
            .filter((x): x is FavoriteModel => x !== null);
        };
        
        const userFavorites = resolveFavorites(localConfig?.favorite);
        const userRecent = resolveFavorites(localConfig?.recent);
        
        setFavorites(userFavorites);
        setRecentModels(userRecent);
        
        if (userFavorites.length > 0) {
          setDefaultModel({ providerID: userFavorites[0].providerID, modelID: userFavorites[0].modelID });
        } else if (userRecent.length > 0) {
          setDefaultModel({ providerID: userRecent[0].providerID, modelID: userRecent[0].modelID });
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    }

    fetchProviders();
  }, []);

  return {
    providers,
    favorites,
    recentModels,
    defaultModel,
    isLoading,
    error,
  };
}
