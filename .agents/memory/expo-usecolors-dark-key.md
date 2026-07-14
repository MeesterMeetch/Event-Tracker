---
name: Expo useColors dark-key cast
description: Adding a real `dark` palette to an Expo artifact's constants/colors.ts breaks the scaffold useColors cast — simplify the hook.
---

# Expo useColors + dark palette typecheck break

When you sync a sibling web artifact's dark theme into an Expo artifact by adding
a real `dark` key to `constants/colors.ts` (alongside `light` and the numeric
`radius`), the scaffold's `hooks/useColors.ts` fails typecheck.

**Why:** the scaffold ships a defensive cast
`(colors as Record<string, typeof colors.light>).dark` intended for the
light-only default. Once `colors` also has `radius: number`, that Record cast is
rejected (`Property 'radius' is incompatible with index signature` — number vs
the palette object type).

**How to apply:** once a genuine `dark` key exists, drop the cast and access it
directly, e.g. `const palette = scheme === 'dark' ? colors.dark : colors.light;`.
No `'dark' in colors` guard or Record cast is needed anymore.
