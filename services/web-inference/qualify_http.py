"""Exercise actual container admission and optional genuine model inference."""

import argparse
import hashlib
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", default="http://127.0.0.1:8789")
    parser.add_argument("--video", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    results = {"schema": "bitsign-http-inference-qualification/1", "startedAtUtc": datetime.now(timezone.utc).isoformat(), "origin": args.origin, "checks": []}

    def request(path, *, data=None, content_type=None, expected=200):
        headers = {} if content_type is None else {"Content-Type": content_type}
        started = time.monotonic()
        try:
            response = urllib.request.urlopen(urllib.request.Request(args.origin + path, data=data, headers=headers), timeout=610)
        except urllib.error.HTTPError as error:
            response = error
        body = json.load(response)
        check = {"path": path, "status": response.status, "body": body, "elapsedSeconds": round(time.monotonic() - started, 3)}
        results["checks"].append(check)
        assert response.status == expected, check
        return body

    health = request("/health")
    assert health["ready"] is True
    request("/missing", expected=404)
    request("/translate", data=b"bad", content_type="text/plain", expected=415)
    request("/translate", data=b"", content_type="video/mp4", expected=413)
    request("/translate", data=b"invalid video bytes", content_type="video/mp4", expected=422)
    # A producer disconnects before sending its declared body. This must release
    # the one inference slot and remove the partial temporary input.
    parsed = urllib.parse.urlsplit(args.origin)
    with socket.create_connection((parsed.hostname, parsed.port or 80), timeout=10) as connection:
        connection.sendall(b"POST /translate HTTP/1.1\r\nHost: localhost\r\nContent-Type: video/mp4\r\nContent-Length: 1000\r\n\r\nshort")
        connection.shutdown(socket.SHUT_WR)
        response = b""
        while True:
            piece = connection.recv(4096)
            if not piece:
                break
            response += piece
        assert b"422" in response.split(b"\r\n", 1)[0] and b"upload_interrupted" in response
        results["checks"].append({"case": "interrupted_upload", "status": 422})
    if args.video:
        raw = args.video.read_bytes()
        result = request("/translate", data=raw, content_type="video/mp4")
        assert result["modelId"] == health["modelId"] and result["text"]
        results["video"] = {"name": args.video.name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
    args.output.write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps({"checks": len(results["checks"]), "output": str(args.output)}))


if __name__ == "__main__":
    main()
