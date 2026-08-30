---
name: vercel-agent-skills
description: Official Vercel Agent Skills suite covering React best practices, Next.js App Router optimization, Web Design Guidelines (accessibility, focus rings, responsive UI), and Vercel AI SDK integration.
---

# Vercel Agent Skills

Standardized development rules and best practices from Vercel Labs for building world-class React, Next.js, and web applications.

## Key Modules

### 1. Web Design Guidelines & Accessibility (WCAG)
- **Keyboard Navigation**: All interactive elements must have `role="button"`, `tabindex="0"`, and support `Enter` / `Space` key triggers.
- **Focus Rings**: Never use `outline: none` without providing an explicit `:focus-visible` styling indicator.
- **Form Controls & Buttons**: Every button and icon must have an `aria-label` or accessible text label.
- **Color Contrast**: Ensure text meets WCAG AA (4.5:1 for normal text, 3:1 for large text).
- **Tabular Numerics**: Use `font-variant-numeric: tabular-nums` for time, counts, and financial tables.

### 2. React & Next.js Best Practices
- **Server vs Client Components**: Keep components as Server Components by default; only add `'use client'` when state or browser event listeners are required.
- **Data Fetching & Caching**: Leverage Next.js caching layers, `revalidateTag`, and `stale-while-revalidate` patterns.
- **Bundle Optimization**: Avoid importing full libraries when tree-shakable submodules are available.

### 3. Vercel AI SDK & Streaming UI
- Implement streaming text and generative UI using `ai` and `@ai-sdk/react`.
- Handle tool-calling cycles, multi-modal inputs, and error states gracefully.
- Provide loading skeletons during asynchronous stream generation.
