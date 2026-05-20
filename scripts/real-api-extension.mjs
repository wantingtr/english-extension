import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "dist");
const outputDir = path.join(repoRoot, "output", "real-api");
const profileDir = path.join(outputDir, "profile");
const extensionId = process.env.EXTENSION_ID ?? "alhgdkgjhinpkbofhgecechhilpfhfcd";
const urls = process.argv.slice(2);

if (!urls.length) {
  console.error("Usage: npm run real-api:extension -- <url> [url...]");
  process.exit(1);
}

await mkdir(outputDir, { recursive: true });
const settings = readInstalledExtensionSettings(extensionId);
await rm(profileDir, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  viewport: { width: 1365, height: 900 }
});

try {
  const worker = await waitForBackgroundWorker(context);
  await worker.evaluate(
    async ({ settings }) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ englishImmersionSettings: settings });
    },
    { settings }
  );

  const results = [];
  for (const [index, url] of urls.entries()) {
    const page = await context.newPage();
    const baseName = `real-api-${String(index + 1).padStart(2, "0")}`;
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

    await page.close();
  }

  const summaryPath = path.join(outputDir, "summary.json");
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        settings: {
          model: settings.model,
          baseUrl: settings.baseUrl,
          hasApiKey: Boolean(settings.apiKey),
          difficulty: settings.difficulty,
          concentration: settings.concentration,
          coverage: settings.coverage
        },
        results
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ summaryPath, results }, null, 2));
} finally {
  await context.close();
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
  const settings = JSON.parse(match[0]);
  if (!settings.apiKey) {
    throw new Error("Installed extension settings do not contain an API key");
  }
  return settings;
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

async function readDebugLog(worker) {
  return await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("englishImmersionDebugLog");
    return stored.englishImmersionDebugLog ?? null;
  });
}
