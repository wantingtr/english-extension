import { DEBUG_LOG_KEY, SETTINGS_KEY, normalizeSettings } from "./sharedDefaults";
import type { BatchTiming, RewriteReplacement, RewriteRequest, RewriteResponse, Settings } from "./types";

type RewriteMessage = {
  type: "REWRITE_PAGE";
  payload: RewriteRequest;
};

type AiSelection = {
  chunkId: string;
  quote: string;
  start?: number;
  end?: number;
  en?: string;
  zh?: string;
  explanation?: string;
  type: "word" | "phrase" | "sentence";
  level?: number;
  isProperNoun?: boolean;
  isTransferable?: boolean;
  learningValue?: number;
};

type DebugLog = {
  status: "running" | "completed" | "failed";
  timestamp: string;
  url: string;
  title: string;
  mode: RewriteRequest["mode"];
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
  requestBody?: ChatCompletionRequestBody;
  httpStatus?: number;
  rawResponse?: string;
  parsedCount?: number;
  sanitizedCount?: number;
  acceptedSelections?: SelectionAudit[];
  rejectedSelections?: SelectionAudit[];
  cached?: boolean;
  batchStatuses?: BatchStatus[];
  error?: string;
  networkErrorName?: string;
  networkErrorDetails?: string;
  currentBatchIndex?: number;
  completedBatchCount?: number;
  totalBatchCount?: number;
};

type BatchStatus = {
  index: number;
  chunkIds: string[];
  maxSelections?: number;
  requestBody?: ChatCompletionRequestBody;
  elapsedMs?: number;
  httpStatus?: number;
  parsedCount?: number;
  sanitizedCount?: number;
  acceptedSelections?: SelectionAudit[];
  rejectedSelections?: SelectionAudit[];
  error?: string;
  rawResponse?: string;
};

type ChatCompletionRequestBody = {
  model: string;
  thinking: { type: "disabled" };
  temperature: number;
  max_tokens: number;
  response_format: { type: "json_object" };
  messages: Array<{ role: "system" | "user"; content: string }>;
};

type SelectionAudit = {
  selection: AiSelection;
  reason?: string;
  replacement?: RewriteReplacement;
};

const CACHE_PREFIX = "rewriteCache:";
const MAX_REPLACEMENTS = 96;
const DEBUG_CHUNK_TEXT_LIMIT = 240;
const DEBUG_RAW_RESPONSE_LIMIT = 12000;
const DEBUG_BATCH_RAW_RESPONSE_LIMIT = 12000;
const PROMPT_VERSION = "selection-protocol-v9-partial-cache-safe";
const REQUEST_TIMEOUT_MS = 18_000;
const CHUNKS_PER_AI_REQUEST = 4;
const MAX_PARALLEL_AI_REQUESTS = 3;
const MAX_SELECTIONS_PER_AI_REQUEST = 8;
const BASE_CHUNKS_PER_SELECTION_BUDGET = 4;

chrome.runtime.onMessage.addListener((message: RewriteMessage, sender, sendResponse) => {
  if (message?.type !== "REWRITE_PAGE") {
    return false;
  }

  handleRewrite(message.payload, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        error: error instanceof Error ? error.message : "改写失败，请稍后重试。"
      });
    });

  return true;
});

async function handleRewrite(request: RewriteRequest, sender: chrome.runtime.MessageSender): Promise<RewriteResponse> {
  const settings = await getSettings();
  const debugLog = createBaseDebugLog(request, settings);

  if (!settings.apiKey.trim()) {
    await saveDebugLog({ ...debugLog, error: "还没有填写 DeepSeek API key，请先打开设置页填写。" });
    throw new Error("还没有填写 DeepSeek API key，请先打开设置页填写。");
  }

  const cacheKey = await buildCacheKey(request, settings);
  const cached = await chrome.storage.local.get(cacheKey);
  const cachedValue = cached[cacheKey] as RewriteResponse | undefined;

  if (cachedValue?.replacements?.length) {
    await saveDebugLog({
      ...debugLog,
      cached: true,
      parsedCount: cachedValue.replacements.length,
      sanitizedCount: cachedValue.replacements.length
    });
    return { ...cachedValue, cached: true, streamed: false };
  }

  const startedAt = Date.now();
  const { replacements, batchTimings, completedChunkIds, failedChunkIds } = await rewriteWithDeepSeek(request, settings, debugLog, sender);
  const cachedResponse: RewriteResponse = {
    replacements: replacements.slice(0, MAX_REPLACEMENTS),
    cached: false,
    streamed: false,
    batchTimings,
    totalElapsedMs: Date.now() - startedAt,
    completedChunkIds,
    failedChunkIds
  };

  if (!failedChunkIds.length) {
    await chrome.storage.local.set({ [cacheKey]: cachedResponse });
  }
  return { ...cachedResponse, streamed: Boolean(request.requestId) };
}

