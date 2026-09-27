import base64
import json
import unittest
from pathlib import Path

from server import MISSING_WEIGHTS, MODEL_ID, translate

ROOT = Path(__file__).resolve().parents[2]
JPEG = base64.b64encode(b"\xff\xd8\xff\xd9").decode()


class TranslateTests(unittest.TestCase):
    def test_stills_do_not_invent_english_without_weights(self) -> None:
        result = translate(
            {"source": "bitsign-vision", "frames": [JPEG], "mime": "image/jpeg"},
            runner=Path("/tmp/bitsign-no-weights"),
        )
        self.assertEqual(result["english"], "")
        self.assertEqual(result["model"], MODEL_ID)
        self.assertEqual(result["reason"], MISSING_WEIGHTS)
        self.assertNotIn("I need help", json.dumps(result))

    def test_skeletal_tensors_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            translate({"motion": [[0.0] * 1184], "frame_mask": [1]})

    def test_empty_burst_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            translate({"frames": []})

    def test_non_jpeg_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            translate({"frames": [base64.b64encode(b"not-a-jpeg").decode()]}, runner=Path("/tmp/bitsign-no-weights"))

    def test_active_model_is_the_open_baseline(self) -> None:
        pin = json.loads((ROOT / "model" / "ACTIVE.json").read_text())
        self.assertEqual(MODEL_ID, "umi-community-baseline-v0.2")
        self.assertEqual(pin["id"], MODEL_ID)
        self.assertEqual(pin["archive"]["bytes"], 2934700086)
        self.assertEqual(
            pin["archive"]["sha256"],
            "f78979599486456e06e7886b126169f8d45e5e1e7d16d7a2b617648615eef3d4",
        )
        self.assertTrue((ROOT / pin["runner"] / "run.py").is_file())
        self.assertNotIn("umi-s1", MODEL_ID)


if __name__ == "__main__":
    unittest.main()
