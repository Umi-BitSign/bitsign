"""Only the C5 translator (SHuBERT + ByT5), for answering live_features bodies.

SHuBERTInferenceRuntime also loads MediaPipe, both DINO embedders and the
video reader; Live computes those inputs in the browser, so its host needs
just the checkpoint, the tokenizer and the vendored model code. The attribute
names match SHuBERTInferenceRuntime so live_features.translate takes either.
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

DEFAULT_GENERATION_NUM_BEAMS = 5
DEFAULT_GENERATION_MAX_LENGTH = 2048


class TranslatorRuntime:
    def __init__(self, root: Path, device: str = "cpu") -> None:
        root = root.resolve()
        for path in (root / "vendor", root / "vendor/demo"):
            if str(path) not in sys.path:
                sys.path.insert(0, str(path))
        os.environ.setdefault("SHUBERT_DEVICE", device)
        import torch
        from inference import ByT5Tokenizer, SignLanguageByT5ForConditionalGeneration

        self.device = torch.device(device)
        self.generation_max_length = DEFAULT_GENERATION_MAX_LENGTH
        self.generation_num_beams = DEFAULT_GENERATION_NUM_BEAMS
        self.generation_length_penalty = None
        self.generation_no_repeat_ngram_size = None
        self._model_execution_slots = threading.BoundedSemaphore(1)
        self._translator = SignLanguageByT5ForConditionalGeneration.from_pretrained(
            str(root / "models/checkpoint-11625"), local_files_only=True
        )
        self._translator.to(self.device).eval()
        self._tokenizer = ByT5Tokenizer.from_pretrained(str(root / "models/byt5_base"), local_files_only=True)