async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = normalizeSettings(stored[SETTINGS_KEY] as Partial<Settings> | undefined);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function buildCacheKey(request: RewriteRequest, settings: Settings): Promise<string> {
  const source = JSON.stringify({
    url: request.url,
    mode: request.mode,
    model: settings.model,
    promptVersion: PROMPT_VERSION,
    difficulty: settings.difficulty,
    concentration: settings.concentration,
    coverage: settings.coverage,
    chunks: request.chunks.map((chunk) => chunk.text)
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${CACHE_PREFIX}${hex}`;
}

async function rewriteWithDeepSeek(
  request: RewriteRequest,
  settings: Settings,
  debugLog: DebugLog,
  sender: chrome.runtime.MessageSender
): Promise<{
  replacements: RewriteReplacement[];
  batchTimings: BatchTiming[];
  completedChunkIds: string[];
  failedChunkIds: string[];
}> {
  const completionUrl = buildCompletionUrl(settings.baseUrl);

  try {
    debugLog.requestUrl = completionUrl;
    debugLog.hostPermissionGranted = await hasHostPermission(completionUrl);

    if (!debugLog.hostPermissionGranted) {
      throw new Error(`扩展没有访问 ${new URL(completionUrl).origin} 的权限，请重新构建并重新加载插件。`);
    }

    const batches = createRequestBatches(request.chunks);
    const selections: AiSelection[] = [];
    const replacements: RewriteReplacement[] = [];
    const acceptedSelections: SelectionAudit[] = [];
    const rejectedSelections: SelectionAudit[] = [];
    const rawResponses: string[] = Array.from({ length: batches.length }, () => "");
    debugLog.batchStatuses = batches.map((chunks, index) => ({
      index: index + 1,
      chunkIds: chunks.map((chunk) => chunk.id)
    }));
    debugLog.status = "running";
    debugLog.completedBatchCount = 0;
    debugLog.totalBatchCount = batches.length;
    await saveDebugLog(debugLog);

    const processBatch = async (chunks: RewriteRequest["chunks"], index: number): Promise<void> => {
      const batchRequest = { ...request, chunks };
      const status = debugLog.batchStatuses?.[index];
      if (!status) {
        return;
      }
      const startedAt = Date.now();
      debugLog.currentBatchIndex = status.index;
      await saveDebugLog(debugLog);

      try {
        const content = await fetchModelContent(completionUrl, batchRequest, settings, status);
        status.elapsedMs = Date.now() - startedAt;
        rawResponses[index] = `Batch ${status.index}: ${content}`;
        debugLog.rawResponse = rawResponses.filter(Boolean).join("\n\n").slice(0, DEBUG_RAW_RESPONSE_LIMIT);
        await saveDebugLog(debugLog);

        const batchSelections = parseModelSelections(content);
        status.parsedCount = batchSelections.length;
        const batchInspection = selectionsToReplacements(batchSelections, batchRequest, settings);
        const batchReplacements = batchInspection.replacements;
        status.sanitizedCount = batchReplacements.length;
        status.acceptedSelections = batchInspection.acceptedSelections;
        status.rejectedSelections = batchInspection.rejectedSelections;
        selections.push(...batchSelections);
        replacements.push(...batchReplacements);
        acceptedSelections.push(...batchInspection.acceptedSelections);
        rejectedSelections.push(...batchInspection.rejectedSelections);
        await emitBatchResult(request, sender, status, batchReplacements, batches.length);
        debugLog.completedBatchCount = (debugLog.completedBatchCount ?? 0) + 1;
        await saveDebugLog(debugLog);
      } catch (error) {
        status.elapsedMs = Date.now() - startedAt;
        status.error = error instanceof Error ? normalizeFetchError(error) : "改写失败，请稍后重试。";
        debugLog.completedBatchCount = (debugLog.completedBatchCount ?? 0) + 1;
        await saveDebugLog(debugLog);
        await emitBatchResult(request, sender, status, [], batches.length);
        if (!isRecoverableBatchError(error)) {
          throw error;
        }
      }
    };

    let nextBatchIndex = 0;
    const processBatchQueue = async (): Promise<void> => {
      while (nextBatchIndex < batches.length) {
        const index = nextBatchIndex;
        nextBatchIndex += 1;
        await processBatch(batches[index], index);
      }
    };
    const workers = Array.from({ length: Math.min(MAX_PARALLEL_AI_REQUESTS, batches.length) }, processBatchQueue);
    const results = await Promise.allSettled(workers);
    const fatalResult = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (fatalResult) {
      throw fatalResult.reason;
    }

    const sortedReplacements = sortReplacementsByRequestOrder(replacements, request);
    debugLog.httpStatus = debugLog.batchStatuses.at(-1)?.httpStatus;
    debugLog.rawResponse = rawResponses.filter(Boolean).join("\n\n").slice(0, DEBUG_RAW_RESPONSE_LIMIT);
    debugLog.parsedCount = selections.length;
    debugLog.sanitizedCount = sortedReplacements.length;
    debugLog.acceptedSelections = acceptedSelections;
    debugLog.rejectedSelections = rejectedSelections;
    debugLog.status = "completed";
    debugLog.currentBatchIndex = undefined;
    if (!sortedReplacements.length && debugLog.batchStatuses.every((status) => status.error)) {
      const firstBatchError = debugLog.batchStatuses[0]?.error;
      if (firstBatchError) {
        throw new Error(firstBatchError);
      }
    }
    const failedChunkIds = getFailedChunkIds(debugLog.batchStatuses);
    const completedChunkIds = getCompletedChunkIds(debugLog.batchStatuses);
    await saveDebugLog(debugLog);
    return {
      replacements: sortedReplacements.slice(0, MAX_REPLACEMENTS),
      batchTimings: getBatchTimings(debugLog.batchStatuses),
      completedChunkIds,
      failedChunkIds
    };
  } catch (error) {
    if (error instanceof Error) {
      debugLog.networkErrorName = error.name;
      debugLog.networkErrorDetails = error.stack?.slice(0, 2000) ?? error.message;
      debugLog.error = normalizeFetchError(error);
    } else {
      debugLog.error = "改写失败，请稍后重试。";
      debugLog.networkErrorDetails = String(error);
    }
    debugLog.status = "failed";
    await saveDebugLog(debugLog);
    throw error;
  }
}

async function fetchModelContent(
  completionUrl: string,
  request: RewriteRequest,
  settings: Settings,
  batchStatus: BatchStatus
): Promise<string> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);
  const requestBody = buildChatCompletionRequestBody(request, settings);
  batchStatus.requestBody = requestBody;
  batchStatus.maxSelections = getMaxSelectionsForChunkCount(settings.coverage, request.chunks.length);

  try {
    const response = await fetch(completionUrl, {
      method: "POST",
      signal: abortController.signal,
      headers: {
        Authorization: `Bearer ${settings.apiKey.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    batchStatus.httpStatus = response.status;
    const rawResponse = await response.text();
    batchStatus.rawResponse = rawResponse.slice(0, DEBUG_BATCH_RAW_RESPONSE_LIMIT);

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("DeepSeek API key 无效或没有权限。");
      }
      if (response.status === 429) {
        throw new Error("DeepSeek 请求过于频繁或额度不足。");
      }
      throw new Error(`DeepSeek 请求失败：HTTP ${response.status}`);
    }

    let data: {
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    try {
      data = JSON.parse(rawResponse) as typeof data;
    } catch {
      throw new Error("DeepSeek 返回了无法解析的 JSON 响应。");
    }

    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim();

    if (!content) {
      const finishReason = choice?.finish_reason ? `，finish_reason=${choice.finish_reason}` : "";
      throw new Error(`模型没有返回候选片段${finishReason}。DeepSeek JSON 模式偶发空 content，请重试；完整响应已写入调试日志。`);
    }

    return content;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildChatCompletionRequestBody(request: RewriteRequest, settings: Settings): ChatCompletionRequestBody {
  const maxSelections = getMaxSelectionsForChunkCount(settings.coverage, request.chunks.length);

  return {
    model: settings.model,
    thinking: { type: "disabled" },
    temperature: 0,
    max_tokens: getMaxTokensForSelectionCount(maxSelections),
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(request.mode, settings, maxSelections)
      },
      {
        role: "user",
        content: JSON.stringify({
          pageTitle: request.title,
          chunks: request.chunks
        })
      }
    ]
  };
}

function normalizeFetchError(error: Error): string {
  if (error.name === "AbortError") {
    return "单批请求超时，已跳过该批并继续处理其它内容。";
  }
  if (error.message === "Failed to fetch") {
    return "无法连接到 AI API。请检查网络、代理、Base URL，或重新加载已构建的插件。";
  }
  return error.message;
}

function isRecoverableBatchError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === "Failed to fetch" ||
      error.message.includes("没有返回候选片段") ||
      error.message.includes("候选 JSON 无法解析"))
  );
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function createRequestBatches(chunks: RewriteRequest["chunks"]): RewriteRequest["chunks"][] {
  return chunkArray(chunks, CHUNKS_PER_AI_REQUEST);
}

