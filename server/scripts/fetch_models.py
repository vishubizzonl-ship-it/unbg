#!/usr/bin/env python3
"""Download model weights. No token, no gated repos, resumable.

    python scripts/fetch_models.py --list
    python scripts/fetch_models.py birefnet-512         # 473 MB, full BiRefNet at 512 px
    python scripts/fetch_models.py birefnet-lite        # 224 MB, fastest CPU option
    python scripts/fetch_models.py birefnet-portrait    # 972 MB, best on people
    python scripts/fetch_models.py u2netp               # 4.7 MB, from rembg's release
    python scripts/fetch_models.py all

Files land at models/<id>/onnx/model.onnx (or models/<id>/<id>.onnx for U²-Net),
which is exactly where the engines look.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unbg_server.config import settings  # noqa: E402
from unbg_server.engines import registry  # noqa: E402

# model id -> (hugging face repo, file inside onnx/, licence note)
REPOS = {
    "birefnet-general": ("onnx-community/BiRefNet-ONNX", "model.onnx"),
    "birefnet-portrait": ("onnx-community/BiRefNet-portrait-ONNX", "model.onnx"),
    "birefnet-lite": ("onnx-community/BiRefNet_lite-ONNX", "model.onnx"),
    "birefnet-512": ("onnx-community/BiRefNet_512x512-ONNX", "model_fp16.onnx"),
}

# U²-Net is Apache-2.0, published by the author's ecosystem via rembg's public release.
U2NET_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/{name}.onnx"
U2NET = {"u2netp", "u2net"}


def human(size: float) -> str:
    return f"{size / 1_000_000:.0f} MB"


def _stream(url: str, dest: Path) -> Path:
    part = dest.with_suffix(dest.suffix + ".part")
    resume_at = part.stat().st_size if part.exists() else 0
    headers = {"Range": f"bytes={resume_at}-"} if resume_at else {}
    with httpx.stream("GET", url, headers=headers, follow_redirects=True, timeout=60.0) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length", 0)) + resume_at
        mode = "ab" if resume_at and response.status_code == 206 else "wb"
        written = resume_at
        with open(part, mode) as handle:
            for chunk in response.iter_bytes(1 << 20):
                handle.write(chunk)
                written += len(chunk)
                pct = (written / total * 100) if total else 0
                print(f"\r  {human(written)} / {human(total)}  {pct:5.1f}%", end="", flush=True)
    print()
    part.replace(dest)
    return dest


def download(model_id: str, *, force: bool = False) -> Path:
    if model_id in U2NET:
        dest = settings.model_dir / model_id / f"{model_id}.onnx"
        if dest.exists() and not force:
            print(f"✓ {model_id}: already present ({human(dest.stat().st_size)})")
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"↓ {model_id}  (rembg public release, Apache-2.0)")
        _stream(U2NET_URL.format(name=model_id), dest)
        print(f"✓ {model_id} → {dest}")
        return dest

    repo, filename = REPOS[model_id]
    dest = settings.model_dir / model_id / "onnx" / filename
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/{repo}/resolve/main/onnx/{filename}"
    if dest.exists() and not force:
        print(f"✓ {model_id}: already present ({human(dest.stat().st_size)})")
        return dest
    print(f"↓ {model_id}  {repo}  ({url})")
    _stream(url, dest)
    print(f"✓ {model_id} → {dest}")
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch unbg model weights.")
    parser.add_argument("models", nargs="*", help="ids, or 'all'")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dir", help="override UNBG_MODEL_DIR")
    args = parser.parse_args()

    if args.dir:
        object.__setattr__(settings, "model_dir", Path(args.dir))

    known = list(REPOS) + sorted(U2NET)
    if args.list or not args.models:
        print("Models:")
        for item in registry.describe():
            mark = "✓" if item["available"] else "·"
            source = REPOS.get(item["id"], ("rembg release, Apache-2.0", ""))[0]
            print(f"  {mark} {item['id']:<18} {item['label']:<24} {item['size_mb']:>5} MB  {source}")
        print("\nBiRefNet weights are MIT (ZhengPeng7 + onnx-community). U²-Net is Apache-2.0.")
        return 0

    targets = known if "all" in args.models else [m for m in args.models if m in known]
    unknown = [m for m in args.models if m not in known and m != "all"]
    if unknown:
        print(f"! unknown model ids: {', '.join(unknown)}")
    for model_id in targets:
        download(model_id, force=args.force)
    print("\nDone. Start the API with:  python -m uvicorn unbg_server.main:app --port 8000")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
