---
name: shadcn FormMessage silent-drop
description: Web form submits blocked with no visible error — check FormMessage renders {body}
---

**Rule:** If a shadcn/react-hook-form form silently refuses to submit (mutation never fires, `aria-invalid="true"` on a field, but no error text anywhere), check the artifact's `src/components/ui/form.tsx`: `FormMessage` must render `{body}` inside the `<p>`. A scaffold variant computed `body` but emitted an empty paragraph, hiding every validation message in that artifact.

**Why:** Cost several debug rounds during the web Edit Bet P&L work — zod, the resolver, and RHF were all fine; only the message rendering was broken. The bug is per-artifact (each artifact vendors its own form.tsx), so it can reappear in a newly scaffolded artifact.

**How to apply:** When a form validation message doesn't appear in a component test or in the UI, grep the artifact's form.tsx for `{body}` before suspecting the schema or resolver.
