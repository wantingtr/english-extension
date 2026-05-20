import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outputDir = path.join(repoRoot, "output", "real-chrome");
const cdpUrl = process.env.CDP_URL ?? "http://127.0.0.1:9223";
const extensionId = process.env.EXTENSION_ID ?? "alhgdkgjhinpkbofhgecechhilpfhfcd";
const sourceExtensionId = process.env.SOURCE_EXTENSION_ID ?? "alhgdkgjhinpkbofhgecechhilpfhfcd";
const urls = process.argv.slice(2);

if (!urls.length) {
  console.error("Usage: npm run real:extension -- <url> [url...]");
  process.exit(1);
}

await mkdir(outputDir, { recursive: true });

const browser = await chromium.connectOverCDP(cdpUrl);
const context = browser.contexts()[0];

try {
  let worker = await waitForExtensionWorker(context, extensionId);
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  worker = await waitForExtensionWorker(context, extensionId, 20_000);
  const settings = readInstalledExtensionSettings(sourceExtensionId);
  await worker.evaluate(
    async ({ settings }) => {
      await chrome.storage.local.set({ englishImmersionSettings: settings });
    },
    { settings }
  );

  const results = [];
  for (const [index, url] of urls.entries()) {
    const page = await context.newPage();
    const baseName = `real-${String(index + 1).padStart(2, "0")}`;
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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
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

      debugLog = await readDebugLog(worker);
      markedCount = await page.locator("[data-english-immersion='true']").count();
      title = await page.title();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      title = await page.title().catch(() => "");
      debugLog = await readDebugLog(worker).catch(() => null);
    }

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(async () => {
      await page.screenshot({ path: screenshotPath });
    });

    const artifact = { url, finalUrl: page.url(), title, runResult, markedCount, error, debugLog };
    await writeFile(logPath, JSON.stringify(artifact, null, 2));

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
      error: error ?? runResult?.error ?? debugLog?.error ?? null,
      screenshotPath,
      logPath
    });

    await page.close();
  }

  const summaryPath = path.join(outputDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify({ cdpUrl, extensionId, results }, null, 2));
  console.log(JSON.stringify({ summaryPath, results }, null, 2));
} finally {
  await browser.close();
}

function readInstalledExtensionSettings(id) {
  const storagePath = path.join(
    process.env.HOME,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Default",
    "Local Extension Settings",
    id,
    "000003.log"
  );
  const source = readFileSync(storagePath, "latin1");
  const marker = "englishImmersionSettings";
  const markerIndex = source.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error(`Could not find ${marker} in installed extension storage`);
  }
  const match = source.slice(markerIndex, markerIndex + 1000).match(/\{[^\0]*?\}/);
  if (!match) {
    throw new Error("Could not parse installed extension settings");
  }
  return JSON.parse(match[0]);
}

async function readDebugLog(worker) {
  return await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("englishImmersionDebugLog");
    return stored.englishImmersionDebugLog ?? null;
  });
}

async function waitForExtensionWorker(context, id, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith(`chrome-extension://${id}/`));
    if (worker) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return await context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith(`chrome-extension://${id}/`),
    timeout: timeoutMs
  });
}