function getMaxSelectionsPerRequest(coverage: number): number {
  const normalizedCoverage = Math.min(5, Math.max(1, Math.round(coverage)));
  const values: Record<number, number> = {
    1: 1,
    2: 2,
    3: 4,
    4: 6,
    5: MAX_SELECTIONS_PER_AI_REQUEST
  };
  return values[normalizedCoverage];
}

function getMaxSelectionsForChunkCount(coverage: number, chunkCount: number): number {
  const base = getMaxSelectionsPerRequest(coverage);
  const scale = Math.max(1, chunkCount / BASE_CHUNKS_PER_SELECTION_BUDGET);
  return Math.min(MAX_REPLACEMENTS, Math.ceil(base * scale));
}

function getMaxTokensForSelectionCount(maxSelections: number): number {
  return Math.min(1800, Math.max(760, 440 + maxSelections * 90));
}

async function emitBatchResult(
  request: RewriteRequest,
  sender: chrome.runtime.MessageSender,
  status: BatchStatus,
  replacements: RewriteReplacement[],
  totalBatches: number
): Promise<void> {
  if (!request.requestId || !sender.tab?.id) {
    return;
  }

  await new Promise<void>((resolve) => {
    chrome.tabs.sendMessage(
      sender.tab!.id!,
      {
        type: "IMMERSION_BATCH_RESULT",
        requestId: request.requestId,
        batchIndex: status.index,
        totalBatches,
        elapsedMs: status.elapsedMs,
        httpStatus: status.httpStatus,
        parsedCount: status.parsedCount,
        sanitizedCount: status.sanitizedCount,
        error: status.error,
        replacements
      },
      () => {
        void chrome.runtime.lastError;
        resolve();
      }
    );
  });
}

