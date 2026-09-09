---
name: pi-gui-frontend
description: Apply and maintain the Pi GUI frontend guidelines when implementing or reviewing changes to src/renderer, frontend documentation, Renderer dependencies or validation scripts, or this skill in /home/vvv/Projects/pi-gui-next. Do not use for backend-only work.
---

# Pi GUI Frontend

Apply the project's current frontend language and ownership boundaries without creating a second design system or a second frontend specification.

## Establish the current boundary

1. Confirm the repository root is `/home/vvv/Projects/pi-gui-next`.
2. Inspect `git status --short` before editing and preserve unrelated dirty work.
3. Read `docs/frontend-guidelines.md` completely.
4. Read only the additional source needed for the task:
   - `docs/p2-workbench-structure.md` for Workbench structure, navigation, or layout.
   - `docs/architecture.md` and `docs/decisions.md` for Renderer ownership, state, security, content, or performance contracts.
   - `docs/development-plan.md` when the current scope or Slice affects the request.
5. Inspect the current owner code, styles, tests, and relevant task-owned diff instead of relying on remembered component inventories or older screenshots.

Treat dirty documentation and source as a local source snapshot, not committed fact. If an accepted decision conflicts with current documentation or implementation and no explicit supersession resolves it, report the conflict instead of silently choosing one side.

When a frontend rule genuinely changes, update `docs/frontend-guidelines.md`. Keep feature-specific product behavior in its owner documentation rather than copying it into this skill.

## Decide the owner before editing

- Keep domain UI and single-use behavior in `src/renderer/src/features/<domain>/`.
- Put behavior in `src/renderer/src/components/` only when at least two independent real call sites share the same interaction semantics, or when a clear cross-feature owner prevents duplication or dependency inversion.
- Do not style a shared component's internal DOM from feature CSS. Extend it through its current props or `className` boundary, and keep caller layout outside the component.
- Use `src/renderer/src/tokens.css` only for stable cross-feature visual semantics. Keep feature-local geometry with its feature owner.
- Keep `src/renderer/src/styles.css` limited to application baseline and genuinely global native-control, focus, disabled, and reduced-motion behavior.
- Keep the dependency direction `App/composition → features → components + renderer shared utilities`.
- Renderer consumes normalized state and sends narrow typed commands through preload; it does not infer backend truth or expose fake controls.

## Implement and review the change

- Inspect `src/renderer/src/components/` and reuse the current shared primitives only within their documented semantics.
- Use semantic typography, color, radius, and motion tokens. Do not duplicate an existing semantic token for a feature-local variant.
- Preserve current ownership and real layout clearance for floating Header, Composer, panel, and portal surfaces.
- Keep narrow-window behavior usable without horizontal overflow. Reuse the owner's current structural breakpoint before introducing a nearby one.
- Disabled controls must block the action, not only look disabled. Hover-revealed actions must also be discoverable and usable from keyboard focus.
- Preserve the applicable ARIA, keyboard, focus restoration, outside-click, hit-testing, nesting, and Escape behavior for custom interactive surfaces.
- Reuse the current shared modal and viewport-popover behavior instead of duplicating focus or positioning logic locally. Do not use an arbitrary larger `z-index` to hide a portal or interaction defect.
- Respect `prefers-reduced-motion`; animation must not be the only carrier of state.
- Use the current measurement owner for dynamic layout and scroll geometry. Do not use fixed timeouts to guess when layout has stabilized.
- Virtualize only when the current data boundary justifies it. Keep small collections on a simple rendering path, use stable item identity and bounded overscan, and preserve complete reading or copying when the surface requires it.
- For Markdown, links, attachments, incremental patches, Conversation history, and other architecture-owned content contracts, read the current documentation, implementation, and tests. Do not restate or change those contracts from memory.

Review the final task-owned diff:

- Global styles did not gain feature-specific variants.
- Shared components did not gain feature-specific state or feature CSS dependencies.
- No feature imports another feature's internals to bypass ownership.
- Pointer, keyboard, focus, disabled, portal, narrow-window, and reduced-motion paths remain coherent.
- Existing local changes outside the task remain intact.

After reviewing the final diff, check whether it makes any factual statement in this skill outdated. If not, finish. If it might, read the affected section and compare it with the current source and documentation. Only when the skill needs modification, read the complete current skill before updating it.

## Validate

For normal frontend source changes, run:

```bash
pnpm typecheck
pnpm build
git diff --check
```

Add relevant existing tests when the change affects an established interaction, accessibility, layout, motion, virtualization, or content contract.

Do not start the application or take screenshots unless the task requires real visual evidence or the user asks for it.

Report the changed frontend boundary, validation results, any skill synchronization needed, and unrelated blockers separately.
