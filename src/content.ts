type RewriteMode = "auto" | "zh-to-en" | "en-assist";
type ResolvedRewriteMode = Exclude<RewriteMode, "auto">;

type TextChunk = {
  id: string;
  text: string;
  key?: string;
};

type RewriteReplacement = {
  chunkId: string;
  original: string;
  replacement: string;
  explanation: string;
  type: "word" | "phrase" | "sentence";
};

type RewriteResponse = {
  replacements: RewriteReplacement[];
  cached: boolean;
  streamed?: boolean;
  batchTimings?: BatchTiming[];
  totalElapsedMs?: number;
  completedChunkIds?: string[];
  failedChunkIds?: string[];
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

type ContentSettings = {
  coverage: number;
  autoRewriteHosts: string[];
};

const PROCESSED_ATTR = "data-english-immersion";
const SETTINGS_KEY = "englishImmersionSettings";
const MIN_TEXT_LENGTH = 18;
const MAX_TEXT_CHUNKS = 160;
const MAX_TEXT_CHARS = 50_000;
const MIN_CHUNKS_BEFORE_SAMPLING = 8;
const LARK_INCREMENTAL_DEBOUNCE_MS = 500;
const LARK_INCREMENTAL_MAX_CHUNKS = 24;
const FLOATING_BALL_ID = "english-immersion-floating-ball";
const COVERAGE_SAMPLE_RATES: Record<number, number> = {
  1: 0.12,
  2: 0.24,
  3: 0.36,
  4: 0.5,
  5: 0.68
};
const chunkNodes = new Map<string, Text>();
const chunkKeys = new Map<string, string>();
const larkProcessedChunkKeys = new Set<string>();
const larkInFlightChunkKeys = new Set<string>();
const larkReplacementCache = new Map<string, Array<Omit<RewriteReplacement, "chunkId">>>();
const floatingBallPosition = { x: 0, y: 0 };
let rewriteRunning = false;
let autoRewritePaused = false;
let rewriteStatus: {
  state: "idle" | "running" | "completed" | "failed";
  completedBatches: number;
  successfulBatches: number;
  totalBatches: number;
  successRate: number | null;
} = {
  state: "idle",
  completedBatches: 0,
  successfulBatches: 0,
  totalBatches: 0,
  successRate: null
};
let larkIncrementalState: {
  mode: ResolvedRewriteMode;
  coverage: number;
  timer: number | undefined;
  running: boolean;
  root: HTMLElement | null;
  onScroll: (() => void) | null;
  observer: MutationObserver | null;
} | null = null;

void initPageControls();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RUN_IMMERSION_REWRITE") {
    return false;
  }

  runRewrite(message.mode as RewriteMode, Number(message.coverage ?? 2))
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "页面改造失败。"
      });
    });

  return true;
});

async function initPageControls() {
  injectStyles();
  const settings = await getContentSettings();
  const whitelisted = isCurrentHostWhitelisted(settings.autoRewriteHosts);
  createFloatingBall(whitelisted, settings);

  if (whitelisted) {
    window.setTimeout(() => {
      if (!autoRewritePaused) {
        void triggerRewrite("auto", settings.coverage);
      }
    }, 800);
  }
}

async function triggerRewrite(mode: RewriteMode, coverage: number) {
  try {
    await runRewrite(mode, coverage);
  } catch {
    updateFloatingBall();
  }
}

async function getContentSettings(): Promise<ContentSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = (stored[SETTINGS_KEY] ?? {}) as Partial<ContentSettings>;
  return {
    coverage: clampCoverage(Number(raw.coverage ?? 2)),
    autoRewriteHosts: normalizeHosts(raw.autoRewriteHosts)
  };
}

