import struct
import unittest

import numpy as np

import live_features as lf


def _streams(frames=60, seed=0):
    rng = np.random.default_rng(seed)
    face, left, right = (rng.normal(size=(frames, lf.EMBEDDING)).astype(np.float32) for _ in range(3))
    pose = rng.uniform(-1, 1, size=(frames, lf.POSE)).astype(np.float32)
    pose[3] = lf.MISSING
    return face, left, right, pose


class DecodeTests(unittest.TestCase):
    def test_round_trip_keeps_missing_marker_exact(self):
        face, left, right, pose = _streams()
        out = lf.decode(lf.encode(face, left, right, pose))
        np.testing.assert_array_equal(out["pose"], pose)
        self.assertTrue((out["pose"][3] == lf.MISSING).all())
        np.testing.assert_allclose(out["face"], face, atol=2e-3)
        self.assertEqual(out["left"].shape, (60, lf.EMBEDDING))

    def test_size_matches_spec(self):
        body = lf.encode(*_streams(frames=10))
        self.assertEqual(len(body), lf.expected_size(10))

    def test_rejects_wrong_magic(self):
        body = bytearray(lf.encode(*_streams()))
        body[:4] = b"NOPE"
        with self.assertRaises(lf.FeaturesError):
            lf.decode(bytes(body))

    def test_rejects_truncated_body(self):
        with self.assertRaises(lf.FeaturesError):
            lf.decode(lf.encode(*_streams())[:-1])

    def test_rejects_frame_counts_outside_limits(self):
        for frames in (1, lf.MAX_FRAMES + 1):
            body = lf.MAGIC + struct.pack("<I", frames)
            with self.assertRaises(lf.FeaturesError):
                lf.decode(body)

    def test_rejects_non_finite_and_out_of_range_pose(self):
        face, left, right, pose = _streams()
        face[0, 0] = np.inf
        with self.assertRaises(lf.FeaturesError):
            lf.decode(lf.encode(face, left, right, pose))
        face, left, right, pose = _streams()
        pose[0, 0] = 5000
        with self.assertRaises(lf.FeaturesError):
            lf.decode(lf.encode(face, left, right, pose))


if __name__ == "__main__":
    unittest.main()
