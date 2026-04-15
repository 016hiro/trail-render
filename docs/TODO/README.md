# TODO — version → planned features

Forward-looking task lists, grouped by target version. The intent is to
keep "what should we do next" out of conversation memory and into git.

| version | theme | file |
|---|---|---|
| v0.3 | production polish — close the gaps in the web UI before announcing | [v0.3.md](v0.3.md) — **shipped 2026-04-15** |
| v0.4 | per-track camera altitude — different GPXs need different heights | [v0.4.md](v0.4.md) |
| v0.5 | product features — elevation overlay, map styles, multi-track, npm publish | [v0.5.md](v0.5.md) |
| backlog | unscoped wishlist; promote into a version when the case is clear | [backlog.md](backlog.md) |

Closing rule: before starting a new version, the previous version's file
must have no unchecked `- [ ]` boxes. If something from v0.N hasn't
shipped, it gets explicitly pushed into v0.N+1 or backlog (with the
reason) before the new milestone starts.

Conventions:

- A bullet should describe the *outcome*, not the implementation. If you
  catch yourself writing "add a function that…", rephrase as "user can…"
  or "system survives…".
- Strike through `~~done~~` when shipped, leave the bullet so future
  readers can see the trajectory. Move to a `## shipped` section after
  a few weeks if it's no longer interesting.
- Each item gets one line of *why* it matters. If you can't justify it
  in one line, it isn't ready for the list yet — it belongs in a design
  doc first.
