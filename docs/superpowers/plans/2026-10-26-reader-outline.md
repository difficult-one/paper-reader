# Reader Outline Implementation Plan

**Goal:** Add the approved collapsible chapter navigation to the desktop PDF reader.

**Architecture:** PdfPane reports its loaded PDF.js document without transferring ownership. OutlinePanel reads its outline on demand and resolves destinations before asking App to navigate through its existing position and linking callbacks.

**Tech Stack:** Existing React, TypeScript, PDF.js, Lucide, Playwright and pdf-lib; no new dependencies.

## Constraints

- Preserve reading, annotations, document switching, pairing and existing PDF lifecycle ownership.
- Add both a toolbar toggle and an internal close button; hiding the panel releases its width.
- Show the correct source in single-pane modes and let the user choose a source in parallel mode.
- Explain missing outlines and offer page navigation; do not invent chapter titles.

## Task 1: Real PDF acceptance coverage

- [x] Create `scripts/outline-smoke.mjs` with nested, named, malformed and absent destination fixtures using pdf-lib.
- [x] Launch the existing built Electron application against isolated test data and verify the test fails because the outline control is absent.
- [x] Assert chapter navigation, child folding, panel width recovery, paper-list coexistence, paired sources, linked/independent jumps, fallback pages, document replacement and saved position.

## Task 2: Outline implementation

- [x] Add `src/renderer/src/pdf-outline.ts` to resolve PDF destinations to existing `Position` values.
- [x] Add `OutlinePanel.tsx` for the source selector, nested disclosure lists, lazy loading, errors and fallback pages.
- [x] Add optional loaded-document reporting to `PdfPane.tsx`; guard the reported URL against outdated document objects.
- [x] Connect panel state, toggle, focus return, Escape and navigation in `App.tsx`, reusing `positionChanged` and PDF handles.
- [x] Add scoped CSS matching the current left sidebar, with overflow and narrow-window behavior.

## Task 3: Verification and documentation

- [x] Run `npm run build` and `node scripts/outline-smoke.mjs`, inspecting expanded, collapsed and narrow-window screenshots.
- [x] Run `npm test`, `npm run test:documents`, `npm run test:pair-drop` and relevant shortcut checks.
- [x] Run Impeccable detect once against changed UI files, address relevant findings, and request an independent code review.
- [x] Add the command and usage to package.json / README.md, and mark completed checks here.

No Git metadata exists in this checkout, so no commits or Git worktrees are created. Execute within this session; the user already approved the design and implementation.
