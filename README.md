# 语境英语

一个本地自用的 Chrome Manifest V3 插件，用硅基流动 OpenAI-compatible API 在真实网页语境中生成可控的英语接触。

## 使用

```bash
npm install
npm run build
```

然后在 Chrome 打开 `chrome://extensions`：

1. 开启开发者模式。
2. 点击“加载已解压的扩展程序”。
3. 选择本项目的 `dist` 目录。
4. 打开插件设置页，填写硅基流动 API key。
5. 在普通网页点击插件图标，选择模式，点击“改造当前页面”。

## 功能

- 中文网页改造：把中文正文中的词汇、短语或短句替换成英文表达，并保留中文括注。
- 英文网页改造：保留英文正文，对难词、短语或句子追加中文括注。
- 英文难度 1-5 档。
- 替换浓度 1-5 档。
- 本地缓存相同页面、模式和设置下的 AI 结果，减少重复 token 消耗。

## 默认 API

- Base URL：`https://api.siliconflow.cn/v1`
- Endpoint：`/chat/completions`
- 默认模型：`Qwen/Qwen2.5-7B-Instruct`

模型名可以在设置页修改。
