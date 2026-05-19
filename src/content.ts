type RewriteMode = "auto" | "zh-to-en" | "en-assist";
type ResolvedRewriteMode = Exclude<RewriteMode, "auto">;

type TextChunk = {
  id: string;
  text: string;
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
  error?: string;
};

const PROCESSED_ATTR = "data-english-immersion";
const MIN_TEXT_LENGTH = 18;
const COVERAGE_LIMITS: Record<number, { chunks: number; chars: number }> = {
  1: { chunks: 6, chars: 1800 },
  2: { chunks: 10, chars: 3000 },
  3: { chunks: 14, chars: 4300 },
  4: { chunks: 18, chars: 5600 },
  5: { chunks: 24, chars: 7600 }
};
const chunkNodes = new Map<string, Text>();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "RUN_IMMERSION_REWRITE") {
    return false;
  }

  runRewrite(message.mode as RewriteMode, Number(message.coverage ?? 3))
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "页面改造失败。"
      });
    });

  return true;
});

async function runRewrite(mode: RewriteMode, coverage: number) {
  injectStyles();
  chunkNodes.clear();

  const chunks = collectTextChunks(coverage);
  if (!chunks.length) {
    throw new Error("没有找到适合改造的正文内容。");
  }

  const resolvedMode = mode === "auto" ? detectMode(chunks) : mode;
  const response = (await chrome.runtime.sendMessage({
    type: "REWRITE_PAGE",
    payload: {
      url: location.href,
      title: document.title,
      mode: resolvedMode,
      chunks
    }
  })) as RewriteResponse;

  if (response.error) {
    throw new Error(response.error);
  }

  const applied = applyReplacements(response.replacements ?? []);
  return {
    ok: true,
    mode: resolvedMode,
    chunks: chunks.length,
    applied,
    cached: response.cached
  };
}

function collectTextChunks(coverage: number): TextChunk[] {
  const limits = COVERAGE_LIMITS[clampCoverage(coverage)];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
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

  const chunks: TextChunk[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  let index = 0;

  while (walker.nextNode() && chunks.length < limits.chunks && totalChars < limits.chars) {
    const node = walker.currentNode as Text;
    const text = normalizeText(node.nodeValue ?? "");

    if (seen.has(text)) {
      continue;
    }

    seen.add(text);
    const id = `chunk-${index++}`;
    chunkNodes.set(id, node);
    chunks.push({ id, text });
    totalChars += text.length;
  }

  return chunks;
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
      "[contenteditable='true']",
      "[role='button']",
      "[aria-hidden='true']"
    ].join(",")
  );

  if (blocked) {
    return false;
  }

  const element = parent instanceof HTMLElement ? parent : null;
  if (!element) {
    return false;
  }

  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 8) {
    return false;
  }

  return true;
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
  `;
  document.documentElement.append(style);
}
