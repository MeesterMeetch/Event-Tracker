import { useMemo, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { useListPaperTrades } from "@workspace/api-client-react";
import type { PaperTrade } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { LineChart as LineChartIcon, Target, RotateCcw, User, Swords } from "lucide-react";
import { easternDayKey, formatPercent, cn } from "@/lib/utils";

// Newer trades persist the model's actual flag decision (`isFlagged`) at log
// time, so the flagged-vs-unflagged split is exact. Rows logged before that
// column existed have no stored decision, so we fall back to re-deriving it:
// a line was "flagged" when it had a market consensus (marketProb present) and
// cleared the same edge threshold the scanner uses to flag lines.
const FLAG_EDGE_PERCENT = 1;

function isFlaggedTrade(t: PaperTrade): boolean {
  if (t.isFlagged != null) return t.isFlagged;
  return t.marketProb != null && t.edgePercent != null && t.edgePercent >= FLAG_EDGE_PERCENT;
}

/** Trades that have a captured closing line (CLV computed) — the gradable set. */
function isGraded(t: PaperTrade): boolean {
  return t.clvPercent != null;
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function beatCloseRate(trades: PaperTrade[]): number | null {
  if (trades.length === 0) return null;
  return trades.filter((t) => t.beatClose === true).length / trades.length;
}

function fmtRate(rate: number | null): string {
  return rate == null ? "—" : `${(rate * 100).toFixed(0)}%`;
}

type BreakdownRow = {
  key: string;
  count: number;
  beatClose: number | null;
  avgClv: number | null;
};

// A pitcher/opponent needs at least this many graded trades before its avg CLV
// is trustworthy enough to rank. Below this, one or two lucky closes can top the
// leaderboard on noise alone, so low-sample groups are split out of the ranking.
const MIN_GRADED_SAMPLE = 5;

/**
 * Group graded trades by an arbitrary key (pitcher / opponent) and summarize
 * each group. Ordered by avg CLV descending so the model's strongest reads
 * surface first; groups with no measurable CLV sink to the bottom.
 */
function buildBreakdown(trades: PaperTrade[], keyOf: (t: PaperTrade) => string): BreakdownRow[] {
  const groups = new Map<string, PaperTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    const arr = groups.get(k);
    if (arr) arr.push(t);
    else groups.set(k, [t]);
  }
  return Array.from(groups.entries())
    .map(([key, rows]) => ({
      key,
      count: rows.length,
      beatClose: beatCloseRate(rows),
      avgClv: mean(rows.map((t) => t.clvPercent ?? 0)),
    }))
    .sort((a, b) => {
      const av = a.avgClv ?? Number.NEGATIVE_INFINITY;
      const bv = b.avgClv ?? Number.NEGATIVE_INFINITY;
      if (bv !== av) return bv - av;
      return b.count - a.count;
    });
}

const EDGE_BUCKETS: { key: string; label: string; test: (edge: number | null) => boolean }[] = [
  { key: "none", label: "<1%", test: (e) => e == null || e < 1 },
  { key: "low", label: "1–3%", test: (e) => e != null && e >= 1 && e < 3 },
  { key: "mid", label: "3–5%", test: (e) => e != null && e >= 3 && e < 5 },
  { key: "high", label: "5%+", test: (e) => e != null && e >= 5 },
];

const clvConfig: ChartConfig = {
  cumAvg: { label: "Cumulative Avg CLV", color: "hsl(var(--primary))" },
};

const bucketConfig: ChartConfig = {
  rate: { label: "Beat-Close Rate", color: "hsl(var(--primary))" },
};

function FilterBar({
  pitchers,
  filters,
  setFilters,
  onReset,
}: {
  pitchers: string[];
  filters: Filters;
  setFilters: (f: Filters) => void;
  onReset: () => void;
}) {
  const dirty =
    filters.from !== "" || filters.to !== "" || filters.pitcher !== "all" || filters.selection !== "all";

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <Label className="mb-1.5 block text-xs">From</Label>
        <Input
          type="date"
          value={filters.from}
          max={filters.to || undefined}
          onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          className="h-9 w-[160px]"
        />
      </div>
      <div>
        <Label className="mb-1.5 block text-xs">To</Label>
        <Input
          type="date"
          value={filters.to}
          min={filters.from || undefined}
          onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          className="h-9 w-[160px]"
        />
      </div>
      <div>
        <Label className="mb-1.5 block text-xs">Pitcher</Label>
        <Select value={filters.pitcher} onValueChange={(v) => setFilters({ ...filters, pitcher: v })}>
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All pitchers</SelectItem>
            {pitchers.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="mb-1.5 block text-xs">Side</Label>
        <Select value={filters.selection} onValueChange={(v) => setFilters({ ...filters, selection: v })}>
          <SelectTrigger className="h-9 w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Over &amp; Under</SelectItem>
            <SelectItem value="Over">Over</SelectItem>
            <SelectItem value="Under">Under</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {dirty && (
        <Button variant="ghost" size="sm" className="h-9 text-muted-foreground" onClick={onReset}>
          <RotateCcw className="mr-1.5 h-3 w-3" /> Reset
        </Button>
      )}
    </div>
  );
}

type Filters = { from: string; to: string; pitcher: string; selection: string };

const EMPTY_FILTERS: Filters = { from: "", to: "", pitcher: "all", selection: "all" };

function StatBlock({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div>
      <div
        className={cn(
          "font-mono font-bold text-lg",
          tone === "pos" && "text-positive",
          tone === "neg" && "text-destructive",
        )}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
    </div>
  );
}

function BreakdownRows({ rows, dim }: { rows: BreakdownRow[]; dim?: boolean }) {
  return (
    <>
      {rows.map((r) => (
        <TableRow key={r.key} className={cn(dim && "opacity-55")}>
          <TableCell className="font-medium whitespace-nowrap max-w-[180px] truncate" title={r.key}>
            {r.key}
          </TableCell>
          <TableCell className="text-right font-mono">{r.count}</TableCell>
          <TableCell className="text-right font-mono">{fmtRate(r.beatClose)}</TableCell>
          <TableCell
            className={cn(
              "text-right font-mono font-semibold",
              r.avgClv == null
                ? "text-muted-foreground"
                : r.avgClv > 0
                  ? "text-positive"
                  : "text-destructive",
            )}
          >
            {r.avgClv == null ? "—" : formatPercent(r.avgClv)}
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function BreakdownTable({
  title,
  icon,
  groupLabel,
  rows,
}: {
  title: string;
  icon: ReactNode;
  groupLabel: string;
  rows: BreakdownRow[];
}) {
  const [showLowSample, setShowLowSample] = useState(false);

  // Only rank groups with enough graded trades to trust; small samples are held
  // out so a 1–2 trade fluke can't masquerade as the model's strongest read.
  const reliable = rows.filter((r) => r.count >= MIN_GRADED_SAMPLE);
  const lowSample = rows.filter((r) => r.count < MIN_GRADED_SAMPLE);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-4">
          {icon}
          <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
        </div>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">No graded trades in this view.</p>
        ) : reliable.length === 0 && !showLowSample ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            No {groupLabel.toLowerCase()} has {MIN_GRADED_SAMPLE}+ graded trades yet — too little data to rank.
          </p>
        ) : (
          <div className="max-h-[280px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{groupLabel}</TableHead>
                  <TableHead className="text-right">Graded</TableHead>
                  <TableHead className="text-right">Beat Close</TableHead>
                  <TableHead className="text-right">Avg CLV</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <BreakdownRows rows={reliable} />
                {showLowSample && lowSample.length > 0 && (
                  <>
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={4}
                        className="pt-3 pb-1 text-[10px] font-mono uppercase tracking-wide text-muted-foreground"
                      >
                        Insufficient sample (&lt;{MIN_GRADED_SAMPLE} graded)
                      </TableCell>
                    </TableRow>
                    <BreakdownRows rows={lowSample} dim />
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        )}
        {lowSample.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 text-xs text-muted-foreground"
            onClick={() => setShowLowSample((v) => !v)}
          >
            {showLowSample ? "Hide" : "Show"} {lowSample.length} low-sample{" "}
            {lowSample.length === 1 ? groupLabel.toLowerCase() : `${groupLabel.toLowerCase()}s`}
          </Button>
        )}
        <p className="mt-3 text-[10px] font-mono text-muted-foreground">
          Graded trades grouped by {groupLabel.toLowerCase()}, ranked by avg CLV. Only groups with {MIN_GRADED_SAMPLE}+
          graded trades are ranked; smaller samples are held out so noise can't top the board.
        </p>
      </CardContent>
    </Card>
  );
}

export default function ModelPerformance() {
  const { data: trades, isLoading } = useListPaperTrades();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  const pitchers = useMemo(() => {
    const set = new Set<string>();
    for (const t of trades ?? []) set.add(t.pitcher);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [trades]);

  const filtered = useMemo(() => {
    return (trades ?? []).filter((t) => {
      if (filters.pitcher !== "all" && t.pitcher !== filters.pitcher) return false;
      if (filters.selection !== "all" && t.selection !== filters.selection) return false;
      const day = easternDayKey(String(t.commenceTime));
      if (filters.from && day < filters.from) return false;
      if (filters.to && day > filters.to) return false;
      return true;
    });
  }, [trades, filters]);

  const graded = useMemo(() => {
    return filtered
      .filter(isGraded)
      .sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime());
  }, [filtered]);

  // CLV over time: cumulative average CLV as graded trades accrue, in
  // chronological order of first pitch.
  const clvSeries = useMemo(() => {
    let sum = 0;
    return graded.map((t, i) => {
      sum += t.clvPercent ?? 0;
      const d = new Date(t.commenceTime);
      return {
        idx: i,
        label: Number.isNaN(d.getTime())
          ? ""
          : d.toLocaleDateString([], { month: "short", day: "numeric" }),
        clv: Math.round((t.clvPercent ?? 0) * 100) / 100,
        cumAvg: Math.round((sum / (i + 1)) * 100) / 100,
        pitcher: t.pitcher,
      };
    });
  }, [graded]);

  const bucketSeries = useMemo(() => {
    return EDGE_BUCKETS.map((b) => {
      const inBucket = graded.filter((t) => b.test(t.edgePercent));
      const rate = beatCloseRate(inBucket);
      return {
        label: b.label,
        count: inBucket.length,
        rate: rate == null ? 0 : Math.round(rate * 100),
        hasData: inBucket.length > 0,
        // Buckets with a handful of trades can post a 100%/0% beat-close rate on
        // a single lucky/unlucky close, so flag them as low-confidence rather
        // than letting them read as proof.
        lowSample: inBucket.length > 0 && inBucket.length < MIN_GRADED_SAMPLE,
      };
    });
  }, [graded]);

  const anyLowSampleBucket = useMemo(
    () => bucketSeries.some((b) => b.lowSample),
    [bucketSeries],
  );

  const flaggedSplit = useMemo(() => {
    const flagged = graded.filter(isFlaggedTrade);
    const unflagged = graded.filter((t) => !isFlaggedTrade(t));
    const build = (rows: PaperTrade[]) => ({
      count: rows.length,
      beatClose: beatCloseRate(rows),
      avgClv: mean(rows.map((t) => t.clvPercent ?? 0)),
      avgEdge: mean(rows.filter((t) => t.edgePercent != null).map((t) => t.edgePercent as number)),
    });
    return { flagged: build(flagged), unflagged: build(unflagged) };
  }, [graded]);

  const byPitcher = useMemo(() => buildBreakdown(graded, (t) => t.pitcher), [graded]);
  const byOpponent = useMemo(() => buildBreakdown(graded, (t) => t.opponent), [graded]);

  const headline = useMemo(() => {
    return {
      total: filtered.length,
      graded: graded.length,
      beatClose: beatCloseRate(graded),
      avgClv: mean(graded.map((t) => t.clvPercent ?? 0)),
      avgEdge: mean(filtered.filter((t) => t.edgePercent != null).map((t) => t.edgePercent as number)),
    };
  }, [filtered, graded]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4 space-y-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    );
  }

  if ((trades?.length ?? 0) === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-2 text-center px-6">
          <LineChartIcon className="h-8 w-8 opacity-40" />
          <p>No paper trades logged yet.</p>
          <p className="text-xs opacity-70">
            Log the model's flags from Projections, then the track record fills in here as closing lines are captured.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 space-y-4">
          <FilterBar
            pitchers={pitchers}
            filters={filters}
            setFilters={setFilters}
            onReset={() => setFilters(EMPTY_FILTERS)}
          />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 pt-1">
            <StatBlock label="Trades" value={String(headline.total)} />
            <StatBlock label="Graded" value={String(headline.graded)} />
            <StatBlock label="Beat Close" value={fmtRate(headline.beatClose)} />
            <StatBlock
              label="Avg CLV"
              value={headline.avgClv == null ? "—" : formatPercent(headline.avgClv)}
              tone={headline.avgClv == null ? undefined : headline.avgClv > 0 ? "pos" : "neg"}
            />
            <StatBlock
              label="Avg Edge"
              value={headline.avgEdge == null ? "—" : formatPercent(headline.avgEdge)}
            />
          </div>
        </CardContent>
      </Card>

      {graded.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-2 text-center px-6">
            <LineChartIcon className="h-8 w-8 opacity-40" />
            <p>No graded trades in this view yet.</p>
            <p className="text-xs opacity-70">
              CLV is measured after the closing line is captured near first pitch. Open trades appear here once graded
              {filters.from || filters.to || filters.pitcher !== "all" || filters.selection !== "all"
                ? " — or widen your filters."
                : "."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-4">
                <LineChartIcon className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold uppercase tracking-wide">CLV Over Time</h2>
              </div>
              <ChartContainer config={clvConfig} className="h-[260px] w-full">
                <LineChart data={clvSeries} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                    fontSize={11}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    width={44}
                    fontSize={11}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={undefined}
                        formatter={(value, name) => [
                          `${value}%`,
                          name === "cumAvg" ? "Cumulative Avg CLV" : "Trade CLV",
                        ]}
                      />
                    }
                  />
                  <Line
                    dataKey="clv"
                    type="monotone"
                    stroke="hsl(var(--muted-foreground))"
                    strokeWidth={1}
                    strokeOpacity={0.5}
                    dot={{ r: 2 }}
                    isAnimationActive={false}
                  />
                  <Line
                    dataKey="cumAvg"
                    type="monotone"
                    stroke="var(--color-cumAvg)"
                    strokeWidth={2.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ChartContainer>
              <p className="mt-3 text-[10px] font-mono text-muted-foreground">
                The bold line is the running average CLV across graded trades; faint dots are individual trades. A
                genuine edge trends above 0%.
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Target className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold uppercase tracking-wide">Beat-Close by Edge</h2>
                </div>
                <ChartContainer config={bucketConfig} className="h-[220px] w-full">
                  <BarChart data={bucketSeries} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      width={40}
                      domain={[0, 100]}
                      fontSize={11}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <ReferenceLine y={50} stroke="hsl(var(--border))" strokeDasharray="4 4" />
                    <ChartTooltip
                      content={
                        <ChartTooltipContent
                          formatter={(value, _name, item) => {
                            const count = item?.payload?.count ?? 0;
                            const low = item?.payload?.lowSample === true;
                            return [
                              `${value}%  (${count} ${count === 1 ? "trade" : "trades"})${
                                low ? " · low confidence" : ""
                              }`,
                              "Beat-Close Rate",
                            ];
                          }}
                        />
                      }
                    />
                    <Bar dataKey="rate" radius={[4, 4, 0, 0]}>
                      {bucketSeries.map((b) => (
                        <Cell
                          key={b.label}
                          fill={b.hasData ? "var(--color-rate)" : "hsl(var(--muted))"}
                          // Low-sample buckets keep the accent color so you can
                          // tell they hold data, but faded so a 1–2 trade fluke
                          // can't read as a confident bar next to a solid sample.
                          fillOpacity={!b.hasData ? 0.4 : b.lowSample ? 0.35 : 1}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartContainer>
                <p className="mt-3 text-[10px] font-mono text-muted-foreground">
                  Share of graded trades that beat the close, grouped by the edge the model saw. Dashed line marks the
                  50% break-even.
                  {anyLowSampleBucket && (
                    <>
                      {" "}
                      Faded bars have fewer than {MIN_GRADED_SAMPLE} graded trades — too small a sample to trust, so a
                      single lucky or unlucky close can swing them to 100% or 0%.
                    </>
                  )}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-4">
                  <Target className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold uppercase tracking-wide">Flagged vs Unflagged</h2>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead></TableHead>
                      <TableHead className="text-right">Graded</TableHead>
                      <TableHead className="text-right">Beat Close</TableHead>
                      <TableHead className="text-right">Avg CLV</TableHead>
                      <TableHead className="text-right">Avg Edge</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(
                      [
                        ["Flagged", flaggedSplit.flagged],
                        ["Unflagged", flaggedSplit.unflagged],
                      ] as const
                    ).map(([label, s]) => (
                      <TableRow key={label}>
                        <TableCell className="font-medium whitespace-nowrap">
                          {label === "Flagged" && <Target className="inline mr-1.5 h-3 w-3 text-positive" />}
                          {label}
                        </TableCell>
                        <TableCell className="text-right font-mono">{s.count}</TableCell>
                        <TableCell className="text-right font-mono">{fmtRate(s.beatClose)}</TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono font-semibold",
                            s.avgClv == null
                              ? "text-muted-foreground"
                              : s.avgClv > 0
                                ? "text-positive"
                                : "text-destructive",
                          )}
                        >
                          {s.avgClv == null ? "—" : formatPercent(s.avgClv)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">
                          {s.avgEdge == null ? "—" : formatPercent(s.avgEdge)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="mt-3 text-[10px] font-mono text-muted-foreground">
                  Flagged = lines the model recommended (consensus market with ≥{FLAG_EDGE_PERCENT}% edge). If flagged
                  trades outperform unflagged ones, the model's signal is real.
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <BreakdownTable
              title="By Pitcher"
              icon={<User className="h-4 w-4 text-primary" />}
              groupLabel="Pitcher"
              rows={byPitcher}
            />
            <BreakdownTable
              title="By Opponent"
              icon={<Swords className="h-4 w-4 text-primary" />}
              groupLabel="Opponent"
              rows={byOpponent}
            />
          </div>
        </>
      )}
    </div>
  );
}
