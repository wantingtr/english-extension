import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "dist");
const outputDir = path.join(repoRoot, "output", "playwright");
const profileDir = path.join(outputDir, "profile");
const urls = process.argv.slice(2);

if (!urls.length) {
  console.error("Usage: npm run smoke:extension -- <url> [url...]");
  process.exit(1);
}

await mkdir(outputDir, { recursive: true });

const mockServer = await startMockOpenAiServer();
const mockBaseUrl = `http://127.0.0.1:${mockServer.port}/v1`;

const context = await launchBrowserContext();

try {
  const extensionId = await waitForExtensionId(context);
  const worker = await waitForBackgroundWorker(context);

  await worker.evaluate(
    async ({ mockBaseUrl }) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        englishImmersionSettings: {
          apiKey: "mock-api-key",
          model: "mock-json-model",
          baseUrl: mockBaseUrl,
          difficulty: 2,
          concentration: 3,
          coverage: 3
        }
      });
    },
    { mockBaseUrl }
  );

  const results = [];
  for (const [index, url] of urls.entries()) {
    const page = await context.newPage();
    const baseName = `smoke-${String(index + 1).padStart(2, "0")}`;
    const screenshotPath = path.join(outputDir, `${baseName}.png`);
    const logPath = path.join(outputDir, `${baseName}.json`);
    let runResult = null;
    let debugLog = null;
    let markedCount = 0;
    let title = "";
    let error = null;

    try {
      await worker.evaluate(async () => {
        await chrome.storage.local.remove("englishImmersionDebugLog");
      });
      await page.bringToFront();
      await gotoWithRetries(page, url);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.bringToFront();

      runResult = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          throw new Error("No active tab found");
        }
        return await chrome.tabs.sendMessage(tab.id, {
          type: "RUN_IMMERSION_REWRITE",
          mode: "auto",
          coverage: 3
        });
      });

      debugLog = await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get("englishImmersionDebugLog");
        return stored.englishImmersionDebugLog ?? null;
      });

      markedCount = await page.locator("[data-english-immersion='true']").count();
      title = await page.title();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      title = await page.title().catch(() => "");
      debugLog = await worker
        .evaluate(async () => {
          const stored = await chrome.storage.local.get("englishImmersionDebugLog");
          return stored.englishImmersionDebugLog ?? null;
        })
        .catch(() => null);
    }

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(async () => {
      await page.screenshot({ path: screenshotPath });
    });
    await writeFile(logPath, JSON.stringify({ url, finalUrl: page.url(), title, runResult, markedCount, error, debugLog }, null, 2));

    results.push({
      url,
      finalUrl: page.url(),
      title,
      ok: Boolean(runResult?.ok),
      chunks: runResult?.chunks ?? 0,
      applied: runResult?.applied ?? 0,
      markedCount,
      batches: debugLog?.batchStatuses?.length ?? 0,
      error: error ?? runResult?.error ?? debugLog?.error ?? null,
      screenshotPath,
      logPath
    });

    await page.close();
  }

  const summaryPath = path.join(outputDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify({ extensionId, mockBaseUrl, results }, null, 2));
  console.log(JSON.stringify({ summaryPath, results }, null, 2));
} finally {
  await context.close();
  await new Promise((resolve) => mockServer.server.close(resolve));
}

async function waitForExtensionId(context) {
  const worker = await waitForBackgroundWorker(context);
  const url = worker.url();
  const [, extensionId] = url.match(/^chrome-extension:\/\/([^/]+)\//) ?? [];
  if (!extensionId) {
    throw new Error(`Could not resolve extension id from ${url}`);
  }
  return extensionId;
}

async function waitForBackgroundWorker(context) {
  const existing = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"));
  if (existing) {
    return existing;
  }
  return await context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith("chrome-extension://"),
    timeout: 15_000
  });
}

async function startMockOpenAiServer() {
  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      writeJson(response, 204, null);
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      writeJson(response, 404, { error: "Not found" });
      return;
    }

    const body = await readRequestBody(request);
    const payload = JSON.parse(body);
    const userMessage = payload.messages?.find((message) => message.role === "user")?.content ?? "{}";
    const userPayload = JSON.parse(userMessage);
    const selections = buildSelections(userPayload.chunks ?? []);

    writeJson(response, 200, {
      choices: [
        {
          message: {
            content: JSON.stringify({ selections })
          }
        }
      ]
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start mock server");
  }
  return { server, port: address.port };
}

function buildSelections(chunks) {
  return chunks
    .map((chunk) => {
      const candidate = pickQuote(chunk.text);
      if (!candidate) {
        return null;
      }
      const { quote, en } = candidate;
      const start = chunk.text.indexOf(quote);
      return {
        chunkId: chunk.id,
        quote,
        start,
        end: start + quote.length,
        en,
        type: quote.length <= 4 ? "word" : "phrase",
        level: 2,
        isProperNoun: false,
        isTransferable: true,
        learningValue: 4
      };
    })
    .filter(Boolean);
}

