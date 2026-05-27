import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  difficulty: 2,
  concentration: 3,
  coverage: 2,
  autoRewriteHosts: []
};

export const SETTINGS_KEY = "englishImmersionSettings";
export const DEBUG_LOG_KEY = "englishImmersionDebugLog";

const LEGACY_SILICONFLOW_BASE_URLS = new Set(["https://api.siliconflow.cn/v1", "https://api.siliconflow.com/v1"]);
const LEGACY_DEFAULT_MODELS = new Set(["Qwen/Qwen2.5-7B-Instruct"]);

export function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(value ?? {})
  };

  if (LEGACY_SILICONFLOW_BASE_URLS.has(settings.baseUrl.trim().replace(/\/+$/, ""))) {
    settings.baseUrl = DEFAULT_SETTINGS.baseUrl;
  }

  if (LEGACY_DEFAULT_MODELS.has(settings.model.trim())) {
    settings.model = DEFAULT_SETTINGS.model;
  }

  settings.autoRewriteHosts = normalizeHosts(settings.autoRewriteHosts);

  return settings;
}

export function normalizeHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts)) {
    return [];
  }

  return [
    ...new Set(
      hosts
        .filter((host): host is string => typeof host === "string")
        .map(normalizeHost)
        .filter(Boolean)
    )
  ];
}

export function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname;
  } catch {
    return trimmed
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .split(":")[0]
      .trim();
  }
}