function createFloatingBall(whitelisted: boolean, settings: ContentSettings) {
  if (document.getElementById(FLOATING_BALL_ID)) {
    updateFloatingBall();
    return;
  }

  const button = document.createElement("button");
  button.id = FLOATING_BALL_ID;
  button.type = "button";
  button.setAttribute("aria-label", whitelisted ? "暂停语境英语自动改造" : "语境英语改造当前页面");
  button.dataset.whitelisted = String(whitelisted);
  button.dataset.status = "点击改造";
  setupFloatingBallDrag(button);
  button.addEventListener("click", () => {
    if (button.dataset.dragged === "true") {
      button.dataset.dragged = "false";
      return;
    }
    if (whitelisted) {
      autoRewritePaused = !autoRewritePaused;
      if (autoRewritePaused) {
        teardownLarkIncrementalRewrite();
        setRewriteStatus({ state: "idle", completedBatches: 0, successfulBatches: 0, totalBatches: 0, successRate: null });
      } else {
        void triggerRewrite("auto", settings.coverage);
      }
      updateFloatingBall();
      return;
    }

    void triggerRewrite("auto", settings.coverage);
    updateFloatingBall();
  });

  document.documentElement.append(button);
  updateFloatingBall();
}

function updateFloatingBall() {
  const button = document.getElementById(FLOATING_BALL_ID);
  if (!button) {
    return;
  }

  button.classList.toggle("is-running", rewriteRunning);
  button.classList.toggle("is-paused", autoRewritePaused);
  const title = getFloatingBallTitle();
  button.title = title;
  button.dataset.status = title;
}

function setupFloatingBallDrag(button: HTMLButtonElement) {
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let moved = false;

  button.addEventListener("pointerdown", (event) => {
    pointerId = event.pointerId;
    const rect = button.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    originX = rect.left;
    originY = rect.top;
    moved = false;
    button.setPointerCapture(event.pointerId);
  });

  button.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (Math.abs(deltaX) + Math.abs(deltaY) < 4) {
      return;
    }

    moved = true;
    const nextX = Math.min(window.innerWidth - button.offsetWidth - 4, Math.max(4, originX + deltaX));
    const nextY = Math.min(window.innerHeight - button.offsetHeight - 4, Math.max(4, originY + deltaY));
    floatingBallPosition.x = nextX;
    floatingBallPosition.y = nextY;
    button.style.setProperty("left", `${nextX}px`, "important");
    button.style.setProperty("top", `${nextY}px`, "important");
    button.style.setProperty("right", "auto", "important");
    button.style.setProperty("bottom", "auto", "important");
  });

  const finishDrag = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) {
      return;
    }
    button.releasePointerCapture(event.pointerId);
    pointerId = null;
    button.dataset.dragged = String(moved);
  };

  button.addEventListener("pointerup", finishDrag);
  button.addEventListener("pointercancel", finishDrag);
}

function setRewriteStatus(next: typeof rewriteStatus) {
  rewriteStatus = next;
  updateFloatingBall();
}

function getFloatingBallTitle(): string {
  if (autoRewritePaused) {
    return "已暂停";
  }
  if (rewriteStatus.state === "running") {
    const progress = formatProgress(rewriteStatus);
    return progress ? `改造中 ${progress}` : "改造中";
  }
  if (rewriteStatus.state === "completed") {
    const successRate = formatSuccessRate(rewriteStatus);
    return successRate ? `完成 ${successRate}` : "改造完成";
  }
  if (rewriteStatus.state === "failed") {
    const successRate = formatSuccessRate(rewriteStatus);
    return successRate ? `失败 ${successRate}` : "改造失败";
  }
  return "点击改造";
}

function formatProgress(status: typeof rewriteStatus): string {
  return status.totalBatches > 0 ? `${status.completedBatches}/${status.totalBatches}` : "";
}

function formatSuccessRate(status: typeof rewriteStatus): string {
  if (typeof status.successRate === "number") {
    return `${status.successRate}%`;
  }
  if (status.totalBatches > 0) {
    return `${status.completedBatches}/${status.totalBatches}`;
  }
  return "";
}

function isCurrentHostWhitelisted(hosts: string[]): boolean {
  return hosts.some((host) => location.hostname === host || location.hostname.endsWith(`.${host}`));
}

