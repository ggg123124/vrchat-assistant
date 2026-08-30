---
name: planning-with-files
description: Persistent Manus-style task planning and memory management using filesystem-based 3-file pattern (task_plan.md, findings.md, progress.md) to eliminate context drift and survive context compression/clear.
---

# Planning with Files (Filesystem-Context)

A persistent memory and planning framework that treats the AI's context window as volatile **RAM** and the local filesystem as persistent **Disk**. It guarantees that the agent never loses its place, even across context truncation, tool errors, or session restarts.

## The 3-File Pattern

Maintain these three files in the active project directory:

### 1. `task_plan.md` (Roadmap & Checklists)
- **Goal**: Clear statement of the primary objective.
- **Phases**: Broken down into sequential phases (Phase 1, Phase 2, etc.).
- **Task Checklist**: Checkboxes `- [ ]` and `- [x]` marking exact progress.
- **Acceptance Criteria**: Concrete conditions for declaring success.

### 2. `findings.md` (Context & Knowledge Store)
- Architecture details, API endpoints, credentials schema, and discovered quirks.
- File paths and symbol relationships discovered during research.
- Decisions made and why alternative approaches were rejected.

### 3. `progress.md` (Session Log & Verifications)
- Chronological changelog of what was done in each step.
- Raw test outputs, compiler results, and network responses.
- Known issues and blockers.

## Execution Rules

1. **Before Taking Action**: Read `task_plan.md` to ensure the current step aligns with the roadmap.
2. **After Completing a Step**: Immediately update `task_plan.md` (`- [x]`) and record results in `progress.md`.
3. **Upon Context Recovery / Interruption**: The agent reads the 3 files to instantly resume work without asking the user for re-orientation.
