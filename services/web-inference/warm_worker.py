"""Run the immutable C5 entrypoint repeatedly, retaining only its baseline model.

The entrypoint still owns router subprocess isolation, admission, fallback,
decoding overrides and stage 2. This adapter does not reproduce those decisions.
Its stdout is a private newline JSON protocol. The production client discards
stderr because native diagnostics may contain private upload paths or content.
"""

import importlib
import importlib.util
import inspect
import json
import os
import sys
import tempfile
import time
from pathlib import Path


class CachedRuntimeFactory:
    """Cache one identical runtime construction; never stack decoding wrappers."""

    def __init__(self, constructor):
        self.constructor = constructor
        self.signature = inspect.signature(constructor)
        self.arguments = None
        self.model = None
        self.generate = None

    def __call__(self, *args, **kwargs):
        bound = self.signature.bind(*args, **kwargs)
        bound.apply_defaults()
        arguments = dict(bound.arguments)
        if self.model is None:
            model = self.constructor(*args, **kwargs)
            self.generate = model._translator.generate
            self.arguments = arguments
            self.model = model
        elif arguments != self.arguments:
            raise RuntimeError("warm runtime construction arguments changed")
        # umi_inference.main installs its own per-request decoding overrides.
        # Restore the original bound method before it does so on a reused model.
        self.model._translator.generate = self.generate
        return self.model


class RepeatableInteropThreads:
    """Permit the entrypoint to reassert its already-established torch setting."""

    def __init__(self, torch):
        self.torch = torch
        self.original = torch.set_num_interop_threads
        self.established = None

    def __call__(self, count):
        if self.established is None:
            self.original(count)
            self.established = self.torch.get_num_interop_threads()
            return
        if (type(count) is not int or count != self.established
                or self.torch.get_num_interop_threads() != self.established):
            raise RuntimeError("warm runtime interop thread setting changed")


class WarmEntrypoint:
    def __init__(self, model_root):
        self.model_root = Path(model_root).resolve(strict=True)
        sys.path.insert(0, str(self.model_root))
        # Apply the pinned main's import-time environment before importing
        # torch/runtime here. main reasserts these same values on every call.
        os.environ["SHUBERT_DINOV2_SOURCE"] = str(self.model_root / "vendor/dinov2-source")
        os.environ["OMP_NUM_THREADS"] = "4"
        os.environ["MKL_NUM_THREADS"] = "4"
        os.environ["OPENBLAS_NUM_THREADS"] = "1"
        # This loads class definitions only. Stage-1 fingerspelling admissions
        # still avoid constructing or loading the baseline model entirely.
        torch = importlib.import_module("torch")
        torch.set_num_interop_threads = RepeatableInteropThreads(torch)
        runtime = importlib.import_module("runtime")
        self.runtime_factory = CachedRuntimeFactory(runtime.SHuBERTInferenceRuntime)
        runtime.SHuBERTInferenceRuntime = self.runtime_factory
        location = self.model_root / "umi_inference.py"
        spec = importlib.util.spec_from_file_location("bitsign_original_entrypoint", location)
        self.entrypoint = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.entrypoint)

    def translate(self, video):
        video = Path(video).resolve(strict=True)
        original_argv = sys.argv
        stdout_descriptor = sys.stdout.fileno()
        sys.stdout.flush()
        protocol_descriptor = os.dup(stdout_descriptor)
        try:
            with tempfile.TemporaryFile(mode="w+b") as result:
                # The original main duplicates stdout, redirects fd 1 to stderr,
                # then writes only its answer through the duplicate. Capture
                # that exact output rather than changing the model source.
                os.dup2(result.fileno(), stdout_descriptor)
                try:
                    sys.argv = [str(self.model_root / "umi_inference.py"), str(video)]
                    self.entrypoint.main()
                finally:
                    sys.stdout.flush()
                    os.dup2(protocol_descriptor, stdout_descriptor)
                result.seek(0)
                output = result.read(4097)
        finally:
            os.close(protocol_descriptor)
            sys.argv = original_argv
            # Original main adds its root per request; bound duplicates while
            # retaining vendor paths installed by the first baseline load.
            sys.path[:] = list(dict.fromkeys(sys.path))
        text = output.decode("utf-8").strip()
        if not text or len(output) > 4096:
            raise RuntimeError("model_output_invalid")
        return text


def main():
    model_root = Path(os.environ.get("BITSIGN_MODEL_ROOT", "/model"))
    os.chdir(model_root)
    # Import-time third-party prints are diagnostics too.
    sys.stdout.flush()
    protocol_descriptor = os.dup(sys.stdout.fileno())
    try:
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        try:
            entrypoint = WarmEntrypoint(model_root)
        finally:
            sys.stdout.flush()
            os.dup2(protocol_descriptor, sys.stdout.fileno())
    finally:
        os.close(protocol_descriptor)
    while True:
        line = sys.stdin.buffer.readline(16385)
        if not line:
            return
        started = time.monotonic()
        try:
            if len(line) > 16384 or not line.endswith(b"\n"):
                raise ValueError("request_invalid")
            request = json.loads(line)
            if (not isinstance(request, dict) or set(request) != {"videoPath"}
                    or not isinstance(request["videoPath"], str)):
                raise ValueError("request_invalid")
            text = entrypoint.translate(request["videoPath"])
            response = {"text": text, "elapsedSeconds": round(time.monotonic() - started, 3)}
        except Exception as error:
            print(json.dumps({"event": "model_execution_failed", "errorType": type(error).__name__}),
                  file=sys.stderr, flush=True)
            print(json.dumps({"error": "model_execution_failed"}), flush=True)
            # A failed model call may leave native state unusable. The client
            # starts a clean process on the next request.
            return
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"event": "model_worker_failed", "errorType": type(error).__name__}),
              file=sys.stderr, flush=True)
        sys.exit(1)