function normalizeHosts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((host): host is string => typeof host === "string")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function updateRewriteProgress(batchTimings: BatchTiming[], totalBatches: number | undefined) {
  const completedBatches = batchTimings.length;
  const successfulBatches = batchTimings.filter((batch) => !batch.error).length;
  const denominator = completedBatches || totalBatches || 0;
  setRewriteStatus({
    state: "running",
    completedBatches,
    successfulBatches,
    totalBatches: totalBatches ?? completedBatches,
    successRate: denominator > 0 ? Math.round((successfulBatches / denominator) * 100) : null
  });
}

async function runRewrite(mode: RewriteMode, coverage: number) {
  if (rewriteRunning) {
    return {
      ok: false,
      error: "页面正在改造中，请稍后再试。"
    };
  }

  rewriteRunning = true;
  setRewriteStatus({ state: "running", completedBatches: 0, successfulBatches: 0, totalBatches: 0, successRate: null });
  injectStyles();
  chunkNodes.clear();
  const batchTimings: BatchTiming[] = [];

  try {
    const allChunks = await collectTextChunksWithRetry();
    if (!allChunks.length) {
      if (isLarkDocumentPage() && !autoRewritePaused) {
        const resolvedMode = mode === "auto" ? "zh-to-en" : mode;
        setupLarkIncrementalRewrite(resolvedMode, coverage);
        return {
          ok: true,
          mode: resolvedMode,
          chunks: 0,
          sourceChunks: 0,
          applied: 0,
          cached: true,
          batchTimings: [],
          totalElapsedMs: 0
        };
      }
      throw new Error("没有找到适合改造的正文内容。");
    }

    const cachedApplied = applyCachedLarkReplacements(allChunks);
    const chunks = getChunksNeedingModel(selectChunksForRewrite(allChunks, coverage));
    const resolvedMode = mode === "auto" ? detectMode(allChunks) : mode;
    const requestId = crypto.randomUUID();
    let streamedApplied = 0;

    if (!chunks.length) {
      if (isLarkDocumentPage() && !autoRewritePaused) {
        setupLarkIncrementalRewrite(resolvedMode, coverage);
      }
      return {
        ok: true,
        mode: resolvedMode,
        chunks: 0,
        sourceChunks: allChunks.length,
        applied: cachedApplied,
        cached: true,
        batchTimings,
        totalElapsedMs: 0
      };
    }

    markLarkChunksInFlight(chunks);

    const batchListener = (message: {
      type?: string;
      requestId?: string;
      batchIndex?: number;
      totalBatches?: number;
      elapsedMs?: number;
      httpStatus?: number;
      parsedCount?: number;
      sanitizedCount?: number;
      error?: string;
      replacements?: RewriteReplacement[];
    }) => {
      if (message?.type !== "IMMERSION_BATCH_RESULT" || message.requestId !== requestId) {
        return false;
      }
      const applied = applyReplacements(message.replacements ?? []);
      streamedApplied += applied;
      batchTimings.push({
        index: Number(message.batchIndex ?? batchTimings.length + 1),
        elapsedMs: message.elapsedMs,
        httpStatus: message.httpStatus,
        parsedCount: message.parsedCount,
        sanitizedCount: message.sanitizedCount,
        error: message.error
      });
      updateRewriteProgress(batchTimings, message.totalBatches);
      void chrome.runtime.sendMessage({
        type: "IMMERSION_RUN_PROGRESS",
        requestId,
        batchIndex: message.batchIndex,
        totalBatches: message.totalBatches,
        elapsedMs: message.elapsedMs,
        httpStatus: message.httpStatus,
        parsedCount: message.parsedCount,
        sanitizedCount: message.sanitizedCount,
        applied,
        totalApplied: streamedApplied,
        error: message.error
      });
      return false;
    };

    chrome.runtime.onMessage.addListener(batchListener);
    let response: RewriteResponse;
    try {
      try {
        response = (await chrome.runtime.sendMessage({
          type: "REWRITE_PAGE",
          payload: {
            requestId,
            url: location.href,
            title: document.title,
            mode: resolvedMode,
            chunks,
            sourceChunkCount: allChunks.length
          }
        })) as RewriteResponse;
      } finally {
        unmarkLarkChunksInFlight(chunks);
      }
    } finally {
      chrome.runtime.onMessage.removeListener(batchListener);
    }

    if (response.error) {
      throw new Error(response.error);
    }

    rememberLarkReplacements(response.replacements ?? []);
    markLarkChunkIdsProcessed(getCompletedChunkIds(response, chunks), chunks);

    const applied = cachedApplied + (response.streamed
      ? streamedApplied + applyReplacements(response.replacements ?? [])
      : applyReplacements(response.replacements ?? []));

    if (isLarkDocumentPage() && !autoRewritePaused) {
      setupLarkIncrementalRewrite(resolvedMode, coverage);
    }

    return {
      ok: true,
      mode: resolvedMode,
      chunks: chunks.length,
      sourceChunks: allChunks.length,
      applied,
      cached: response.cached,
      batchTimings: response.batchTimings ?? batchTimings,
      totalElapsedMs: response.totalElapsedMs
    };
  } catch (error) {
    updateRewriteProgress(batchTimings, batchTimings.length);
    setRewriteStatus({ ...rewriteStatus, state: "failed" });
    throw error;
  } finally {
    rewriteRunning = false;
    if (rewriteStatus.state === "running") {
      updateRewriteProgress(batchTimings, batchTimings.length);
      setRewriteStatus({ ...rewriteStatus, state: "completed" });
    }
    updateFloatingBall();
  }
}

