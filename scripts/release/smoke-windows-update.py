"""Run from an interactive Windows desktop: python smoke-windows-update.py INSTALL_DIR TARGET_RESOURCES.

Exercises the packaged updater against a small HTTPS test release in a disposable install.
The two ASARs supply the real desktop main and renderer code. The test entry point isolates
the account profile and drives the application's Restart to Update menu command.
"""

import argparse
import errno
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import zipfile


def link_or_copy(source, destination):
    try:
        os.link(source, destination)
    except OSError as error:
        if error.errno != errno.EXDEV and getattr(error, "winerror", None) != 17:
            raise
        shutil.copyfile(source, destination)


def asar_version(asar):
    with asar.open("rb") as f:
        _, header_size, _, length = struct.unpack("<4I", f.read(16))
        entry = json.loads(f.read(length))["files"]["package.json"]
        f.seek(8 + header_size + int(entry["offset"]))
        return json.loads(f.read(entry["size"]))["version"]


def harness_asar(version):
    files = {
        "package.json": json.dumps(
            dict(name="claudex-update-smoke", version=version, main="entry.cjs")
        ).encode(),
        "entry.cjs": b'require(require("node:path").join(require("node:path").dirname(process.execPath),"control.cjs"));',
    }
    entries, payload = {}, bytearray()
    for name, data in files.items():
        entries[name] = dict(size=len(data), offset=str(len(payload)))
        payload.extend(data)
    header = json.dumps(dict(files=entries), separators=(",", ":")).encode()
    padded = header + bytes(-len(header) % 4)
    return (
        struct.pack("<4I", 4, 8 + len(padded), 4 + len(padded), len(header))
        + padded
        + payload
    )


def run(install, target, root, next_version):
    resources = root / "resources"
    resources.mkdir()
    for f in install.iterdir():
        if (
            f.is_file()
            and not f.name.startswith(".")
            and not f.name.lower().startswith("uninstall")
        ):
            link_or_copy(f, root / f.name)
    shutil.copytree(install / "locales", root / "locales", copy_function=link_or_copy)
    versions = []
    baseline = target if next_version else install / "resources"
    for label, directory in [("baseline", baseline), ("candidate", target)]:
        dest = root / (label + ".asar")
        link_or_copy(directory / "app.asar", dest)
        unpacked = directory / "app.asar.unpacked"
        if unpacked.exists():
            shutil.copytree(
                unpacked, Path(str(dest) + ".unpacked"), copy_function=link_or_copy
            )
        versions.append(asar_version(dest))
    old, new = versions
    new = next_version or new
    if tuple(map(int, new.split("."))) <= tuple(map(int, old.split("."))):
        raise ValueError("Supply a newer target release")
    (resources / "app.asar").write_bytes(harness_asar(old))
    keep = resources / "codex"
    keep.mkdir()
    (keep / "fixture").write_bytes(b"keep")
    keep_hash = hashlib.sha256(
        ("fixture\n" + hashlib.sha256(b"keep").hexdigest() + "\n").encode()
    ).hexdigest()
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("app.asar", harness_asar(new))
    archive = out.getvalue()
    seen = []

    class Feed(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            route = self.path.split("?")[0]
            if route == "/api/v1/claudex/release":
                data = json.dumps(
                    dict(
                        code=0,
                        message="success",
                        data={
                            "api_version": 1,
                            "channel": "stable",
                            "latest_version": new,
                            "state": "available",
                            "enforced": False,
                            "minimum_version": None,
                            "ui": None,
                            "download_url": base + "/setup.exe",
                            "sha256": "a" * 64,
                            "app_pack": dict(
                                url=base + "/app.zip",
                                sha256=hashlib.sha256(archive).hexdigest(),
                                runtime=runtime,
                                keep=keep_hash,
                            ),
                        },
                    )
                ).encode()
            elif route == "/app.zip":
                data = archive
            else:
                self.send_error(404)
                return
            seen.append(route)
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.send_header(
                "Content-Type",
                "application/json" if route != "/app.zip" else "application/zip",
            )
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    exe = root / "Claudex.exe"
    runtime = subprocess.check_output(
        [str(exe), "-p", "process.versions.electron"],
        env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"},
        text=True,
    ).strip()
    openssl = shutil.which("openssl") or str(
        Path(os.environ["ProgramFiles"]) / "Git/usr/bin/openssl.exe"
    )
    cert, key = root / "cert.pem", root / "key.pem"
    subprocess.run(
        [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-keyout",
            str(key),
            "-out",
            str(cert),
        ],
        stderr=subprocess.DEVNULL,
        check=True,
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Feed)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(cert, key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    base = "https://127.0.0.1:" + str(server.server_port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = root / "profile"
    profile.mkdir()
    (profile / "update-policy.json").write_text(
        json.dumps({"updatesHost": base}), encoding="utf-8"
    )
    (root / "smoke.json").write_text(json.dumps(dict(target=new)), encoding="utf-8")
    shutil.copyfile(
        Path(__file__).with_name("windows-update-smoke-host.cjs"), root / "control.cjs"
    )
    proc = subprocess.Popen(
        [str(exe)], env={**os.environ, "NODE_EXTRA_CA_CERTS": str(cert)}
    )
    try:
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            log = root / "events.jsonl"
            entries = (
                [
                    json.loads(s)
                    for s in log.read_text(encoding="utf-8").splitlines()
                    if s
                ]
                if log.exists()
                else []
            )
            events = [e["event"] for e in entries]
            launches = [entry for entry in entries if entry["event"] == "launch"]
            if len(launches) > 1 and launches[1]["version"] == old:
                raise RuntimeError("The updater reopened the old version")
            if "unexpected-error" in events:
                raise RuntimeError(entries[-1])
            if "new-window" in events:
                assert events == [
                    "launch",
                    "ready",
                    "handoff-failed",
                    "retry",
                    "launch",
                    "new-window",
                ], events
                assert all(e["pid"] == proc.pid for e in entries[:4])
                assert entries[-1]["pid"] != proc.pid and entries[-1]["version"] == new
                assert proc.wait(timeout=10) == 0
                assert (
                    "/api/v1/claudex/release" in seen and seen.count("/app.zip") == 1
                ), seen
                assert (keep / "fixture").read_bytes() == b"keep"
                result = json.loads(
                    (profile / "updates/apply-result.json").read_bytes()
                )
                assert result["ok"] and result["version"] == new, result
                print(
                    json.dumps(
                        dict(
                            previous=old, installed=new, events=entries, downloads=seen
                        ),
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                return
            time.sleep(0.5)
        raise TimeoutError(f"{entries!r}; HTTP {seen!r}")
    finally:
        server.shutdown()
        if proc.poll() is None:
            proc.terminate()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("install", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument(
        "--next-version",
        help="Offer a fixture version when validating a release as the source of its next update",
    )
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Requires an interactive Windows desktop with Explorer")
    directory = Path(tempfile.mkdtemp(prefix="Claudex update smoke "))
    print("Test installation:", directory, flush=True)
    run(args.install.resolve(), args.target.resolve(), directory, args.next_version)
    for attempt in range(20):
        try:
            shutil.rmtree(directory)
            break
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.5)
