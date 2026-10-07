# CM3 UI prototype

This package is a throwaway CM3 UI prototype for CookieMonster. Keep all prototype work inside `packages/cm-ui-prototype`; do not modify production UI in `packages/app`, Electron renderer code, or unrelated packages unless the user explicitly expands the scope.

## Current Direction

- Treat **Concept A / CM3 UI** as the sole design direction.
- Provide DARK AND LIGHT versions. Keep the calm cream `#fbfaf7` light shell and a coherent dark equivalent with readable controls, focus indicators, browser previews, and diffs.
- In-app CM3 follows the existing `ThemeProvider` and `html[data-color-scheme]`. Use its Light/Dark/System API and localized labels; never duplicate preference storage, force light mode, or write global CM3 colors. Preserve the `quietCompanion` preference key and return behavior.
- The standalone prototype has its own page-local Light/Dark/System control, defaults to System, follows OS changes, and retains the selection across landing/thread navigation without importing app services. Reloading resets it to System.
- Scope in-app palette variables and styles to CM3. Do not import standalone styles into the app. Theme changes must not reset drafts or context selection.
- Do not restore Concept B, Concept C, concept switchers, variant menus, `?variant=` routing, or keyboard concept cycling.
- Preserve URL state routing for `?state=landing` and `?state=thread`; unknown or omitted states should default to landing.
- Preserve landing-to-thread and thread-to-landing transitions.
- Preserve Browser/Changes context tabs, including `[data-open-changes]` opening the Changes view.
- Preserve textarea auto-resizing.
- Maintain usable desktop, tablet, and mobile layouts.

## Package Structure

- `index.html` — Vite entry document and page metadata.
- `src/main.ts` — prototype markup, URL state handling, and interactions.
- `src/styles.css` — all prototype styling and responsive rules.
- `package.json` — package scripts and dependencies.
- `tsconfig.json` — strict browser TypeScript configuration.

Prefer editing these existing files over adding new abstractions or dependencies. This package is intentionally small; keep simple, single-use logic inline unless extraction clearly improves readability.

## Code Conventions

- Use TypeScript without `any`.
- Prefer `const`, early returns, type inference, and functional array methods.
- Avoid unnecessary destructuring, import aliases, star imports, and `try`/`catch`.
- Add comments only for non-obvious constraints or surprising behavior.
- Follow repository formatting: Prettier, no semicolons, 120-column lines.
- Do not add a dependency unless necessary. Workspace dependencies are recorded in the root `bun.lock`.

## Commands

Run commands from this package directory:

```bash
bun run dev
bun run typecheck
bun run build
```

Use `bun run typecheck`; do not invoke `tsc` directly. If linting is needed, run it from the repository root and scope it to this package:

```bash
bun run lint packages/cm-ui-prototype
```

## Verification

Before considering UI work complete:

1. Run `bun run typecheck`.
2. Run `bun run build`.
3. Smoke-test landing and thread states.
4. Verify Browser/Changes tab switching and `[data-open-changes]`.
5. Check representative desktop, tablet, and mobile widths.
6. Check Light/Dark/System, live OS scheme changes in System, focus indicators, preview/diff contrast, and no style leakage into Current UI.
7. Confirm no Concept B/C or variant-switching artifacts were reintroduced.

Record component, real-browser, and Electron verification separately. Component tests do not establish visual or native-window behavior.

Generated `dist/` and package-local `node_modules/` are disposable. Remove them after verification when workspace cleanup is requested. Preserve source files and the root `bun.lock`.

## Git

- The repository default branch is `dev`; local `main` may not exist.
- Use short branch names of at most three hyphen-separated words without type prefixes.
- Use conventional commit messages: `type(scope): summary`.
- Do not commit, push, or create a pull request unless explicitly requested.
- Do not delete or commit unrelated work.
