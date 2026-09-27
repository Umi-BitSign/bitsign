import json
import unittest
from pathlib import Path

from server import MODEL_ID, STILL_REASON, translate

ROOT = Path(__file__).resolve().parents[2]


class TranslateTests(unittest.TestCase):
    def test_stills_do_not_invent_english(self) -> None:
        result = translate({"source": "bitsign-vision", "frames": ["abcd"], "mime": "image/jpeg"})
        self.assertEqual(result["english"], "")
        self.assertEqual(result["model"], MODEL_ID)
        self.assertEqual(result["reason"], STILL_REASON)
        self.assertNotIn("I need help", json.dumps(result))

    def test_unusable_motion_does_not_invent_english(self) -> None:
        motion = [[0.0] * 1184 for _ in range(120)]
        mask = [1] + [0] * 119
        result = translate({"motion": motion, "frame_mask": mask})
        self.assertEqual(result["english"], "")
        self.assertEqual(result["model"], MODEL_ID)
        self.assertIn("did not return", result["reason"])

    def test_empty_burst_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            translate({"frames": []})

    def test_published_model_archive_is_present(self) -> None:
        archive = ROOT / "model" / "release" / "umi-s1-public-finetune-v1-portable.zip"
        card = (ROOT / "model" / "MODEL_CARD.md").read_text()
        self.assertTrue(archive.is_file())
        self.assertGreater(archive.stat().st_size, 1_000_000)
        self.assertIn(MODEL_ID, card)


if __name__ == "__main__":
    unittest.main()
