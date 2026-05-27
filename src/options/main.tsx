import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEBUG_LOG_KEY, DEFAULT_SETTINGS, SETTINGS_KEY, normalizeHost, normalizeSettings } from "../sharedDefaults";
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
  "1 档：顶部优先 + 极少抽样",
  "2 档：顶部优先 + 轻量抽样",
  "3 档：顶部优先 + 标准抽样",
  "4 档：顶部优先 + 较高抽样",
  "5 档：顶部优先 + 高抽样"
];

type DebugLog = {
  timestamp: string;
  url: string;
  title: string;
  mode: string;
  model: string;
  baseUrl: string;
  requestUrl?: string;
  hasApiKey: boolean;
  hostPermissionGranted?: boolean;
  difficulty: number;
  concentration: number;
  coverage: number;
  sourceChunkCount?: number;
  chunks: Array<{ id: string; text: string }>;
  requestBody?: unknown;
  httpStatus?: number;
  rawResponse?: string;
  parsedCount?: number;
  sanitizedCount?: number;
  acceptedSelections?: SelectionAudit[];
  rejectedSelections?: SelectionAudit[];
  cached?: boolean;
  batchStatuses?: Array<{
    index: number;
    chunkIds: string[];
    maxSelections?: number;
    requestBody?: unknown;
    elapsedMs?: number;
    httpStatus?: number;
    parsedCount?: number;
    sanitizedCount?: number;
    acceptedSelections?: SelectionAudit[];
    rejectedSelections?: SelectionAudit[];
    error?: string;
    rawResponse?: string;
  }>;
  error?: string;
  networkErrorName?: string;
  networkErrorDetails?: string;
};

type SelectionAudit = {
  selection: unknown;
  reason?: string;
  replacement?: unknown;
};

function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [debugLog, setDebugLog] = useState<DebugLog | null>(null);
  const [saved, setSaved] = useState(false);
  const [hostInput, setHostInput] = useState("");
  const [selectedHost, setSelectedHost] = useState("");

  useEffect(() => {
    chrome.storage.local.get([SETTINGS_KEY, DEBUG_LOG_KEY]).then((stored) => {
      const normalizedSettings = normalizeSettings(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
      setSettings(normalizedSettings);
      setDebugLog((stored[DEBUG_LOG_KEY] as DebugLog | undefined) ?? null);
      void chrome.storage.local.set({ [SETTINGS_KEY]: normalizedSettings });
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

  function addAutoHost() {
    const host = normalizeHost(hostInput);
    if (!host) {
      return;
    }

    update("autoRewriteHosts", [...new Set([...settings.autoRewriteHosts, host])]);
    setHostInput("");
    setSelectedHost(host);
  }

  function removeAutoHost() {
    if (!selectedHost) {
      return;
    }

    update(
      "autoRewriteHosts",
      settings.autoRewriteHosts.filter((host) => host !== selectedHost)
    );
    setSelectedHost("");
  }

  return (
    <main className="options">
      <header>
        <p className="eyebrow">Context English</p>
        <h1>语境英语设置</h1>
      </header>

      <form onSubmit={saveSettings}>
        <section>
          <h2>AI API</h2>
          <label>
            DeepSeek API key
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
            覆盖密度
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

        <section>
          <h2>自动改造白名单</h2>
          <label>
            域名
            <div className="hostEditor">
              <input
                type="text"
                value={hostInput}
                placeholder="bytedance.larkoffice.com"
                onChange={(event) => setHostInput(event.target.value)}
              />
              <button type="button" className="secondary" onClick={addAutoHost}>
                添加
              </button>
            </div>
          </label>
          <label>
            已启用域名
            <select
              size={Math.max(3, Math.min(6, settings.autoRewriteHosts.length || 3))}
              value={selectedHost}
              onChange={(event) => setSelectedHost(event.target.value)}
            >
              {settings.autoRewriteHosts.map((host) => (
                <option key={host} value={host}>
                  {host}
                </option>
              ))}
            </select>
          </label>
          <div className="hostActions">
            <button type="button" className="secondary danger" disabled={!selectedHost} onClick={removeAutoHost}>
              移除选中域名
            </button>
            <span className="hint">匹配该域名下所有路径；悬浮球可手动触发或暂停自动改造。</span>
          </div>
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
            <DebugField label="请求 URL" value={debugLog.requestUrl ?? "无"} />
            <DebugField label="API key" value={debugLog.hasApiKey ? "已填写" : "未填写"} />
            <DebugField label="Host 权限" value={debugLog.hostPermissionGranted === undefined ? "无" : debugLog.hostPermissionGranted ? "已授权" : "未授权"} />
            <DebugField label="HTTP 状态" value={debugLog.httpStatus ?? "无"} />
            <DebugField label="覆盖密度" value={debugLog.coverage ?? "无"} />
            <DebugField label="全文段数" value={debugLog.sourceChunkCount ?? debugLog.chunks.length} />
            <DebugField label="请求段数" value={debugLog.chunks.length} />
            <DebugField label="解析数量" value={debugLog.parsedCount ?? "无"} />
            <DebugField label="有效替换" value={debugLog.sanitizedCount ?? "无"} />
            <DebugField label="接受候选" value={debugLog.acceptedSelections?.length ?? "无"} />
            <DebugField label="拒绝候选" value={debugLog.rejectedSelections?.length ?? "无"} />
            <DebugField label="请求批次" value={debugLog.batchStatuses?.length ?? "无"} />
            <DebugField label="缓存" value={debugLog.cached ? "是" : "否"} />
            <DebugField label="错误" value={debugLog.error ?? "无"} />
            <DebugField label="网络错误类型" value={debugLog.networkErrorName ?? "无"} />
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
        requestUrl: debugLog.requestUrl,
        hasApiKey: debugLog.hasApiKey,
        hostPermissionGranted: debugLog.hostPermissionGranted,
        difficulty: debugLog.difficulty,
        concentration: debugLog.concentration,
        coverage: debugLog.coverage,
        sourceChunkCount: debugLog.sourceChunkCount,
        selectedChunkCount: debugLog.chunks.length,
        httpStatus: debugLog.httpStatus,
        parsedCount: debugLog.parsedCount,
        sanitizedCount: debugLog.sanitizedCount,
        acceptedCount: debugLog.acceptedSelections?.length,
        rejectedCount: debugLog.rejectedSelections?.length,
        batchStatuses: debugLog.batchStatuses,
        cached: debugLog.cached,
        error: debugLog.error,
        networkErrorName: debugLog.networkErrorName,
        networkErrorDetails: debugLog.networkErrorDetails
      },
      chunks: debugLog.chunks,
      requestBody: debugLog.requestBody,
      acceptedSelections: debugLog.acceptedSelections ?? [],
      rejectedSelections: debugLog.rejectedSelections ?? [],
      rawResponse: debugLog.rawResponse || ""
    },
    null,
    2
  );
}

createRoot(document.getElementById("root")!).render(<App />);
