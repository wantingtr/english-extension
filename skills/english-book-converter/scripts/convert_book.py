#!/usr/bin/env python3
"""Convert a legally obtained ebook into a low-density English-immersion EPUB.

The converter deliberately owns deterministic file work (validation, EPUB I/O,
candidate sampling, offset validation and packaging). A model only sees the
small candidate set selected locally.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import math
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from xml.etree import ElementTree as ET


EPUB_MIMETYPE = b"application/epub+zip"
OPF_NS = "http://www.idpf.org/2007/opf"
CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"
XHTML_NS = "http://www.w3.org/1999/xhtml"
DC_NS = "http://purl.org/dc/elements/1.1/"
STYLE_HREF = "english-immersion.css"
STYLE_ID = "english-immersion-style"
STYLE_TEXT = """.english-immersion-mark {
  color: inherit;
  text-decoration-line: underline;
  text-decoration-color: #38bdb4;
  text-decoration-thickness: 2px;
  text-underline-offset: 4px;
  text-decoration-skip-ink: none;
}\n"""
PDF_MESSAGE = "暂不支持 PDF；请使用 EPUB、TXT，或无 DRM 的 MOBI/AZW/AZW3 文件。"


@dataclass(frozen=True)
class Candidate:
    paragraph_id: str
    chapter_href: str
    paragraph_index: int
    text: str
    chinese_chars: int


@dataclass(frozen=True)
class Selection:
    paragraph_id: str
    quote: str
    start: int
    end: int
    en: str
    kind: str


class ConversionError(RuntimeError):
    pass


def count_chinese(text: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", text))


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def has_url_or_code(text: str) -> bool:
    return bool(re.search(r"https?://|www\.|`|</?\w+|\b(?:SELECT|function|const)\b", text, re.I))


def is_candidate_text(text: str) -> bool:
    chinese = count_chinese(text)
    if chinese < 45 or len(text) < 55 or len(text) > 900:
        return False
    if chinese / max(1, len(re.sub(r"\s", "", text))) < 0.55:
        return False
    if has_url_or_code(text):
        return False
    numeric = len(re.findall(r"[0-9０-９]", text))
    if numeric / max(1, len(text)) > 0.2:
        return False
    return True


def epub_path_join(base_file: str, href: str) -> str:
    return str((PurePosixPath(base_file).parent / href).as_posix())


def xml_namespace(element: ET.Element) -> str:
    if element.tag.startswith("{"):
        return element.tag.split("}", 1)[0][1:]
    return ""


def qname(namespace: str, local: str) -> str:
    return f"{{{namespace}}}{local}" if namespace else local


def find_child(element: ET.Element, namespace: str, local: str) -> ET.Element | None:
    return element.find(qname(namespace, local))


def parse_container(book: zipfile.ZipFile) -> str:
    try:
        root = ET.fromstring(book.read("META-INF/container.xml"))
    except (KeyError, ET.ParseError) as exc:
        raise ConversionError("EPUB 缺少或损坏 META-INF/container.xml。") from exc
    rootfile = root.find(f".//{{{CONTAINER_NS}}}rootfile")
    if rootfile is None or not rootfile.get("full-path"):
        raise ConversionError("EPUB 未声明 OPF 包文件。")
    return rootfile.get("full-path", "")


def get_spine_hrefs(book: zipfile.ZipFile, opf_path: str) -> tuple[ET.Element, str, list[str]]:
    try:
        root = ET.fromstring(book.read(opf_path))
    except (KeyError, ET.ParseError) as exc:
        raise ConversionError("EPUB 的 OPF 包文件无法读取。") from exc
    namespace = xml_namespace(root) or OPF_NS
    manifest = find_child(root, namespace, "manifest")
    spine = find_child(root, namespace, "spine")
    if manifest is None or spine is None:
        raise ConversionError("EPUB 的 OPF 缺少 manifest 或 spine。")
    items = {item.get("id", ""): item for item in manifest.findall(qname(namespace, "item"))}
    hrefs: list[str] = []
    for itemref in spine.findall(qname(namespace, "itemref")):
        item = items.get(itemref.get("idref", ""))
        if item is None:
            continue
        media_type = item.get("media-type", "")
        if media_type in {"application/xhtml+xml", "text/html"} and item.get("href"):
            hrefs.append(epub_path_join(opf_path, item.get("href", "")))
    if not hrefs:
        raise ConversionError("EPUB 没有可处理的 XHTML 正文章节。")
    return root, namespace, hrefs


def should_skip_element(element: ET.Element) -> bool:
    tag = element.tag.rsplit("}", 1)[-1].lower()
    klass = (element.get("class") or "").lower()
    ident = (element.get("id") or "").lower()
    return tag in {"h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "caption", "figcaption"} or any(
        word in f"{klass} {ident}" for word in ("title", "toc", "copyright", "footnote", "note", "reference")
    )


def collect_candidates(book: zipfile.ZipFile, hrefs: Iterable[str]) -> tuple[list[Candidate], dict[str, int]]:
    candidates: list[Candidate] = []
    chapter_chars: dict[str, int] = {}
    for chapter_number, href in enumerate(hrefs, 1):
        try:
            root = ET.fromstring(book.read(href))
        except (KeyError, ET.ParseError):
            continue
        paragraph_index = 0
        chapter_total = 0
        for element in root.iter():
            if element.tag.rsplit("}", 1)[-1].lower() not in {"p", "li", "blockquote"}:
                continue
            if should_skip_element(element) or list(element):
                continue
            text = normalize_text(element.text or "")
            chapter_total += count_chinese(text)
            if not is_candidate_text(text):
                continue
            paragraph_index += 1
            candidates.append(
                Candidate(
                    paragraph_id=f"chapter-{chapter_number:04d}-p-{paragraph_index:04d}",
                    chapter_href=href,
                    paragraph_index=paragraph_index,
                    text=text,
                    chinese_chars=count_chinese(text),
                )
            )
        chapter_chars[href] = chapter_total
    return candidates, chapter_chars


def sample_evenly(values: list[Candidate], count: int) -> list[Candidate]:
    if count >= len(values):
        return values
    if count <= 0:
        return []
    positions = [round((index + 0.5) * len(values) / count - 0.5) for index in range(count)]
    return [values[min(len(values) - 1, max(0, position))] for position in sorted(set(positions))]


def select_candidates(candidates: list[Candidate], chapter_chars: dict[str, int], chars_per_replacement: int, multiplier: int) -> tuple[list[Candidate], dict[str, int], int]:
    total_chars = sum(chapter_chars.values())
    budget = max(1, math.ceil(total_chars / chars_per_replacement)) if total_chars else 0
    # A global cap is essential: many short chapters must not turn a small book
    # budget into hundreds of model requests. The ordered, even sample still
    # spreads candidates through the book and naturally weights longer chapters.
    candidate_cap = min(len(candidates), budget * multiplier)
    selected = sample_evenly(candidates, candidate_cap)
    chapter_budgets: dict[str, int] = {}
    for item in selected:
        chapter_budgets[item.chapter_href] = chapter_budgets.get(item.chapter_href, 0) + 1
    return selected, chapter_budgets, budget


def source_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def build_prompt(difficulty: int) -> str:
    difficulty_map = {1: "基础", 2: "常见生活、学习和工作表达", 3: "大学四级常用表达", 4: "大学六级表达", 5: "高阶地道表达"}
    return "\n".join(
        [
            "你是英语学习电子书的候选片段选择器，不是全文翻译器。",
            "对每个候选段落最多选择一处可迁移的中文词或短语；没有合适候选必须返回空。",
            "只选高频动作、状态、关系或评价表达。不要选人名、书名、数字、日期、价格、ID、URL、代码或当前书独有事实。",
            f"难度：{difficulty_map[difficulty]}。",
            "quote 必须从 text 逐字复制；start/end 必须是 Python 字符偏移，且 text[start:end] 等于 quote。",
            "en 只写自然英文，不含中文或括号。本地会生成 en(quote)。",
            "输出严格 JSON：{\"selections\":[{\"paragraphId\":\"...\",\"quote\":\"...\",\"start\":0,\"end\":0,\"en\":\"...\",\"type\":\"word|phrase|sentence\"}]}。",
        ]
    )


def get_json_candidates(content: str) -> list[Any]:
    cleaned = re.sub(r"^```(?:json)?|```$", "", content.strip(), flags=re.I | re.M).strip()
    values = [cleaned]
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start >= 0 and end > start:
        values.append(cleaned[start : end + 1])
    parsed: list[Any] = []
    for value in values:
        try:
            parsed.append(json.loads(value))
        except json.JSONDecodeError:
            continue
    return parsed


def request_model(batch: list[Candidate], args: argparse.Namespace) -> list[dict[str, Any]]:
    api_key = args.api_key or os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        raise ConversionError("未提供模型 API Key。请设置 DEEPSEEK_API_KEY 或传入 --api-key；也可先用 --dry-run 导出候选清单。")
    endpoint = args.base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": args.model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": build_prompt(args.difficulty)},
            {"role": "user", "content": json.dumps({"candidates": [{"paragraphId": item.paragraph_id, "text": item.text} for item in batch]}, ensure_ascii=False)},
        ],
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise ConversionError(f"模型请求失败：HTTP {exc.code}。{detail}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise ConversionError(f"无法连接模型服务：{exc}") from exc
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    for parsed in get_json_candidates(content):
        if isinstance(parsed, dict) and isinstance(parsed.get("selections"), list):
            return parsed["selections"]
    raise ConversionError("模型返回的候选 JSON 无法解析。")


def validate_selections(raw: Iterable[dict[str, Any]], candidates: dict[str, Candidate]) -> tuple[list[Selection], list[str]]:
    accepted: list[Selection] = []
    skipped: list[str] = []
    seen: set[str] = set()
    for item in raw:
        paragraph_id = str(item.get("paragraphId") or item.get("chunkId") or "")
        candidate = candidates.get(paragraph_id)
        quote = str(item.get("quote") or "").strip()
        en = str(item.get("en") or "").strip()
        kind = str(item.get("type") or "phrase")
        try:
            start, end = int(item["start"]), int(item["end"])
        except (KeyError, TypeError, ValueError):
            skipped.append(f"{paragraph_id}: 缺少有效 start/end")
            continue
        if candidate is None or paragraph_id in seen:
            skipped.append(f"{paragraph_id}: 候选不存在或同段重复")
            continue
        if kind not in {"word", "phrase", "sentence"} or not en or re.search(r"[\u4e00-\u9fff]", en):
            skipped.append(f"{paragraph_id}: 英文或类型不符合要求")
            continue
        if start < 0 or end <= start or end > len(candidate.text) or candidate.text[start:end] != quote:
            skipped.append(f"{paragraph_id}: quote 与偏移不一致")
            continue
        if count_chinese(quote) < 2 or len(quote) > 32 or re.search(r"\d|https?://", quote):
            skipped.append(f"{paragraph_id}: 原文片段不适合替换")
            continue
        seen.add(paragraph_id)
        accepted.append(Selection(paragraph_id, quote, start, end, re.sub(r"\s+", " ", en), kind))
    return accepted, skipped


def add_style_and_links(book: zipfile.ZipFile, opf_path: str, output: zipfile.ZipFile) -> tuple[ET.Element, str]:
    root, namespace, _ = get_spine_hrefs(book, opf_path)
    manifest = find_child(root, namespace, "manifest")
    if manifest is None:
        raise ConversionError("EPUB 缺少 manifest。")
    if not any(item.get("id") == STYLE_ID for item in manifest.findall(qname(namespace, "item"))):
        ET.SubElement(manifest, qname(namespace, "item"), {"id": STYLE_ID, "href": STYLE_HREF, "media-type": "text/css"})
    style_path = epub_path_join(opf_path, STYLE_HREF)
    output.writestr(style_path, STYLE_TEXT.encode("utf-8"))
    return root, namespace


def apply_to_chapter(data: bytes, selections: dict[int, Selection], stylesheet_href: str) -> tuple[bytes, int]:
    root = ET.fromstring(data)
    namespace = xml_namespace(root) or XHTML_NS
    head = root.find(f".//{qname(namespace, 'head')}")
    if head is not None and not any(child.get("href") == stylesheet_href for child in head):
        ET.SubElement(head, qname(namespace, "link"), {"rel": "stylesheet", "type": "text/css", "href": stylesheet_href})
    applied = 0
    paragraph_index = 0
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1].lower() not in {"p", "li", "blockquote"} or should_skip_element(element) or list(element):
            continue
        text = normalize_text(element.text or "")
        if not is_candidate_text(text):
            continue
        paragraph_index += 1
        selection = selections.get(paragraph_index)
        if selection is None or text[selection.start : selection.end] != selection.quote:
            continue
        prefix, suffix = text[: selection.start], text[selection.end :]
        element.text = prefix
        mark = ET.SubElement(element, qname(namespace, "span"), {"class": "english-immersion-mark"})
        mark.text = f"{selection.en}({selection.quote})"
        mark.tail = suffix
        applied += 1
    ET.register_namespace("", namespace)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), applied


def write_epub(source: Path, output_path: Path, selections: list[Selection], candidate_map: dict[str, Candidate]) -> int:
    by_href: dict[str, dict[int, Selection]] = {}
    for selection in selections:
        candidate = candidate_map[selection.paragraph_id]
        by_href.setdefault(candidate.chapter_href, {})[candidate.paragraph_index] = selection
    with zipfile.ZipFile(source) as book, zipfile.ZipFile(output_path, "w") as output:
        opf_path = parse_container(book)
        opf_root, _namespace, hrefs = get_spine_hrefs(book, opf_path)
        style_path = epub_path_join(opf_path, STYLE_HREF)
        copied = set()
        mimetype = zipfile.ZipInfo("mimetype")
        mimetype.compress_type = zipfile.ZIP_STORED
        output.writestr(mimetype, EPUB_MIMETYPE)
        copied.add("mimetype")
        for info in book.infolist():
            if info.filename in {"mimetype", opf_path, style_path} or info.filename in hrefs:
                continue
            output.writestr(info, book.read(info.filename))
            copied.add(info.filename)
        styled_root, namespace = add_style_and_links(book, opf_path, output)
        output.writestr(opf_path, ET.tostring(styled_root, encoding="utf-8", xml_declaration=True))
        applied = 0
        for href in hrefs:
            try:
                stylesheet_href = posixpath.relpath(style_path, str(PurePosixPath(href).parent))
                chapter, count = apply_to_chapter(book.read(href), by_href.get(href, {}), stylesheet_href)
            except (KeyError, ET.ParseError):
                output.writestr(href, book.read(href))
                continue
            output.writestr(href, chapter)
            applied += count
    return applied


def split_long_paragraph(text: str, maximum: int = 700) -> list[str]:
    if len(text) <= maximum:
        return [text]
    sentences = [value for value in re.split(r"(?<=[。！？!?])", text) if value]
    values: list[str] = []
    current = ""
    for sentence in sentences:
        if current and len(current) + len(sentence) > maximum:
            values.append(current)
            current = sentence
        else:
            current += sentence
    if current:
        values.append(current)
    return values


def split_txt(text: str, limit: int = 60) -> list[list[str]]:
    raw_blocks = [normalize_text(value) for value in re.split(r"\n\s*\n", text) if normalize_text(value)]
    if len(raw_blocks) <= 1:
        raw_blocks = [normalize_text(value) for value in text.splitlines() if normalize_text(value)] or raw_blocks
    paragraphs = [part for value in raw_blocks for part in split_long_paragraph(value)]
    return [paragraphs[index : index + limit] for index in range(0, len(paragraphs), limit)] or [["空文本"]]


def create_epub_from_txt(source: Path, destination: Path) -> None:
    raw = source.read_bytes()
    text = next((raw.decode(encoding) for encoding in ("utf-8-sig", "gb18030", "utf-16") if _can_decode(raw, encoding)), None)
    if text is None:
        raise ConversionError("TXT 编码无法识别；请先转为 UTF-8。")
    chapters = split_txt(text)
    title = source.stem
    with zipfile.ZipFile(destination, "w") as book:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        book.writestr(info, EPUB_MIMETYPE)
        book.writestr("META-INF/container.xml", f'''<?xml version="1.0"?><container version="1.0" xmlns="{CONTAINER_NS}"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>''')
        manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
        spine = []
        nav = []
        for index, paragraphs in enumerate(chapters, 1):
            identifier = f"chapter-{index}"
            href = f"text/chapter-{index:03d}.xhtml"
            manifest.append(f'<item id="{identifier}" href="{href}" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="{identifier}"/>')
            nav.append(f'<li><a href="{href}">第 {index} 章</a></li>')
            body = "".join(f"<p>{html.escape(value)}</p>" for value in paragraphs)
            book.writestr(f"OEBPS/{href}", f'''<?xml version="1.0" encoding="utf-8"?><html xmlns="{XHTML_NS}"><head><title>{html.escape(title)}</title></head><body>{body}</body></html>''')
        book.writestr("OEBPS/nav.xhtml", f'''<?xml version="1.0" encoding="utf-8"?><html xmlns="{XHTML_NS}"><head><title>目录</title></head><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol>{''.join(nav)}</ol></nav></body></html>''')
        book.writestr("OEBPS/content.opf", f'''<?xml version="1.0" encoding="utf-8"?><package xmlns="{OPF_NS}" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="{DC_NS}"><dc:identifier id="bookid">urn:uuid:{hashlib.sha1(raw).hexdigest()}</dc:identifier><dc:title>{html.escape(title)}</dc:title><dc:language>zh</dc:language></metadata><manifest>{''.join(manifest)}</manifest><spine>{''.join(spine)}</spine></package>''')


def _can_decode(raw: bytes, encoding: str) -> bool:
    try:
        raw.decode(encoding)
        return True
    except UnicodeDecodeError:
        return False


def prepare_source(source: Path, temporary: Path) -> Path:
    prefix = source.read_bytes()[:8]
    suffix = source.suffix.lower()
    if prefix.startswith(b"%PDF") or suffix == ".pdf":
        raise ConversionError(PDF_MESSAGE)
    if suffix == ".txt":
        target = temporary / f"{source.stem}.epub"
        create_epub_from_txt(source, target)
        return target
    if suffix in {".mobi", ".azw", ".azw3"}:
        converter = shutil.which("ebook-convert")
        if not converter:
            raise ConversionError("检测到 MOBI/AZW/AZW3。此电脑未安装 Calibre 的 ebook-convert，无法确认文件可读取或转换；不会尝试绕过 DRM。")
        target = temporary / f"{source.stem}.epub"
        result = subprocess.run([converter, str(source), str(target)], capture_output=True, text=True, timeout=180)
        if result.returncode != 0 or not target.exists():
            raise ConversionError("MOBI/AZW/AZW3 无法转换。文件可能受 DRM 保护、损坏或格式不兼容；本工具不会绕过 DRM。")
        return target
    if suffix != ".epub":
        raise ConversionError("不支持该文件格式。请使用 EPUB、TXT，或无 DRM 的 MOBI/AZW/AZW3。")
    if not zipfile.is_zipfile(source):
        raise ConversionError("文件扩展名为 EPUB，但实际不是有效 ZIP/EPUB 文件。")
    with zipfile.ZipFile(source) as book:
        try:
            if book.read("mimetype") != EPUB_MIMETYPE:
                raise ConversionError("文件不是标准 EPUB 容器。")
        except KeyError as exc:
            raise ConversionError("EPUB 缺少 mimetype 声明。") from exc
    return source


def read_selection_file(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConversionError("--selections 文件不是有效 JSON。") from exc
    if isinstance(value, dict) and isinstance(value.get("selections"), list):
        return value["selections"]
    if isinstance(value, list):
        return value
    raise ConversionError("--selections 必须是 selections 数组或包含 selections 的对象。")


def make_report(source: Path, candidates: list[Candidate], budget: int, selected_candidates: list[Candidate], selections: list[Selection], skipped: list[str], args: argparse.Namespace) -> dict[str, Any]:
    return {
        "source": str(source),
        "outputFormat": "EPUB",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "density": args.density,
        "charsPerReplacement": args.chars_per_replacement,
        "sourceDigest": source_digest(source),
        "candidateParagraphs": len(candidates),
        "submittedCandidates": len(selected_candidates),
        "replacementBudget": budget,
        "validatedSelections": len(selections),
        "skippedSelections": skipped,
        "model": args.model if not args.selections else "external selections",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成低密度英语沉浸版 EPUB。")
    parser.add_argument("source", type=Path, help="输入 EPUB、TXT，或无 DRM 的 MOBI/AZW/AZW3")
    parser.add_argument("--output", type=Path, help="输出 EPUB 路径")
    parser.add_argument("--density", choices=["light", "standard", "high"], default="light")
    parser.add_argument("--difficulty", type=int, choices=range(1, 6), default=2)
    parser.add_argument("--chars-per-replacement", type=int, help="覆盖密度估算；默认随 density 变化")
    parser.add_argument("--candidate-multiplier", type=int, default=2, help="发送给模型的候选数相对最终预算的倍数")
    parser.add_argument("--dry-run", action="store_true", help="只写出候选清单和报告，不调用模型或生成 EPUB")
    parser.add_argument("--selections", type=Path, help="使用外部生成的 selections JSON，不调用模型")
    parser.add_argument("--api-key", help="OpenAI 兼容模型 API Key；也可使用 DEEPSEEK_API_KEY")
    parser.add_argument("--base-url", default="https://api.deepseek.com", help="OpenAI 兼容 API Base URL")
    parser.add_argument("--model", default="deepseek-v4-flash")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--timeout", type=int, default=45)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.source.is_file():
        raise ConversionError(f"找不到输入文件：{args.source}")
    if args.candidate_multiplier < 1 or args.batch_size < 1:
        raise ConversionError("候选倍数和批大小必须至少为 1。")
    defaults = {"light": 500, "standard": 300, "high": 180}
    args.chars_per_replacement = args.chars_per_replacement or defaults[args.density]
    output = args.output or args.source.with_name(f"{args.source.stem}-英语学习版.epub")
    if output.resolve() == args.source.resolve():
        raise ConversionError("输出路径不能覆盖原始电子书。请指定新的 --output 路径。")
    output.parent.mkdir(parents=True, exist_ok=True)
    report_path = output.with_suffix(".report.json")
    candidates_path = output.with_suffix(".candidates.json")
    with tempfile.TemporaryDirectory(prefix="english-book-") as directory:
        prepared = prepare_source(args.source, Path(directory))
        with zipfile.ZipFile(prepared) as book:
            opf_path = parse_container(book)
            _root, _namespace, hrefs = get_spine_hrefs(book, opf_path)
            candidates, chapter_chars = collect_candidates(book, hrefs)
        submitted, _chapter_budgets, budget = select_candidates(candidates, chapter_chars, args.chars_per_replacement, args.candidate_multiplier)
        candidate_map = {item.paragraph_id: item for item in submitted}
        candidates_path.write_text(json.dumps({"source": str(args.source), "budget": budget, "candidates": [asdict(item) for item in submitted]}, ensure_ascii=False, indent=2), "utf-8")
        if args.dry_run:
            report = make_report(args.source, candidates, budget, submitted, [], [], args)
            report["status"] = "dry-run"
            report["candidateFile"] = str(candidates_path)
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
            print(json.dumps({"status": "dry-run", "budget": budget, "candidateFile": str(candidates_path), "report": str(report_path)}, ensure_ascii=False))
            return 0
        raw_selections: list[dict[str, Any]] = []
        if args.selections:
            raw_selections = read_selection_file(args.selections)
        else:
            for index in range(0, len(submitted), args.batch_size):
                batch = submitted[index : index + args.batch_size]
                raw_selections.extend(request_model(batch, args))
                time.sleep(0.2)
        selections, skipped = validate_selections(raw_selections, candidate_map)
        selections = selections[:budget]
        if not selections:
            raise ConversionError("没有通过校验的替换项；未生成电子书。可检查候选或模型返回。")
        applied = write_epub(prepared, output, selections, candidate_map)
        report = make_report(args.source, candidates, budget, submitted, selections, skipped, args)
        report.update({"status": "completed", "output": str(output), "applied": applied, "candidateFile": str(candidates_path)})
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
        print(json.dumps({"status": "completed", "output": str(output), "applied": applied, "report": str(report_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ConversionError as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
