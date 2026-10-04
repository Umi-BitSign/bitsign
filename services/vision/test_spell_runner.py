import importlib
import sys
import types
import unittest
from unittest import mock

import server


def _runner() -> types.ModuleType:
    """Import spell_runner's decode helpers without its inference dependencies.

    spell_runner runs in the pinned runner's own interpreter, which has torch.
    This service's interpreter is standard library only, and the decode helpers
    are plain Python over the head's per-frame scores, so stubbing the imports
    they do not use is enough to test the part the request selects. A new
    module-level use of torch will break this import, which is the right
    signal: the decode is meant to stay dependency-free.
    """
    torch = types.ModuleType("torch")
    torch.nn = types.ModuleType("torch.nn")
    torch.nn.Module = type("Module", (), {})
    stubs = {"torch": torch, "torch.nn": torch.nn, "numpy": types.ModuleType("numpy")}
    with mock.patch.dict(sys.modules, stubs):
        return importlib.import_module("spell_runner")


spell_runner = _runner()


def _scores(word: str, blank_wins: bool = False) -> list[list[float]]:
    """One row per captured still, shaped like the head's log-softmax output.

    blank_wins is the realistic case for slow-spell: the head was trained on
    continuous video where most frames fall between letters, so blank often
    outscores the letter that is actually being held.
    """
    rows = []
    for letter in word:
        row = [-9.0] * (spell_runner.BLANK + 1)
        row[spell_runner.CHARS.index(letter)] = -0.2
        row[spell_runner.BLANK] = -0.05 if blank_wins else -8.0
        rows.append(row)
    return rows


def _greedy(rows: list[list[float]]) -> list[int]:
    """The continuous path's argmax, which includes the blank label."""
    return [max(range(len(row)), key=lambda label: row[label]) for row in rows]


class SlowSpellDecodeTests(unittest.TestCase):
    def test_a_double_letter_survives(self) -> None:
        self.assertEqual(spell_runner._per_letter(_scores("kelly")), "kelly")

    def test_the_continuous_path_would_have_eaten_the_double_letter(self) -> None:
        # Why slow-spell needs its own path rather than the existing one: with
        # one still per letter there is no blank frame between the two l's for
        # the collapse to break on.
        rows = _scores("kelly")
        self.assertEqual(spell_runner._collapse(_greedy(rows)), "kely")
        self.assertEqual(spell_runner._per_letter(rows), "kelly")

    def test_every_still_gives_back_exactly_one_letter(self) -> None:
        for word in ("kelly", "russell", "ab", "aaa"):
            rows = _scores(word)
            self.assertEqual(spell_runner._per_letter(rows), word)
            self.assertEqual(len(spell_runner._per_letter(rows)), len(rows))

    def test_a_held_letter_is_read_even_when_blank_outscores_it(self) -> None:
        rows = _scores("russell", blank_wins=True)
        self.assertEqual(spell_runner._collapse(_greedy(rows)), "")
        self.assertEqual(spell_runner._per_letter(rows), "russell")

    def test_the_answer_is_not_trimmed_so_letters_stay_in_position(self) -> None:
        rows = _scores(" ab ")
        self.assertEqual(spell_runner._per_letter(rows), " ab ")

    def test_the_continuous_collapse_is_unchanged(self) -> None:
        label = spell_runner.CHARS.index
        blank = spell_runner.BLANK
        # One letter held over several frames reads as one letter.
        self.assertEqual(spell_runner._collapse([label("h"), label("h"), blank, label("e")]), "he")
        # A genuine double letter there needs the blank between its two labels,
        # which is exactly what one still per letter cannot provide.
        self.assertEqual(
            spell_runner._collapse([label("l"), blank, label("l")]),
            "ll",
        )
        self.assertEqual(spell_runner._collapse([label("l"), label("l")]), "l")


class SpellModeTests(unittest.TestCase):
    def test_the_runner_and_the_service_name_the_modes_the_same_way(self) -> None:
        self.assertEqual(spell_runner.CONTINUOUS, server.SPELL_MODE_CONTINUOUS)
        self.assertEqual(spell_runner.SLOW_SPELL, server.SPELL_MODE_SLOW)
        self.assertEqual(spell_runner.SLOW_SPELL, "slow-spell")

    def test_the_label_set_leaves_the_blank_out_of_the_slow_spell_argmax(self) -> None:
        self.assertEqual(spell_runner.BLANK, len(spell_runner.CHARS))
        self.assertNotIn(spell_runner.BLANK, range(len(spell_runner.CHARS)))


if __name__ == "__main__":
    unittest.main()