function pickQuote(text) {
  const reusablePhrases = [
    ["依然有效", "still works"],
    ["刻意降低", "deliberately reduce"],
    ["关注", "focus on"],
    ["最关注的指标", "the metric they cared about most"],
    ["一路飙升", "kept climbing"],
    ["算力吃紧", "compute was stretched thin"],
    ["推迟", "postpone"],
    ["规模效应", "economies of scale"],
    ["同步增长", "grow in step"],
    ["付费订阅", "paid subscription"],
    ["回答不够准确", "answers are not accurate enough"],
    ["复杂任务", "complex tasks"],
    ["尤其吃力", "especially struggles with"],
    ["紧急开会", "hold an emergency meeting"],
    ["失败任务", "failed tasks"],
    ["追求回答质量", "pursue answer quality"],
    ["必然受影响", "will inevitably be affected"],
    ["增长奇迹", "growth miracle"],
    ["相对克制", "relatively restrained"],
    ["特殊之处", "what makes it distinctive"],
    ["绝对领先", "clear lead"],
    ["顺应人性", "work with human nature"],
    ["依赖数据", "rely on data"],
    ["极速迭代", "iterate rapidly"],
    ["信念正在动摇", "the belief is being shaken"],
    ["威胁它的地位", "threaten its position"],
    ["残酷的地方", "the brutal part"],
    ["很快被改写", "be rewritten quickly"],
    ["低矮的红砖小楼", "low red-brick building"],
    ["繁华街道", "busy streets"],
    ["严格保密状态", "under strict secrecy"],
    ["具体内容", "specific details"],
    ["形成与转向", "formation and shift"],
    ["输入URL", "enter a URL"],
    ["页面加载", "page loading"],
    ["请帮忙指出", "please point out"],
    ["完善自己的", "improve your own"],
    ["知识体系", "knowledge system"],
    ["需要花费大量时间", "requires a lot of time"],
    ["多批次阅读", "read in batches"],
    ["因此并不确保适用于所有场景", "therefore not guaranteed to fit every scenario"],
    ["浏览器", "browser"],
    ["服务器", "server"],
    ["缓存", "cache"],
    ["渲染", "rendering"],
    ["执行", "execute"],
    ["解析", "parse"],
    ["请求", "request"],
    ["响应", "response"],
    ["年度大促", "annual sale"],
    ["热门航线", "popular routes"],
    ["天天有", "available every day"],
    ["福利力度", "discount level"],
    ["拿好拿满", "make the most of it"],
    ["活动期间", "during the campaign"],
    ["最多可获得", "can get up to"],
    ["上不封顶", "no upper limit"],
    ["性价比拉满", "great value for money"],
    ["机票", "flight tickets"],
    ["简介", "introduction"],
    ["实现什么", "what it can do"],
    ["弱类型", "weakly typed"],
    ["脚本语言", "scripting language"],
    ["网页", "web page"],
    ["无需特殊的准备", "requires no special setup"],
    ["现代浏览器", "modern browsers"],
    ["完全兼容", "fully compatible"],
    ["安全地执行", "execute safely"],
    ["没有任何关系", "has nothing to do with"],
    ["这些术语", "these terms"],
    ["性能", "performance"],
    ["原理解析", "principle explained"],
    ["模块", "module"],
    ["更新", "update"],
    ["编译", "compile"],
    ["开发环境", "development environment"]
  ];

  const exact = reusablePhrases
    .map(([quote, en]) => ({ quote, en, index: text.indexOf(quote) }))
    .filter((candidate) => candidate.index > 0)
    .sort((a, b) => scoreCandidate(text, b) - scoreCandidate(text, a))[0];
  if (exact) {
    return exact;
  }

  const matches = [...text.matchAll(/[\u4e00-\u9fff]{2,10}/g)]
    .map((match) => ({
      quote: match[0],
      en: translateFallback(match[0]),
      index: match.index ?? 0
    }))
    .filter((candidate) => candidate.index > 4 && candidate.en && !looksLikeBadQuote(candidate.quote));

  if (matches.length) {
    return matches.sort((a, b) => scoreCandidate(text, b) - scoreCandidate(text, a))[0];
  }

  return null;
}

function scoreCandidate(text, candidate) {
  let score = candidate.quote.length;
  if (candidate.index > 0) {
    score += 8;
  }
  if (candidate.index > text.length * 0.25) {
    score += 4;
  }
  if (/[的了是在和与及或、，。]/.test(candidate.quote)) {
    score -= 4;
  }
  if (candidate.index === 0) {
    score -= 20;
  }
  return score;
}

function looksLikeBadQuote(quote) {
  return (
    quote.length < 2 ||
    /^[的一是在了和与及或、，。]+$/.test(quote) ||
    /^(这个|一个|我们|他们|这里|现在|过去|今年|近日)$/.test(quote)
  );
}

function translateFallback(quote) {
  const fallbackMap = {
    形成: "formation",
    转向: "shift",
    有效: "effective",
    暴露: "expose",
    边界: "limits",
    降低: "reduce",
    关注: "attention",
    目标: "goal",
    推迟: "delay",
    增长: "growth",
    收入: "revenue",
    准确: "accurate",
    质量: "quality",
    影响: "impact",
    方法论: "methodology",
    入口: "entry point",
    动摇: "waver",
    改写: "rewrite",
    页面: "page",
    加载: "load",
    浏览器: "browser",
    渲染: "render",
    请求: "request",
    响应: "response",
    简介: "introduction",
    执行: "execute"
  };

  for (const [zh, en] of Object.entries(fallbackMap)) {
    if (quote.includes(zh)) {
      return en;
    }
  }

  return null;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeJson(response, status, value) {
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json"
  });
  response.end(value === null ? "" : JSON.stringify(value));
}

async function launchBrowserContext() {
  return await chromium.launchPersistentContext(profileDir, {
    headless: false,
    ignoreHTTPSErrors: true,
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--disable-quic",
      "--disable-blink-features=AutomationControlled"
    ],
    viewport: { width: 1365, height: 900 }
  });
}

async function gotoWithRetries(page, url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1500 * attempt);
    }
  }
  throw lastError;
}
