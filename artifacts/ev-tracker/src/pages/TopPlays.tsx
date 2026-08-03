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
 * The window the button asks for: now until midnight tonight, in the viewer's
 * own timezone. Computed in the browser because that is the only place that
 * knows what "today" means for the person looking at the screen. The server
 * runs in UTC and would call it tomorrow for the last five hours of every
 * evening.
 *
 * Games already underway are excluded. These are pregame prices, and a number
 * attached to a game in the third inning is not a play.
 */
function todayWindow(): ListTopPlaysParams {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return { startTime: now.toISOString(), endTime: midnight.toISOString() };
}

export default function TopPlays() {
  // Never fetched on mount. A fan-out is one billed scan per sport, so it costs
  // real money every time it runs and must be a deliberate action rather than
  // something that happens because a tab was opened.
  const [scanning, setScanning] = useState(false);
  const [request, setRequest] = useState<ListTopPlaysParams | null>(null);
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

  const run = () => setRequest(todayWindow());

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
            Scans the day's board across sports and selects the plays most worth making
            together. Confidence outranks size, and a game can only contribute so much, so
            five correlated bets on one script cannot fill the list.
          </p>
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
                  Nothing cleared the bar for today. Scanned{" "}
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
            <div className="space-y-3">
              {data.picks.map((p) => (
                <PlayCard key={`${p.edge.gameId}-${p.edge.market}-${p.edge.selection}-${p.rank}`} play={p} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
