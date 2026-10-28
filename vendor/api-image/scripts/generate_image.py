from __future__ import annotations

import argparse
import sys
from pathlib import Path

from provider_imagegen.config import load_provider_config, resolve_codex_home
from provider_imagegen.http_client import EDIT_SUFFIX, GENERATION_SUFFIX, extract_images, post_json, post_multipart
from provider_imagegen.outputs import output_paths_for_response, resolve_base_path, write_images
from provider_imagegen.payloads import build_edit_parts, build_generation_payload
from provider_imagegen.validation import (
    DEFAULT_COUNT,
    DEFAULT_MODEL,
    DEFAULT_QUALITY,
    DEFAULT_SIZE,
    DEFAULT_TIMEOUT,
    validate_timeout,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate or edit images using the provider configured in the user's Codex root."
    )
    parser.add_argument("--prompt", help="Image prompt.")
    parser.add_argument("--prompt-file", help="UTF-8 text file with one prompt per non-empty line.")
    parser.add_argument("--out", help="Output file path. Defaults to the current directory.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Image model name.")
    parser.add_argument("--mode", choices=["auto", "generate", "edit"], default="auto")
    parser.add_argument("--size", default=DEFAULT_SIZE, help="auto or a valid WxH value.")
    parser.add_argument("--quality", default=DEFAULT_QUALITY, help="low, medium, high, or auto.")
    parser.add_argument("--n", type=int, default=DEFAULT_COUNT, help="Number of images per prompt.")
    parser.add_argument("--image", action="append", default=[], help="Reference/edit image path.")
    parser.add_argument("--image-role", action="append", default=[], help="Role label for an image.")
    parser.add_argument("--mask", help="Mask image path for localized edits.")
    parser.add_argument(
        "--background",
        help="Background mode. Use auto or opaque for gpt-image-2; transparent is model/provider-specific.",
    )
    parser.add_argument("--output-format", help="png, jpeg, or webp.")
    parser.add_argument("--output-compression", type=int, help="0-100, only for jpeg/webp.")
    parser.add_argument(
        "--input-fidelity",
        help="low or high for supported edit models. Do not use with gpt-image-2.",
    )
    parser.add_argument("--moderation", help="auto or low for supported GPT image models.")
    parser.add_argument("--codex-home", help="Override Codex root directory.")
    parser.add_argument("--base-url", help="Temporarily override the configured provider base_url.")
    parser.add_argument(
        "--api-key-env",
        help="Environment variable containing a temporary API key override. Preferred over --api-key.",
    )
    parser.add_argument(
        "--api-key",
        help="Temporary API key override. Prefer --api-key-env to avoid putting secrets in command text.",
    )
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="0 disables client timeout.")
    return parser.parse_args()


def load_prompts(prompt: str | None, prompt_file: str | None) -> list[str]:
    if bool(prompt) == bool(prompt_file):
        raise ValueError("Use exactly one of --prompt or --prompt-file.")
    if prompt:
        return [prompt]
    path = Path(prompt_file).expanduser()
    # Claudex: the whole file is one prompt, so the multi-line structured
    # prompt SKILL.md recommends stays together (one prompt per line sent its
    # "Use case:" line alone and drew an unrelated picture). Several prompts
    # are separated by a line holding only "---".
    blocks: list[list[str]] = [[]]
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() == "---":
            blocks.append([])
        else:
            blocks[-1].append(line)
    prompts = ["\n".join(block).strip() for block in blocks]
    prompts = [prompt for prompt in prompts if prompt]
    if not prompts:
        raise ValueError(f"Prompt file contains no prompts: {path}")
    return prompts


def apply_image_roles(prompt: str, image_roles: list[str], image_count: int) -> str:
    if not image_roles:
        return prompt
    if len(image_roles) > image_count:
        raise ValueError("--image-role count must not exceed --image count.")
    lines = ["", "Input image roles:"]
    for index, role in enumerate(image_roles, start=1):
        lines.append(f"Image {index}: {role}")
    return prompt + "\n" + "\n".join(lines)


def determine_mode(args: argparse.Namespace) -> str:
    if args.mode != "auto":
        return args.mode
    if args.image or args.mask:
        return "edit"
    return "generate"


def validate_mode(args: argparse.Namespace, mode: str) -> None:
    if mode == "edit" and not args.image:
        raise ValueError("Edit/reference mode requires at least one --image.")
    if mode == "generate" and (args.image or args.mask):
        raise ValueError("--image and --mask require edit mode or auto mode.")


def request_images(args: argparse.Namespace, prompt: str, mode: str, timeout: int | None) -> list[bytes]:
    codex_home = resolve_codex_home(args.codex_home)
    provider = load_provider_config(
        codex_home,
        base_url_override=args.base_url,
        api_key_override=args.api_key,
        api_key_env=args.api_key_env,
    )
    if mode == "edit":
        fields, files = build_edit_parts(args, prompt)
        response = post_multipart(f"{provider.base_url}{EDIT_SUFFIX}", provider.api_key, fields, files, timeout)
    else:
        payload = build_generation_payload(args, prompt)
        response = post_json(f"{provider.base_url}{GENERATION_SUFFIX}", provider.api_key, payload, timeout)
    return extract_images(response, timeout)


def main() -> int:
    args = parse_args()
    timeout = validate_timeout(args.timeout)
    mode = determine_mode(args)
    validate_mode(args, mode)
    prompts = load_prompts(args.prompt, args.prompt_file)
    base_path = resolve_base_path(args.out)
    for prompt_index, raw_prompt in enumerate(prompts):
        prompt = apply_image_roles(raw_prompt, args.image_role, len(args.image))
        print(f"Waiting for provider image {mode} job {prompt_index + 1}/{len(prompts)}...", file=sys.stderr)
        images = request_images(args, prompt, mode, timeout)
        output_paths = output_paths_for_response(base_path, prompt_index, len(prompts), len(images))
        for path in write_images(images, output_paths):
            print(path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
