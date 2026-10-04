import base64
import contextlib
import json
import unittest
from pathlib import Path
from unittest import mock

import server
from server import (
    CONSENT_SCOPE,
    MAX_SLOW_SPELL_FRAMES,
    MISSING_SPELL_HEAD,
    MISSING_WEIGHTS,
    MODEL_ID,
    SPELL_MODE_CONTINUOUS,
    SPELL_MODE_SLOW,
    SPELL_MODEL_ID,
    TOO_FEW_LETTERS,
    fingerspell,
    spell_head,
    spell_head_ready,
    translate,
)

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
HEAD = Path(__file__).resolve()
JPEG = base64.b64encode(b"\xff\xd8\xff\xd9").decode()
CONSENT = {"granted": True, "scope": CONSENT_SCOPE, "session": "test-session"}
NO_WEIGHTS = Path("/tmp/bitsign-no-weights")


def slow_payload(letters: int = 5, **extra: object) -> dict:
    """One still per letter, with the mode the phone sends for slow-spell."""
    return {
        "frames": [JPEG] * letters,
        "mime": "image/jpeg",
        "mode": SPELL_MODE_SLOW,
        "consent": CONSENT,
        **extra,
    }


@contextlib.contextmanager
def installed(letters: str, frames: int):
    """Stand in for an install this machine does not have.

    The baseline weights are a 2.9 GB optional download, the letter head is
    never committed and the runner's venv is not built, so all three readiness
    gates are satisfied here to get at the decode the request selected.
    VENV_PYTHON is pointed at this test file so the gate finds a real file
    under the runner root that callers pass as HERE.
    """
    with mock.patch.object(server, "weights_ready", return_value=True), mock.patch.object(
        server, "VENV_PYTHON", Path(Path(__file__).name)
    ), mock.patch.object(server, "_spelled_letters", return_value=(letters, frames)) as call:
        yield call


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


class FingerspellTests(unittest.TestCase):
    def test_a_burst_without_consent_is_not_read(self) -> None:
        result = fingerspell({"frames": [JPEG], "mime": "image/jpeg"}, runner=NO_WEIGHTS)
        self.assertEqual(result["error"], "consent_required")
        self.assertEqual(result["spelled"], "")
        self.assertEqual(result["english"], "")

    def test_partial_consent_is_not_consent(self) -> None:
        for consent in (
            {"granted": False, "scope": CONSENT_SCOPE, "session": "s"},
            {"granted": True, "scope": "corpus", "session": "s"},
            {"granted": True, "scope": CONSENT_SCOPE, "session": "  "},
            {"granted": True, "scope": CONSENT_SCOPE},
            "yes",
        ):
            result = fingerspell({"frames": [JPEG], "consent": consent}, runner=NO_WEIGHTS)
            self.assertEqual(result["error"], "consent_required", consent)

    def test_a_request_to_keep_the_burst_is_rejected(self) -> None:
        for extra in ({"retain": True}, {"corpus": "signrush"}):
            with self.assertRaises(ValueError):
                fingerspell({"frames": [JPEG], "consent": CONSENT, **extra}, runner=NO_WEIGHTS)

    def test_every_answer_says_the_burst_was_not_kept(self) -> None:
        result = fingerspell({"frames": [JPEG], "consent": CONSENT}, runner=NO_WEIGHTS)
        self.assertFalse(result["retained"])
        self.assertTrue(result["provisional"])
        self.assertEqual(result["model"], SPELL_MODEL_ID)

    def test_a_missing_head_is_a_structured_answer_not_a_crash(self) -> None:
        # The baseline weights are a 2.9 GB optional install, so the encoder has
        # to be assumed present to say anything about the head alone.
        with mock.patch.object(server, "weights_ready", return_value=True):
            result = fingerspell(
                {"frames": [JPEG], "consent": CONSENT},
                runner=NO_WEIGHTS,
                head=Path("/tmp/bitsign-no-spell-head.pt"),
            )
        self.assertEqual(result["error"], "spell_head_missing")
        self.assertEqual(result["reason"], MISSING_SPELL_HEAD)
        self.assertEqual(result["spelled"], "")

    def test_missing_weights_are_reported_before_the_head(self) -> None:
        result = fingerspell({"frames": [JPEG], "consent": CONSENT}, runner=NO_WEIGHTS)
        self.assertEqual(result["error"], "weights_missing")
        self.assertEqual(result["reason"], MISSING_WEIGHTS)

    def test_a_bad_burst_is_rejected_the_way_translate_rejects_it(self) -> None:
        with self.assertRaises(ValueError):
            fingerspell({"frames": [], "consent": CONSENT})
        with self.assertRaises(ValueError):
            fingerspell({"frames": [base64.b64encode(b"not-a-jpeg").decode()], "consent": CONSENT})

    def test_the_head_path_is_configurable_and_absent_here(self) -> None:
        self.assertEqual(spell_head(Path("/tmp/elsewhere.pt")), Path("/tmp/elsewhere.pt"))
        self.assertEqual(spell_head().name, "spell_head_fsboard.pt")
        self.assertFalse(spell_head_ready(Path("/tmp/bitsign-no-spell-head.pt")))

    def test_the_continuous_route_does_not_require_consent(self) -> None:
        result = translate({"frames": [JPEG]}, runner=NO_WEIGHTS)
        self.assertEqual(result["model"], MODEL_ID)
        self.assertEqual(result["reason"], MISSING_WEIGHTS)

    def test_a_burst_without_a_mode_is_still_the_continuous_burst(self) -> None:
        result = fingerspell({"frames": [JPEG], "consent": CONSENT}, runner=NO_WEIGHTS)
        self.assertEqual(result["mode"], SPELL_MODE_CONTINUOUS)
        self.assertNotIn("letters", result)