function setupLarkIncrementalRewrite(mode: ResolvedRewriteMode, coverage: number) {
  teardownLarkIncrementalRewrite();

  const root = getLarkDocumentRoot();
  const state = {
    mode,
    coverage,
    timer: undefined as number | undefined,
    running: false,
    root,
    onScroll: null as (() => void) | null,
    observer: null as MutationObserver | null
  };

  const scheduleIncrementalRewrite = () => {
    if (state.timer) {
      window.clearTimeout(state.timer);
    }
    state.timer = window.setTimeout(() => {
      void runLarkIncrementalRewrite(state);
    }, LARK_INCREMENTAL_DEBOUNCE_MS);
  };

  state.onScroll = scheduleIncrementalRewrite;
  state.observer = new MutationObserver(scheduleIncrementalRewrite);

  root.addEventListener("scroll", state.onScroll, { passive: true });
  state.observer.observe(root, {
    childList: true,
    characterData: true,
    subtree: true
  });
  larkIncrementalState = state;
}

function teardownLarkIncrementalRewrite() {
  if (!larkIncrementalState?.root || !larkIncrementalState.onScroll) {
    larkIncrementalState = null;
    return;
  }

  larkIncrementalState.root.removeEventListener("scroll", larkIncrementalState.onScroll);
  larkIncrementalState.observer?.disconnect();
  if (larkIncrementalState.timer) {
    window.clearTimeout(larkIncrementalState.timer);
  }
  larkIncrementalState = null;
}

async function runLarkIncrementalRewrite(state: NonNullable<typeof larkIncrementalState>) {
  if (state.running || rewriteRunning) {
    return;
  }

  state.running = true;
  setRewriteStatus({ state: "running", completedBatches: 0, successfulBatches: 0, totalBatches: 0, successRate: null });
  let chunks: TextChunk[] = [];
  try {
    chunkNodes.clear();
    chunkKeys.clear();
    const firstPassChunks = collectTextChunks();
    applyCachedLarkReplacements(firstPassChunks);

    chunkNodes.clear();
    chunkKeys.clear();
    const visibleChunks = collectTextChunks();
    const eligibleChunks = visibleChunks.filter(shouldSendLarkChunkToModel);
    chunks = selectChunksForRewrite(eligibleChunks, state.coverage, { forceSample: true }).slice(0, LARK_INCREMENTAL_MAX_CHUNKS);

    if (!chunks.length) {
      setRewriteStatus({ state: "completed", completedBatches: 0, successfulBatches: 0, totalBatches: 0, successRate: null });
      return;
    }

    markLarkChunksInFlight(chunks);

    const response = (await chrome.runtime.sendMessage({
      type: "REWRITE_PAGE",
      payload: {
        url: location.href,
        title: document.title,
        mode: state.mode,
        chunks,
        sourceChunkCount: visibleChunks.length
      }
    })) as RewriteResponse;

    if (!response.error) {
      rememberLarkReplacements(response.replacements ?? []);
      applyReplacements(response.replacements ?? []);
      markLarkChunkIdsProcessed(getCompletedChunkIds(response, chunks), chunks);
      updateRewriteProgress(response.batchTimings ?? [], response.batchTimings?.length);
      setRewriteStatus({ ...rewriteStatus, state: "completed" });
    } else {
      setRewriteStatus({ ...rewriteStatus, state: "failed" });
    }
  } catch {
    setRewriteStatus({ ...rewriteStatus, state: "failed" });
  } finally {
    unmarkLarkChunksInFlight(chunks);
    state.running = false;
  }
}

