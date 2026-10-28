from __future__ import annotations

import base64
import json
import mimetypes
import uuid
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

CRLF = b"\r\n"
GENERATION_SUFFIX = "/images/generations"
EDIT_SUFFIX = "/images/edits"


@dataclass(frozen=True)
class FilePart:
    field_name: str
    path: Path


def open_url(target: str | urllib.request.Request, timeout: int | None):
    if timeout is None:
        return urllib.request.urlopen(target)
    return urllib.request.urlopen(target, timeout=timeout)


def post_json(url: str, api_key: str, payload: dict, timeout: int | None) -> dict:
    request = urllib.request.Request(
        url=url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    return read_json_response(request, timeout)


def post_multipart(
    url: str,
    api_key: str,
    fields: list[tuple[str, str]],
    files: list[FilePart],
    timeout: int | None,
) -> dict:
    boundary = f"----api-image-{uuid.uuid4().hex}"
    body = encode_multipart(fields, files, boundary)
    request = urllib.request.Request(
        url=url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    return read_json_response(request, timeout)


def read_json_response(request: urllib.request.Request, timeout: int | None) -> dict:
    try:
        with open_url(request, timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} from provider: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Failed to connect to provider: {exc.reason}") from exc


def encode_multipart(fields: list[tuple[str, str]], files: list[FilePart], boundary: str) -> bytes:
    chunks: list[bytes] = []
    boundary_bytes = f"--{boundary}".encode("ascii")
    for name, value in fields:
        chunks.extend([boundary_bytes, CRLF])
        chunks.extend([f'Content-Disposition: form-data; name="{name}"'.encode("utf-8"), CRLF])
        chunks.extend([CRLF, value.encode("utf-8"), CRLF])
    for file_part in files:
        chunks.extend(encode_file_part(file_part, boundary_bytes))
    chunks.extend([boundary_bytes, b"--", CRLF])
    return b"".join(chunks)


def encode_file_part(file_part: FilePart, boundary_bytes: bytes) -> list[bytes]:
    media_type = mimetypes.guess_type(file_part.path.name)[0] or "application/octet-stream"
    header = (
        f'Content-Disposition: form-data; name="{file_part.field_name}"; '
        f'filename="{file_part.path.name}"'
    )
    return [
        boundary_bytes,
        CRLF,
        header.encode("utf-8"),
        CRLF,
        f"Content-Type: {media_type}".encode("utf-8"),
        CRLF,
        CRLF,
        file_part.path.read_bytes(),
        CRLF,
    ]


def extract_images(response: dict, timeout: int | None) -> list[bytes]:
    data = response.get("data")
    if not isinstance(data, list) or not data:
        preview = json.dumps(response, ensure_ascii=False)
        raise ValueError(f"Provider response does not contain image data: {preview}")
    images = [fetch_image_bytes(item, timeout) for item in data]
    if not images:
        raise ValueError("Provider response contained no decodable images.")
    return images


def fetch_image_bytes(item: dict, timeout: int | None) -> bytes:
    b64_json = item.get("b64_json")
    if isinstance(b64_json, str) and b64_json:
        return base64.b64decode(b64_json)
    image_url = item.get("url")
    if isinstance(image_url, str) and image_url:
        with open_url(image_url, timeout) as response:
            return response.read()
    raise ValueError("Provider response item does not contain b64_json or url.")
