"""Precision-gated fingerspelling router (rc5-compatible rules).

Confidence is the mean non-blank CTC emission probability from the letter head.
Stage 1 can pick fingerspelling before trusting the baseline. Stage 2 can still
override a short baseline answer that contains a digit when fingerspelling is
confident enough. Neither path invents text: the chosen component's own string
is returned unchanged.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "model" / "fs_router.json"

DEFAULT_RULES = (
    {"min_chars": 10, "threshold": 0.9},
    {"min_chars": 16, "threshold": 0.85},
)
DEFAULT_STAGE2 = {
    "enabled": True,
    "max_baseline_words": 6,
    "min_chars": 8,
    "min_confidence": 0.83,
}


def load_config(path: Path | None = None) -> dict[str, Any]:
    target = path or Path(
        __import__("os").environ.get("BITSIGN_FS_ROUTER", "").strip() or DEFAULT_CONFIG
    )
    if not target.is_file():
        return {
            "rules": [dict(rule) for rule in DEFAULT_RULES],
            "stage2": dict(DEFAULT_STAGE2),
            "baseline_generate_overrides": {
                "length_penalty": 0.6,
                "no_repeat_ngram_size": 16,
            },
        }
    raw = json.loads(target.read_text())
    if not isinstance(raw, dict):
        raise ValueError("fs_router.json must be an object")
    return raw


def alnum_count(text: str) -> int:
    """Letters and digits only, matching rc5's stage gates."""
    return sum(1 for char in text if char.isalnum())


def stage1_accepts(text: str, confidence: float, rules: list[dict[str, Any]] | None = None) -> bool:
    count = alnum_count(text)
    if count < 1 or confidence <= 0.0:
        return False
    for rule in rules or DEFAULT_RULES:
        try:
            min_chars = int(rule["min_chars"])
            threshold = float(rule["threshold"])
        except (KeyError, TypeError, ValueError):
            continue
        if count >= min_chars and confidence >= threshold:
            return True
    return False


def stage2_accepts(
    baseline: str,
    spelled: str,
    confidence: float,
    stage2: dict[str, Any] | None = None,
) -> bool:
    cfg = stage2 if isinstance(stage2, dict) else DEFAULT_STAGE2
    if not cfg.get("enabled", True):
        return False
    try:
        max_words = int(cfg.get("max_baseline_words", 6))
        min_chars = int(cfg.get("min_chars", 8))
        min_confidence = float(cfg.get("min_confidence", 0.83))
    except (TypeError, ValueError):
        return False
    words = [word for word in baseline.split() if word]
    if len(words) == 0 or len(words) > max_words:
        return False
    if not any(char.isdigit() for char in baseline):
        return False
    return alnum_count(spelled) >= min_chars and confidence >= min_confidence


def choose(
    baseline: str,
    spelled: str,
    confidence: float,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Pick continuous or fingerspelling. Empty spelled never wins."""
    cfg = config if isinstance(config, dict) else {}
    rules = cfg.get("rules")
    if not isinstance(rules, list):
        rules = list(DEFAULT_RULES)
    stage2 = cfg.get("stage2") if isinstance(cfg.get("stage2"), dict) else dict(DEFAULT_STAGE2)
    spelled = spelled.strip()
    baseline = baseline.strip()
    if spelled and stage1_accepts(spelled, confidence, rules):
        return {
            "path": "fingerspelling",
            "stage": 1,
            "english": spelled,
            "spelled": spelled,
            "baseline": baseline,
            "confidence": confidence,
        }
    if spelled and stage2_accepts(baseline, spelled, confidence, stage2):
        return {
            "path": "fingerspelling",
            "stage": 2,
            "english": spelled,
            "spelled": spelled,
            "baseline": baseline,
            "confidence": confidence,
        }
    return {
        "path": "continuous",
        "stage": 0,
        "english": baseline,
        "spelled": spelled,
        "baseline": baseline,
        "confidence": confidence,
    }


def generation_overrides(config: dict[str, Any] | None = None) -> dict[str, float | int]:
    cfg = config if isinstance(config, dict) else load_config()
    raw = cfg.get("baseline_generate_overrides")
    if not isinstance(raw, dict):
        raw = {"length_penalty": 0.6, "no_repeat_ngram_size": 16}
    out: dict[str, float | int] = {}
    if "length_penalty" in raw:
        out["length_penalty"] = float(raw["length_penalty"])
    if "no_repeat_ngram_size" in raw:
        out["no_repeat_ngram_size"] = int(raw["no_repeat_ngram_size"])
    if "num_beams" in raw:
        out["num_beams"] = int(raw["num_beams"])
    if "max_length" in raw:
        out["max_length"] = int(raw["max_length"])
    return out
