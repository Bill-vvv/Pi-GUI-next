# Codex Desktop for macOS: third-party platform

This setup follows the OpenAI Codex custom model-provider format. The platform
must expose an OpenAI-compatible Responses API; Chat Completions-only gateways
are not sufficient.

## One-click setup

1. Copy `install.command` to the Mac.
2. In Terminal, run `chmod +x install.command` once.
3. Double-click `install.command` in Finder.
4. Enter the platform base URL, model ID, and API key.
5. Fully quit Codex Desktop with Command-Q, then reopen it.

The installer backs up an existing `~/.codex/config.toml`, preserves unrelated
settings, stores the API key in macOS Keychain, and writes the provider to the
user-level config. It can be rerun to change the endpoint, model, or key.

`config.toml` is the equivalent manual template. Replace all placeholder values
before using it.

Official references:

- https://developers.openai.com/codex/config-advanced#custom-model-providers
- https://developers.openai.com/codex/config-reference#configtoml
