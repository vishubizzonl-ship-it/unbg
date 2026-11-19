"""ONNX Runtime plumbing shared by the concrete engines.

Keeping provider selection in one place means "GPU with CPU fallback" is one code path,
and so is the memory tuning (threads, arena, single session per model).
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

log = logging.getLogger("unbg.ort")

try:  # onnxruntime is a hard dependency, but a missing one must read clearly
    import onnxruntime as ort
except Exception as exc:  # pragma: no cover
    ort = None  # type: ignore[assignment]
    log.error("onnxruntime is not installed: %s", exc)


def providers(use_gpu: bool) -> list[str]:
    """Preferred providers, best first, always ending with CPU."""
    if ort is None:
        return ["CPUExecutionProvider"]
    available = set(ort.get_available_providers())
    chain: list[str] = []
    if use_gpu:
        for name in ("TensorrtExecutionProvider", "CUDAExecutionProvider", "ROCMExecutionProvider", "DmlExecutionProvider"):
            if name in available:
                chain.append(name)
    chain.append("CPUExecutionProvider")
    return chain


def describe_runtime() -> dict:
    if ort is None:
        return {"onnxruntime": None, "providers": []}
    return {
        "onnxruntime": ort.__version__,
        "providers": sorted(ort.get_available_providers()),
    }


class Session:
    """One loaded ONNX graph: input name, output name, and a `run` that fixes dtypes."""

    def __init__(self, path: Path, *, use_gpu: bool = True, threads: int = 2) -> None:
        if ort is None:
            raise RuntimeError("onnxruntime is not installed — pip install onnxruntime")
        if not path.exists():
            raise FileNotFoundError(path)
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, int(threads))
        options.inter_op_num_threads = 4
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.enable_mem_pattern = True
        # A fresh arena per request keeps peak RSS predictable on small boxes;
        # set UNBG_ORT_ARENA=1 to let ORT grow its arena for maximum throughput.
        import os as _os

        if _os.environ.get("UNBG_ORT_ARENA", "0") != "1":
            options.enable_cpu_mem_arena = False
        options.log_severity_level = 3
        self.path = path
        self.providers = providers(use_gpu)
        self.session = ort.InferenceSession(str(path), sess_options=options, providers=self.providers)
        self.input = self.session.get_inputs()[0]
        self.output = self.session.get_outputs()[0]
        self.input_name = self.input.name
        self.output_name = self.output.name
        self.size_mb = int(path.stat().st_size / 1_000_000)
        log.info("loaded %s (%s) providers=%s", path.name, self.input.shape, self.providers)

    @property
    def static_size(self) -> tuple[int, int] | None:
        """(width, height) when the graph was exported with fixed H/W, else None."""
        shape = self.input.shape
        if len(shape) == 4:
            h, w = shape[2], shape[3]
            if isinstance(h, int) and isinstance(w, int):
                return (w, h)
        return None

    def layout(self) -> str:
        shape = self.input.shape
        if len(shape) == 4 and str(shape[1]) == "3":
            return "nchw"
        if len(shape) == 4 and str(shape[3]) == "3":
            return "nhwc"
        return "nchw"

    def run(self, batch: np.ndarray) -> np.ndarray:
        outputs = self.session.run([self.output_name], {self.input_name: batch})
        return np.asarray(outputs[0], dtype=np.float32)
