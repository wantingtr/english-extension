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
  httpStatus?: number;
  rawResponse?: string;
  parsedCount?: number;
  sanitizedCount?: number;
  cached?: boolean;
  batchStatuses?: BatchStatus[];
  error?: string;
  networkErrorName?: string;
  networkErrorDetails?: string;
};

type BatchStatus = {
  index: number;
  chunkIds: string[];
  elapsedMs?: number;
  httpStatus?: number;
  parsedCount?: number;
  sanitizedCount?: number;
  error?: string;
  rawResponse?: string;
};

const CACHE_PREFIX = "rewriteCache:";
const MAX_REPLACEMENTS = 96;
const DEBUG_CHUNK_TEXT_LIMIT = 240;
const DEBUG_RAW_RESPONSE_LIMIT = 12000;
const PROMPT_VERSION = "selection-protocol-v6-word-first-concentration";
const REQUEST_TIMEOUT_MS = 12_000;
const CHUNKS_PER_AI_REQUEST = 4;
const MAX_PARALLEL_AI_REQUESTS = 1;
const MAX_SELECTIONS_PER_AI_REQUEST = 8;

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
  const { replacements, batchTimings } = await rewriteWithDeepSeek(request, settings, debugLog, sender);
  const cachedResponse: RewriteResponse = {
    replacements: replacements.slice(0, MAX_REPLACEMENTS),
    cached: false,
    streamed: false,
    batchTimings,
    totalElapsedMs: Date.now() - startedAt
  };

  await chrome.storage.local.set({ [cacheKey]: cachedResponse });
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
): Promise<{ replacements: RewriteReplacement[]; batchTimings: BatchTiming[] }> {
  const completionUrl = buildCompletionUrl(settings.baseUrl);

  try {
    debugLog.requestUrl = completionUrl;
    debugLog.hostPermissionGranted = await hasHostPermission(completionUrl);

    if (!debugLog.hostPermissionGranted) {
      throw new Error(`扩展没有访问 ${new URL(completionUrl).origin} 的权限，请重新构建并重新加载插件。`);
    }

    const batches = chunkArray(request.chunks, CHUNKS_PER_AI_REQUEST);
    const selections: AiSelection[] = [];
    const replacements: RewriteReplacement[] = [];
    const rawResponses: string[] = Array.from({ length: batches.length }, () => "");
    debugLog.batchStatuses = batches.map((chunks, index) => ({
      index: index + 1,
      chunkIds: chunks.map((chunk) => chunk.id)
    }));

    for (let start = 0; start < batches.length; start += MAX_PARALLEL_AI_REQUESTS) {
      const wave = batches.slice(start, start + MAX_PARALLEL_AI_REQUESTS);
      await Promise.all(
        wave.map(async (chunks, waveIndex) => {
          const index = start + waveIndex;
          const batchRequest = { ...request, chunks };
          const status = debugLog.batchStatuses?.[index];
          if (!status) {
            return;
          }
          const startedAt = Date.now();

          try {
            const content = await fetchModelContent(completionUrl, batchRequest, settings, status);
            status.elapsedMs = Date.now() - startedAt;
            rawResponses[index] = `Batch ${status.index}: ${content}`;
            debugLog.rawResponse = rawResponses.filter(Boolean).join("\n\n").slice(0, DEBUG_RAW_RESPONSE_LIMIT);
            await saveDebugLog(debugLog);

            const batchSelections = parseModelSelections(content);
            status.parsedCount = batchSelections.length;
            const batchReplacements = selectionsToReplacements(batchSelections, batchRequest, settings);
            status.sanitizedCount = batchReplacements.length;
            selections.push(...batchSelections);
            replacements.push(...batchReplacements);
            await emitBatchResult(request, sender, status, batchReplacements, batches.length);
            await saveDebugLog(debugLog);
          } catch (error) {
            status.elapsedMs = Date.now() - startedAt;
            status.error = error instanceof Error ? normalizeFetchError(error) : "改写失败，请稍后重试。";
            await saveDebugLog(debugLog);
            await emitBatchResult(request, sender, status, [], batches.length);
            if (!isRecoverableBatchError(error)) {
              throw error;
            }
          }
        })
      );

    }

    debugLog.httpStatus = debugLog.batchStatuses.at(-1)?.httpStatus;
    debugLog.rawResponse = rawResponses.filter(Boolean).join("\n\n").slice(0, DEBUG_RAW_RESPONSE_LIMIT);
    debugLog.parsedCount = selections.length;
    debugLog.sanitizedCount = replacements.length;
    if (!replacements.length) {
      const firstBatchError = debugLog.batchStatuses.find((status) => status.error)?.error;
      if (firstBatchError) {
        throw new Error(firstBatchError);
      }
    }
    await saveDebugLog(debugLog);
    return { replacements: replacements.slice(0, MAX_REPLACEMENTS), batchTimings: getBatchTimings(debugLog.batchStatuses) };
  } catch (error) {
    if (error instanceof Error) {
      debugLog.networkErrorName = error.name;
      debugLog.networkErrorDetails = error.stack?.slice(0, 2000) ?? error.message;
      debugLog.error = normalizeFetchError(error);
    } else {
      debugLog.error = "改写失败，请稍后重试。";
      debugLog.networkErrorDetails = String(error);
    }
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

  try {
    const response = await fetch(completionUrl, {
      method: "POST",
      signal: abortController.signal,
      headers: {
        Authorization: `Bearer ${settings.apiKey.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: settings.model,
        thinking: { type: "disabled" },
        temperature: 0,
        max_tokens: 900,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(request.mode, settings, getMaxSelectionsPerRequest(settings.coverage))
          },
          {
            role: "user",
            content: JSON.stringify({
              pageTitle: request.title,
              chunks: request.chunks
            })
          }
        ]
      })
    });

    batchStatus.httpStatus = response.status;
    const rawResponse = await response.text();
    batchStatus.rawResponse = rawResponse.slice(0, 4000);

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
    1: "小学到初中，选择最常见、最基础的词汇和短语。",
    2: "高中水平，选择常见生活、学习、工作表达。",
    3: "大学四级水平，选择更自然的常用短语。",
    4: "大学六级水平，选择更成熟的短语和抽象表达。",
    5: "更高阶水平，选择地道表达、抽象词汇和短句。"
  };
  const concentrationMap: Record<number, string> = {
    1: "强制 word 优先，只选单个词或非常短的词组，不选 sentence。",
    2: "word 优先，至少优先寻找单个词，只有固定搭配或单词无法自然表达时才选 phrase。",
    3: "候选 word 和 phrase 均衡，谨慎选择 sentence。",
    4: "候选以 phrase 为主，可少量选择 sentence。",
    5: "减少 word，更多选择 phrase 和短 sentence。"
  };
  const concentrationRuleMap: Record<number, string> = {
    1: "浓度 1 的硬规则：优先选择单个中文词或 2-4 个汉字的短词，type 应主要为 word；每批最多 1 个 phrase，禁止 sentence。",
    2: "浓度 2 的硬规则：先在每个 chunk 中寻找单个中文词或 2-4 个汉字的短词，type 应以 word 为主；只有“安全边际、资金拥挤、正反馈”这类固定搭配或单词无法自然学习时才选 phrase；每批 phrase 数量应少于 word。",
    3: "浓度 3 的规则：word 和 phrase 均衡，只有短句本身很有学习价值时才选 sentence。",
    4: "浓度 4 的规则：phrase 优先，可以少量选择短 sentence，但仍要避开整段翻译。",
    5: "浓度 5 的规则：可以更多选择 phrase 和短 sentence，但每个 selection 仍必须短、可迁移、有学习价值。"
  };
  const modeTask =
    mode === "zh-to-en"
      ? [
          "处理中文网页。你只负责选择适合学习的中文原文片段并给英文表达，不要生成最终替换文本。",
          "quote 必须从 chunk 原文中逐字复制，不能改字、漏字、加空格、改标点或修正原文。",
          "en 只写英文表达，不要加中文括注。本地程序会生成 en(quote)。",
          "选择原则必须通用：优先选择可迁移到其他语境的高频表达、状态描述、动作表达、关系表达、条件表达、评价表达。",
          "避免选择只能用于当前页面的唯一标识信息，例如专有名词、具体名称、编号、价格、日期、距离、面积、地址、联系方式。",
          "如果一个片段混合了唯一标识信息和通用表达，只选择其中可迁移的通用表达。",
          "en 要自然、可复用。浓度 1-2 时优先给单词级英文；浓度 3-5 时才更多使用英文短语。不要逐字硬翻，也不要把整句写成完整英文句子。",
          "每个 chunk 最多选择 2 个候选。禁止选择整段长句。"
        ].join("\n")
      : [
          "处理英文网页。你只负责选择适合解释的英文原文片段并给中文释义，不要生成最终替换文本。",
          "quote 必须从 chunk 原文中逐字复制，不能改字、漏字、加空格、改标点或修正原文。",
          "zh 只写中文释义，不要重复 quote。本地程序会生成 quote(zh)。",
          "每个 chunk 最多选择 2 个候选。优先选择难词、短语、短表达，禁止选择整段长句。"
        ].join("\n");

  return [
    "你是一个英文学习网页候选片段选择器，不是网页翻译器。",
    modeTask,
    `英语难度：${settings.difficulty} 档，${difficultyMap[settings.difficulty]}`,
    `替换浓度：${settings.concentration} 档，${concentrationMap[settings.concentration]}`,
    concentrationRuleMap[settings.concentration],
    `覆盖密度：${settings.coverage} 档。页面会全文扫描；该档位只控制每批候选数量和替换积极程度，不允许选择整段凑数。`,
    `本次最多返回 ${maxSelections} 个 selection。宁可少选，也不要补无价值候选。`,
    "严格输出：",
    '1. 只返回 JSON，不要 Markdown，不要代码块，不要解释。格式：{"selections":[...]}',
    "2. 每个 selection 必须包含 chunkId、quote、start、end、type、level、isProperNoun、isTransferable、learningValue。",
    mode === "zh-to-en"
      ? "3. 中文模式每个 selection 必须包含 en；quote 必须含中文；en 必须含英文。"
      : "3. 英文模式每个 selection 必须包含 zh；quote 必须含英文；zh 必须含中文。",
    "4. isProperNoun 表示 quote 是否是当前页面特有的专名或唯一标识；isTransferable 表示 quote 是否可迁移到其他语境学习；learningValue 为 1-5。",
    "5. start/end 是 quote 在 chunk.text 中的 JavaScript 字符串下标，end 为开区间。",
    "6. 如果不确定下标，也必须保证 quote 在 chunk.text 中精确存在。",
    "7. type 只能是 word、phrase、sentence。",
    mode === "zh-to-en"
      ? settings.concentration <= 2
        ? "8. 中文 quote 在浓度 1-2 时优先 2-4 个汉字的单词或短词，type 优先 word；phrase 必须是固定搭配或强可迁移表达，最多不要超过 8 个汉字；不要选 sentence。"
        : "8. 中文 quote 优先 2-10 个汉字，最多不要超过 16 个汉字；除非浓度为 5，否则不要选 sentence。"
      : "8. 英文 quote 优先 1-6 个英文词，不要整段解释。",
    mode === "zh-to-en"
      ? `9. 中文模式每个 chunk 选择 0-2 个 selection，本次总数不得超过 ${maxSelections}；只选择 isTransferable=true 且 learningValue>=3 的候选。`
      : `9. 英文模式每个 chunk 选择 0-2 个 selection，本次总数不得超过 ${maxSelections}。`,
    "10. 不要选择 isProperNoun=true 的候选，不要选择数字、日期、URL、代码、价格。",
    '11. 如果没有合适候选，返回 {"selections":[]}。',
    mode === "zh-to-en"
      ? '12. 示例结构：{"selections":[{"chunkId":"chunk-0","quote":"原文片段","start":0,"end":4,"en":"natural English","type":"phrase","level":2,"isProperNoun":false,"isTransferable":true,"learningValue":4}]}'
      : '12. 示例结构：{"selections":[{"chunkId":"chunk-0","quote":"source phrase","start":0,"end":13,"zh":"中文释义","type":"phrase","level":2,"isProperNoun":false,"isTransferable":true,"learningValue":4}]}'
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

  console.warn("[English Immersion] Raw model response was not parseable selections JSON:", content);
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
): RewriteReplacement[] {
  const chunksById = new Map(request.chunks.map((chunk) => [chunk.id, chunk.text]));
  const seen = new Set<string>();
  const replacements: RewriteReplacement[] = [];
  const typeCounts = { word: 0, phrase: 0, sentence: 0 };

  for (const selection of selections) {
    const chunkText = chunksById.get(selection.chunkId);
    if (!chunkText || !isAllowedByMode(selection, request.mode)) {
      continue;
    }

    const match = locateQuote(chunkText, selection);
    if (!match) {
      continue;
    }

    const key = `${selection.chunkId}:${match.start}:${match.end}`;
    if (seen.has(key) || overlapsExisting(replacements, selection.chunkId, match.quote)) {
      continue;
    }

    if (!fitsConcentration(selection.type, settings.concentration, typeCounts)) {
      continue;
    }

    seen.add(key);
    typeCounts[selection.type] += 1;
    const replacement =
      request.mode === "zh-to-en"
        ? `${cleanInlineText(selection.en ?? "")}(${match.quote})`
        : `${match.quote}(${cleanInlineText(selection.zh ?? "")})`;

    replacements.push({
      chunkId: selection.chunkId,
      original: match.quote,
      replacement,
      explanation: selection.explanation ?? replacement,
      type: selection.type
    });

    if (replacements.length >= MAX_REPLACEMENTS) {
      break;
    }
  }

  return replacements;
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

function isAllowedByMode(selection: AiSelection, mode: RewriteRequest["mode"]): boolean {
  const quote = selection.quote.trim();

  if (!["word", "phrase", "sentence"].includes(selection.type)) {
    return false;
  }

  if (mode === "zh-to-en") {
    const quoteZhCount = countMatches(quote, /[\u4e00-\u9fff]/g);
    const en = selection.en?.trim() ?? "";

    if (quoteZhCount === 0 || !/[A-Za-z]/.test(en) || /[\u4e00-\u9fff]/.test(en)) {
      return false;
    }
    if (selection.isProperNoun === true || selection.isTransferable === false) {
      return false;
    }
    if (typeof selection.learningValue === "number" && selection.learningValue < 3) {
      return false;
    }
    if (selection.type === "sentence" && quoteZhCount > 18) {
      return false;
    }
    if (selection.type !== "sentence" && quoteZhCount > 14) {
      return false;
    }

    return true;
  }

  const zh = selection.zh?.trim() ?? "";
  if (!/[A-Za-z]/.test(quote) || !/[\u4e00-\u9fff]/.test(zh)) {
    return false;
  }
  if (selection.isProperNoun === true || selection.isTransferable === false) {
    return false;
  }

  return true;
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