async function collectTextChunksWithRetry(): Promise<TextChunk[]> {
  const firstPass = collectTextChunks();
  if (firstPass.length || !isLarkDocumentPage()) {
    return firstPass;
  }

  await new Promise((resolve) => setTimeout(resolve, 600));
  chunkNodes.clear();
  return collectTextChunks();
}

function collectTextChunks(): TextChunk[] {
  const roots = getTextCollectionRoots();
  const chunks: TextChunk[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  let index = 0;

  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node instanceof Text)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!isGoodTextNode(node)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode() && chunks.length < MAX_TEXT_CHUNKS && totalChars < MAX_TEXT_CHARS) {
      const node = walker.currentNode as Text;
      const text = normalizeText(node.nodeValue ?? "");

      if (seen.has(text)) {
        continue;
      }

      seen.add(text);
      const id = `chunk-${index++}`;
      const key = getChunkStableKey(node, text);
      chunkNodes.set(id, node);
      if (key) {
        chunkKeys.set(id, key);
      }
      chunks.push({ id, text, key });
      totalChars += text.length;
    }
  }

  return chunks;
}

function getChunksNeedingModel(chunks: TextChunk[]): TextChunk[] {
  if (!isLarkDocumentPage()) {
    return chunks;
  }

  return chunks.filter(shouldSendLarkChunkToModel);
}

function shouldSendLarkChunkToModel(chunk: TextChunk): boolean {
  const key = chunk.key ?? chunkKeys.get(chunk.id);
  if (!key) {
    return true;
  }
  return !larkReplacementCache.has(key) && !larkProcessedChunkKeys.has(key) && !larkInFlightChunkKeys.has(key);
}

function markLarkChunksInFlight(chunks: TextChunk[]) {
  if (!isLarkDocumentPage()) {
    return;
  }

  for (const chunk of chunks) {
    const key = chunk.key ?? chunkKeys.get(chunk.id);
    if (key) {
      larkInFlightChunkKeys.add(key);
    }
  }
}

function unmarkLarkChunksInFlight(chunks: TextChunk[]) {
  if (!isLarkDocumentPage()) {
    return;
  }

  for (const chunk of chunks) {
    const key = chunk.key ?? chunkKeys.get(chunk.id);
    if (key) {
      larkInFlightChunkKeys.delete(key);
    }
  }
}

function markLarkChunksProcessed(chunks: TextChunk[]) {
  if (!isLarkDocumentPage()) {
    return;
  }

  for (const chunk of chunks) {
    const key = chunk.key ?? chunkKeys.get(chunk.id);
    if (key) {
      larkProcessedChunkKeys.add(key);
    }
  }
}

function markLarkChunkIdsProcessed(chunkIds: string[], chunks: TextChunk[]) {
  if (!isLarkDocumentPage()) {
    return;
  }

  const chunkIdSet = new Set(chunkIds);
  markLarkChunksProcessed(chunks.filter((chunk) => chunkIdSet.has(chunk.id)));
}

