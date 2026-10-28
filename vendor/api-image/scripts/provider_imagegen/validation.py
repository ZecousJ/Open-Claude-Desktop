from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

DEFAULT_COUNT = 1
DEFAULT_MODEL = "gpt-image-2"
DEFAULT_QUALITY = "high"
DEFAULT_SIZE = "2048x1152"
DEFAULT_TIMEOUT = 1800
EDIT_IMAGE_LIMIT = 16
MAX_ASPECT_RATIO = 3
MAX_EDGE = 3840
MAX_FILE_BYTES = 50 * 1024 * 1024
MIN_PIXEL_COUNT = 655_360
MAX_PIXEL_COUNT = 8_294_400
MULTIPLE_OF = 16
QUALITY_AUTO = "auto"
SIZE_AUTO = "auto"
SIZE_PATTERN = re.compile(r"^(?P<width>\d+)x(?P<height>\d+)$")
SUPPORTED_BACKGROUNDS = frozenset({"auto", "opaque", "transparent"})
SUPPORTED_FORMATS = frozenset({"png", "jpeg", "webp"})
SUPPORTED_INPUT_FIDELITY = frozenset({"low", "high"})
SUPPORTED_MODERATION = frozenset({"auto", "low"})
SUPPORTED_QUALITIES = frozenset({"low", "medium", "high", QUALITY_AUTO})


@dataclass(frozen=True)
class ImageInfo:
    format: str
    width: int
    height: int
    has_alpha: bool


def validate_timeout(timeout: int) -> int | None:
    if timeout < 0:
        raise ValueError("--timeout must be 0 or a positive integer.")
    return None if timeout == 0 else timeout


def validate_quality(quality: str) -> str:
    normalized = quality.strip().lower()
    if normalized in SUPPORTED_QUALITIES:
        return normalized
    choices = ", ".join(sorted(SUPPORTED_QUALITIES))
    raise ValueError(f"Unsupported --quality '{quality}'. Supported values: {choices}")


def validate_size(size: str) -> str:
    normalized = size.strip().lower()
    if normalized == SIZE_AUTO:
        return normalized
    match = SIZE_PATTERN.fullmatch(normalized)
    if not match:
        raise ValueError("Unsupported --size format. Use auto or a WxH value like 2048x2048.")
    return validate_dimensions(normalized, int(match.group("width")), int(match.group("height")))


def validate_dimensions(size: str, width: int, height: int) -> str:
    short_edge = min(width, height)
    long_edge = max(width, height)
    pixels = width * height
    if width % MULTIPLE_OF or height % MULTIPLE_OF:
        raise ValueError("--size width and height must both be multiples of 16.")
    if long_edge > MAX_EDGE:
        raise ValueError(f"--size exceeds the maximum edge of {MAX_EDGE}px.")
    if short_edge == 0 or long_edge / short_edge > MAX_ASPECT_RATIO:
        raise ValueError(f"--size aspect ratio must not exceed {MAX_ASPECT_RATIO}:1.")
    if pixels < MIN_PIXEL_COUNT or pixels > MAX_PIXEL_COUNT:
        raise ValueError(
            f"--size total pixels must be between {MIN_PIXEL_COUNT} and {MAX_PIXEL_COUNT}."
        )
    return size


def validate_background(background: str | None) -> str | None:
    if background is None:
        return None
    normalized = background.strip().lower()
    if normalized in SUPPORTED_BACKGROUNDS:
        return normalized
    choices = ", ".join(sorted(SUPPORTED_BACKGROUNDS))
    raise ValueError(f"Unsupported --background '{background}'. Supported values: {choices}")


def validate_model_background(model: str, background: str | None) -> str | None:
    if model.strip().lower() == DEFAULT_MODEL and background == "transparent":
        raise ValueError(
            "--background transparent is not supported by official gpt-image-2. "
            "Use auto or opaque, or choose a model/provider that explicitly supports transparency."
        )
    return background


def validate_output_format(output_format: str | None) -> str | None:
    if output_format is None:
        return None
    normalized = output_format.strip().lower()
    if normalized in SUPPORTED_FORMATS:
        return normalized
    choices = ", ".join(sorted(SUPPORTED_FORMATS))
    raise ValueError(f"Unsupported --output-format '{output_format}'. Supported values: {choices}")


def validate_compression(compression: int | None, output_format: str | None) -> int | None:
    if compression is None:
        return None
    if compression < 0 or compression > 100:
        raise ValueError("--output-compression must be between 0 and 100.")
    if output_format not in {"jpeg", "webp"}:
        raise ValueError("--output-compression is only valid with jpeg or webp output.")
    return compression


def validate_transparency(background: str | None, output_format: str | None) -> None:
    if background != "transparent":
        return
    if output_format not in {None, "png", "webp"}:
        raise ValueError("--background transparent requires png or webp output.")


def validate_input_fidelity(input_fidelity: str | None) -> str | None:
    if input_fidelity is None:
        return None
    normalized = input_fidelity.strip().lower()
    if normalized in SUPPORTED_INPUT_FIDELITY:
        return normalized
    choices = ", ".join(sorted(SUPPORTED_INPUT_FIDELITY))
    raise ValueError(f"Unsupported --input-fidelity '{input_fidelity}'. Supported values: {choices}")


def validate_model_input_fidelity(model: str, input_fidelity: str | None) -> str | None:
    if model.strip().lower() == DEFAULT_MODEL and input_fidelity is not None:
        raise ValueError(
            "--input-fidelity is not supported by official gpt-image-2; "
            "it always processes image inputs at high fidelity."
        )
    return input_fidelity


