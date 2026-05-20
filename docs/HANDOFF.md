# 语境英语 Hand-off

## 当前状态

这是一个本地自用的 Chrome Manifest V3 插件。当前产品名为 **语境英语**，英文标识为 **Context English**。

核心能力：

- 中文网页改造：从中文正文中选择可迁移、高频、有学习价值的片段，替换成 `English(中文原文)`。
- 英文网页改造：从英文正文中选择需要解释的难词或短语，替换成 `English(中文释义)`。
- 手动触发：通过 popup 点击“改造当前页面”。
- 设置项：硅基流动 API key、base URL、模型名、英文难度、替换浓度、覆盖密度。
- 调试面板：options 页面底部展示完整日志，方便跨设备复制给 Codex。

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

- `src/content.ts`：全文扫描正文 chunks、按覆盖密度选择请求 chunks、接收 popup 指令、流式应用批次结果、注入青绿色下划线样式。
- `src/background.ts`：读取设置、分批调用硅基流动、解析 AI selections、校验 quote、生成最终 replacements、把每批成功结果回推给页面、写入调试日志和页面级缓存。
- `src/popup/main.tsx`：模式选择、手动触发当前页改造、显示处理状态。
- `src/options/main.tsx`：API 和学习参数设置、完整调试日志。
- `src/sharedDefaults.ts`：默认设置和 storage key。
- `src/types.ts`：跨模块共享类型。

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

当前 prompt version 是 `selection-protocol-v4-streaming-fullscan`。

页面处理流程：

1. content script 从 DOM 从上到下全文扫描可用正文，最多收集 `160` 个 chunk / `50,000` 字符作为安全上限。
2. 顶部 `24` 个 chunk 必选，保证用户从上往下阅读时前几屏优先出现结果。
3. 顶部之后的正文按覆盖密度做确定性的均匀抽样，不做随机抽样，确保缓存稳定。
4. 选中的 chunk 每 `4` 个组成一个 batch。
5. background 串行请求 LLM，当前并发数为 `1`。
6. 单批请求最多等待 `12s`；超时、`Failed to fetch`、候选 JSON 解析失败都视为可恢复批次错误，跳过该批并继续下一批。
7. 每批成功后，background 通过 `IMMERSION_BATCH_RESULT` 立即发回当前 tab，content script 立刻替换对应 DOM，不再等整页全部完成。
8. 所有批次结束后写入页面级缓存；命中缓存时仍一次性应用缓存结果。

覆盖密度当前语义：

```text
1 档：顶部优先，后文抽样约 12%，每批最多 1 个 selection
2 档：顶部优先，后文抽样约 22%，每批最多 2 个 selections
3 档：顶部优先，后文抽样约 40%，每批最多 4 个 selections
4 档：顶部优先，后文抽样约 60%，每批最多 6 个 selections
5 档：顶部优先，后文抽样约 80%，每批最多 8 个 selections
```

真实 LatePost 验证记录：

```text
URL: https://www.latepost.com/news/dj_detail?id=3558
全文扫描: 122 chunks
覆盖密度 3 档实际请求: 64 chunks
请求批次: 16 batches
旧全文全送策略: 122 chunks / 31 batches
```

测试产物在本地 `output/`，已加入 `.gitignore`，不要提交大截图或日志。

## 设计决策

已经确定：

- 不走预置本地大词典。中文网页表达开放，词典穷举不可行。
- 不做轻量个人词典缓存。短期先把选择和替换质量调稳，缓存词典不是 MVP 必需。
- 不让 AI 直接生成最终 replacement。AI 只负责语义判断和英文表达，本地负责可靠执行。
- 不做场景硬编码。上一版曾尝试用租房词和地名正则过滤，已移除。后续也不要用具体页面补丁替代通用策略。
- 当前重点是 prompt 和 selection schema，而不是引入 npm 翻译包。

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

- AI 有时仍选择低学习价值片段，例如朝向、地名、站名、楼盘名。
- AI 有时生成不自然表达，例如把短语翻成完整句。
- 替换数量偏少，尤其当 `isProperNoun/isTransferable/learningValue` 字段判断偏保守时。
- 页面级缓存可能复用旧 prompt 结果；每次大幅调整 prompt 后应升级 `PROMPT_VERSION`。
- SiliconFlow 当前响应非常不稳定，真实测试中大量 batch 会卡到 `12s` 超时。现有代码已降低请求量并支持流式应用，但 API 慢仍会影响整页完成时间。
- 当前是串行请求，用户体验比全页等待好，但总耗时仍受超时批次数影响。

当前通用过滤策略在 `src/background.ts`：

- `isProperNoun === true` 跳过。
- `isTransferable === false` 跳过。
- `learningValue < 3` 跳过。
- 中文模式要求 `quote` 含中文、`en` 含英文且不含中文。
- 英文模式要求 `quote` 含英文、`zh` 含中文。
- quote 过长会跳过。
- 按浓度限制 `word/phrase/sentence` 的数量配额。

## 下一步建议

优先级 1：继续优化 prompt，但保持通用。

- 不要写具体租房词表。
- 可以强化通用原则：选择“可复用表达”，避开“唯一标识信息”。
- 可以要求 AI 对每个 selection 给一个简短 `reason`，方便调试为什么选它。
- 可以把 `learningValue` 定义得更严格：1=无价值，3=可用，5=高频可迁移表达。

优先级 2：改善“替换太少”。

- 让 AI 每个 chunk 返回 4-8 个候选，本地再筛。
- 降低本地 `learningValue` 阈值或按浓度动态调整阈值。
- 对 `isProperNoun/isTransferable` 缺失的候选，目前本地不会直接拒绝；如果模型输出不稳定，先看完整日志再决定。

优先级 3：让调试更直观。

- 在调试日志里加入 `acceptedSelections` 和 `rejectedSelections`，记录每条被拒原因。
- popup 显示“AI 候选 N，最终替换 M”，便于判断是模型少选还是本地过滤太严。
- popup 增加进度状态，例如“已完成 4/16 批，已替换 12 处”，让用户知道不是卡死。
- 可以尝试并发 `2`、单批 timeout `8-10s`，但需要用真实 SiliconFlow 压测，避免供应商限流或更多超时。

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
- `real-api:extension`：独立 Playwright Chromium + 真实 SiliconFlow API，适合验证真实接口慢/超时。
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