function getCompletedChunkIds(response: RewriteResponse, chunks: TextChunk[]): string[] {
  if (response.completedChunkIds) {
    return response.completedChunkIds;
  }
  if (response.failedChunkIds?.length) {
    const failed = new Set(response.failedChunkIds);
    return chunks.filter((chunk) => !failed.has(chunk.id)).map((chunk) => chunk.id);
  }
  return chunks.map((chunk) => chunk.id);
}

function rememberLarkReplacements(replacements: RewriteReplacement[]) {
  if (!isLarkDocumentPage()) {
    return;
  }

  const grouped = new Map<string, Array<Omit<RewriteReplacement, "chunkId">>>();
  for (const replacement of replacements) {
    const key = chunkKeys.get(replacement.chunkId);
    if (!key) {
      continue;
    }
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    const { chunkId: _chunkId, ...cachedReplacement } = replacement;
    grouped.get(key)?.push(cachedReplacement);
    larkProcessedChunkKeys.add(key);
  }

  for (const [key, cachedReplacements] of grouped) {
    larkReplacementCache.set(key, cachedReplacements);
  }
}

function applyCachedLarkReplacements(chunks: TextChunk[]): number {
  if (!isLarkDocumentPage()) {
    return 0;
  }

  const replacements: RewriteReplacement[] = [];
  for (const chunk of chunks) {
    const key = chunk.key ?? chunkKeys.get(chunk.id);
    if (!key) {
      continue;
    }
    const cachedReplacements = larkReplacementCache.get(key);
    if (!cachedReplacements?.length) {
      continue;
    }
    larkProcessedChunkKeys.add(key);
    replacements.push(
      ...cachedReplacements.map((replacement) => ({
        ...replacement,
        chunkId: chunk.id
      }))
    );
  }

  return applyReplacements(replacements);
}

function getChunkStableKey(node: Text, text: string): string | undefined {
  if (!isLarkDocumentPage()) {
    return undefined;
  }

  const parent = node.parentElement;
  const block = parent?.closest<HTMLElement>(
    "[data-block-id],[data-docx-block-id],[data-page-id],[data-uuid],[blockid]"
  );
  const blockId =
    block?.dataset.blockId ??
    block?.dataset.docxBlockId ??
    block?.dataset.pageId ??
    block?.dataset.uuid ??
    block?.getAttribute("blockid");

  return `lark:${blockId ?? getElementPath(parent)}:${hashText(text)}`;
}

function getElementPath(element: Element | null): string {
  if (!element) {
    return "unknown";
  }

  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && parts.length < 4) {
    const parent: Element | null = current.parentElement;
    const index = parent ? [...parent.children].indexOf(current) : 0;
    parts.push(`${current.tagName.toLowerCase()}:${index}`);
    current = parent;
  }
  return parts.reverse().join("/");
}

function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function getTextCollectionRoots(): ParentNode[] {
  if (!isLarkDocumentPage()) {
    return [document.body];
  }

  const documentRoot = getLarkDocumentRoot();
  const selectors = [
    "[contenteditable='true']",
    "[role='textbox']",
    "[data-block-id]",
    "[data-docx-block-id]",
    "[data-page-id]",
    ".docx-page",
    ".suite-doc",
    ".lark-doc"
  ];
  const roots = selectors.flatMap((selector) => [...documentRoot.querySelectorAll(selector)]);
  const visibleRoots = roots.filter((element): element is HTMLElement => element instanceof HTMLElement && isVisibleElement(element));

  return visibleRoots.length ? dedupeNestedElements(visibleRoots) : [documentRoot];
}

function dedupeNestedElements(elements: HTMLElement[]): HTMLElement[] {
  return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)));
}

function getLarkDocumentRoot(): HTMLElement {
  const candidates = [
    ...document.querySelectorAll<HTMLElement>(".bear-web-x-container.docx-in-wiki"),
    ...document.querySelectorAll<HTMLElement>("[class*='bear-web-x-container']"),
    ...document.querySelectorAll<HTMLElement>("[class*='docx-in-wiki']")
  ].filter(isVisibleElement);

  const scrollable = candidates
    .filter((element) => element.scrollHeight > element.clientHeight + 100)
    .sort((left, right) => right.scrollHeight - left.scrollHeight)[0];

  return scrollable ?? candidates[0] ?? document.body;
}

