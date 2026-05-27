import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings } from "../sharedDefaults";
import type { RewriteMode, Settings } from "../types";
import "./style.css";

type RunResult = {
  ok: boolean;
  mode?: "zh-to-en" | "en-assist";
  chunks?: number;
  applied?: number;
  cached?: boolean;
  batchTimings?: BatchTiming[];
  totalElapsedMs?: number;
  error?: string;
};

type BatchTiming = {
  index: number;
  elapsedMs?: number;
  httpStatus?: number;
  parsedCount?: number;
  sanitizedCount?: number;
  error?: string;
};

type ProgressMessage = {
  type?: string;
  batchIndex?: number;
  totalBatches?: number;
  elapsedMs?: number;
  httpStatus?: number;
  parsedCount?: number;
  sanitizedCount?: number;
  totalApplied?: number;
  error?: string;
};

const modeLabels: Record<RewriteMode, string> = {
  auto: "自动判断",
  "zh-to-en": "中文网页改造",
  "en-assist": "英文网页改造"
};

function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [mode, setMode] = useState<RewriteMode>("auto");
  const [status, setStatus] = useState("准备改造当前页面");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(SETTINGS_KEY).then((stored) => {
      const normalizedSettings = normalizeSettings(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
      setSettings(normalizedSettings);
      void chrome.storage.local.set({ [SETTINGS_KEY]: normalizedSettings });
    });
  }, []);

  useEffect(() => {
    const listener = (message: ProgressMessage) => {
      if (message?.type !== "IMMERSION_RUN_PROGRESS") {
        return false;
      }

      const batchText =
        message.batchIndex && message.totalBatches
          ? `第 ${message.batchIndex}/${message.totalBatches} 批`
          : "当前批次";
      const elapsedText = formatDuration(message.elapsedMs);
      const appliedText = `累计替换 ${message.totalApplied ?? 0} 处`;
      const parseText =
        typeof message.parsedCount === "number" && typeof message.sanitizedCount === "number"
          ? `，候选 ${message.parsedCount}，有效 ${message.sanitizedCount}`
          : "";
      const errorText = message.error ? `，${message.error}` : "";
      setStatus(`${batchText}完成：DeepSeek ${elapsedText}，${appliedText}${parseText}${errorText}`);
      return false;
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  async function runRewrite() {
    setBusy(true);
    setStatus("正在提取正文并请求 AI...");

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) {
        throw new Error("没有找到当前标签页。");
      }

      const result = await sendTabMessage<RunResult>(tab.id, {
        type: "RUN_IMMERSION_REWRITE",
        mode,
        coverage: settings.coverage
      });

      if (!result.ok) {
        throw new Error(result.error ?? "改造失败。");
      }

      const finalMode = result.mode ? modeLabels[result.mode] : modeLabels[mode];
      const cacheText = result.cached ? "，使用缓存" : "";
      const timingText = result.cached ? "" : `，${formatTimingSummary(result.batchTimings, result.totalElapsedMs)}`;
      setStatus(`${finalMode}完成：处理 ${result.chunks ?? 0} 段，替换 ${result.applied ?? 0} 处${cacheText}${timingText}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "改造失败。";
      setStatus(message.includes("Receiving end does not exist") ? "当前页面不支持插件注入，请刷新页面后重试。" : message);
    } finally {
      setBusy(false);
    }
  }

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  return (
    <main className="popup">
      <header>
        <div>
          <h1>语境英语</h1>
          <p className="eyebrow">Context English</p>
        </div>
        <button className="iconButton" onClick={openOptions} title="打开设置">
          ⚙
        </button>
      </header>

      <section className="panel" aria-label="改造模式">
        {(Object.keys(modeLabels) as RewriteMode[]).map((item) => (
          <button
            key={item}
            className={item === mode ? "modeButton active" : "modeButton"}
            type="button"
            onClick={() => setMode(item)}
          >
            {item === "auto" ? "自动" : item === "zh-to-en" ? "中文" : "英文"}
          </button>
        ))}
      </section>

      <section className="meta">
        <span>
          <small>难度</small>
          {settings.difficulty}
        </span>
        <span>
          <small>浓度</small>
          {settings.concentration}
        </span>
        <span>
          <small>覆盖</small>
          {settings.coverage}
        </span>
      </section>

      <button className="primary" disabled={busy} onClick={runRewrite}>
        {busy ? "改造中..." : "改造当前页"}
      </button>

      <p className="status">{status}</p>

      {!settings.apiKey && (
        <button className="linkButton" onClick={openOptions}>
          填写 DeepSeek API key
        </button>
      )}
    </main>
  );
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "耗时未知";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimingSummary(batchTimings: BatchTiming[] | undefined, totalElapsedMs: number | undefined): string {
  const finished = (batchTimings ?? []).filter((batch) => typeof batch.elapsedMs === "number");
  if (!finished.length) {
    return `总耗时 ${formatDuration(totalElapsedMs)}`;
  }

  const latest = finished.at(-1);
  const slowest = finished.reduce((max, batch) => ((batch.elapsedMs ?? 0) > (max.elapsedMs ?? 0) ? batch : max), finished[0]);
  const averageMs = finished.reduce((sum, batch) => sum + (batch.elapsedMs ?? 0), 0) / finished.length;
  const totalText = totalElapsedMs ? `总耗时 ${formatDuration(totalElapsedMs)}` : `${finished.length} 批`;
  return `${totalText}，最后一批 ${formatDuration(latest?.elapsedMs)}，最慢 ${formatDuration(slowest.elapsedMs)}，平均 ${formatDuration(averageMs)}`;
}

function sendTabMessage<T>(tabId: number, message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response as T);
    });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
