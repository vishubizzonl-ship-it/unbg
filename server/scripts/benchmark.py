#!/usr/bin/env python3
"""Benchmark the engines: memory, speed, and quality — with numbers, not adjectives.

    python scripts/benchmark.py                      # silueta vs u2netp on a synthetic test card
    python scripts/benchmark.py photo.jpg product.jpg --models silueta,u2netp,birefnet-lite
    python scripts/benchmark.py photo.jpg --runs 5 --threads 4

Every model runs in its own subprocess, so the peak RSS reported is that model alone
(loading a 972 MB graph next to a 44 MB one would make the numbers meaningless).

Quality needs ground truth, so the first measurement uses a generated test card whose
alpha is known exactly (soft-edged subject + hair-like strands over a textured
background). Metrics: IoU at 0.5, mean absolute alpha error, and edge sharpness.
Real photos get coverage + timings only, because nobody can score them objectively.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

CARD = Path("bench-card.png")


# --------------------------------------------------------------------------- test card
def make_test_card(path: Path = CARD, size: tuple[int, int] = (900, 600)) -> tuple[Path, np.ndarray]:
    """Subject + strands over a noisy coloured background; returns the image and true alpha."""
    width, height = size
    yy, xx = np.mgrid[0:height, 0:width]
    rng = np.random.default_rng(7)

    background = np.zeros((height, width, 3), dtype=np.float32)
    background[..., 0] = 60 + 50 * np.sin(xx / 33.0)
    background[..., 1] = 110 + 40 * np.cos(yy / 41.0)
    background[..., 2] = 170 + rng.normal(0, 6, (height, width))

    cx, cy = width * 0.5, height * 0.55
    body = (((xx - cx) / (width * 0.20)) ** 2 + ((yy - cy) / (height * 0.32)) ** 2) < 1.0
    distance = np.sqrt(((xx - cx) / (width * 0.20)) ** 2 + ((yy - cy) / (height * 0.32)) ** 2)
    soft = np.clip((1.04 - distance) / 0.08, 0.0, 1.0)  # 8% soft edge, like real matting

    # hair-like strands: three whiskers with decreasing opacity
    for angle, length, opacity in ((-1.05, 0.34, 0.85), (-0.72, 0.30, 0.65), (2.4, 0.26, 0.5)):
        dx, dy = np.cos(angle), np.sin(angle)
        for t in np.linspace(0, length, 260):
            px = int(cx + dx * t * width)
            py = int(cy + dy * t * height)
            if 0 <= px < width and 0 <= py < height:
                falloff = 1.0 - t / length
                soft[max(0, py - 1) : py + 2, max(0, px - 1) : px + 2] = np.maximum(
                    soft[max(0, py - 1) : py + 2, max(0, px - 1) : px + 2], opacity * falloff
                )

    subject = np.zeros_like(background)
    subject[..., 0] = 235
    subject[..., 1] = 205
    subject[..., 2] = 175
    composed = subject * soft[..., None] + background * (1 - soft[..., None])
    Image.fromarray(np.clip(composed, 0, 255).astype(np.uint8)).save(path)
    return path, soft.astype(np.float32)


# --------------------------------------------------------------------------- metrics
def quality(pred: np.ndarray, truth: np.ndarray) -> dict:
    pred = np.clip(pred, 0.0, 1.0)
    truth = np.clip(truth, 0.0, 1.0)
    p_bin, t_bin = pred > 0.5, truth > 0.5
    inter = np.logical_and(p_bin, t_bin).sum()
    union = np.logical_or(p_bin, t_bin).sum()
    from PIL import ImageFilter

    gy_p, gx_p = np.gradient(pred)
    gy_t, gx_t = np.gradient(truth)
    eroded = np.asarray(
        Image.fromarray((t_bin * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))
    ) > 127
    edge = t_bin & ~eroded  # 1-pixel boundary of the true subject
    sharp_pred = float(np.hypot(gx_p, gy_p)[edge].mean()) if edge.any() else 0.0
    sharp_truth = float(np.hypot(gx_t, gy_t)[edge].mean()) if edge.any() else 0.0
    return {
        "iou": round(float(inter / union), 4) if union else 0.0,
        "alpha_mae": round(float(np.abs(pred - truth).mean()), 4),
        "edge_sharpness": round(sharp_pred, 4),
        "edge_sharpness_truth": round(sharp_truth, 4),
        "coverage": round(float(pred.mean()), 4),
    }


# --------------------------------------------------------------------------- worker
def worker(model_id: str, images: list[Path], runs: int, threads: int) -> dict:
    os.environ["UNBG_THREADS"] = str(threads)
    import resource

    from unbg_server import pipeline
    from unbg_server.engines import registry

    card, truth = make_test_card()
    engine = registry.get(model_id)
    if not engine.available():
        return {"model": model_id, "available": False}

    started = time.perf_counter()
    engine.load()
    load_ms = (time.perf_counter() - started) * 1000

    # speed on the real photo (or the card), engine only — no matting, no PNG encode
    target = images[0] if images else card
    rgb = np.asarray(Image.open(target).convert("RGB"), dtype=np.float32) / 255.0
    times, times_1pass = [], []
    supports_two = getattr(engine, "supports_second_pass", False)
    for _ in range(runs):
        started = time.perf_counter()
        engine.predict(rgb)
        times.append((time.perf_counter() - started) * 1000)
        if supports_two:
            started = time.perf_counter()
            engine.predict(rgb, second_pass=False)
            times_1pass.append((time.perf_counter() - started) * 1000)

    # quality on the card, through the real engine path
    card_rgb = np.asarray(Image.open(card).convert("RGB"), dtype=np.float32) / 255.0
    pred, meta = engine.predict(card_rgb)
    scores = quality(pred, truth)

    # what the user actually gets: mask + smoothstep + feather + decontamination
    from unbg_server import backgrounds, io_images, refine

    loaded = io_images.load(card.read_bytes())
    card_float = loaded.rgb.astype(np.float32) / 255.0
    raw, _ = engine.predict(card_float)
    refined, _ = refine.refine(raw, loaded.rgb, matte=False)
    scores_refined = quality(refined, truth)

    # whole pipeline on the real photo, so the reported number is what a user waits for
    pipeline_ms = {}
    coverage = {}
    for image in images:
        started = time.perf_counter()
        png, meta_full = pipeline.remove_background(
            image.read_bytes(), model=model_id, matte=False, decontaminate=True
        )
        out = Path("bench-out") / f"{image.stem}-{model_id}.png"
        out.parent.mkdir(exist_ok=True)
        out.write_bytes(png)
        pipeline_ms[image.name] = round((time.perf_counter() - started) * 1000, 1)
        coverage[image.name] = meta_full["coverage"]

    peak_rss_mb = int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024)
    return {
        "model": model_id,
        "available": True,
        "size_mb": engine.info.size_mb,
        "providers": getattr(engine, "runtime", {}).get("providers", []),
        "load_ms": round(load_ms, 1),
        "infer_ms_median": round(statistics.median(times), 1),
        "infer_ms_min": round(min(times), 1),
        "infer_ms_max": round(max(times), 1),
        "infer_ms_1pass": round(statistics.median(times_1pass), 1) if times_1pass else None,
        "pipeline_ms": pipeline_ms,
        "coverage": coverage,
        "quality": scores,
        "quality_refined": scores_refined,
        "second_pass": meta.get("second_pass"),
        "second_pass_gain": meta.get("second_pass_gain"),
        "peak_rss_mb": peak_rss_mb,
        "threads": threads,
    }


# --------------------------------------------------------------------------- parent
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="*")
    parser.add_argument("--models", default="silueta,u2netp")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--threads", type=int, default=0, help="0 = the server default")
    parser.add_argument("--worker")
    parser.add_argument("--json")
    args = parser.parse_args()

    images = [Path(p) for p in args.images]
    threads = args.threads or int(os.environ.get("UNBG_THREADS", max(1, (os.cpu_count() or 2) // 2)))

    if args.worker:
        result = worker(args.worker, images, args.runs, threads)
        Path(args.json).write_text(json.dumps(result))
        return 0

    rows = []
    for model_id in [m.strip() for m in args.models.split(",") if m.strip()]:
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as handle:
            out = Path(handle.name)
        cmd = [
            sys.executable,
            str(Path(__file__)),
            *[str(p) for p in images],
            "--worker",
            model_id,
            "--runs",
            str(args.runs),
            "--threads",
            str(threads),
            "--json",
            str(out),
        ]
        print(f"→ {model_id} …", flush=True)
        subprocess.run(cmd, check=False)
        if out.exists() and out.stat().st_size:
            rows.append(json.loads(out.read_text()))
        out.unlink(missing_ok=True)

    print(f"\nthreads={threads} · runs={args.runs} · host={os.cpu_count()} CPUs\n")
    header = (
        f"{'model':<18}{'MB':>6}{'load':>9}{'1 pass':>9}{'2 pass':>9}{'peak RSS':>10}"
        f"{'IoU':>8}{'IoU+':>8}{'αMAE':>8}"
    )
    print(header)
    print("-" * len(header))
    for row in rows:
        if not row.get("available"):
            print(f"{row['model']:<18}{'—':>6}{'not downloaded':>20}")
            continue
        q = row["quality"]
        qr = row.get("quality_refined", q)
        one = f"{row['infer_ms_1pass']:.0f}ms" if row.get("infer_ms_1pass") else "—"
        print(
            f"{row['model']:<18}{row['size_mb']:>6}"
            f"{row['load_ms']:>8.0f}ms{one:>9}"
            f"{row['infer_ms_median']:>8.0f}ms"
            f"{row['peak_rss_mb']:>8}MB"
            f"{q['iou']:>8.3f}{qr['iou']:>8.3f}{qr['alpha_mae']:>8.3f}"
        )
    print(f"\nground truth edge sharpness on the test card: {rows[0]['quality']['edge_sharpness_truth'] if rows else 0}")

    for row in rows:
        if not row.get("available"):
            continue
        print(f"\n{row['model']}:")
        for name, ms in row["pipeline_ms"].items():
            print(f"   full pipeline · {name}: {ms} ms (coverage {row['coverage'][name]})")
        if row.get("second_pass"):
            print(f"   second pass: {row['second_pass']} (gain {row.get('second_pass_gain')})")
        print(f"   providers: {row['providers']}")
    print("\ncutouts written to bench-out/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
