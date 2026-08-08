import { useEffect, useState } from "react";
import { toCsv, csvFilename, downloadCsv, type CsvColumn } from "@/lib/csv";
import {
  useListModelSlate,
  getListModelSlateQueryKey,
  type ModelSlatePlay,
  type ModelCalibrationState,
  type ListModelSlateParams,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatOdds, formatGameTime } from "@workspace/format";
import { Loader2, AlertTriangle, FlaskConical, Download } from "lucide-react";

/**
 * The whole strikeout board, ranked by how far the model disagrees with the
 * market.
 *
 * This deliberately does not present its rows as plays while the model is
 * uncalibrated, and it shows no stake sizes. The recommended units the scanner
 * produces are Kelly fractions of probabilities we have never once checked
 * against an outcome, and a stake size next to an unvalidated number is the
 * most harmful thing this screen could show. Both come back automatically once
 * the calibration state says they have been earned.
 */

const WINDOWS = [
  { key: "today", label: "Today", extraDays: 0 },
  { key: "tomorrow", label: "Today & tomorrow", extraDays: 1 },
] as const;

type WindowKey = (typeof WINDOWS)[number]["key"];

function windowFor(extraDays: number): ListModelSlateParams {
  const now = new Date();
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  end.setDate(end.getDate() + extraDays);
  return {
    startTime: now.toISOString(),
    endTime: end.toISOString(),
    limit: 25,
    // The board is ranked, not filtered. Deciding what is worth showing is the
    // page's job, and while the model is uncalibrated the threshold means very
    // little anyway.
    minEdgePercent: -100,
  };
}

