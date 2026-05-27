export type RewriteMode = "auto" | "zh-to-en" | "en-assist";

export type ResolvedRewriteMode = Exclude<RewriteMode, "auto">;

export type Settings = {
  apiKey: string;
  model: string;
  baseUrl: string;
  difficulty: number;
  concentration: number;
  coverage: number;
  autoRewriteHosts: string[];
};

export type TextChunk = {
  id: string;
  text: string;
};

export type RewriteReplacement = {
  chunkId: string;
  original: string;
  replacement: string;
  explanation: string;
  type: "word" | "phrase" | "sentence";
};

export type RewriteRequest = {
  requestId?: string;
  url: string;
  title: string;
  mode: ResolvedRewriteMode;
  chunks: TextChunk[];
  sourceChunkCount?: number;
};

export type RewriteResponse = {
  replacements: RewriteReplacement[];
  cached: boolean;
  streamed?: boolean;
  batchTimings?: BatchTiming[];
  totalElapsedMs?: number;
  completedChunkIds?: string[];
  failedChunkIds?: string[];
};

export type BatchTiming = {
  index: number;
  elapsedMs?: number;
  httpStatus?: number;
  parsedCount?: number;
  sanitizedCount?: number;
  error?: string;
};
