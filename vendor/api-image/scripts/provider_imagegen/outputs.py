from __future__ import annotations

from datetime import datetime
from pathlib import Path

TIMESTAMP_FORMAT = "%Y%m%d-%H%M%S"


def resolve_base_path(out_arg: str | None) -> Path:
    if out_arg:
        base_path = Path(out_arg).expanduser()
    else:
        timestamp = datetime.now().strftime(TIMESTAMP_FORMAT)
        base_path = Path.cwd() / f"provider-image-{timestamp}.png"
    if base_path.suffix:
        return base_path.resolve()
    return base_path.with_suffix(".png").resolve()


def output_paths_for_response(
    base_path: Path,
    prompt_index: int,
    prompt_count: int,
    image_count: int,
) -> list[Path]:
    if prompt_count == 1 and image_count == 1:
        return [base_path]
    paths: list[Path] = []
    for image_index in range(image_count):
        paths.append(versioned_path(base_path, prompt_index, prompt_count, image_index, image_count))
    return paths


def versioned_path(
    base_path: Path,
    prompt_index: int,
    prompt_count: int,
    image_index: int,
    image_count: int,
) -> Path:
    parts: list[str] = []
    if prompt_count > 1:
        parts.append(f"p{prompt_index + 1}")
    if image_count > 1:
        parts.append(f"v{image_index + 1}")
    suffix = "-" + "-".join(parts) if parts else ""
    return base_path.with_name(f"{base_path.stem}{suffix}{base_path.suffix}")


def write_images(images: list[bytes], output_paths: list[Path]) -> list[Path]:
    if len(images) != len(output_paths):
        raise ValueError("Image count does not match output path count.")
    saved_paths: list[Path] = []
    for image_bytes, path in zip(images, output_paths, strict=True):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(image_bytes)
        saved_paths.append(path)
    return saved_paths