function CalibrationBanner({ state }: { state: ModelCalibrationState }) {
  if (state.isCalibrated) return null;

  const graded = state.gradedTrades;
  const target = state.minGradedForCalibration;

  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="pt-6 flex items-start gap-3">
        <FlaskConical className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p className="text-sm font-medium" data-testid="text-uncalibrated">
            This model has never been checked against a result.
          </p>
          <p className="text-sm text-muted-foreground">
            {graded == null
              ? "The graded-trade count could not be read, so progress is unknown."
              : `${graded} of ${target} graded predictions needed before its probabilities mean anything.`}
            {state.blendWeight >= 1 &&
              " Its output is also unblended with the market, which is why it can disagree with a liquid market on nearly every line."}
          </p>
          <p className="text-xs text-muted-foreground">
            Every line scanned is being logged automatically and grades itself out after
            each game. Stake sizes stay hidden until the count clears.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function PlayRow({ play, showUnits }: { play: ModelSlatePlay; showUnits: boolean }) {
  const disagreement = (play.modelProb - play.marketProb) * 100;
  // A large edge on a thin sample is the model guessing rather than knowing, so
  // the sample sits next to the claim rather than behind a tooltip.
  const thin = play.sampleStarts < 6;

  return (
    <Card data-testid={`row-slate-play-${play.rank}`}>
      <CardContent className="pt-5 pb-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs text-muted-foreground">#{play.rank}</span>
              <span className="font-medium">{play.pitcher}</span>
              <Badge variant="outline">
                {play.selection} {play.point}
              </Badge>
              <span className="font-mono text-sm">{formatOdds(play.americanOdds)}</span>
              <span className="text-xs text-muted-foreground">{play.book}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {play.awayTeam} @ {play.homeTeam} · {formatGameTime(play.commenceTime)} ·{" "}
              {play.expectedStrikeouts.toFixed(1)} projected K
            </p>
          </div>

          <div className="text-right space-y-1 shrink-0">
            <div className="font-mono text-sm">
              model {(play.modelProb * 100).toFixed(1)}% vs market{" "}
              {(play.marketProb * 100).toFixed(1)}%
            </div>
            <div className="text-xs text-muted-foreground">
              {disagreement >= 0 ? "+" : ""}
              {disagreement.toFixed(1)} points apart
            </div>
            <div className="flex items-center gap-2 justify-end">
              <Badge
                variant={thin ? "destructive" : "secondary"}
                className="font-mono text-[10px]"
                data-testid={`badge-sample-${play.rank}`}
              >
                {play.sampleStarts} starts
              </Badge>
              {play.degradedInputs && (
                <Badge variant="destructive" className="text-[10px]">
                  no opponent data
                </Badge>
              )}
              {showUnits && (
                <span className="font-mono text-xs">{play.recommendedUnits.toFixed(2)}u</span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Export columns.
 *
 * The calibration state rides on every row deliberately. A spreadsheet outlives
 * the banner that framed it, and a file of model edges with no record of
 * whether the model had ever been checked is the same trap the banner exists to
 * prevent, just deferred by three weeks.
 *
 * recommendedUnits is left empty while uncalibrated, matching the screen. A
 * Kelly stake computed from an unvalidated probability should not be one
 * spreadsheet formula away from being acted on.
 */
export function slateColumns(
  scannedAt: string,
  calibration: ModelCalibrationState,
): CsvColumn<ModelSlatePlay>[] {
  return [
    { header: "rank", value: (p) => p.rank },
    { header: "edgePercent", value: (p) => p.edgePercent },
    { header: "pitcher", value: (p) => p.pitcher },
    { header: "team", value: (p) => p.team },
    { header: "opponent", value: (p) => p.opponent },
    { header: "selection", value: (p) => p.selection },
    { header: "point", value: (p) => p.point },
    { header: "americanOdds", value: (p) => p.americanOdds },
    { header: "book", value: (p) => p.book },
    { header: "modelProb", value: (p) => p.modelProb },
    { header: "marketProb", value: (p) => p.marketProb },
    { header: "disagreementPoints", value: (p) => (p.modelProb - p.marketProb) * 100 },
    { header: "expectedStrikeouts", value: (p) => p.expectedStrikeouts },
    { header: "sampleStarts", value: (p) => p.sampleStarts },
    { header: "degradedInputs", value: (p) => p.degradedInputs },
    { header: "isFlagged", value: (p) => p.isFlagged },
    {
      header: "recommendedUnits",
      value: (p) => (calibration.isCalibrated ? p.recommendedUnits : null),
    },
    { header: "modelCalibrated", value: () => calibration.isCalibrated },
    { header: "gradedTrades", value: () => calibration.gradedTrades },
    { header: "blendWeight", value: () => calibration.blendWeight },
    { header: "awayTeam", value: (p) => p.awayTeam },
    { header: "homeTeam", value: (p) => p.homeTeam },
    { header: "commenceTime", value: (p) => p.commenceTime },
    { header: "scannedAt", value: () => scannedAt },
  ];
}

export default function SlateBoard() {
  const [windowKey, setWindowKey] = useState<WindowKey>("today");
  const [request, setRequest] = useState<ListModelSlateParams | null>(null);
  const [scanning, setScanning] = useState(false);

  const selected = WINDOWS.find((w) => w.key === windowKey) ?? WINDOWS[0];

  const { data, isFetching, isError, error, refetch } = useListModelSlate(request ?? undefined, {
    query: {
      queryKey: getListModelSlateQueryKey(request ?? undefined),
      enabled: false,
      gcTime: 0,
    },
  });

  // Fired from an effect so the query has re-rendered with the new window
  // before refetch runs; calling it inline sends the previous render's params.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const busy = scanning || isFetching;
  const showUnits = data?.calibration.isCalibrated === true;

  const exportCsv = () => {
    if (data == null) return;
    downloadCsv(
      csvFilename("strikeout-board"),
      toCsv(data.plays, slateColumns(String(data.scannedAt), data.calibration)),
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-sm text-muted-foreground max-w-2xl">
          Runs the projection model across every game in the window and ranks the lines by how
          far it disagrees with the de-vigged market. One credit per game, so a full slate is
          about fifteen.
        </p>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w.key}
                size="sm"
                variant={w.key === windowKey ? "default" : "outline"}
                onClick={() => setWindowKey(w.key)}
                disabled={busy}
                aria-pressed={w.key === windowKey}
                data-testid={`button-slate-window-${w.key}`}
              >
                {w.label}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={busy || !data || data.plays.length === 0}
            data-testid="button-export-slate"
          >
            <Download className="h-3.5 w-3.5 mr-1" />
            Export CSV
          </Button>
          <Button
            onClick={() => setRequest(windowFor(selected.extraDays))}
            disabled={busy}
            data-testid="button-scan-slate"
          >
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
      </div>

      {!data && !busy && !isError && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Nothing scanned yet. Each game is a separate billed request, so this runs only when
            you ask it to.
          </CardContent>
        </Card>
      )}

      {busy && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      )}

      {isError && !busy && (
        <Card>
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="text-sm font-medium">The scan failed.</p>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Every game failed to return odds."}
              </p>
              <p className="text-xs text-muted-foreground">
                Nothing was measured, so no conclusion should be drawn about the board.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {data && !busy && (
        <>
          <CalibrationBanner state={data.calibration} />

          <Card>
            <CardContent className="pt-6 space-y-1">
              <p className="text-sm">{data.summary.interpretation}</p>
              <p className="text-xs text-muted-foreground">
                {data.summary.eventsScanned} games · {data.summary.pitchersProjected} starters ·{" "}
                {data.summary.linesMeasured} lines measured ·{" "}
                {data.summary.insufficientData} starters excluded for thin data
              </p>
            </CardContent>
          </Card>

          {data.eventsFailed.length > 0 && (
            <Card>
              <CardContent className="pt-6 flex items-start gap-3">
                <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <p className="text-sm text-muted-foreground">
                  {data.eventsFailed.length} game
                  {data.eventsFailed.length === 1 ? "" : "s"} failed to scan, so the board below
                  is smaller than it should be for that reason rather than because the model
                  likes nothing.
                </p>
              </CardContent>
            </Card>
          )}

          {data.plays.length === 0 ? (
            <Card>
              <CardContent className="pt-6 text-sm text-muted-foreground">
                No lines to rank. Either no games are in this window or none were quoted by
                enough books to measure.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3" data-testid="list-slate-plays">
              {data.plays.map((p) => (
                <PlayRow key={`${p.gameId}-${p.pitcher}-${p.point}-${p.selection}`} play={p} showUnits={showUnits} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
