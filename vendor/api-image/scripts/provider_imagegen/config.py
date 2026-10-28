from __future__ import annotations

import json
import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

AUTH_FILE_NAME = "auth.json"
CONFIG_FILE_NAME = "config.toml"
KEY_FIELD = "OPENAI_API_KEY"


@dataclass(frozen=True)
class ProviderConfig:
    api_key: str
    base_url: str
    codex_home: Path


def resolve_codex_home(explicit_path: str | None) -> Path:
    if explicit_path:
        return Path(explicit_path).expanduser().resolve()
    env_path = os.environ.get("CODEX_HOME")
    if env_path:
        return Path(env_path).expanduser().resolve()
    return (Path.home() / ".codex").resolve()


def load_json(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Missing required file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_toml(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"Missing required file: {path}")
    with path.open("rb") as handle:
        return tomllib.load(handle)


def load_provider_config(
    codex_home: Path,
    base_url_override: str | None = None,
    api_key_override: str | None = None,
    api_key_env: str | None = None,
) -> ProviderConfig:
    override_api_key = resolve_api_key_override(api_key_override, api_key_env)

    api_key = override_api_key
    if api_key is None:
        auth = load_json(codex_home / AUTH_FILE_NAME)
        api_key = auth.get(KEY_FIELD)
    if not api_key:
        raise ValueError(f"{KEY_FIELD} is missing in {codex_home / AUTH_FILE_NAME}")

    base_url = base_url_override
    if base_url is None:
        config = load_toml(codex_home / CONFIG_FILE_NAME)
        provider_name = config.get("model_provider")
        if not provider_name:
            raise ValueError(f"model_provider is missing in {codex_home / CONFIG_FILE_NAME}")
        providers = config.get("model_providers", {})
        provider = providers.get(provider_name)
        if not isinstance(provider, dict):
            raise ValueError(f"Provider '{provider_name}' is missing in {codex_home / CONFIG_FILE_NAME}")
        base_url = provider.get("base_url")
    if not isinstance(base_url, str) or not base_url.strip():
        raise ValueError("base_url is missing in config or --base-url.")
    return ProviderConfig(api_key=api_key, base_url=normalize_base_url(base_url), codex_home=codex_home)


def resolve_api_key_override(api_key_override: str | None, api_key_env: str | None) -> str | None:
    if api_key_override and api_key_env:
        raise ValueError("Use only one of --api-key or --api-key-env.")
    if api_key_override:
        api_key = api_key_override.strip()
        if not api_key:
            raise ValueError("--api-key must not be empty.")
        return api_key
    if api_key_env:
        env_name = api_key_env.strip()
        if not env_name:
            raise ValueError("--api-key-env must name a non-empty environment variable.")
        api_key = os.environ.get(env_name, "").strip()
        if not api_key:
            raise ValueError(f"Environment variable '{env_name}' is empty or not set.")
        return api_key
    return None


def normalize_base_url(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if not normalized:
        raise ValueError("--base-url must not be empty.")
    if not normalized.startswith(("http://", "https://")):
        raise ValueError("--base-url must start with http:// or https://.")
    return normalized