function getBatchTimings(statuses: BatchStatus[] | undefined): BatchTiming[] {
  return (statuses ?? []).map((status) => ({
    index: status.index,
    elapsedMs: status.elapsedMs,
    httpStatus: status.httpStatus,
    parsedCount: status.parsedCount,
    sanitizedCount: status.sanitizedCount,
    error: status.error
  }));
}

function getCompletedChunkIds(statuses: BatchStatus[] | undefined): string[] {
  return (statuses ?? []).flatMap((status) => (status.error ? [] : status.chunkIds));
}

function getFailedChunkIds(statuses: BatchStatus[] | undefined): string[] {
  return (statuses ?? []).flatMap((status) => (status.error ? status.chunkIds : []));
}

function buildCompletionUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedBaseUrl) {
    throw new Error("Base URL 不能为空。");
  }
  return `${normalizedBaseUrl}/chat/completions`;
}

async function hasHostPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin;
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

function buildSystemPrompt(mode: RewriteRequest["mode"], settings: Settings, maxSelections: number): string {
  const difficultyMap: Record<number, string> = {
    1: "基础词汇/短语",
    2: "常见生活、学习、工作表达",
    3: "大学四级常用自然表达",
    4: "大学六级成熟表达",
    5: "高阶地道表达"
  };
  const concentrationMap: Record<number, string> = {
    1: "word 优先，不选 sentence",
    2: "word 优先，少量固定 phrase",
    3: "word/phrase 均衡，谨慎 sentence",
    4: "phrase 优先，少量短 sentence",
    5: "phrase/短 sentence 更多"
  };
  const concentrationRuleMap: Record<number, string> = {
    1: "规则：中文 quote 优先 2-4 字，type 主要 word；每批最多 1 个 phrase，禁止 sentence。",
    2: "规则：中文 quote 优先 2-4 字，word 多于 phrase；phrase 只选固定搭配/强可迁移表达。",
    3: "规则：word/phrase 均衡，sentence 只选很短且高价值的。",
    4: "规则：phrase 优先，可少量短 sentence，禁止整段翻译。",
    5: "规则：可更多 phrase/短 sentence，但必须短、可迁移、有学习价值。"
  };
  const modeTask =
    mode === "zh-to-en"
      ? [
          "中文网页：选适合英语学习的中文原文 quote，并给自然英文 en。",
          "只选可迁移的高频表达/动作/状态/关系/评价；避开专名、数字、日期、价格、URL、代码、当前页唯一信息。",
          "quote 必须从 chunk.text 逐字复制；en 只写英文，不加中文括注；本地会生成 en(quote)。",
          "每个 chunk 0-2 个候选；禁止整段翻译；宁可少选。"
        ].join("\n")
      : [
          "英文网页：选适合解释的英文原文 quote，并给中文 zh。",
          "quote 必须从 chunk.text 逐字复制；zh 只写中文释义；本地会生成 quote(zh)。",
          "每个 chunk 0-2 个候选；优先难词/短语/短表达，禁止整段长句。"
        ].join("\n");

  return [
    "你是英文学习网页候选片段选择器，不是翻译器。",
    modeTask,
    `难度 ${settings.difficulty}：${difficultyMap[settings.difficulty]}。浓度 ${settings.concentration}：${concentrationMap[settings.concentration]}。覆盖 ${settings.coverage}。`,
    concentrationRuleMap[settings.concentration],
    `最多返回 ${maxSelections} 个 selection；不要为凑数选低价值内容。`,
    "输出严格 JSON，无 Markdown/解释：",
    '1. 格式：{"selections":[...]}',
    "2. 每个 selection 只包含 chunkId、quote、type，以及 en 或 zh。",
    mode === "zh-to-en"
      ? "3. 中文模式：quote 含中文，en 含英文且不含中文。"
      : "3. 英文模式：quote 含英文，zh 含中文。",
    "4. type 只能是 word、phrase、sentence。",
    mode === "zh-to-en"
      ? settings.concentration <= 2
        ? "5. 中文 quote 优先 2-4 字；phrase 最多 8 字；不要 sentence。"
        : "5. 中文 quote 优先 2-10 字，最多 16 字；浓度非 5 时尽量不选 sentence。"
      : "5. 英文 quote 优先 1-6 个词。",
    mode === "zh-to-en"
      ? "6. 不要返回专名/不可迁移/数字日期价格 URL 代码。"
      : "6. 不要返回专名/不可迁移/数字日期价格 URL 代码。",
    '7. 没有合适候选返回 {"selections":[]}。',
    mode === "zh-to-en"
      ? '示例：{"selections":[{"chunkId":"chunk-0","quote":"原文片段","en":"natural English","type":"phrase"}]}'
      : '示例：{"selections":[{"chunkId":"chunk-0","quote":"source phrase","zh":"中文释义","type":"phrase"}]}'
  ].join("\n");
}

