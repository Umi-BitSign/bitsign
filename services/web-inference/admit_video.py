"""Decode or normalize one full clip inside a killable resource-bounded process."""

import hashlib
import json
import math
import os
import resource
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

MAX_SECONDS = 30.05
MAX_PIXELS = 350_000_000
MAX_FRAMES = 3600
MAX_NORMALIZED_AREA = 307_200


def fail(reason):
    raise ValueError(reason)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def probe(path, *, require_duration=True):
    result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=False)
    if result.returncode or len(result.stdout) > 1024 * 1024:
        fail("video_unreadable")
    value = json.loads(result.stdout)
    videos = [stream for stream in value.get("streams", []) if stream.get("codec_type") == "video"]
    if len(videos) != 1:
        fail("video_stream_count_unsupported")
    stream = videos[0]
    width, height = int(stream.get("width", 0)), int(stream.get("height", 0))
    if not 0 < width <= 7680 or not 0 < height <= 7680 or width * height > 7680 * 4320:
        fail("video_resolution_too_large")
    try:
        fps = float(Fraction(stream.get("avg_frame_rate", "0/1")))
        duration = float(stream.get("duration") or value.get("format", {}).get("duration") or "nan")
    except (ValueError, ZeroDivisionError):
        fail("video_timing_invalid")
    if not math.isfinite(fps) or not 0 < fps <= 240:
        fail("video_timing_invalid")
    if require_duration and (not math.isfinite(duration) or duration <= 0):
        fail("video_timing_invalid")
    if math.isfinite(duration) and duration > MAX_SECONDS:
        fail("video_too_long")
    if not math.isfinite(duration) or duration <= 0:
        duration = None
    return {"width": width, "height": height, "fps": fps, "durationSeconds": duration,
            "estimatedFrames": None if duration is None else max(1, math.ceil(duration * fps))}


def inspect(path, *, max_pixels=MAX_PIXELS, max_frames=MAX_FRAMES):
    import cv2
    capture = cv2.VideoCapture(str(path))
    try:
        fps = capture.get(cv2.CAP_PROP_FPS)
        if not capture.isOpened() or not math.isfinite(fps) or not 0 < fps <= 120:
            fail("video_timing_invalid")
        frames, pixels, width, height = 0, 0, 0, 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frames += 1
            h, w = frame.shape[:2]
            if not width:
                width, height = w, h
            if w != width or h != height:
                fail("video_dimensions_changed")
            pixels += w * h
            if frames > max_frames or pixels > max_pixels:
                return None
            if frames / fps > MAX_SECONDS:
                fail("video_too_long")
        if not frames:
            fail("video_unreadable")
        return {"width": width, "height": height, "frames": frames, "fps": fps,
                "durationSeconds": frames / fps, "decodedPixels": pixels}
    finally:
        capture.release()


def normalize(source, output):
    # No duration truncation, frame cutoff, or hand/face crop: the complete clip
    # is uniformly resized and resampled. Its output must pass full decode again.
    scale = "min(1,min(1280/max(iw,ih),sqrt(307200/(iw*ih))))"
    filters = f"scale=w='trunc(iw*{scale}/2)*2':h='trunc(ih*{scale}/2)*2',fps=30"
    result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-threads", "2", "-noautorotate", "-i", str(source),
        "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", filters, "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "23", "-pix_fmt", "yuv420p", "-threads", "2", "-movflags", "+faststart", str(output)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=100, check=False)
    if result.returncode or not output.is_file() or output.stat().st_size > 50 * 1024 * 1024:
        fail("video_optimization_failed")


def admit(source, output):
    metadata = probe(source, require_duration=False)
    timing_unknown = metadata["durationSeconds"] is None
    preinspected = None
    if timing_unknown:
        # Camera MediaRecorder WebM often has no seek index or duration. Scan
        # the complete source under the same hard deadline before converting;
        # preserve its bytes when its actual decoded count is already bounded.
        scanned = inspect(source, max_pixels=MAX_PIXELS, max_frames=MAX_FRAMES)
        if scanned is not None:
            metadata["durationSeconds"] = scanned["durationSeconds"]
            metadata["estimatedFrames"] = scanned["frames"]
            preinspected = scanned
        else:
            # With no declared duration, use a streamed tiny frame scan to prove
            # the whole source ends within the limit before optimization. The
            # process-group deadline still bounds malformed or stalled decoders.
            result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-threads", "2", "-noautorotate", "-i", str(source),
                "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "scale=2:2", "-vsync", "0", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=80, check=False)
            if result.returncode or len(result.stdout) % 4 or not result.stdout:
                fail("video_unreadable")
            frames = len(result.stdout) // 4
            duration = frames / metadata["fps"]
            if duration > MAX_SECONDS:
                fail("video_too_long")
            metadata["durationSeconds"] = duration
            metadata["estimatedFrames"] = frames
    estimated_pixels = metadata["width"] * metadata["height"] * metadata["estimatedFrames"]
    normalized = estimated_pixels > MAX_PIXELS or metadata["estimatedFrames"] > MAX_FRAMES or metadata["fps"] > 120
    details = None if normalized else preinspected or inspect(source)
    if details is None:
        normalize(source, output)
        probe(output)
        details = inspect(output)
        normalized = True
    if details is None:
        fail("video_decoded_budget_exceeded")
    if abs(details["durationSeconds"] - metadata["durationSeconds"]) > max(.15, 2 / metadata["fps"]):
        fail("video_duration_changed")
    selected = output if normalized else source
    return {"path": str(selected), "schema": "bitsign-video-admission/1", "normalized": normalized,
            "inputSha256": digest(source), "inferenceSha256": digest(selected),
            "inputBytes": source.stat().st_size, "inferenceBytes": selected.stat().st_size,
            "inputWidth": metadata["width"], "inputHeight": metadata["height"],
            "inputFps": metadata["fps"], "inputEstimatedFrames": metadata["estimatedFrames"],
            "inputDurationSeconds": metadata["durationSeconds"], "maximumDecodedPixels": MAX_PIXELS,
            "maximumFrames": MAX_FRAMES, **details}


if __name__ == "__main__":
    # This process and ffprobe/ffmpeg children share one killable process group.
    # The server also enforces a 120-second wall deadline for the whole group.
    # Linux x86 uses address-space limits directly; Docker Desktop's Rosetta
    # reserves a large virtual region before model-independent decoding begins.
    # The server's wall/group deadline and container memory cap remain active.
    if os.environ.get("BITSIGN_EMULATED_QUALIFICATION") != "1":
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_CPU, (110, 110))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024**2, 64 * 1024**2))
    try:
        response = admit(Path(sys.argv[1]), Path(sys.argv[2]))
    except ValueError as error:
        response = {"error": str(error)}
    except Exception as error:
        response = {"error": "video_admission_failed", "errorType": type(error).__name__}
    print(json.dumps(response), flush=True)
