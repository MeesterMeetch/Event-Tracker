---
name: MLB K inputs degrade silently
description: getMatchupKInputs returns zeroed/null stats instead of throwing when the MLB feed fails; downstream model consumers must guard against it.
---

# MLB strikeout inputs degrade silently, not loudly

`getMatchupKInputs` (and its helpers `fetchPitcherKStats` / `fetchTeamKProfile`)
never throw on an MLB Stats API failure or an unannounced probable starter. They
catch, log a warning, and return a **non-null** pitcher object with zeroed
rolling stats (`rollingStarts: 0`, `rollingBattersFaced: 0`) and null
season/career/opponent fields.

**Why this matters:** the pure model (`projectPitcherK`) treats missing inputs
as "regress to the league baseline" — an empty pitcher silently becomes a
league-average projection (K/PA 0.22, ~24 BF). So a total feed failure produces a
*confident-looking* number off nothing, not an error.

**How to apply:** any consumer of `MatchupKInputs` must check for a real
strikeout-rate sample before projecting — a non-null `pitcher` is not enough.
The rule used in `pitcher-k-scanner.ts`: a side is usable only if it has real
batters-faced from at least one of rolling / season / career; otherwise abstain
and surface `insufficientData` rather than emit the fallback number. A missing
opponent split or null `throws` is a *soft* degrade (neutral opponent factor),
not grounds to abstain on its own.
