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
