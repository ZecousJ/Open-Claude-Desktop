from __future__ import annotations

from argparse import Namespace
from pathlib import Path

from provider_imagegen.http_client import FilePart
from provider_imagegen.validation import (
    validate_background,
    validate_compression,
    validate_count,
    validate_edit_files,
    validate_input_fidelity,
    validate_model_background,
    validate_model_input_fidelity,
    validate_moderation,
    validate_output_format,
    validate_quality,
    validate_size,
    validate_transparency,
)


def normalized_common_options(args: Namespace) -> dict:
    output_format = validate_output_format(args.output_format)
    background = validate_background(args.background)
    background = validate_model_background(args.model, background)
    validate_transparency(background, output_format)
    return {
        "model": args.model,
        "size": validate_size(args.size),
        "quality": validate_quality(args.quality),
        "n": validate_count(args.n),
        "background": background,
        "output_format": output_format,
        "output_compression": validate_compression(args.output_compression, output_format),
        "moderation": validate_moderation(args.moderation),
    }


def build_generation_payload(args: Namespace, prompt: str) -> dict:
    payload = normalized_common_options(args)
    payload["prompt"] = prompt
    return remove_empty_values(payload)


def build_edit_parts(args: Namespace, prompt: str) -> tuple[list[tuple[str, str]], list[FilePart]]:
    image_paths = [Path(path).expanduser().resolve() for path in args.image]
    mask_path = Path(args.mask).expanduser().resolve() if args.mask else None
    validate_edit_files(image_paths, mask_path)
    fields = common_fields(args, prompt)
    files = [FilePart("image[]", path) for path in image_paths]
    if mask_path:
        files.append(FilePart("mask", mask_path))
    return fields, files


def common_fields(args: Namespace, prompt: str) -> list[tuple[str, str]]:
    options = normalized_common_options(args)
    options["prompt"] = prompt
    input_fidelity = validate_input_fidelity(args.input_fidelity)
    options["input_fidelity"] = validate_model_input_fidelity(args.model, input_fidelity)
    normalized = remove_empty_values(options)
    return [(key, str(value)) for key, value in normalized.items()]


def remove_empty_values(payload: dict) -> dict:
    return {key: value for key, value in payload.items() if value is not None}