function selectChunksForRewrite(
  chunks: TextChunk[],
  coverage: number,
  options: { forceSample?: boolean } = {}
): TextChunk[] {
  if (!options.forceSample && chunks.length <= MIN_CHUNKS_BEFORE_SAMPLING) {
    return chunks;
  }

  const rate = COVERAGE_SAMPLE_RATES[clampCoverage(coverage)];
  const sampleCount = Math.min(chunks.length, Math.max(1, Math.ceil(chunks.length * rate)));

  return evenlySample(chunks, sampleCount);
}

function evenlySample<T>(items: T[], count: number): T[] {
  if (count <= 0) {
    return [];
  }
  if (count >= items.length) {
    return items;
  }

  const sampled: T[] = [];
  const usedIndexes = new Set<number>();

  for (let index = 0; index < count; index += 1) {
    const itemIndex = Math.min(items.length - 1, Math.floor(((index + 0.5) * items.length) / count));
    if (!usedIndexes.has(itemIndex)) {
      usedIndexes.add(itemIndex);
      sampled.push(items[itemIndex]);
    }
  }

  return sampled;
}

function clampCoverage(value: number): number {
  return Math.min(5, Math.max(1, Number.isFinite(value) ? Math.round(value) : 3));
}

function isGoodTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || parent.closest(`[${PROCESSED_ATTR}]`)) {
    return false;
  }

  const text = normalizeText(node.nodeValue ?? "");
  if (text.length < MIN_TEXT_LENGTH || text.length > 700) {
    return false;
  }

  if (!/[a-zA-Z\u4e00-\u9fff]/.test(text)) {
    return false;
  }

  const blocked = parent.closest(
    [
      "a",
      "button",
      "input",
      "textarea",
      "select",
      "option",
      "script",
      "style",
      "noscript",
      "code",
      "pre",
      "kbd",
      "samp",
      "svg",
      "canvas",
      "nav",
      "footer",
      "header",
      "[role='button']",
      "[aria-hidden='true']"
    ].join(",")
  );

  if (blocked) {
    return false;
  }

  if (isLarkDocumentPage() && isBlockedLarkChromeText(parent)) {
    return false;
  }

  const element = parent instanceof HTMLElement ? parent : null;
  if (!element) {
    return false;
  }

  if (!isVisibleElement(element)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 8) {
    return false;
  }

  return true;
}

function isBlockedLarkChromeText(element: HTMLElement): boolean {
  return Boolean(
    element.closest(
      [
        "[class*='catalogue__']",
        "[class*='catalogue-styled']",
        "[class*='sidebar']",
        "[class*='workspace-tree']",
        "[class*='back-reference']",
        "[class*='back_ref']",
        "[class*='reflink']",
        "[class*='ai-recommend-list']",
        "[class*='comment-']"
      ].join(",")
    )
  );
}

function isVisibleElement(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width >= 1 && rect.height >= 1;
}

function isLarkDocumentPage(): boolean {
  return /(?:^|\.)((larkoffice|larksuite|feishu)\.(com|cn))$/.test(location.hostname);
}

