# pi-gui-openai-fast-mode

App-owned Pi extension for Pi GUI. When Fast mode is enabled, requests using
the official `openai` or `openai-codex` provider, plus GPT models routed through
the app-owned `vvqq-cpa` provider, are sent with `service_tier: "priority"`.

Pi GUI updates the current Session immediately through its app-owned internal
extension command. Each change is stored as a branch-aware Pi custom Session
entry, so it survives Runtime hibernation and application restarts without
entering LLM context. New Sessions default to disabled. Grok models under
`vvqq-cpa`, other providers, and disabled Sessions are left unchanged.
