---
name: Odds API EV/CLV/grading patterns for a sports betting tracker
description: Devig math, CLV capture timing, and auto-grading rules used when building a +EV betting tracker against the-odds-api.com.
---

**EV calculation:** for each event/market, devig each bookmaker's own two-sided line individually (multiplicative: `fairProb = impliedProb / overround`), then average the fair probability for the same outcome across bookmakers that quote it (require >=2 books) to get a consensus "true" price. EV% = bestAvailableDecimalOdds * avgFairProb - 1. Single-book "devig" is not reliable enough to alone justify a bet.

**CLV capture:** poll odds shortly before kickoff (a window like T-30min through T+3h) for bets missing `closingOdds`, match on exact market/selection/point (normalize totals selection to base "Over"/"Under" before matching), and store the closing price. Games delisted from the live odds feed after kickoff will never resolve — that's an acceptable v1 gap, not a bug to chase.

**Auto-grading:** never guess. If final scores don't unambiguously resolve a bet's market (e.g. team name mismatch, missing point, scores API hasn't posted a completed result yet), leave the bet pending for manual settlement rather than infer a result.

**Settlement invariant:** `status` and `pnl` must move together — settling a bet without recomputing pnl (or reopening to pending without clearing it) causes dashboards to silently misstate ROI. Compute pnl server-side from odds/units on any status transition unless the caller explicitly overrides it.

**Sports list is free — source it live, don't hard-code:** `/v4/sports?all=false` returns only in-season sports and does NOT consume the request quota (only `/odds` and `/scores` cost credits). A hard-coded picker list goes stale — it shows out-of-season leagues that return no games and omits in-season ones. Filter out entries with `has_outrights: true`; those are futures/outright-only markets (championship/election winners) with no per-game h2h/spreads/totals. Cache the result (hours) to cut noise.

**Devig is N-way, not 2-way:** the multiplicative devig (`fairProb = impliedProb / overround`) generalizes to any outcome count. Soccer h2h is 3-way (home/draw/away). Do not gate on "exactly 2 outcomes" — require `>= 2` so 3-way markets are devigged too, otherwise soccer moneyline edges are silently dropped.

**Player props are per-event only and priced per market:** props never appear in the bulk `/odds` feed — only `GET /sports/{sport}/events/{id}/odds`, charged ~1 credit per market × region per call (the game list `GET /events` is free). So the UX must be a drill-down (sport → free game list → scan one game), never a "scan all props" button. Prop outcomes put the player in `description`, the line in `point`, Over/Under in `name`; within each book, group outcomes by (player, point) and devig that pair — a prop market response bundles every player, unlike game markets. Skip Yes-only markets (anytime TD/scorer): no "No" side exists to devig. Invalid market keys → 422; valid-but-unoffered ones are just omitted from the response.

**Prop bets are manual-settle:** auto-grading works off final team scores and CLV capture off the bulk odds feed — neither carries player stats/prop closers. Filter both jobs to h2h/spreads/totals up front so prop bets don't trigger warnings or burn per-event credits; their CLV legitimately stays null.

**react-query defaults burn paid-API credits:** default `refetchOnWindowFocus: true` + `staleTime: 0` re-hits credit-priced endpoints on every tab focus/re-enable. For apps whose queries cost money, set QueryClient defaults `refetchOnWindowFocus: false` plus a staleTime. Gating `enabled` on UI state (like the active tab) is the right way to stop paid scans the user isn't looking at — but only alongside a staleTime, because each re-enable of a stale query refetches, so quick tab flips would otherwise re-burn credits.

**Per-game MLB input caches must key on event time, not date+teams:** any cache of matchup inputs (probable starters, lineup splits) resolved from the MLB schedule must include the event's start timestamp in its key. Doubleheaders share the same date AND team names, so a `date|home|away` key serves game 1's starters for game 2 within the TTL — silently producing wrong projections. The nearest-game-by-time resolution is correct; it's the cache key that collides.

**"Zero edges" needs a positive control:** an empty +EV scan is indistinguishable from a silent parse failure (e.g. wrong outcome field name skips everything). Verify with a threshold the market can't beat — call the edges endpoint with `minEdgePercent=-100`; if consensus rows come back with real player names, the pipeline works and empty states are honest.
