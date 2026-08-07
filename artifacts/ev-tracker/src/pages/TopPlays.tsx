import { useEffect, useState } from "react";
import { useListTopPlays, getListTopPlaysQueryKey } from "@workspace/api-client-react";
import type { TopPlay, SlateSummary, ListTopPlaysParams } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatOdds, formatPercent, formatPoint, formatGameTime, formatMarketLabel } from "@workspace/format";
import { Star, Loader2, AlertTriangle } from "lucide-react";

type ConfidenceTier = "solid" | "playable" | "fragile" | "suspect";

const TIER_STYLE: Record<ConfidenceTier, string> = {
  solid: "bg-positive/15 text-positive border-positive/30",
  playable: "bg-primary/10 text-primary border-primary/30",
  fragile: "bg-muted text-muted-foreground border-border",
  suspect: "bg-destructive/10 text-destructive border-destructive/30",
};

function ConfidenceBadge({ tier, reasons }: { tier: ConfidenceTier; reasons: string[] }) {
  return (
    <Badge
      variant="outline"
      className={`text-[10px] uppercase font-mono ${TIER_STYLE[tier]}`}
      title={reasons.join(" · ")}
    >
      {tier}
    </Badge>
  );
}

/**
 * The read on the day, which is the actual product here.
 *
 * This sits above the list rather than below it on purpose. Most days the list
 * is short or empty, because the market is efficient more often than not, and a
 * top-five list on its own cannot tell you that. Leading with the list would
 * make an empty board look like a broken page instead of an answer.
 */
function SlateRead({ summary, scannedAt }: { summary: SlateSummary; scannedAt: string }) {
  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        <p className="text-sm leading-relaxed">{summary.interpretation}</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs font-mono text-muted-foreground">
          <span>{summary.totalEdges} priced</span>
          <span>{summary.eligibleEdges} above 1%</span>
          <span>{summary.gamesRepresented} games</span>
          <span>{summary.sportsRepresented} sports</span>
          <span className="text-positive">{summary.byTier.solid} solid</span>
          <span className="text-primary">{summary.byTier.playable} playable</span>
          <span>{summary.byTier.fragile} fragile</span>
          <span className="text-destructive">{summary.byTier.suspect} suspect</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Scanned {formatGameTime(scannedAt)}. These prices move within minutes, so treat
          anything older than a few minutes as a starting point rather than a live quote.
        </p>
      </CardContent>
    </Card>
  );
}

