# 语境英语 Hand-off

## 当前状态

这是一个本地自用的 Chrome Manifest V3 插件。当前产品名为 **语境英语**，英文标识为 **Context English**。

核心能力：

- 中文网页改造：从中文正文中选择可迁移、高频、有学习价值的片段，替换成 `English(中文原文)`。
- 英文网页改造：从英文正文中选择需要解释的难词或短语，替换成 `English(中文释义)`。
- 手动触发：通过 popup 点击“改造当前页面”。
- 自动触发：options 里配置域名白名单后，匹配域名会自动改造，并在页面右侧显示可拖拽悬浮球。
- 飞书/Lark 页面增强：白名单下支持自动改造、暂停/恢复、滚动/DOM 变化后的增量改造和本页 chunk 级缓存。
- 设置项：DeepSeek API key、base URL、模型名、英文难度、替换浓度、覆盖密度、自动改造白名单。
- 调试面板：options 页面底部展示完整日志、请求体、接受/拒绝候选及拒绝原因，方便复制给 Codex。

构建验证命令：

```bash
npm install
npm run build
```

Chrome 加载路径：

```text
/Users/wanting/project/english-extension/dist
```

如果源码改动后已经重新 build，Chrome 扩展页点刷新/更新即可；目标网页仍需刷新，因为 content script 已注入旧页面。

## 关键架构

主要文件：

- `src/content.ts`：全文扫描正文 chunks、按覆盖密度抽样、接收 popup 指令、流式应用批次结果、向 popup 转发进度、注入下划线和悬浮球样式；飞书/Lark 页面额外维护增量扫描、chunk stable key、本页 replacement cache 和 in-flight/processed 集合。
- `src/background.ts`：读取设置、并发分批调用 DeepSeek、解析 AI selections、校验 quote、生成最终 replacements、把每批结果回推给页面、写入调试日志和页面级缓存；现在会记录 accepted/rejected selections 和 requestBody。
- `src/popup/main.tsx`：分段按钮式模式选择、手动触发当前页改造、显示批次耗时/候选数/有效数/累计替换数和最终耗时统计。
- `src/options/main.tsx`：API、学习参数、自动改造白名单设置、完整调试日志。
- `src/sharedDefaults.ts`：默认设置、storage key、settings/host normalization。
- `src/types.ts`：跨模块共享类型，包含自动白名单和部分失败 chunk 字段。

当前 AI 协议是 **selection protocol**，不是直接 replacement protocol。

AI 应返回：

```json
{
  "selections": [
    {
      "chunkId": "chunk-0",
      "quote": "原文片段",
      "start": 0,
      "end": 4,
      "en": "natural English",
      "type": "phrase",
      "level": 2,
      "isProperNoun": false,
      "isTransferable": true,
      "learningValue": 4
    }
  ]
}
```

本地执行规则：

- `quote` 必须能在对应 `chunk.text` 中精确定位。
- 如果 `start/end` 精确命中，优先用下标；否则 fallback 到 `chunk.text.indexOf(quote)`。
- 中文模式本地生成最终替换：`${en}(${quote})`。
- 英文模式本地生成最终替换：`${quote}(${zh})`。
- 本地不再维护手写词典、租房词表、地名黑名单或个人词典缓存。
- 当前只保留页面级缓存：同 URL、被选中请求 chunks、模式、模型、难度、浓度、覆盖密度、prompt version 下复用上次 replacements。

## 当前请求策略

当前 prompt version 是 `selection-protocol-v9-partial-cache-safe`。

默认 API 设置：

```text
baseUrl: https://api.deepseek.com
model: deepseek-v4-flash
thinking: disabled
temperature: 0
max_tokens: 900
response_format: json_object
```

DeepSeek JSON Output 偶发空 `content`。当前策略是不重试：把该批视为可恢复错误，记录 `rawResponse`/耗时/错误，跳过该批并继续后续 chunk。只有所有批次都没有有效替换时，才向用户报错。

页面处理流程：

