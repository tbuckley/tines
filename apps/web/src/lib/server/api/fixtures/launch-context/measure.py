from importlib.metadata import version
import json
from pathlib import Path
import tiktoken

if version("tiktoken") != "0.14.0":
    raise SystemExit("install tiktoken==0.14.0 before measuring")

root = Path(__file__).parent
recorded = json.loads((root / "measurements.json").read_text())
encoder = tiktoken.get_encoding("o200k_base")

for section in ("opening", "retrieval_overhead"):
    for name, expected in recorded[section].items():
        data = (root / name).read_bytes()
        actual = {
            "bytes": len(data),
            "text_tokens": len(encoder.encode(data.decode("utf-8"))),
        }
        if actual != expected:
            raise SystemExit(f"{name}: expected {expected}, got {actual}")

print("launch-context measurements match measurements.json")