function PlayCard({ play }: { play: TopPlay }) {
  const e = play.edge;
  const point = formatPoint(e.point, e.market);
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">#{play.rank}</span>
              <span className="font-semibold truncate">
                {e.player ? `${e.player} ` : ""}
                {e.selection}
                {point ? ` ${point}` : ""}
              </span>
              <ConfidenceBadge
                tier={e.confidenceTier as ConfidenceTier}
                reasons={e.confidenceReasons}
              />
            </div>
            <div className="text-sm text-muted-foreground truncate">
              {e.awayTeam} at {e.homeTeam} · {formatMarketLabel(e.market)} ·{" "}
              {formatGameTime(e.commenceTime)}
            </div>
            <div className="text-xs font-mono text-muted-foreground">{play.rationale}</div>

            {/*
              The four numbers behind the EV, rather than only its output. Market
              is the de-vigged consensus the edge was measured against; sharp and
              public split that same consensus by book type. There is no model
              figure here on purpose: these are game-line edges derived from
              market prices, and the projection model is a different pipeline
              that only covers MLB pitcher strikeouts.
            */}
            <div className="text-xs font-mono text-muted-foreground flex flex-wrap gap-x-3">
              {e.marketProb != null && (
                <span data-testid={`text-market-${play.rank}`}>
                  market {e.marketProb.toFixed(1)}%
                </span>
              )}
              <span data-testid={`text-sharp-${play.rank}`}>
                {e.sharpProb == null ? "sharp none" : `sharp ${e.sharpProb.toFixed(1)}%`}
              </span>
              <span data-testid={`text-public-${play.rank}`}>
                {e.publicProb == null ? "public none" : `public ${e.publicProb.toFixed(1)}%`}
              </span>
              {e.dispersionPercent != null && (
                <span>spread {e.dispersionPercent.toFixed(1)}pp</span>
              )}
            </div>
            {play.sameGameCount > 0 && (
              <div className="text-xs text-muted-foreground">
                Second selection from this game. Correlated with a pick above it, so size it
                smaller rather than treating it as an independent position.
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="font-mono text-lg text-positive">{formatPercent(e.evPercent)}</div>
            <div className="font-mono text-sm">{formatOdds(e.americanOdds)}</div>
            <div className="text-xs text-muted-foreground">{e.book}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * How far ahead to look. Every option ends at a local midnight rather than at
 * "now plus N times 24 hours", so "today" means today's calendar rather than a
 * rolling day that dribbles into tomorrow afternoon.
 *
 * Widening the window costs nothing extra. The scan is billed per sport, not
 * per day, so the only thing a longer horizon changes is what is allowed to
 * compete for the list.
 */
type WindowKey = "today" | "tomorrow" | "week" | "fortnight";

interface WindowOption {
  key: WindowKey;
  label: string;
  /** Extra local midnights past tonight's. Zero means tonight's. */
  extraDays: number;
  /** What the empty state and the header call this span. */
  phrase: string;
}

const WINDOW_OPTIONS: readonly WindowOption[] = [
  { key: "today", label: "Today", extraDays: 0, phrase: "today" },
  { key: "tomorrow", label: "Today & tomorrow", extraDays: 1, phrase: "today and tomorrow" },
  { key: "week", label: "7 days", extraDays: 7, phrase: "the next 7 days" },
  { key: "fortnight", label: "14 days", extraDays: 14, phrase: "the next 14 days" },
];

const DEFAULT_WINDOW: WindowKey = "today";

/**
 * Builds the window in the viewer's own timezone, because that is the only
 * place that knows what "today" means for the person looking at the screen.
 * The server runs in UTC and would call it tomorrow for the last hours of
 * every evening.
 *
 * Always starts at now, so games already underway are excluded. These are
 * pregame prices, and a number attached to a game in the third inning is not
 * a play.
 */
function windowFor(option: WindowOption): ListTopPlaysParams {
  const now = new Date();
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  end.setDate(end.getDate() + option.extraDays);
  return {
    startTime: now.toISOString(),
    endTime: end.toISOString(),
    limit: LIST_LIMIT,
    // Deliberately below zero. The page asks for the whole ranked board and
    // decides how to present it, rather than letting the server hand back an
    // empty list on a day when the honest answer is "here is where the board
    // sits, and none of it is worth betting". The 1% bar is still applied, just
    // as a presentation split rather than as a filter.
    minEvPercent: -100,
  };
}

/** How many ranked plays to pull. Enough to be useful, few enough to read. */
const LIST_LIMIT = 15;

/** The EV a play has to clear to count as a play rather than as information. */
const EV_BAR = 1;

export default function TopPlays() {
  // Never fetched on mount. A fan-out is one billed scan per sport, so it costs
  // real money every time it runs and must be a deliberate action rather than
  // something that happens because a tab was opened.
  const [scanning, setScanning] = useState(false);
  const [windowKey, setWindowKey] = useState<WindowKey>(DEFAULT_WINDOW);
  const [request, setRequest] = useState<ListTopPlaysParams | null>(null);
  // The window the last scan actually used. Held separately from windowKey so
  // the results stay labelled with the span they came from even after the
  // selector is changed but before the board is scanned again.
  const [scannedWindow, setScannedWindow] = useState<WindowOption | null>(null);
  const selected = WINDOW_OPTIONS.find((o) => o.key === windowKey) ?? WINDOW_OPTIONS[0];
  const { data, isFetching, isError, error, refetch } = useListTopPlays(request ?? undefined, {
    query: {
      queryKey: getListTopPlaysQueryKey(request ?? undefined),
      enabled: false,
      gcTime: 0,
    },
  });

  // The scan fires from an effect rather than from the click handler so the
  // query has re-rendered with the new window before refetch runs. Calling
  // refetch() inline would send whatever params the previous render held, which
  // is wrong on the first press and stale on every one after midnight.
  useEffect(() => {
    if (request == null) return;
    let cancelled = false;
    setScanning(true);
    void (async () => {
      try {
        await refetch();
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // refetch is deliberately not a dependency; its identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const run = () => {
    setScannedWindow(selected);
    setRequest(windowFor(selected));
  };

  // The server returns one ranked list; the bar decides how it is presented.
  // Suspect-tier edges never appear here at all, since selectTopPlays excludes
  // them upstream, which is the one filter worth keeping even in this mode.
  const picks = data?.picks ?? [];
  const clearing = picks.filter((p) => p.edge.evPercent >= EV_BAR);
  const below = picks.filter((p) => p.edge.evPercent < EV_BAR);

  const busy = scanning || isFetching;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Star className="h-5 w-5 text-primary" />
            Top Plays
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Scans the board across sports and selects the plays most worth making together.
            Confidence outranks size, and a game can only contribute so much, so five
            correlated bets on one script cannot fill the list. Widening the window does not
            cost more, since each scan is billed per sport rather than per day.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="How far ahead to look">
            {WINDOW_OPTIONS.map((option) => (
              <Button
                key={option.key}
                size="sm"
                variant={option.key === windowKey ? "default" : "outline"}
                onClick={() => setWindowKey(option.key)}
                disabled={busy}
                aria-pressed={option.key === windowKey}
                data-testid={`button-window-${option.key}`}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <Button onClick={run} disabled={busy} data-testid="button-scan-top-plays">
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Scanning
              </>
            ) : (
              "Scan the board"
            )}
          </Button>
          {selected.extraDays >= 7 && (
            <p
              className="text-xs text-muted-foreground max-w-xs text-right"
              data-testid="text-wide-window-note"
            >
              A wide window ranks a game two weeks out against tonight's board on equal
              terms. Useful for finding early number, misleading as a list of plays to make
              now.
            </p>
          )}
        </div>
      </div>

      {!data && !busy && !isError && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground space-y-2">
            <p>
              Nothing scanned yet. Each sport on the board is a separate billed request, so
              this runs only when you ask it to.
            </p>
            <p>
              Expect a short list. On an efficient day it will be empty, and that is a real
              answer rather than a failure.
            </p>
          </CardContent>
        </Card>
      )}

      {busy && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {isError && !busy && (
        <Card>
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-sm font-medium">The scan failed.</p>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Every sport failed to return odds."}
              </p>
              <p className="text-xs text-muted-foreground">
                This is not the same as a quiet board. Nothing was measured, so no conclusion
                should be drawn about today.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !busy && (
        <>
          <SlateRead summary={data.summary} scannedAt={String(data.scannedAt)} />

          {data.sportsSkipped.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="text-sports-skipped">
              Skipped without spending a credit, no games in this window:{" "}
              {data.sportsSkipped.join(", ")}.
            </p>
          )}

          {data.sportsFailed.length > 0 && (
            <Card>
              <CardContent className="pt-6 flex items-start gap-3">
                <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {data.sportsFailed.length} of{" "}
                    {data.sportsFailed.length + data.sportsScanned.length} sports failed to
                    scan.
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {data.sportsFailed.map((f) => f.sport).join(", ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    The board below is smaller than it should be for that reason, not
                    necessarily because the market is tight.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {data.picks.length === 0 ? (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground space-y-2">
                <p>
                  Nothing priced for {(scannedWindow ?? selected).phrase}. Scanned{" "}
                  {data.sportsScanned.join(", ") || "no sports"}.
                </p>
                {data.edgesOutsideWindow > 0 && (
                  <p data-testid="text-outside-window">
                    {data.edgesOutsideWindow} priced outcomes were set aside for falling on a
                    later day. An empty list this late usually means today's board is
                    finished rather than that the market is tight.
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              {clearing.length === 0 && (
                <Card className="border-destructive/30 bg-destructive/5">
                  <CardContent className="pt-6 flex items-start gap-3">
                    <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium" data-testid="text-nothing-clears">
                        Nothing clears the {EV_BAR}% bar. Every play below is priced worse
                        than fair.
                      </p>
                      <p className="text-sm text-muted-foreground">
                        This is the ranked board, best first, so you can see where the market
                        sits for {(scannedWindow ?? selected).phrase}. Betting any of it loses
                        money by construction, not by bad luck.
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}

              {clearing.length > 0 && (
                <div className="space-y-3" data-testid="list-clearing">
                  {clearing.map((p) => (
                    <PlayCard
                      key={`${p.edge.gameId}-${p.edge.market}-${p.edge.selection}-${p.rank}`}
                      play={p}
                    />
                  ))}
                </div>
              )}

              {below.length > 0 && (
                <div className="space-y-3" data-testid="list-below-bar">
                  {clearing.length > 0 && (
                    <p className="text-xs text-muted-foreground pt-2">
                      Below the {EV_BAR}% bar, ranked. Shown for context rather than as
                      plays.
                    </p>
                  )}
                  {below.map((p) => (
                    <PlayCard
                      key={`${p.edge.gameId}-${p.edge.market}-${p.edge.selection}-${p.rank}`}
                      play={p}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
