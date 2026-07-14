import { useMemo } from "react";
import { useGetDashboardSummary, useListSports } from "@workspace/api-client-react";
import { formatSportKey } from "@workspace/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, Target, Coins, Percent } from "lucide-react";

export default function Dashboard() {
  const { data: summary, isLoading, isError } = useGetDashboardSummary();

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight mb-2">Performance Terminal</h1>
        <p className="text-muted-foreground">Aggregated lifetime betting edge</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total P&L</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold font-mono ${summary.totalPnl > 0 ? 'text-positive' : summary.totalPnl < 0 ? 'text-negative' : ''}`}>
              {summary.totalPnl > 0 ? '+' : ''}{formatCurrency(summary.totalPnl)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
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
            <div className={`text-2xl font-bold font-mono ${summary.roiPercent > 0 ? 'text-positive' : summary.roiPercent < 0 ? 'text-negative' : ''}`}>
              {formatPercent(summary.roiPercent)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Return on invested capital</p>
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
                <TableHead className="text-right">ROI</TableHead>
                <TableHead className="text-right">P&L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.bySport.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
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
                    <TableCell className={`text-right ${sport.roiPercent > 0 ? 'text-positive' : sport.roiPercent < 0 ? 'text-negative' : ''}`}>
                      {formatPercent(sport.roiPercent)}
                    </TableCell>
                    <TableCell className={`text-right ${sport.pnl > 0 ? 'text-positive' : sport.pnl < 0 ? 'text-negative' : ''}`}>
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