function parseModelSelections(content: string): AiSelection[] {
  const candidates = getJsonCandidates(content);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const selections = pickSelections(parsed);
      if (selections) {
        return selections;
      }
    } catch {
      // Try the next candidate. Some models wrap valid JSON in prose.
    }
  }

  const recovered = recoverSelectionObjects(content);
  if (recovered.length) {
    return recovered;
  }

  console.warn("[Chinglishify] Raw model response was not parseable selections JSON:", content);
  throw new Error("模型返回的候选 JSON 无法解析，请重试；设置页调试面板可查看原始返回。");
}

function getJsonCandidates(content: string): string[] {
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  const candidates = [normalized];
  const objectStart = normalized.indexOf("{");
  const objectEnd = normalized.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(normalized.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = normalized.indexOf("[");
  const arrayEnd = normalized.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(normalized.slice(arrayStart, arrayEnd + 1));
  }

  return [...new Set(candidates)];
}

function pickSelections(parsed: unknown): AiSelection[] | null {
  if (Array.isArray(parsed)) {
    return normalizeSelectionList(parsed);
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.selections)) {
    return normalizeSelectionList(record.selections);
  }
  if (Array.isArray(record.items)) {
    return normalizeSelectionList(record.items);
  }
  if (Array.isArray(record.data)) {
    return normalizeSelectionList(record.data);
  }
  if (Array.isArray(record.chunks)) {
    const grouped: unknown[] = [];
    for (const chunk of record.chunks) {
      if (!chunk || typeof chunk !== "object") {
        continue;
      }
      const chunkRecord = chunk as Record<string, unknown>;
      const chunkId = typeof chunkRecord.chunkId === "string" ? chunkRecord.chunkId : undefined;
      if (!chunkId || !Array.isArray(chunkRecord.selections)) {
        continue;
      }
      for (const selection of chunkRecord.selections) {
        grouped.push({ ...(selection as Record<string, unknown>), chunkId });
      }
    }
    return normalizeSelectionList(grouped);
  }

  return null;
}

