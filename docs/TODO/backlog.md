# backlog — unscoped wishlist

Items that aren't on a version yet. Promote into v0.x.md when the
problem is clear and the scope can be justified in one line.

## tooling

- **JSDoc `@ts-check` on the data-shape modules.** Locks the
  `parseGPX → renderConfig → captureFrames` data contract without a
  TS migration. Decided in conversation 2026-04-15 to *not* go full TS
  at this scale; revisit if src/ grows past ~5000 lines.
- **Biome lint/format.** Zero-config replacement for ESLint + Prettier.
  One `bunx @biomejs/biome init` + one `biome check --write` pass; CI
  step. Worth it once contributors aren't only us.
- **Dockerfile.** ffmpeg + playwright chromium pre-installed so a user
  can run trail-render without setting up the toolchain. Audience is
  narrow (most GPX users are on a desktop with brew); low priority.
- **Parallel frame capture via worker pool.** Today playwright drives
  one tab serially; ~30 ms/frame is the bottleneck. Two tabs running
  alternating frames could halve capture time. Measure first
  (`src/benchmark.js`) before implementing — chromium WebGL contention
  may eat the gains.

## ergonomics

- **`CONTRIBUTING.md`.** Five lines: how to run tests, how to run e2e,
  what `MAPTILER_KEY` does, where to file issues. Add when there's
  evidence someone other than us is contributing.
- **`CHANGELOG.md`.** Right now `git log --oneline` is the changelog.
  When we cut a real npm release this becomes worth maintaining.
- **MIT license header in source files.** Currently only `LICENSE` at
  root. Conventional but not required.

## product (not yet justified enough for v0.4)

- **Per-segment narration / captions.** Voice-over track timed to
  segment boundaries, or burned-in subtitles. Big lift; only worth
  it if users start asking.
- **Shareable links: render server hosts a "watch" URL for each MP4.**
  Today the user gets a download. A link they can DM is more useful.
  Hostility surface: requires public hosting and a story for abuse.
- **Stitched timelapse from photos with EXIF GPS.** Different input
  modality entirely; would basically be a sister product.

## meta

- **`docs/devlog/` template.** When the next bug-hunting session
  generates lessons worth recording, having a template prevents
  blank-page fatigue. Template based on the `2026-04-15` entry's
  Symptom / Root cause / Fix / Lesson structure.