class SlowSpellTests(unittest.TestCase):
    """One still per deliberately held letter, selected by the request."""

    def test_the_mode_comes_off_the_request_and_is_echoed_back(self) -> None:
        result = fingerspell(slow_payload(), runner=NO_WEIGHTS)
        self.assertEqual(result["mode"], SPELL_MODE_SLOW)

    def test_an_unknown_mode_is_rejected(self) -> None:
        for mode in ("fast", "", "slow_spell", 1, True, []):
            with self.assertRaises(ValueError, msg=mode):
                fingerspell(slow_payload(mode=mode), runner=NO_WEIGHTS)

    def test_the_answer_is_positional_so_one_letter_can_be_fixed(self) -> None:
        with installed("kelly", 5):
            result = fingerspell(slow_payload(), runner=HERE, head=HEAD)
        self.assertEqual(result["spelled"], "kelly")
        self.assertEqual(result["letters"], ["k", "e", "l", "l", "y"])

    def test_a_double_letter_reaches_the_phone_intact(self) -> None:
        with installed("russell", 7):
            result = fingerspell(slow_payload(letters=7), runner=HERE, head=HEAD)
        self.assertEqual(result["spelled"], "russell")
        self.assertEqual(result["letters"].count("s"), 2)
        self.assertEqual(result["letters"].count("l"), 2)

    def test_the_runner_is_told_which_decode_to_use(self) -> None:
        with installed("ab", 2) as spelled:
            fingerspell(slow_payload(letters=2), runner=HERE, head=HEAD)
        self.assertEqual(spelled.call_args.args[3], SPELL_MODE_SLOW)
        with installed("ab", 2) as spelled:
            fingerspell({"frames": [JPEG] * 2, "consent": CONSENT}, runner=HERE, head=HEAD)
        self.assertEqual(spelled.call_args.args[3], SPELL_MODE_CONTINUOUS)

    def test_a_space_label_is_not_trimmed_out_of_position(self) -> None:
        with installed(" ab", 3):
            result = fingerspell(slow_payload(letters=3), runner=HERE, head=HEAD)
        self.assertEqual(result["letters"], [" ", "a", "b"])

    def test_nothing_legible_is_not_an_answer(self) -> None:
        with installed("   ", 3):
            result = fingerspell(slow_payload(letters=3), runner=HERE, head=HEAD)
        self.assertEqual(result["error"], "no_letters")
        self.assertEqual(result["spelled"], "")

    def test_one_letter_is_too_few_to_read(self) -> None:
        result = fingerspell(slow_payload(letters=1), runner=NO_WEIGHTS)
        self.assertEqual(result["error"], "too_few_letters")
        self.assertEqual(result["reason"], TOO_FEW_LETTERS)
        self.assertEqual(result["spelled"], "")

    def test_a_word_longer_than_the_ceiling_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            fingerspell(slow_payload(letters=MAX_SLOW_SPELL_FRAMES + 1), runner=NO_WEIGHTS)

    def test_slow_spell_goes_through_the_same_consent_gate(self) -> None:
        payload = slow_payload()
        del payload["consent"]
        result = fingerspell(payload, runner=NO_WEIGHTS)
        self.assertEqual(result["error"], "consent_required")
        self.assertEqual(result["mode"], SPELL_MODE_SLOW)
        self.assertEqual(result["spelled"], "")

    def test_slow_spell_may_not_be_retained_or_sent_to_the_corpus(self) -> None:
        for extra in ({"retain": True}, {"corpus": "signrush"}):
            with self.assertRaises(ValueError):
                fingerspell(slow_payload(**extra), runner=NO_WEIGHTS)

    def test_every_slow_spell_answer_says_the_stills_were_not_kept(self) -> None:
        with installed("kelly", 5):
            result = fingerspell(slow_payload(), runner=HERE, head=HEAD)
        self.assertFalse(result["retained"])
        self.assertTrue(result["provisional"])
        self.assertEqual(result["model"], SPELL_MODEL_ID)

    def test_no_accuracy_figure_is_offered_to_the_wearer(self) -> None:
        with installed("kelly", 5):
            answer = json.dumps(fingerspell(slow_payload(), runner=HERE, head=HEAD))
        self.assertNotIn("40.54", answer)
        self.assertNotIn("%", answer)


if __name__ == "__main__":
    unittest.main()
