import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outputDir = path.join(repoRoot, "output", "current-chrome");
const extensionId = process.env.EXTENSION_ID ?? "alhgdkgjhinpkbofhgecechhilpfhfcd";
const urls = process.argv.slice(2);

if (!urls.length) {
  console.error("Usage: npm run current:extension -- <url> [url...]");
  process.exit(1);
}

await mkdir(outputDir, { recursive: true });

const browser = await chromium.connectOverCDP(readDevToolsWsUrl());
const context = browser.contexts()[0];
let controller = await openController(context);

try {
  if (process.env.RELOAD_EXTENSION === "1") {
    await controller.evaluate(() => chrome.runtime.reload());
    await controller.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    controller = await openController(context);
  }

  const results = [];
  for (const [index, url] of urls.entries()) {
    const page = await context.newPage();
    const baseName = `current-${String(index + 1).padStart(2, "0")}`;
    const screenshotPath = path.join(outputDir, `${baseName}.png`);
    const logPath = path.join(outputDir, `${baseName}.json`);
    let runResult = null;
    let debugLog = null;
    let markedCount = 0;
    let title = "";
    let error = null;

    try {
      await controller.evaluate(async () => {
        const all = await chrome.storage.local.get(null);
        const cacheKeys = Object.keys(all).filter((key) => key.startsWith("rewriteCache:"));
        await chrome.storage.local.remove(["englishImmersionDebugLog", ...cacheKeys]);
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.bringToFront();

      const targetUrl = page.url();
      runResult = await controller.evaluate(async ({ targetUrl }) => {
        const tabs = await chrome.tabs.query({});
        const tab =
          tabs
            .filter((candidate) => candidate.url === targetUrl)
            .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0] ??
          tabs
            .filter((candidate) => candidate.url?.split("#")[0] === targetUrl.split("#")[0])
            .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0];
        if (!tab?.id) {
          throw new Error(`No tab found for ${targetUrl}`);
        }
        const message = {
          type: "RUN_IMMERSION_REWRITE",
          mode: "auto",
          coverage: 3
        };
        try {
          return await chrome.tabs.sendMessage(tab.id, message);
        } catch (error) {
          if (!String(error?.message ?? error).includes("Receiving end does not exist")) {
            throw error;
          }
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["assets/content.js"]
          });
          await new Promise((resolve) => setTimeout(resolve, 150));
          return await chrome.tabs.sendMessage(tab.id, message);
        }
      }, { targetUrl });

      debugLog = await readDebugLog(controller);
      markedCount = await page.locator("[data-english-immersion='true']").count();
      title = await page.title();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      title = await page.title().catch(() => "");
      debugLog = await readDebugLog(controller).catch(() => null);
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
      elapsedMs: debugLog?.batchStatuses?.map((batch) => batch.elapsedMs) ?? [],
      batchErrors: debugLog?.batchStatuses?.filter((batch) => batch.error).map((batch) => ({ index: batch.index, error: batch.error })) ?? [],
      error: error ?? runResult?.error ?? debugLog?.error ?? null,
      screenshotPath,
      logPath
    });
    await page.close().catch(() => {});
  }

  const summaryPath = path.join(outputDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify({ extensionId, results }, null, 2));
  console.log(JSON.stringify({ summaryPath, results }, null, 2));
} finally {
  await controller.close().catch(() => {});
  await browser.close();
}

async function openController(context) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded", timeout: 10_000 });
  return page;
}

function readDevToolsWsUrl() {
  const activePortPath = path.join(process.env.HOME, "Library", "Application Support", "Google", "Chrome", "DevToolsActivePort");
  const [port, browserPath] = readFileSync(activePortPath, "utf8").trim().split("\n");
  if (!port || !browserPath) {
    throw new Error(`Invalid DevToolsActivePort at ${activePortPath}`);
  }
  return `ws://127.0.0.1:${port}${browserPath}`;
}

async function readDebugLog(page) {
  return await page.evaluate(async () => {
    const stored = await chrome.storage.local.get("englishImmersionDebugLog");
    return stored.englishImmersionDebugLog ?? null;
  });
}
