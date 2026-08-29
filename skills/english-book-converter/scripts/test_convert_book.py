#!/usr/bin/env python3
"""Black-box checks for the local ebook conversion flow."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


SCRIPT = Path(__file__).with_name("convert_book.py")


def paragraph(seed: str) -> str:
    return (f"这是第{seed}段内容，企业在市场变化中需要保持长期主义，并通过持续学习改善经营效率。" * 3)


class ConvertBookTests(unittest.TestCase):
    def run_script(self, *args: str, expected: int = 0) -> subprocess.CompletedProcess[str]:
        result = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, msg=result.stderr)
        return result

    def test_txt_dry_run_then_external_selection_generates_epub(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "sample.txt"
            source.write_text("\n\n".join(paragraph(str(index)) for index in range(1, 13)), "utf-8")
            output = root / "sample-learning.epub"
            dry = self.run_script(str(source), "--output", str(output), "--dry-run")
            dry_data = json.loads(dry.stdout)
            candidate_data = json.loads(Path(dry_data["candidateFile"]).read_text("utf-8"))
            candidates = candidate_data["candidates"]
            self.assertGreater(candidates.__len__(), 0)
            self.assertLessEqual(len(candidates), dry_data["budget"] * 2)
            first = candidates[0]
            quote = "长期主义"
            start = first["text"].index(quote)
            selections = root / "selections.json"
            selections.write_text(json.dumps({"selections": [{"paragraphId": first["paragraph_id"], "quote": quote, "start": start, "end": start + len(quote), "en": "long-termism", "type": "phrase"}]}, ensure_ascii=False), "utf-8")
            completed = self.run_script(str(source), "--output", str(output), "--selections", str(selections))
            completed_data = json.loads(completed.stdout)
            self.assertEqual(completed_data["applied"], 1)
            with zipfile.ZipFile(output) as book:
                self.assertEqual(book.read("mimetype"), b"application/epub+zip")
                self.assertIn("OEBPS/english-immersion.css", book.namelist())
                chapter = book.read("OEBPS/text/chapter-001.xhtml").decode("utf-8")
                self.assertIn("long-termism(长期主义)", chapter)
                self.assertIn("english-immersion-mark", chapter)
                self.assertIn('href="../english-immersion.css"', chapter)
            roundtrip = root / "sample-roundtrip.epub"
            second_dry = self.run_script(str(output), "--output", str(roundtrip), "--dry-run")
            second_candidates = json.loads(Path(json.loads(second_dry.stdout)["candidateFile"]).read_text("utf-8"))["candidates"]
            second = second_candidates[0]
            second_start = second["text"].index(quote)
            selections.write_text(json.dumps({"selections": [{"paragraphId": second["paragraph_id"], "quote": quote, "start": second_start, "end": second_start + len(quote), "en": "long-termism", "type": "phrase"}]}, ensure_ascii=False), "utf-8")
            self.run_script(str(output), "--output", str(roundtrip), "--selections", str(selections))
            with zipfile.ZipFile(roundtrip) as book:
                self.assertEqual(book.namelist().count("OEBPS/english-immersion.css"), 1)

    def test_pdf_is_rejected_before_processing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sample.pdf"
            source.write_bytes(b"%PDF-1.7\nnot a real pdf")
            result = self.run_script(str(source), expected=2)
            self.assertIn("暂不支持 PDF", result.stderr)

    def test_txt_without_blank_lines_is_split_into_convertible_paragraphs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "line-based.txt"
            source.write_text("\n".join(paragraph(str(index)) for index in range(1, 6)), "utf-8")
            result = self.run_script(str(source), "--dry-run")
            candidates = json.loads(Path(json.loads(result.stdout)["candidateFile"]).read_text("utf-8"))["candidates"]
            self.assertGreater(len(candidates), 0)


if __name__ == "__main__":
    unittest.main()
