# Chinglishify

一个本地自用的 Chrome Manifest V3 插件，用 DeepSeek OpenAI-compatible API 把真实网页轻轻 Chinglishify 一下。

## 使用

```bash
npm install
npm run build
```

然后在 Chrome 打开 `chrome://extensions`：

1. 开启开发者模式。
2. 点击“加载已解压的扩展程序”。
3. 选择本项目的 `dist` 目录。
4. 打开插件设置页，填写 DeepSeek API key。
5. 在普通网页点击插件图标，选择模式，点击“Chinglishify 当前页”。

## 功能

- 中文网页改造：把中文正文中的词汇、短语或短句替换成英文表达，并保留中文括注。
- 英文网页改造：保留英文正文，对难词、短语或句子追加中文括注。
- 英文难度 1-5 档。
- 替换浓度 1-5 档。
- 本地缓存相同页面、模式和设置下的 AI 结果，减少重复 token 消耗。

## 默认 API

- Base URL：`https://api.deepseek.com`
- Endpoint：`/chat/completions`
- 默认模型：`deepseek-v4-flash`

模型名可以在设置页修改。

## 电子书英语沉浸转换（Codex Skill）

仓库根目录的 [`skills/english-book-converter`](skills/english-book-converter) 是一个独立的 Codex Skill。它把合法取得的电子书预处理为可导入微信读书的学习版 EPUB：只在少量位置将中文表达替换为 `English(原中文)`，并附加青绿色下划线。

在 Codex 中上传电子书后，可以直接说：

```text
使用 $english-book-converter，把这本书转成默认轻度英语学习版。
```

首次在新电脑克隆本仓库后，需要将仓库内的 Skill 注册到 Codex（只需一次）：

```bash
ln -s "$(pwd)/skills/english-book-converter" "$HOME/.codex/skills/english-book-converter"
```

默认目标约为每两页一处，先由本地脚本按整书配额筛掉大部分段落，再只处理候选文本，降低模型调用量。支持 EPUB、TXT，以及本机安装 Calibre 后可读取的无 DRM MOBI/AZW/AZW3；PDF 会直接提示不支持，受 DRM 保护的文件不会尝试处理。

Skill 的唯一执行脚本是：

```bash
python3 skills/english-book-converter/scripts/convert_book.py <电子书路径> --dry-run
```

`--dry-run` 只做格式校验和候选筛选，不调用模型、不修改原书。详细规则见 [Skill 说明](skills/english-book-converter/SKILL.md)。
