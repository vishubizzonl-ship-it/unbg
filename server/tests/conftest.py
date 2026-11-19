import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

_TMP = Path(tempfile.mkdtemp(prefix="unbg-test-"))
os.environ.setdefault("UNBG_MODEL_DIR", str(_TMP / "models"))
os.environ.setdefault("UNBG_RESULT_DIR", str(_TMP / "results"))
os.environ.setdefault("UNBG_WARM", "0")  # never load a 1 GB graph during tests
os.environ.setdefault("UNBG_MATTE", "0")  # deterministic, fast
os.environ.setdefault("UNBG_MAX_UPLOAD_BYTES", str(2 * 1024 * 1024))
os.environ.setdefault("UNBG_MAX_PIXELS", str(2_000_000))
