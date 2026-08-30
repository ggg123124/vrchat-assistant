---
name: superpowers
description: A disciplined software engineering methodology skill enforcing Test-Driven Development (TDD), systematic debugging, brainstorming, plan creation, plan execution, and code review with autonomous subagent delegation.
---

# Superpowers Engineering Framework

Superpowers is an opinionated, high-discipline software development methodology designed for autonomous coding agents. It enforces rigorous engineering standards: "Think before you act, test before you code, and verify before you claim success."

## Core Principles

1. **Test-Driven Development (TDD) First**: Never write production code without first creating a failing test.
2. **Context Preservation**: Treat context as a precious resource; delegate heavy sub-tasks to subagents.
3. **No Hallucinated Verification**: A task is never complete until an automated test or runtime probe explicitly proves it works.
4. **Structured Planning**: Complex tasks must be broken down into atomic, measurable phases.

---

## 1. Brainstorming & Requirement Discovery
- Explore the codebase and existing conventions before proposing solutions.
- Clarify ambiguous requirements by asking targeted questions.
- Identify architectural constraints, side effects, and dependencies.

## 2. Writing Detailed Plans
- Break work into small, verifiable chunks (15-30 minute units).
- Define clear entry/exit criteria for each phase.
- Specify exact file paths, function signatures, and expected behaviors.

## 3. Test-Driven Development (TDD) Cycle
1. **Red**: Write a minimal failing test expressing the desired feature or bugfix.
2. **Green**: Write the minimal code necessary to make the test pass.
3. **Refactor**: Clean up the implementation while keeping tests green.
4. **Regression**: Run the entire test suite to ensure zero regressions.

## 4. Systematic Debugging Workflow
1. **Reproduce**: Create a minimal reproducible example (script or test case).
2. **Hypothesize**: Formulate 1-3 testable hypotheses for the root cause.
3. **Isolate**: Inspect logs, variables, and network traffic without making random code edits.
4. **Fix & Verify**: Fix the verified root cause and prove that the regression test now passes.

## 5. Requesting Code Review
- Perform self-audit before submitting: check git diff, linting, tests, and documentation.
- Address reviewer feedback systematically without introducing new regressions.