def validate_moderation(moderation: str | None) -> str | None:
    if moderation is None:
        return None
    normalized = moderation.strip().lower()
    if normalized in SUPPORTED_MODERATION:
        return normalized
    choices = ", ".join(sorted(SUPPORTED_MODERATION))
    raise ValueError(f"Unsupported --moderation '{moderation}'. Supported values: {choices}")


def validate_count(count: int) -> int:
    if count < DEFAULT_COUNT:
        raise ValueError("--n must be at least 1.")
    if count > 10:
        raise ValueError("--n must not exceed 10.")
    return count


def validate_edit_files(image_paths: list[Path], mask_path: Path | None) -> None:
    if len(image_paths) > EDIT_IMAGE_LIMIT:
        raise ValueError(f"--image supports at most {EDIT_IMAGE_LIMIT} files.")
    for path in image_paths:
        validate_input_file(path)
    if mask_path:
        validate_input_file(mask_path)
        if image_paths:
            validate_mask_compatibility(image_paths[0], mask_path)


def validate_input_file(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"Missing input file: {path}")
    if not path.is_file():
        raise ValueError(f"Input path is not a file: {path}")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError(f"Input file exceeds the 50 MB image API limit: {path}")


def validate_mask_compatibility(source_path: Path, mask_path: Path) -> None:
    source = inspect_image(source_path)
    mask = inspect_image(mask_path)
    if source.format != mask.format:
        raise ValueError(
            "--mask must use the same image format as the first --image edit target "
            f"({source.format}); got {mask.format}: {mask_path}"
        )
    if (source.width, source.height) != (mask.width, mask.height):
        raise ValueError(
            "--mask dimensions must match the first --image edit target "
            f"({source.width}x{source.height}); got {mask.width}x{mask.height}: {mask_path}"
        )
    if not mask.has_alpha:
        raise ValueError(f"--mask must include an alpha channel: {mask_path}")


def inspect_image(path: Path) -> ImageInfo:
    pillow_info = inspect_image_with_pillow(path)
    if pillow_info is not None:
        return pillow_info
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return inspect_png(data, path)
    if data.startswith(b"\xff\xd8\xff"):
        return inspect_jpeg(data, path)
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return inspect_webp(data, path)
    raise ValueError(f"Unsupported image format for image API input: {path}")


def inspect_image_with_pillow(path: Path) -> ImageInfo | None:
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError:
        return None
    try:
        with Image.open(path) as image:
            image_format = normalize_image_format(image.format or "")
            if image_format not in SUPPORTED_FORMATS:
                raise ValueError(f"Unsupported image format for image API input: {path}")
            has_alpha = "A" in image.getbands() or "transparency" in image.info
            return ImageInfo(image_format, image.width, image.height, has_alpha)
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Unable to inspect image file: {path}") from exc


def normalize_image_format(image_format: str) -> str:
    normalized = image_format.strip().lower()
    if normalized in {"jpg", "jpeg", "jpe"}:
        return "jpeg"
    return normalized


def inspect_png(data: bytes, path: Path) -> ImageInfo:
    if len(data) < 33 or data[12:16] != b"IHDR":
        raise ValueError(f"Invalid PNG image: {path}")
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    color_type = data[25]
    has_alpha = color_type in {4, 6} or png_has_transparency_chunk(data)
    return ImageInfo("png", width, height, has_alpha)


def png_has_transparency_chunk(data: bytes) -> bool:
    offset = 8
    while offset + 8 <= len(data):
        length = int.from_bytes(data[offset : offset + 4], "big")
        chunk_type = data[offset + 4 : offset + 8]
        offset += 8
        if chunk_type == b"tRNS":
            return True
        offset += length + 4
    return False


def inspect_jpeg(data: bytes, path: Path) -> ImageInfo:
    offset = 2
    sof_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    while offset + 4 < len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in {0x01, *range(0xD0, 0xD9)}:
            continue
        if offset + 2 > len(data):
            break
        segment_length = int.from_bytes(data[offset : offset + 2], "big")
        if marker in sof_markers and offset + 7 <= len(data):
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            return ImageInfo("jpeg", width, height, False)
        offset += segment_length
    raise ValueError(f"Unable to inspect JPEG dimensions: {path}")


def inspect_webp(data: bytes, path: Path) -> ImageInfo:
    offset = 12
    while offset + 8 <= len(data):
        chunk_type = data[offset : offset + 4]
        chunk_size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        payload = offset + 8
        if payload + chunk_size > len(data):
            break
        if chunk_type == b"VP8X" and chunk_size >= 10:
            flags = data[payload]
            width = read_uint24_le(data[payload + 4 : payload + 7]) + 1
            height = read_uint24_le(data[payload + 7 : payload + 10]) + 1
            return ImageInfo("webp", width, height, bool(flags & 0x10))
        if chunk_type == b"VP8 " and chunk_size >= 10:
            width = int.from_bytes(data[payload + 6 : payload + 8], "little") & 0x3FFF
            height = int.from_bytes(data[payload + 8 : payload + 10], "little") & 0x3FFF
            return ImageInfo("webp", width, height, False)
        if chunk_type == b"VP8L" and chunk_size >= 5:
            bits = int.from_bytes(data[payload + 1 : payload + 5], "little")
            width = (bits & 0x3FFF) + 1
            height = ((bits >> 14) & 0x3FFF) + 1
            has_alpha = bool((bits >> 28) & 0x01)
            return ImageInfo("webp", width, height, has_alpha)
        offset = payload + chunk_size + (chunk_size % 2)
    raise ValueError(f"Unable to inspect WebP dimensions: {path}")


def read_uint24_le(value: bytes) -> int:
    return int.from_bytes(value, "little")
