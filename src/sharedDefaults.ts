import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "Qwen/Qwen2.5-7B-Instruct",
  baseUrl: "https://api.siliconflow.cn/v1",
  difficulty: 2,
  concentration: 3,
  coverage: 3
};

export const SETTINGS_KEY = "englishImmersionSettings";
export const DEBUG_LOG_KEY = "englishImmersionDebugLog";
