#!/usr/bin/env python3
"""Prove the install actually works — on your machine, with the real weights.

    python scripts/selftest.py                        # synthetic portrait-ish test card
    python scripts/selftest.py photo.jpg --model birefnet-portrait
    python scripts/selftest.py photo.jpg --detail high --matte

It prints timings and mask statistics, then writes <photo>-cutout.png next to the input
so you can look at the result with your own eyes. Exit code 1 means something is wrong.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unbg_server import pipeline  # noqa: E402
from unbg_server.engines import registry  # noqa: E402


def test_card(path: Path, size=(900, 1200)) -> Path:
    """A stand-in subject: a soft-edged ellipse on a textured background."""
    width, height = size
    yy, xx = np.mgrid[0:height, 0:width]
    bg = np.zeros((height, width, 3), dtype=np.float32)
    bg[..., 0] = 90 + 40 * np.sin(xx / 40.0)
    bg[..., 1] = 120 + 30 * np.cos(yy / 55.0)
    bg[..., 2] = 200
    subject = ((yy - height / 2) ** 2 / (height / 3.2) ** 2 + (xx - width / 2) ** 2 / (width / 3.6) ** 2) < 1
    bg[subject] = (235, 200, 170)
    Image.fromarray(bg.astype(np.uint8)).save(path, quality=92)
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", nargs="?")
    parser.add_argument("--model", default=None)
    parser.add_argument("--detail", default="normal", choices=["normal", "high"])
    parser.add_argument("--matte", action="store_true", default=True)
    parser.add_argument("--no-matte", dest="matte", action="store_false")
    parser.add_argument("--background", default="transparent")
    args = parser.parse_args()

    source = Path(args.image) if args.image else test_card(Path("selftest-card.jpg"))
    data = source.read_bytes()

    print("installed models:")
    for item in registry.describe():
        print(f"  {'✓' if item['available'] else '·'} {item['id']:<18} {item['size_mb']:>5} MB  {item['license']}")

    chosen = args.model or next(
        (i["id"] for i in registry.describe() if i["available"] and i["id"] != "u2net"), None
    )
    if not chosen:
        print("\nNo BiRefNet weights found. Run: python scripts/fetch_models.py birefnet-512")
        return 1

    print(f"\nrunning {chosen} on {source} …")
    started = time.perf_counter()
    png, meta = pipeline.remove_background(
        data, model=chosen, detail=args.detail, matte=args.matte, background=args.background
    )
    elapsed = time.perf_counter() - started

    out = source.with_name(f"{source.stem}-cutout.png")
    out.write_bytes(png)
    image = Image.open(out)
    alpha = np.asarray(image.convert("RGBA"))[..., 3]
    print(f"  output      {image.width}x{image.height} {image.mode} → {out}")
    print(f"  coverage    {meta['coverage']:.1%} of pixels kept")
    print(f"  timings     {meta['timings']}")
    print(f"  wall clock  {elapsed:.2f}s")

    if meta["coverage"] < 0.01:
        print("\n✗ the mask is empty — wrong model file, or an inverted/odd export.")
        return 1
    if meta["coverage"] > 0.99:
        print("\n✗ the mask is everything — the subject was not separated.")
        return 1
    corner = int(alpha[: max(1, alpha.shape[0] // 20), : max(1, alpha.shape[1] // 20)].mean())
    middle = int(alpha[alpha.shape[0] // 2 - 20 : alpha.shape[0] // 2 + 20, alpha.shape[1] // 2 - 20 : alpha.shape[1] // 2 + 20].mean())
    print(f"  corner α    {corner}   centre α {middle}")
    if corner < 10 and middle > 200:
        print("\n✓ background removed, subject kept. Open the PNG to check the edges.")
        return 0
    print("\n~ mask looks unusual (corner/centre alpha). Open the PNG and check.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
