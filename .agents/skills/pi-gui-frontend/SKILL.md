---
name: pi-gui-frontend
description: Apply the Pi GUI frontend guidelines when implementing or reviewing any task that touches src/renderer in /home/vvv/Projects/pi-gui-next, including React/TSX/CSS, tokens, icons, typography, components, layout, responsive behavior, interaction, or accessibility. Do not use for backend-only work.
---

# Pi GUI Frontend

Apply the project's established frontend language and library boundaries without creating a second design system.

## Establish the current boundary

1. Confirm the repository root is `/home/vvv/Projects/pi-gui-next`.
2. Inspect `git status --short` before editing. Preserve unrelated dirty work.
3. Read `docs/frontend-guidelines.md` completely. Treat it as the frontend specification and library fact source.
4. Read only the additional source needed for the task:
   - `docs/p2-workbench-structure.md` for Navigator, Header, Timeline, Composer, navigation, or layout work.
   - `docs/architecture.md` and `docs/decisions.md` when Renderer ownership, state facts, security, attachments, Markdown, or performance is involved.
   - `docs/development-plan.md` when scope or current Slice status affects the requested change.
5. Inspect the exact components and styles to be changed. Prefer current observed code over assumptions from older screenshots or repositories.

If the documents conflict, follow the current non-superseded architecture decision and the current implementation boundary, then update `docs/frontend-guidelines.md` in the same change when the frontend rule genuinely changes.

## Decide the owner before editing

- Keep domain UI and single-use behavior in `src/renderer/src/features/<domain>/`.
- Put an element in `src/renderer/src/components/` only when it has at least two independent real call sites with matching interaction semantics, or when a clear cross-feature owner prevents duplication or dependency inversion.
- Use `src/renderer/src/tokens.css` only for stable cross-feature visual semantics. Do not create a feature-local palette, icon scale, typography scale, or near-duplicate token; keep one-off grid/spacing geometry with its feature owner.
- Keep `src/renderer/src/styles.css` limited to HTML/application baseline, native-control minimum states, focus-visible, disabled, and global reduced-motion. Product variants and domain layout stay in feature CSS.
- Keep the dependency direction `App/composition → features → components + renderer shared utilities`.
- Do not add a package, barrel export, registry, base class, compatibility path, or speculative component API for possible future use.
- Do not expose fake controls or infer backend state. Renderer consumes normalized state and sends narrow typed commands through preload.

## Implement the smallest complete change

- Reuse `Icon`, `IconButton`, `Select`, `FontSelect`, `TooltipProvider`, `useViewportPopoverPosition`, and `useModalDialog` only within their documented semantics.
- Use `Icon` sizes `sm`, `control`, or `lg`; do not resize SVGs from feature CSS.
- Use semantic typography, color, radius, and motion tokens. Keep feature-local spacing/layout values local unless a stable cross-feature semantic is proven; do not manufacture a generic spacing scale from repeated numbers.
- Preserve the Workbench's Navigator, Header, Timeline, and Composer responsibilities. Any floating Header or Composer surface must reserve real Timeline clearance.
- Keep narrow-window behavior usable without horizontal overflow. Reuse the owner's current structural breakpoint before introducing a nearby one; constrain and flip portal surfaces against the viewport.
- Give every interactive control distinguishable hover, `focus-visible`, selected/expanded, and disabled states.
- For custom listbox, combobox, menu, tooltip, disclosure, modal, or drag behavior, preserve the matching ARIA, keyboard, focus restoration, outside-click, portal, hit-testing, and Escape semantics. Renderer modals reuse `useModalDialog` for top-layer focus/Escape behavior while the feature retains portal, label, backdrop, busy, and visual ownership. Escape is handled by the innermost active surface before Workbench-level settings/detail/abort behavior.
- Keep ordinary text buttons native and feature-owned unless a shared behavior contract—not only a visual variant—proves a common component. Do not create generic Button, Dialog, HoverCard, Status, or Popover wrappers from appearance alone.
- Respect `prefers-reduced-motion`; do not make animation the only carrier of state.
- Keep CommonMark/GFM, external-link, attachment, incremental patch, and 60-turn mounting boundaries unchanged unless the user explicitly requests that contract to change.
- Fail fast on unsupported states. Do not add silent fallback or compatibility behavior unless required by an active project boundary.

## Review the result

Check the relevant diff, not only the rendered appearance:

- No touched raw color/radius/motion value duplicates an existing semantic token; `0`, `inherit`, circles, masks, SVG geometry, and clearly local layout math remain valid exceptions.
- Global styles did not gain feature-specific variants or selectors that can alter unrelated domains.
- No shared component gained feature-specific state.
- No feature imports another feature's internals to bypass ownership.
- Icon size, text hierarchy, spacing, alignment, and truncation match the surrounding surface.
- Pointer, keyboard, focus, disabled, portal, narrow-window, and reduced-motion paths remain coherent.
- Existing local changes outside the task remain intact.

## Validate

Run the smallest relevant checks. For normal frontend source changes, use:

```bash
pnpm typecheck
pnpm build
git diff --check
```

If the shell-provided `pnpm` uses the wrong Node runtime, use the project's current local binaries rather than modifying `package.json` or the lockfile:

```bash
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/electron-vite build
git diff --check
```

Add targeted existing tests only when the changed behavior has a relevant test surface. Do not start the application or take screenshots unless the task requires real visual evidence or the user asks for it.

Report the changed frontend boundary, the reusable library effect, validation results, and any unrelated blocker separately.
