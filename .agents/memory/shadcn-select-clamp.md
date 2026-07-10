---
name: shadcn select dropdown one-row clamp
description: shadcn/radix Select showing only one option / not scrolling — caused by a height-clamp class on the popper Viewport
---

# shadcn Select dropdown clamped to one row

**Symptom:** The Select dropdown menu shows only the first option (or ~one row) and won't scroll to reveal the rest, even though all items are rendered in the DOM.

**Cause:** In the generated `ui/select.tsx`, the popper-position `SelectPrimitive.Viewport` carries `h-[var(--radix-select-trigger-height)]`, which forces the scroll viewport to the trigger's height (~one row). Radix nests the scrollable content inside this Viewport, so clamping its height hides the overflow.

**Fix:** Remove the `h-[var(--radix-select-trigger-height)]` class from the popper Viewport (keep `w-full min-w-[var(--radix-select-trigger-width)]`).

**Why it matters:** This ships in some shadcn `select` scaffolds and comes back whenever the component is re-added/regenerated (`shadcn add select`). If a Select suddenly shows one row again, check this class first before debugging data/state.
