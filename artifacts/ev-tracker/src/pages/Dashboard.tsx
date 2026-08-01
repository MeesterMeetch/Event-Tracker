import { useMemo } from "react";
import { useGetDashboardSummary, useGetLedgerAudit, useListSports } from "@workspace/api-client-react";
import { formatSportKey } from "@workspace/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, Target, Coins, Percent, AlertTriangle } from "lucide-react";

export default function Dashboard() {
  const { data: summary, isLoading, isError } = useGetDashboardSummary();

  // Automatic corrupt-ledger watchdog: the server runs the same checks as the
  // manual audit script. Failures stay silent here (the banner only ever
  // appears on a confirmed non-zero count) — the dashboard must not break if
  // the audit endpoint is unreachable.
  const { data: audit } = useGetLedgerAudit();

  // The free in-season sports list resolves keys like "baseball_mlb" to
  // display titles; formatSportKey covers keys that have dropped off the
  // list (out-of-season leagues still present in the ledger history).
  // Mirrors the mobile bets screen so the two apps read the same.
  const { data: sports } = useListSports();
  const sportTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sports ?? []) map.set(s.key, s.title);
    return map;
  }, [sports]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">Performance Terminal</h1>
          <p className="text-muted-foreground">Aggregated lifetime betting edge</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError || !summary) {
    return (
      <div className="flex items-center justify-center h-64 border border-destructive/20 bg-destructive/5 rounded-lg">
        <p className="text-destructive font-mono">ERR_DATA_UNAVAILABLE</p>
      </div>
    );
  }

  // Same realized-stake rule as the mobile ledger card: P&L and ROI only
  // earn a tone (and lose the muted styling) once there is settled stake
  // with a real pnl — totalUnits > 0 — never off the W-L-P count alone.
  // Covers the API edge case where bets are settled but pnl is still null
  // (totalUnits 0): an unmuted "$0.00 / 0.00%" must not sit next to a
  // non-zero record as if results were in.
  const hasRealizedStake = summary.totalUnits > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Performance Terminal</h1>
        <p className="text-muted-foreground">Aggregated lifetime betting edge</p>
      </div>

      {audit && audit.total > 0 && (
        <Alert variant="destructive" data-testid="alert-ledger-audit">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {audit.total} corrupt ledger {audit.total === 1 ? 'entry is' : 'entries are'} skewing profit/ROI
          </AlertTitle>
          <AlertDescription>
            {[
              audit.impossibleOddsBets > 0 && `${audit.impossibleOddsBets} bet(s) with impossible odds`,
              audit.zeroOrNegativeUnitBets > 0 && `${audit.zeroOrNegativeUnitBets} bet(s) with zero or negative units`,
              audit.settledNullPnlBets > 0 && `${audit.settledNullPnlBets} settled bet(s) missing P&L`,
              audit.contradictoryPnlBets > 0 && `${audit.contradictoryPnlBets} bet(s) whose P&L contradicts their result`,
              audit.impossibleOddsPaperTrades > 0 && `${audit.impossibleOddsPaperTrades} paper trade(s) with impossible odds`,
            ]
              .filter(Boolean)
              .join(' · ')}
            . Fix bets via the Bet Log edit dialog and paper trades via the scorecard's edit button — the totals above can't be trusted until then.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total P&L</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold font-mono ${!hasRealizedStake ? 'text-muted-foreground' : summary.totalPnl > 0 ? 'text-positive' : summary.totalPnl < 0 ? 'text-negative' : ''}`}>
              {hasRealizedStake && summary.totalPnl > 0 ? '+' : ''}{formatCurrency(summary.totalPnl)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {!hasRealizedStake && <span>Awaiting results · </span>}
              Record: {summary.won}-{summary.lost}-{summary.push} ({summary.pending} pending)
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Settled Stake</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {/* Server semantics: totalUnits sums SETTLED stake only — it is
                the ROI denominator, not the pending exposure. */}
            <div className="text-2xl font-bold font-mono">{summary.totalUnits.toFixed(2)}u</div>
            <p className="text-xs text-muted-foreground mt-1">
              Units risked on settled bets — the ROI denominator
              {summary.pendingUnits > 0 && (
                <span className="text-foreground font-mono"> · +{summary.pendingUnits.toFixed(2)}u pending</span>
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Yield (ROI)</CardTitle>
            <Percent className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold font-mono ${!hasRealizedStake ? 'text-muted-foreground' : summary.roiPercent > 0 ? 'text-positive' : summary.roiPercent < 0 ? 'text-negative' : ''}`}>
              {formatPercent(summary.roiPercent)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {hasRealizedStake ? 'Return on invested capital' : 'Awaiting results — no settled stake yet'}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Average CLV</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold font-mono ${summary.avgClvPercent && summary.avgClvPercent > 0 ? 'text-positive' : summary.avgClvPercent && summary.avgClvPercent < 0 ? 'text-negative' : ''}`}>
              {summary.avgClvPercent != null ? formatPercent(summary.avgClvPercent) : 'N/A'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">From {summary.clvSampleSize} graded bets</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sport Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sport</TableHead>
                <TableHead>Bets</TableHead>
                <TableHead>Record (W-L-P)</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">ROI</TableHead>
                <TableHead className="text-right">P&L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.bySport.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No data available.
                  </TableCell>
                </TableRow>
              ) : (
                summary.bySport.map(sport => (
                  <TableRow key={sport.sport}>
                    <TableCell className="font-semibold text-foreground">
                      {sportTitles.get(sport.sport) ?? formatSportKey(sport.sport)}
                    </TableCell>
                    <TableCell>{sport.bets}</TableCell>
                    <TableCell>{sport.won}-{sport.lost}-{sport.push}</TableCell>
                    {/* Open exposure per sport — count plus units riding, so
                        concentration is visible when bets span leagues. */}
                    <TableCell className="text-right font-mono">
                      {sport.pending > 0 ? (
                        <span>{sport.pending} · +{sport.pendingUnits.toFixed(2)}u</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    {/* Same realized-stake rule as the mobile ledger card:
                        only tint ROI/P&L once this sport has settled stake
                        with a real pnl (settledUnits > 0), never off the
                        W-L-P count alone. */}
                    <TableCell className={`text-right ${sport.settledUnits > 0 && sport.roiPercent > 0 ? 'text-positive' : sport.settledUnits > 0 && sport.roiPercent < 0 ? 'text-negative' : ''}`}>
                      {formatPercent(sport.roiPercent)}
                    </TableCell>
                    <TableCell className={`text-right ${sport.settledUnits > 0 && sport.pnl > 0 ? 'text-positive' : sport.settledUnits > 0 && sport.pnl < 0 ? 'text-negative' : ''}`}>
                      {sport.pnl > 0 ? '+' : ''}{formatCurrency(sport.pnl)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
