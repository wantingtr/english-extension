import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEBUG_LOG_KEY, DEFAULT_SETTINGS, SETTINGS_KEY } from "../sharedDefaults";
import type { Settings } from "../types";
import "./style.css";

const difficultyLabels = [
  "1 档：小学 + 初中",
  "2 档：高中",
  "3 档：四级",
  "4 档：六级",
  "5 档：更高阶"
];

const concentrationLabels = [
  "1 档：更多词汇，几乎不动句子",
  "2 档：词汇为主，少量短语",
  "3 档：词汇和短语均衡",
  "4 档：短语为主，少量句子",
  "5 档：更少词汇，更多短语和句子"
];

const coverageLabels = [
  "1 档：很小，只处理前 6 段",
  "2 档：较小，处理前 10 段",
  "3 档：适中，处理前 14 段",
  "4 档：较大，处理前 18 段",
  "5 档：很大，处理前 24 段"
];

type DebugLog = {
  timestamp: string;
  url: string;
  title: string;
  mode: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  difficulty: number;
  concentration: number;
  coverage: number;
  chunks: Array<{ id: string; text: string }>;
  httpStatus?: number;
  rawResponse?: string;
  parsedCount?: number;
  sanitizedCount?: number;
  cached?: boolean;
  error?: string;
};

function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [debugLog, setDebugLog] = useState<DebugLog | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.local.get([SETTINGS_KEY, DEBUG_LOG_KEY]).then((stored) => {
      setSettings({ ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) });
      setDebugLog((stored[DEBUG_LOG_KEY] as DebugLog | undefined) ?? null);
    });
  }, []);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSaved(false);
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    setSaved(true);
  }

  async function refreshDebugLog() {
    const stored = await chrome.storage.local.get(DEBUG_LOG_KEY);
    setDebugLog((stored[DEBUG_LOG_KEY] as DebugLog | undefined) ?? null);
  }

  async function clearDebugLog() {
    await chrome.storage.local.remove(DEBUG_LOG_KEY);
    setDebugLog(null);
  }

  return (
    <main className="options">
      <header>
        <p className="eyebrow">English Immersion</p>
        <h1>英语浸泡设置</h1>
      </header>

      <form onSubmit={saveSettings}>
        <section>
          <h2>AI API</h2>
          <label>
            硅基流动 API key
            <input
              type="password"
              value={settings.apiKey}
              placeholder="sk-..."
              autoComplete="off"
              onChange={(event) => update("apiKey", event.target.value)}
            />
          </label>
          <label>
            Base URL
            <input value={settings.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} />
          </label>
          <label>
            模型名
            <input value={settings.model} onChange={(event) => update("model", event.target.value)} />
          </label>
        </section>

        <section>
          <h2>学习参数</h2>
          <label>
            英文难度
            <input
              type="range"
              min="1"
              max="5"
              value={settings.difficulty}
              onChange={(event) => update("difficulty", Number(event.target.value))}
            />
            <span className="hint">{difficultyLabels[settings.difficulty - 1]}</span>
          </label>
          <label>
            替换浓度
            <input
              type="range"
              min="1"
              max="5"
              value={settings.concentration}
              onChange={(event) => update("concentration", Number(event.target.value))}
            />
            <span className="hint">{concentrationLabels[settings.concentration - 1]}</span>
          </label>
          <label>
            替换范围
            <input
              type="range"
              min="1"
              max="5"
              value={settings.coverage}
              onChange={(event) => update("coverage", Number(event.target.value))}
            />
            <span className="hint">{coverageLabels[settings.coverage - 1]}</span>
          </label>
        </section>

        <footer>
          <button type="submit">保存设置</button>
          <span>{saved ? "已保存" : "修改后记得保存"}</span>
        </footer>
      </form>

      <section className="debugPanel">
        <div className="sectionHeader">
          <h2>调试面板</h2>
          <div className="actions">
            <button type="button" className="secondary" onClick={refreshDebugLog}>
              刷新日志
            </button>
            <button type="button" className="secondary danger" onClick={clearDebugLog}>
              清空
            </button>
          </div>
        </div>

        {debugLog ? (
          <div className="debugGrid">
            <DebugField label="时间" value={new Date(debugLog.timestamp).toLocaleString()} />
            <DebugField label="URL" value={debugLog.url} />
            <DebugField label="标题" value={debugLog.title} />
            <DebugField label="模式" value={debugLog.mode} />
            <DebugField label="模型" value={debugLog.model} />
            <DebugField label="Base URL" value={debugLog.baseUrl} />
            <DebugField label="API key" value={debugLog.hasApiKey ? "已填写" : "未填写"} />
            <DebugField label="HTTP 状态" value={debugLog.httpStatus ?? "无"} />
            <DebugField label="替换范围" value={debugLog.coverage ?? "无"} />
            <DebugField label="解析数量" value={debugLog.parsedCount ?? "无"} />
            <DebugField label="有效替换" value={debugLog.sanitizedCount ?? "无"} />
            <DebugField label="缓存" value={debugLog.cached ? "是" : "否"} />
            <DebugField label="错误" value={debugLog.error ?? "无"} />
            <DebugBlock label="完整日志" value={formatFullDebugLog(debugLog)} />
          </div>
        ) : (
          <p className="empty">还没有调试日志。运行一次页面改造后再刷新。</p>
        )}
      </section>
    </main>
  );
}

function DebugField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="debugField">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DebugBlock({ label, value }: { label: string; value: string }) {
  return (
    <label className="debugBlock">
      {label}
      <textarea readOnly value={value} />
    </label>
  );
}

function formatFullDebugLog(debugLog: DebugLog): string {
  return JSON.stringify(
    {
      meta: {
        timestamp: debugLog.timestamp,
        url: debugLog.url,
        title: debugLog.title,
        mode: debugLog.mode,
        model: debugLog.model,
        baseUrl: debugLog.baseUrl,
        hasApiKey: debugLog.hasApiKey,
        difficulty: debugLog.difficulty,
        concentration: debugLog.concentration,
        coverage: debugLog.coverage,
        httpStatus: debugLog.httpStatus,
        parsedCount: debugLog.parsedCount,
        sanitizedCount: debugLog.sanitizedCount,
        cached: debugLog.cached,
        error: debugLog.error
      },
      chunks: debugLog.chunks,
      rawResponse: debugLog.rawResponse || ""
    },
    null,
    2
  );
}

createRoot(document.getElementById("root")!).render(<App />);
