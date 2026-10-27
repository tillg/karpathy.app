"""Stub of instascraper.writer (v1.1.0): writes post.md, metadata.json and one media file."""

from __future__ import annotations

import json
from pathlib import Path


def write_result(client, media, result, output_base: str, progress=None) -> Path:
    out_dir = Path(output_base) / result.shortcode
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{result.shortcode}.jpg").write_bytes(b"\xff\xd8 fake jpeg")
    (out_dir / "post.md").write_text(f"# @{result.owner}\n\ncaption\n", encoding="utf-8")
    (out_dir / "metadata.json").write_text(json.dumps({"shortcode": result.shortcode, "owner": result.owner}),
                                           encoding="utf-8")
    return out_dir
