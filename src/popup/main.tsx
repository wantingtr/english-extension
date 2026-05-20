import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../sharedDefaults";
import type { RewriteMode, Settings } from "../types";
import "./style.css";

type RunResult = {
  ok: boolean;
  mode?: "zh-to-en" | "en-assist";
  chunks?: number;
  applied?: number;
  cached?: boolean;
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
      setSettings({ ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) });
    });
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
      setStatus(`${finalMode}完成：处理 ${result.chunks ?? 0} 段，替换 ${result.applied ?? 0} 处${cacheText}`);
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
          <p className="eyebrow">Context English</p>
          <h1>语境英语</h1>
        </div>
        <button className="iconButton" onClick={openOptions} title="打开设置">
          ⚙
        </button>
      </header>

      <section className="panel">
        <label htmlFor="mode">改造模式</label>
        <select id="mode" value={mode} onChange={(event) => setMode(event.target.value as RewriteMode)}>
          <option value="auto">自动判断</option>
          <option value="zh-to-en">中文网页改造</option>
          <option value="en-assist">英文网页改造</option>
        </select>
      </section>

      <section className="meta">
        <span>难度 {settings.difficulty}</span>
        <span>浓度 {settings.concentration}</span>
        <span>覆盖 {settings.coverage}</span>
      </section>

      <button className="primary" disabled={busy} onClick={runRewrite}>
        {busy ? "改造中..." : "改造当前页面"}
      </button>

      <p className="status">{status}</p>

      {!settings.apiKey && (
        <button className="linkButton" onClick={openOptions}>
          填写硅基流动 API key
        </button>
      )}
    </main>
  );
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