function normalizeSelectionList(values: unknown[]): AiSelection[] {
  return values
    .map((value) => (value && typeof value === "object" ? normalizeSelection(value as Record<string, unknown>) : null))
    .filter((value): value is AiSelection => Boolean(value));
}

function normalizeSelection(record: Record<string, unknown>): AiSelection | null {
  const chunkId = pickString(record, ["chunkId", "chunkID", "id"]);
  const quote = pickString(record, ["quote", "original", "source"]);
  const en = pickString(record, ["en", "english", "translation"]);
  const zh = pickString(record, ["zh", "chinese", "gloss", "meaning", "explanation"]);
  const type = normalizeType(pickString(record, ["type", "kind"]));

  if (!chunkId || !quote || !type) {
    return null;
  }

  return {
    chunkId,
    quote,
    start: pickNumber(record, ["start", "begin"]),
    end: pickNumber(record, ["end", "stop"]),
    en: en ?? undefined,
    zh: zh ?? undefined,
    explanation: pickString(record, ["explanation", "reason"]) ?? undefined,
    type,
    level: pickNumber(record, ["level", "difficulty"]),
    isProperNoun: pickBoolean(record, ["isProperNoun", "properNoun"]),
    isTransferable: pickBoolean(record, ["isTransferable", "transferable"]),
    learningValue: pickNumber(record, ["learningValue", "value", "score"])
  };
}

function recoverSelectionObjects(content: string): AiSelection[] {
  const items: AiSelection[] = [];
  const objectPattern = /\{[^{}]*"chunkId"[^{}]*"quote"[^{}]*\}/g;
  const matches = content.match(objectPattern) ?? [];

  for (const match of matches) {
    try {
      const parsed = JSON.parse(match) as unknown;
      if (parsed && typeof parsed === "object") {
        const item = normalizeSelection(parsed as Record<string, unknown>);
        if (item) {
          items.push(item);
        }
      }
    } catch {
      const item = recoverLooseSelection(match);
      if (item) {
        items.push(item);
      }
    }
  }

  return items;
}

function recoverLooseSelection(source: string): AiSelection | null {
  const chunkId = matchJsonString(source, "chunkId");
  const quote = matchJsonString(source, "quote");
  const en = matchJsonString(source, "en") ?? matchJsonString(source, "english");
  const zh = matchJsonString(source, "zh") ?? matchJsonString(source, "chinese");
  const type = normalizeType(matchJsonString(source, "type") ?? "phrase");

  if (!chunkId || !quote || !type) {
    return null;
  }

  return {
    chunkId,
    quote,
    start: matchJsonNumber(source, "start") ?? undefined,
    end: matchJsonNumber(source, "end") ?? undefined,
    en: en ?? undefined,
    zh: zh ?? undefined,
    type,
    isProperNoun: matchJsonBoolean(source, "isProperNoun") ?? undefined,
    isTransferable: matchJsonBoolean(source, "isTransferable") ?? undefined,
    learningValue: matchJsonNumber(source, "learningValue") ?? undefined
  };
}

