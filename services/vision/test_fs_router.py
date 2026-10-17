import unittest

import fs_router


class Stage1Tests(unittest.TestCase):
    def test_high_confidence_short_word_is_rejected(self) -> None:
        self.assertFalse(fs_router.stage1_accepts("hello", 0.99))

    def test_ten_chars_at_point_nine_wins(self) -> None:
        self.assertTrue(fs_router.stage1_accepts("abcdefghij", 0.9))

    def test_sixteen_chars_at_point_eighty_five_wins(self) -> None:
        self.assertTrue(fs_router.stage1_accepts("abcdefghijklmnop", 0.85))

    def test_sixteen_chars_just_under_threshold_loses(self) -> None:
        self.assertFalse(fs_router.stage1_accepts("abcdefghijklmnop", 0.84))

    def test_spaces_do_not_count_as_alnum(self) -> None:
        # Nine letters padded with spaces stay under the min_chars:10 gate.
        self.assertFalse(fs_router.stage1_accepts("a b c d e f g h i", 0.99))



class Stage2Tests(unittest.TestCase):
    def test_digit_short_baseline_can_defer_to_spelling(self) -> None:
        self.assertTrue(
            fs_router.stage2_accepts("room 12", "abcdefgh", 0.83)
        )

    def test_no_digit_keeps_baseline(self) -> None:
        self.assertFalse(
            fs_router.stage2_accepts("hello there", "abcdefgh", 0.99)
        )

    def test_long_baseline_is_not_overridden(self) -> None:
        self.assertFalse(
            fs_router.stage2_accepts("one two three four five six seven", "abcdefgh", 0.99)
        )


class ChooseTests(unittest.TestCase):
    def test_stage1_prefers_fingerspelling(self) -> None:
        chosen = fs_router.choose("something else", "abcdefghij", 0.95)
        self.assertEqual(chosen["path"], "fingerspelling")
        self.assertEqual(chosen["stage"], 1)
        self.assertEqual(chosen["english"], "abcdefghij")

    def test_stage2_after_baseline(self) -> None:
        chosen = fs_router.choose("bus 42", "abcdefgh", 0.84)
        self.assertEqual(chosen["path"], "fingerspelling")
        self.assertEqual(chosen["stage"], 2)

    def test_low_confidence_keeps_continuous(self) -> None:
        chosen = fs_router.choose("hello world", "abc", 0.5)
        self.assertEqual(chosen["path"], "continuous")
        self.assertEqual(chosen["stage"], 0)
        self.assertEqual(chosen["english"], "hello world")

    def test_empty_spelled_never_wins(self) -> None:
        chosen = fs_router.choose("hello", "", 0.99)
        self.assertEqual(chosen["path"], "continuous")
        self.assertEqual(chosen["english"], "hello")


class ConfigTests(unittest.TestCase):
    def test_shipped_config_loads_rc5_thresholds(self) -> None:
        cfg = fs_router.load_config()
        self.assertEqual(cfg["rules"][0]["threshold"], 0.9)
        self.assertEqual(cfg["rules"][1]["min_chars"], 16)
        overrides = fs_router.generation_overrides(cfg)
        self.assertEqual(overrides["length_penalty"], 0.6)
        self.assertEqual(overrides["no_repeat_ngram_size"], 16)


if __name__ == "__main__":
    unittest.main()
