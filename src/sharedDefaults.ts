import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  difficulty: 2,
  concentration: 3,
  coverage: 2
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

  return settings;
}