function selectionsToReplacements(
  selections: AiSelection[],
  request: RewriteRequest,
  settings: Settings
): { replacements: RewriteReplacement[]; acceptedSelections: SelectionAudit[]; rejectedSelections: SelectionAudit[] } {
  const chunksById = new Map(request.chunks.map((chunk) => [chunk.id, chunk.text]));
  const seen = new Set<string>();
  const replacements: RewriteReplacement[] = [];
  const acceptedSelections: SelectionAudit[] = [];
  const rejectedSelections: SelectionAudit[] = [];
  const typeCounts = { word: 0, phrase: 0, sentence: 0 };

  for (const selection of selections) {
    const chunkText = chunksById.get(selection.chunkId);
    if (!chunkText) {
      rejectedSelections.push({ selection, reason: "chunkId 不在本批请求 chunks 中" });
      continue;
    }

    const modeReason = getModeRejectionReason(selection, request.mode);
    if (modeReason) {
      rejectedSelections.push({ selection, reason: modeReason });
      continue;
    }

    const match = locateQuote(chunkText, selection);
    if (!match) {
      rejectedSelections.push({ selection, reason: "quote 无法在 chunk.text 中精确定位" });
      continue;
    }

    const key = `${selection.chunkId}:${match.start}:${match.end}`;
    if (seen.has(key)) {
      rejectedSelections.push({ selection, reason: "与已接受候选位置重复" });
      continue;
    }
    if (overlapsExisting(replacements, selection.chunkId, match.quote)) {
      rejectedSelections.push({ selection, reason: "与已接受候选文本重叠" });
      continue;
    }

    if (!fitsConcentration(selection.type, settings.concentration, typeCounts)) {
      rejectedSelections.push({ selection, reason: `超过浓度 ${settings.concentration} 的 ${selection.type} 配额` });
      continue;
    }

    seen.add(key);
    typeCounts[selection.type] += 1;
    const replacement =
      request.mode === "zh-to-en"
        ? `${cleanInlineText(selection.en ?? "")}(${match.quote})`
        : `${match.quote}(${cleanInlineText(selection.zh ?? "")})`;

    const replacementItem = {
      chunkId: selection.chunkId,
      original: match.quote,
      replacement,
      explanation: selection.explanation ?? replacement,
      type: selection.type
    };
    replacements.push(replacementItem);
    acceptedSelections.push({ selection, replacement: replacementItem });

    if (replacements.length >= MAX_REPLACEMENTS) {
      break;
    }
  }

  return { replacements, acceptedSelections, rejectedSelections };
}

function sortReplacementsByRequestOrder(
  replacements: RewriteReplacement[],
  request: RewriteRequest
): RewriteReplacement[] {
  const chunkOrder = new Map(request.chunks.map((chunk, index) => [chunk.id, index]));
  const chunkTextById = new Map(request.chunks.map((chunk) => [chunk.id, chunk.text]));

  return [...replacements].sort((left, right) => {
    const leftChunkIndex = chunkOrder.get(left.chunkId) ?? Number.MAX_SAFE_INTEGER;
    const rightChunkIndex = chunkOrder.get(right.chunkId) ?? Number.MAX_SAFE_INTEGER;
    if (leftChunkIndex !== rightChunkIndex) {
      return leftChunkIndex - rightChunkIndex;
    }

    const text = chunkTextById.get(left.chunkId) ?? "";
    return text.indexOf(left.original) - text.indexOf(right.original);
  });
}

function locateQuote(chunkText: string, selection: AiSelection): { quote: string; start: number; end: number } | null {
  const quote = selection.quote.trim();
  if (!quote) {
    return null;
  }

  if (
    typeof selection.start === "number" &&
    typeof selection.end === "number" &&
    selection.start >= 0 &&
    selection.end > selection.start &&
    selection.end <= chunkText.length &&
    chunkText.slice(selection.start, selection.end) === quote
  ) {
    return { quote, start: selection.start, end: selection.end };
  }

  const index = chunkText.indexOf(quote);
  if (index >= 0) {
    return { quote, start: index, end: index + quote.length };
  }

  return null;
}