1. content script 从 DOM 从上到下全文扫描可用正文，最多收集 `160` 个 chunk / `50,000` 字符作为安全上限。
2. 正文按覆盖密度做确定性的均匀抽样，不做随机抽样，确保缓存稳定；8 个以内 chunk 默认全选。
3. 选中的 chunk 每 `4` 个组成一个 batch。
4. background 使用 worker queue 并发请求 LLM，当前并发数为 `3`。
5. 单批请求最多等待 `18s`；超时、`Failed to fetch`、候选 JSON 解析失败都视为可恢复批次错误，跳过该批并继续下一批。
6. 每批成功后，background 通过 `IMMERSION_BATCH_RESULT` 立即发回当前 tab，content script 立刻替换对应 DOM，不再等整页全部完成。
7. replacements 会按原始请求 chunk 顺序排序，避免并发返回顺序影响最终结果。
8. 只有所有 batch 都成功时才写入页面级缓存；出现失败 batch 时返回 `completedChunkIds`/`failedChunkIds`，避免缓存半截页面结果。

飞书/Lark 自动改造流程：

1. options 的“自动改造白名单”保存域名，例如 `bytedance.larkoffice.com`。
2. content script 加载后读取 settings，匹配当前 hostname 或其子域名时，约 `800ms` 后自动触发改造。
3. 页面右侧注入可拖拽悬浮球：白名单页点击可暂停/恢复自动改造，非白名单页点击可手动触发一次。
4. 飞书页面会优先在可见文档根节点内收集正文，过滤目录、侧边栏、评论、AI 推荐等 chrome 文本。
5. 飞书 chunk 使用 block id/元素路径 + 文本 hash 生成 stable key；已处理、正在请求、已有缓存的 chunk 不再重复发送。
6. 初次改造后会监听滚动和 DOM 变化，`500ms` debounce 后最多取 `24` 个新增/可见 chunk 做增量改造。

覆盖密度当前语义：

```text
1 档：均匀抽样约 12%，每 4 个 chunks 基准最多 1 个 selection
2 档：均匀抽样约 24%，每 4 个 chunks 基准最多 2 个 selections
3 档：均匀抽样约 36%，每 4 个 chunks 基准最多 4 个 selections
4 档：均匀抽样约 50%，每 4 个 chunks 基准最多 6 个 selections
5 档：均匀抽样约 68%，每 4 个 chunks 基准最多 8 个 selections
```

真实 LatePost 验证记录：

```text
URL: https://www.latepost.com/news/dj_detail?id=3565
全文扫描: 107 chunks
覆盖密度 3 档实际请求: 42 chunks
请求批次: 11 batches
parsedCount: 42
sanitizedCount: 41
总耗时约 28.6s
单批平均约 2.6s
total_tokens 约 15.5k；第 3 批后 DeepSeek prompt cache 命中 768 tokens/batch
```

测试产物在本地 `output/`，已加入 `.gitignore`，不要提交大截图或日志。

## 设计决策

已经确定：

- 不走预置本地大词典。中文网页表达开放，词典穷举不可行。
- 不做轻量个人词典缓存。短期先把选择和替换质量调稳，缓存词典不是 MVP 必需。
- 不让 AI 直接生成最终 replacement。AI 只负责语义判断和英文表达，本地负责可靠执行。
- 不做场景硬编码。上一版曾尝试用租房词和地名正则过滤，已移除。后续也不要用具体页面补丁替代通用策略。
- 当前重点是 prompt 和 selection schema，而不是引入 npm 翻译包。
- 默认覆盖密度已降为 `2`，以减少长文 token 和请求次数；用户保存过设置时仍以本地 storage 为准。
- 替换浓度 `1/2` 已改成 word-first prompt：优先单个中文词或 2-4 字短词，phrase 只用于固定搭配或单词无法自然表达的强可迁移表达。

AI 的职责：

- 判断哪些片段值得学习。
- 判断候选是否为当前页面特有专名。
- 判断候选是否可迁移到其他语境。
- 给出自然英文表达或中文释义。
- 给出 `quote + start/end` 供本地校验。

本地的职责：

- 提取正文。
- 控制处理范围。
- 校验 quote 精确存在。
- 按难度、浓度、范围做结构化过滤。
- 生成最终显示格式。
- 执行 DOM 替换。
- 保存调试日志。

## 当前问题

最近观察到的问题：