function applyReplacements(replacements: RewriteReplacement[]): number {
  const byChunk = new Map<string, RewriteReplacement[]>();

  for (const replacement of replacements) {
    if (!byChunk.has(replacement.chunkId)) {
      byChunk.set(replacement.chunkId, []);
    }
    byChunk.get(replacement.chunkId)?.push(replacement);
  }

  let applied = 0;

  for (const [chunkId, items] of byChunk) {
    const node = chunkNodes.get(chunkId);
    if (!node?.parentNode) {
      continue;
    }

    const originalText = node.nodeValue ?? "";
    const matches = items
      .map((item) => ({
        item,
        index: originalText.indexOf(item.original)
      }))
      .filter((match) => match.index >= 0)
      .sort((a, b) => a.index - b.index);

    const nonOverlapping = [];
    let cursor = 0;
    for (const match of matches) {
      if (match.index < cursor) {
        continue;
      }
      nonOverlapping.push(match);
      cursor = match.index + match.item.original.length;
    }

    if (!nonOverlapping.length) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let offset = 0;

    for (const match of nonOverlapping) {
      if (match.index > offset) {
        fragment.append(document.createTextNode(originalText.slice(offset, match.index)));
      }
      fragment.append(createReplacementSpan(match.item));
      offset = match.index + match.item.original.length;
      applied += 1;
    }

    if (offset < originalText.length) {
      fragment.append(document.createTextNode(originalText.slice(offset)));
    }

    node.parentNode.replaceChild(fragment, node);
  }

  return applied;
}

function createReplacementSpan(item: RewriteReplacement): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = item.replacement;
  span.className = "english-immersion-mark";
  span.setAttribute(PROCESSED_ATTR, "true");
  span.dataset.explanation = item.explanation;
  span.dataset.kind = item.type;
  return span;
}

function detectMode(chunks: TextChunk[]): ResolvedRewriteMode {
  const sample = chunks.map((chunk) => chunk.text).join("\n").slice(0, 2000);
  const zh = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const en = (sample.match(/[A-Za-z]/g) ?? []).length;
  return zh >= en * 0.35 ? "zh-to-en" : "en-assist";
}

function normalizeText(text: string): string {
  return text.trim();
}

function injectStyles() {
  if (document.getElementById("english-immersion-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "english-immersion-style";
  style.textContent = `
    .english-immersion-mark {
      position: relative !important;
      color: inherit !important;
      text-decoration-line: underline !important;
      text-decoration-color: #38bdb4 !important;
      text-decoration-thickness: 2px !important;
      text-underline-offset: 4px !important;
      text-decoration-skip-ink: none !important;
      cursor: help !important;
      border-radius: 2px !important;
      transition: background-color 120ms ease, box-shadow 120ms ease !important;
    }
    #english-immersion-floating-ball {
      position: fixed !important;
      right: 14px !important;
      top: 52% !important;
      z-index: 2147483647 !important;
      width: 34px !important;
      height: 34px !important;
      padding: 0 !important;
      border: 1px solid rgba(56, 189, 180, 0.28) !important;
      border-radius: 999px !important;
      background: rgba(56, 189, 180, 0.24) !important;
      box-shadow: 0 8px 22px rgba(19, 87, 80, 0.14) !important;
      cursor: pointer !important;
      opacity: 0.34 !important;
      transition: opacity 120ms ease, transform 120ms ease, background-color 120ms ease !important;
      touch-action: none !important;
    }
    #english-immersion-floating-ball::before {
      content: "" !important;
      position: absolute !important;
      inset: 10px !important;
      border-radius: 999px !important;
      background: #168f84 !important;
    }
    #english-immersion-floating-ball:hover {
      opacity: 0.82 !important;
      transform: translateY(-1px) !important;
    }
    #english-immersion-floating-ball::after {
      content: attr(data-status) !important;
      position: absolute !important;
      right: 42px !important;
      top: 50% !important;
      transform: translateY(-50%) !important;
      max-width: 96px !important;
      padding: 4px 7px !important;
      border-radius: 999px !important;
      background: rgba(22, 42, 38, 0.82) !important;
      color: #fff !important;
      font-size: 12px !important;
      line-height: 1.2 !important;
      white-space: nowrap !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 120ms ease !important;
    }
    #english-immersion-floating-ball:hover::after {
      opacity: 1 !important;
    }
    #english-immersion-floating-ball.is-running {
      opacity: 0.7 !important;
      background: rgba(228, 197, 51, 0.3) !important;
    }
    #english-immersion-floating-ball.is-paused {
      opacity: 0.46 !important;
      background: rgba(120, 133, 129, 0.24) !important;
    }
    #english-immersion-floating-ball.is-paused::before {
      background: #7c8b86 !important;
    }
  `;
  document.documentElement.append(style);
}