function getModeRejectionReason(selection: AiSelection, mode: RewriteRequest["mode"]): string | null {
  const quote = selection.quote.trim();

  if (!["word", "phrase", "sentence"].includes(selection.type)) {
    return "type 不是 word/phrase/sentence";
  }

  if (mode === "zh-to-en") {
    const quoteZhCount = countMatches(quote, /[\u4e00-\u9fff]/g);
    const en = selection.en?.trim() ?? "";

    if (quoteZhCount === 0 || !/[A-Za-z]/.test(en) || /[\u4e00-\u9fff]/.test(en)) {
      return "中文模式要求 quote 含中文，en 含英文且不含中文";
    }
    if (selection.isProperNoun === true || selection.isTransferable === false) {
      return "专名或不可迁移候选";
    }
    if (typeof selection.learningValue === "number" && selection.learningValue < 3) {
      return "learningValue 低于 3";
    }
    if (selection.type === "sentence" && quoteZhCount > 18) {
      return "sentence quote 超过 18 个汉字";
    }
    if (selection.type !== "sentence" && quoteZhCount > 14) {
      return "word/phrase quote 超过 14 个汉字";
    }

    return null;
  }

  const zh = selection.zh?.trim() ?? "";
  if (!/[A-Za-z]/.test(quote) || !/[\u4e00-\u9fff]/.test(zh)) {
    return "英文模式要求 quote 含英文，zh 含中文";
  }
  if (selection.isProperNoun === true || selection.isTransferable === false) {
    return "专名或不可迁移候选";
  }

  return null;
}

function fitsConcentration(
  type: AiSelection["type"],
  concentration: number,
  counts: Record<AiSelection["type"], number>
): boolean {
  const caps: Record<number, Record<AiSelection["type"], number>> = {
    1: { word: 24, phrase: 8, sentence: 0 },
    2: { word: 22, phrase: 12, sentence: 1 },
    3: { word: 18, phrase: 18, sentence: 2 },
    4: { word: 10, phrase: 22, sentence: 4 },
    5: { word: 6, phrase: 22, sentence: 8 }
  };
  const safeConcentration = Math.min(5, Math.max(1, Math.round(concentration)));
  return counts[type] < caps[safeConcentration][type];
}

function overlapsExisting(replacements: RewriteReplacement[], chunkId: string, quote: string): boolean {
  return replacements.some(
    (replacement) =>
      replacement.chunkId === chunkId &&
      (replacement.original.includes(quote) || quote.includes(replacement.original))
  );
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }

  return undefined;
}

function pickBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
  }

  return undefined;
}

function normalizeType(value: string | null): AiSelection["type"] | null {
  if (value === "word" || value === "phrase" || value === "sentence") {
    return value;
  }
  return null;
}

function matchJsonString(source: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "s"));
  if (!match?.[1]) {
    return null;
  }

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function matchJsonNumber(source: string, key: string): number | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match?.[1] ? Number(match[1]) : null;
}

function matchJsonBoolean(source: string, key: string): boolean | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`"${escapedKey}"\\s*:\\s*(true|false)`, "i"));
  if (!match?.[1]) {
    return null;
  }
  return match[1].toLowerCase() === "true";
}

function cleanInlineText(value: string): string {
  return value.replace(/[<>{}[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function countMatches(value: string, pattern: RegExp): number {
  return (value.match(pattern) ?? []).length;
}

function createBaseDebugLog(request: RewriteRequest, settings: Settings): DebugLog {
  return {
    status: "running",
    timestamp: new Date().toISOString(),
    url: request.url,
    title: request.title,
    mode: request.mode,
    model: settings.model,
    baseUrl: settings.baseUrl,
    hasApiKey: Boolean(settings.apiKey.trim()),
    difficulty: settings.difficulty,
    concentration: settings.concentration,
    coverage: settings.coverage,
    requestBody: buildChatCompletionRequestBody(request, settings),
    sourceChunkCount: request.sourceChunkCount,
    chunks: request.chunks.map((chunk) => ({
      id: chunk.id,
      text:
        chunk.text.length > DEBUG_CHUNK_TEXT_LIMIT
          ? `${chunk.text.slice(0, DEBUG_CHUNK_TEXT_LIMIT)}...`
          : chunk.text
    }))
  };
}

async function saveDebugLog(debugLog: DebugLog) {
  await chrome.storage.local.set({ [DEBUG_LOG_KEY]: debugLog });
}