- 浓度 `2` 现在已有明显 word 回归，但 phrase 比例仍由 prompt 引导，不是硬比例约束；最近日志约为 word/phrase 接近一半一半。
- 调试日志已能看到 `acceptedSelections` 和 `rejectedSelections`，每条 rejected 会带原因；后续排查优先复制完整日志。
- 页面级缓存可能复用旧 prompt 结果；每次大幅调整 prompt 后应升级 `PROMPT_VERSION`。
- DeepSeek 已替换原 SiliconFlow 接口。默认 base URL 为 `https://api.deepseek.com`，默认模型为 `deepseek-v4-flash`；如果本地仍保存旧 SiliconFlow 默认配置，启动时会自动迁移到 DeepSeek，并保留已有 API key 和学习参数。
- 当前请求并发为 `3`，总耗时明显依赖 DeepSeek 当时延迟和失败批次数；如果遇到限流或更高错误率，可降回 `1-2`。
- popup 是 Manifest V3 临时浮窗：只有打开期间能实时接收批次进度；关闭后再打开不会恢复正在进行的进度视图。
- 飞书/Lark 增量改造主要按可见正文和 DOM 变化工作，复杂页面结构变化后 stable key 可能变化，导致同一文本再次请求。

当前通用过滤策略在 `src/background.ts`：

- `isProperNoun === true` 跳过。
- `isTransferable === false` 跳过。
- `learningValue < 3` 跳过。
- 中文模式要求 `quote` 含中文、`en` 含英文且不含中文。
- 英文模式要求 `quote` 含英文、`zh` 含中文。
- quote 过长会跳过。
- 按浓度限制 `word/phrase/sentence` 的数量配额。

## 下一步建议

优先级 1：真实页面回归。

- 在飞书/Lark 文档、普通中文网页、英文网页各跑一次真实改造。
- 重点看悬浮球暂停/恢复、滚动增量触发、chunk 是否重复请求、失败 batch 是否不会污染缓存。
- popup 已显示批次耗时、候选数、有效数、累计替换数；后续可考虑把最终统计也写入 debug meta，方便复制分析。

优先级 2：视情况约束浓度比例。

- 目前浓度 2 的 word-first prompt 质量已经可接受，先不优化。
- 如果用户后续仍觉得 phrase 太多，可以给本地过滤加硬比例，例如浓度 2 每批最多 1 个 phrase，或整页 phrase 不超过 word 的一半。

优先级 3：速度和成本。

- 默认覆盖密度已经降为 2，顶部必选和后文抽样都已变轻。
- 可以尝试并发 `2`、单批 timeout `8-10s`，但需要用真实 DeepSeek 压测，避免供应商限流或更多超时。

优先级 4：英文网页模式。

- 目前主要围绕中文网页调试；英文网页模式还需要单独测试。
- 英文模式应该继续用 `quote + zh`，不要让 AI 整句翻译。

## 调试流程

1. `npm run build`
2. Chrome `chrome://extensions` 刷新 **语境英语**
3. 刷新目标网页
4. 点击插件 popup 的“改造当前页面”
5. 打开设置页底部“调试面板”
6. 复制完整日志给 Codex

重点看：

- `sourceChunkCount`：全文扫描到多少正文 chunk。
- `chunks`：实际选中并发送给 LLM 的 chunk 是否合理。
- `rawResponse`：AI 是否按 selections schema 返回。
- `parsedCount`：解析到多少候选。
- `sanitizedCount`：最终接受多少候选。
- `requestBody`：实际发送给 DeepSeek 的 body，包含 prompt 和 chunk。
- `acceptedSelections`：本地接受的候选和生成的 replacement。
- `rejectedSelections`：本地拒绝的候选及原因。
- `batchStatuses`：每批 chunk、耗时、HTTP 状态、解析/接受数量、是否超时。
- `error`：是否有请求、解析或执行错误。

## 自动化测试脚本

当前有几条脚本用于减少手工复制日志：

```bash
npm run smoke:extension
npm run real-api:extension -- 'https://www.latepost.com/news/dj_detail?id=3558'
npm run current:extension -- 'https://www.latepost.com/news/dj_detail?id=3558'
```

- `smoke:extension`：使用 mock API，适合验证 DOM 替换和基本流程。
- `real-api:extension`：独立 Playwright Chromium + 真实 DeepSeek API，适合验证真实接口表现。
- `current:extension`：尝试控制用户当前 Chrome。当前机器标准 `http://127.0.0.1:9222/json/version` 返回 404，但可通过 `~/Library/Application Support/Google/Chrome/DevToolsActivePort` 读取 websocket 直连。长时间测试后该 websocket 可能握手超时，需要重启调试 Chrome 或改用 `real-api:extension`。

## Git/远程

远程仓库：

```text
origin https://github.com/wantingtr/english-extension.git
```

建议提交信息风格：

```text
feat: improve selection protocol
docs: add handoff notes
```
