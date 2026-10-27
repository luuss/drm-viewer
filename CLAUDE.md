<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `convex/_generated/ai/guidelines.md` first** for important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->


## Git: Branch `claude/digital` (strikte Regel, seit 27.10.2026)

Auf zwei Rechnern arbeitet je ein Claude an diesem Repo. Damit beide immer
denselben Stand haben:

* **Dieser Claude arbeitet nur im Branch `claude/digital`.** Nie direkt auf
  `main` committen.
* **Nach jeder Aenderung committen und pushen** (`git push origin claude/digital`).
  Kein Stand bleibt nur lokal oder nur auf dem Server liegen.
* **Vor jeder Arbeit** `git fetch` und `origin/main` in den Branch holen
  (`git rebase origin/main` oder `git merge origin/main`), damit Arbeit des
  anderen Rechners nicht verloren geht.
* **Ausrollen ist erlaubt** (Convex, Oberflaeche, Gateway, Apache), aber nur
  aus einem Stand, der committet und gepusht ist. Vor einem Convex-Deploy
  mit dem Server abgleichen (HANDOVER 1e, Falle `stripeModus`).
* Commits ohne Session-Links oder Co-Authored-By-Zeilen.
* **Vor jedem Push und jedem Deploy alles holen und zusammenfuehren**
  (Anweisung 27.10.2026): `git fetch --all`, dann `origin/main` und jeden
  anderen Arbeitsbranch des zweiten Rechners in `claude/digital` mergen,
  Konflikte loesen, Tests + `vite build` laufen lassen, erst dann pushen
  und ausrollen. Live steht immer der **gemeinsame** Stand beider Rechner,
  nie nur der eigene, sonst ueberschreibt ein Deploy die Arbeit
  (Design, Seiten) des anderen.
* Bei CSS-Konflikten: Klassennamen des Readers bleiben die kurzen
  (`rv`, `fb`, `fb-c`, `gx`, siehe Kopierschutz in HANDOVER), neue Regeln
  von `main` werden angehaengt, nicht verworfen.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
