import { useState, useMemo, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListEvents,
  useListModelEdges,
  useCreatePaperTrade,
  useUpdatePaperTrade,
  useDeletePaperTrade,
  useRestorePaperTrade,
  useListPaperTrades,
  useGetPaperTradeSummary,
  getListEventsQueryKey,
  getListModelEdgesQueryKey,
  getListPaperTradesQueryKey,
  getGetPaperTradeSummaryQueryKey,
} from "@workspace/api-client-react";
import type { ModelPitcherProjection, ModelKLine, PaperTrade } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { parseOddsInput, isValidAmericanOdds } from "@workspace/format";
import { AlertTriangle, Brain, Loader2, Pencil, Plus, Target, Trash2, TrendingUp } from "lucide-react";
import ModelPerformance from "@/components/ModelPerformance";
import { useToast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { formatOdds, formatPercent, formatGameTime, formatTimeOnly, easternDayKey, formatDayLabel, cn } from "@/lib/utils";

const MODEL_SPORT = "baseball_mlb";
const KELLY_MULTIPLIER = 0.25;
const MIN_EDGE_PERCENT = 1;

function formatProb(p: number | null | undefined) {
  if (p == null) return "—";
  return `${(p * 100).toFixed(1)}%`;
}

function statusBadge(status: string) {
  if (status === "closed") return "text-positive border-positive/40";
  if (status === "expired") return "text-muted-foreground border-border";
  return "text-primary border-primary/40";
}

// Exported so the component test can lock in the duplicate-log framing:
// a 409 from the create endpoint means the pick is already in the scorecard,
// which must surface as a neutral "Already logged" toast, not a red failure.
export function ProjectionCard({ projection }: { projection: ModelPitcherProjection }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createPaperTrade = useCreatePaperTrade();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListPaperTradesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPaperTradeSummaryQueryKey() });
  };

  const logTrade = (line: ModelKLine) => {
    if (!isValidAmericanOdds(line.americanOdds)) {
      toast({
        title: "Invalid odds",
        description: `${line.americanOdds} is not a valid American odds price — must be -100 or below, or +100 and up.`,
        variant: "destructive",
      });
      return;
    }
    createPaperTrade.mutate(
      {
        data: {
          sport: projection.sport,
          gameId: projection.gameId,
          commenceTime: projection.commenceTime,
          homeTeam: projection.homeTeam,
          awayTeam: projection.awayTeam,
          pitcher: projection.pitcher,
          team: projection.team,
          opponent: projection.opponent,
          selection: line.selection,
          point: line.point,
          book: line.book,
          americanOdds: line.americanOdds,
          modelProb: line.modelProb,
          marketProb: line.marketProb,
          edgePercent: line.edgePercent,
          isFlagged: line.isFlagged,
          expectedStrikeouts: projection.expectedStrikeouts,
          projectedBattersFaced: projection.projectedBattersFaced,
          recommendedUnits: line.recommendedUnits,
          kellyMultiplier: KELLY_MULTIPLIER,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: "Paper trade logged",
            description: `${projection.pitcher} ${line.selection} ${line.point} K @ ${formatOdds(line.americanOdds)}`,
          });
          invalidate();
        },
        onError: (err) => {
          // A 409 means the pick is already in the scorecard (each pick counts
          // once) — frame it as information, not a failure.
          const isDuplicate = err.status === 409;
          toast({
            title: isDuplicate ? "Already logged" : "Failed to log paper trade",
            description: err.data?.error || "An unknown error occurred.",
            variant: isDuplicate ? "default" : "destructive",
          });
        },
      },
    );
  };

  if (projection.insufficientData) {
    return (
      <Card className="overflow-hidden border-amber-500/30 bg-amber-500/5">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-base">{projection.pitcher}</span>
            {projection.throws && (
              <Badge variant="outline" className="font-mono text-[10px]">{projection.throws}HP</Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {projection.team}
            {projection.opponent ? ` · vs ${projection.opponent}` : ""}
          </div>
          <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-500">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Insufficient data — no recent or season strikeout inputs, so the model won't project this start.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-base">{projection.pitcher}</span>
              {projection.throws && (
                <Badge variant="outline" className="font-mono text-[10px]">{projection.throws}HP</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {projection.team} · vs {projection.opponent}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="font-mono font-semibold text-primary">{projection.expectedStrikeouts.toFixed(2)}</div>
              <div className="text-[10px] uppercase text-muted-foreground">Proj K</div>
            </div>
            <div>
              <div className="font-mono font-semibold">{projection.projectedBattersFaced.toFixed(1)}</div>
              <div className="text-[10px] uppercase text-muted-foreground">Proj BF</div>
            </div>
            <div>
              <div className="font-mono font-semibold">{projection.opponentFactor.toFixed(2)}×</div>
              <div className="text-[10px] uppercase text-muted-foreground">Opp Adj</div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-muted-foreground">
          <span>K/BF {(projection.ratePerBF * 100).toFixed(1)}%</span>
          <span>sample {projection.sampleStarts} starts / {projection.sampleBattersFaced} BF</span>
          {!projection.opponentDataAvailable && <span className="text-amber-500">opp split N/A — using neutral adj</span>}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Line</TableHead>
              <TableHead className="text-right">Model</TableHead>
              <TableHead className="text-right">Market</TableHead>
              <TableHead className="text-right">Edge</TableHead>
              <TableHead className="text-right">Odds</TableHead>
              <TableHead>Book</TableHead>
              <TableHead className="text-right">Kelly</TableHead>
              <TableHead className="w-[70px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projection.lines.map((line, idx) => (
              <TableRow key={`${line.point}-${line.selection}-${idx}`} className={cn(line.isFlagged && "bg-positive/5")}>
                <TableCell className="font-medium whitespace-nowrap">
                  {line.selection} {line.point}
                  {line.isFlagged && <Target className="inline ml-1.5 h-3 w-3 text-positive" />}
                </TableCell>
                <TableCell className="text-right font-mono">{formatProb(line.modelProb)}</TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">{formatProb(line.marketProb)}</TableCell>
                <TableCell className={cn("text-right font-mono font-semibold", (line.edgePercent ?? 0) > 0 ? "text-positive" : "text-muted-foreground")}>
                  {formatPercent(line.edgePercent)}
                </TableCell>
                <TableCell className="text-right font-mono text-primary">{formatOdds(line.americanOdds)}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{line.book}</TableCell>
                <TableCell className="text-right font-mono">{line.recommendedUnits > 0 ? `${line.recommendedUnits}u` : "—"}</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant={line.isFlagged ? "secondary" : "ghost"}
                    className="h-7 px-2"
                    aria-label={
                      isValidAmericanOdds(line.americanOdds)
                        ? `Log paper trade ${projection.pitcher} ${line.selection} ${line.point}`
                        : `Cannot log — invalid odds ${line.americanOdds} for ${projection.pitcher} ${line.selection} ${line.point}`
                    }
                    disabled={createPaperTrade.isPending || !isValidAmericanOdds(line.americanOdds)}
                    onClick={() => logTrade(line)}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ValidationSummary() {
  const { data: summary } = useGetPaperTradeSummary();
  if (!summary) return null;

  const stats = [
    { label: "Paper Trades", value: String(summary.total) },
    { label: "Open", value: String(summary.open) },
    { label: "Graded", value: String(summary.gradedCount) },
    { label: "Beat Close", value: summary.beatCloseRate == null ? "—" : `${(summary.beatCloseRate * 100).toFixed(0)}%` },
    { label: "Avg CLV", value: summary.avgClvPercent == null ? "—" : formatPercent(summary.avgClvPercent) },
    { label: "Avg Edge", value: summary.avgEdgePercent == null ? "—" : formatPercent(summary.avgEdgePercent) },
  ];

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide">Model Validation</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {stats.map((s) => (
            <div key={s.label}>
              <div className="font-mono font-bold text-lg">{s.value}</div>
              <div className="text-[10px] uppercase text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[10px] font-mono text-muted-foreground">
          Closing lines are captured near first pitch to measure beat-the-close and CLV. A model with genuine edge should beat the close well over 50% of the time.
        </p>
      </CardContent>
    </Card>
  );
}

// Correct a mistyped price without delete-and-relog: deleting loses the edge
// snapshot and any captured closing line, and re-logging is impossible once
// the game starts. Editing keeps the row's history; the server recomputes
// CLV%/beat-close from the corrected price if a close was already captured.
export function EditPaperTradeDialog({ trade, open, onOpenChange, onSaved }: {
  trade: PaperTrade;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const updateTrade = useUpdatePaperTrade();
  const [oddsText, setOddsText] = useState(String(trade.americanOdds));

  // Re-seed the input each time the dialog opens for a (possibly different) trade.
  useEffect(() => {
    if (open) {
      setOddsText(String(trade.americanOdds));
    }
  }, [open, trade.id, trade.americanOdds]);

  const parsed = parseOddsInput(oddsText);

  const save = () => {
    if (!parsed.valid) return;
    updateTrade.mutate(
      { id: trade.id, data: { americanOdds: parsed.value } },
      {
        onSuccess: () => {
          toast({
            title: "Price corrected",
            description: `${trade.pitcher} ${trade.selection} ${trade.point} K is now ${formatOdds(parsed.value)}.${trade.closingOdds != null ? " CLV was recomputed against the captured close." : ""}`,
          });
          onSaved();
          onOpenChange(false);
        },
        onError: (err) => {
          toast({
            title: "Failed to correct price",
            description: err?.data?.error || "An unknown error occurred.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Correct logged price</DialogTitle>
          <DialogDescription>
            {trade.pitcher} {trade.selection} {trade.point} K @ {trade.book}. Only the logged price changes —
            the edge snapshot and any captured closing line stay as recorded
            {trade.closingOdds != null ? ", and CLV is recomputed from the corrected price" : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="paper-trade-odds">American odds</Label>
          <Input
            id="paper-trade-odds"
            inputMode="text"
            value={oddsText}
            onChange={(e) => setOddsText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            aria-invalid={!parsed.valid}
            placeholder="-110"
          />
          {!parsed.valid && (
            <p className="text-xs text-destructive" role="alert">
              Odds must be -100 or below, or +100 and up (e.g. -110).
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={updateTrade.isPending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={updateTrade.isPending || !parsed.valid}>
            {updateTrade.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Save price
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Exported so the component test can lock in the graded-delete guard:
// closed (graded) picks must confirm before deleting; open/expired delete
// immediately with an undo toast.
export function PaperTradesTable() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: trades, isLoading } = useListPaperTrades();
  const deleteTrade = useDeletePaperTrade();
  const restoreTrade = useRestorePaperTrade();
  // Deleting a graded (closed) pick rewrites the model's validation stats, so
  // it gets a blocking confirm dialog; open/expired picks delete immediately
  // with the lightweight undo toast.
  const [confirmTrade, setConfirmTrade] = useState<PaperTrade | null>(null);
  // A mistyped price is corrected in place (dialog) rather than delete-and-relog,
  // which would lose the edge snapshot and any captured closing line.
  const [editTrade, setEditTrade] = useState<PaperTrade | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListPaperTradesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPaperTradeSummaryQueryKey() });
  };

  // Undo a delete: the server soft-deletes for a grace period, so restore
  // brings back the exact row — logged odds, edge, and any closing-line data.
  const undoDelete = (trade: PaperTrade) => {
    restoreTrade.mutate(
      { id: trade.id },
      {
        onSuccess: () => {
          toast({
            title: "Paper trade restored",
            description: `${trade.pitcher} ${trade.selection} ${trade.point} K is back in the scorecard.`,
          });
          invalidate();
        },
        onError: (err) => {
          toast({
            title: "Could not undo",
            description: err.data?.error || "This pick can no longer be restored.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const remove = (trade: PaperTrade) => {
    deleteTrade.mutate(
      { id: trade.id },
      {
        onSuccess: () => {
          toast({
            title: "Paper trade deleted",
            description: `${trade.pitcher} ${trade.selection} ${trade.point} K removed from the scorecard.`,
            action: (
              <ToastAction altText="Undo delete" onClick={() => undoDelete(trade)}>
                Undo
              </ToastAction>
            ),
          });
          invalidate();
        },
        onError: (err) => {
          toast({
            title: "Failed to delete paper trade",
            description: err.data?.error || "An unknown error occurred.",
            variant: "destructive",
          });
        },
      },
    );
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4 space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Pitcher</TableHead>
            <TableHead>Line</TableHead>
            <TableHead className="text-right">Odds</TableHead>
            <TableHead className="text-right">Model</TableHead>
            <TableHead className="text-right">Edge</TableHead>
            <TableHead className="text-right">Close</TableHead>
            <TableHead className="text-right">CLV</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[80px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(trades?.length ?? 0) === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-muted-foreground py-12">
                <div className="flex flex-col items-center gap-2">
                  <Target className="h-6 w-6 opacity-30" />
                  <p>No paper trades logged yet.</p>
                  <p className="text-xs opacity-70">Scan a game in Projections and log the model's flags.</p>
                </div>
              </TableCell>
            </TableRow>
          ) : (
            trades!.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <div className="font-medium text-xs whitespace-nowrap">{t.pitcher}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{formatGameTime(t.commenceTime)}</div>
                </TableCell>
                <TableCell className="whitespace-nowrap font-medium">{t.selection} {t.point}</TableCell>
                <TableCell className="text-right font-mono text-primary">{formatOdds(t.americanOdds)}</TableCell>
                <TableCell className="text-right font-mono">{formatProb(t.modelProb)}</TableCell>
                <TableCell className="text-right font-mono">{formatPercent(t.edgePercent)}</TableCell>
                <TableCell className="text-right font-mono text-muted-foreground">{t.closingOdds == null ? "—" : formatOdds(t.closingOdds)}</TableCell>
                <TableCell className={cn("text-right font-mono font-semibold", t.clvPercent == null ? "text-muted-foreground" : t.clvPercent > 0 ? "text-positive" : "text-destructive")}>
                  {t.clvPercent == null ? "—" : formatPercent(t.clvPercent)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={cn("text-[10px] uppercase font-mono", statusBadge(t.status))}>{t.status}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-muted-foreground hover:text-foreground"
                      aria-label={`Edit price for paper trade ${t.pitcher} ${t.selection} ${t.point}`}
                      onClick={() => setEditTrade(t)}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-muted-foreground hover:text-destructive"
                      aria-label={`Delete paper trade ${t.pitcher} ${t.selection} ${t.point}`}
                      onClick={() => (t.status === "closed" ? setConfirmTrade(t) : remove(t))}
                      disabled={deleteTrade.isPending}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {editTrade && (
        <EditPaperTradeDialog
          trade={editTrade}
          open={editTrade != null}
          onOpenChange={(open) => { if (!open) setEditTrade(null); }}
          onSaved={invalidate}
        />
      )}
      <AlertDialog open={confirmTrade != null} onOpenChange={(open) => { if (!open) setConfirmTrade(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete a graded pick?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTrade
                ? `${confirmTrade.pitcher} ${confirmTrade.selection} ${confirmTrade.point} K is already graded against the closing line. `
                : ""}
              Deleting it changes the scorecard's beat-close rate and average CLV — the model's
              validation stats. Only remove it if the pick was logged in error.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep pick</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmTrade) remove(confirmTrade);
                setConfirmTrade(null);
              }}
            >
              Delete graded pick
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default function ModelEdges() {
  const [tab, setTab] = useState<"projections" | "paper" | "performance">("projections");
  const [selectedEventId, setSelectedEventId] = useState<string>("");

  const [selectedDay, setSelectedDay] = useState<string>("");

  const { data: events, isLoading: loadingEvents, isError: eventsError } = useListEvents(
    { sport: MODEL_SPORT },
    { query: { queryKey: getListEventsQueryKey({ sport: MODEL_SPORT }) } },
  );

  type Ev = NonNullable<typeof events>[number];
  const eventsByDay = useMemo(() => {
    const map: Record<string, Ev[]> = {};
    for (const ev of events ?? []) {
      const key = easternDayKey(ev.commenceTime);
      if (!key) continue;
      (map[key] ??= []).push(ev);
    }
    return map;
  }, [events]);
  const dayKeys = useMemo(() => Object.keys(eventsByDay).sort(), [eventsByDay]);

  // Default to the soonest day with games, and keep the selection valid as the
  // event list refreshes (a day can empty out once its games start). When the
  // day is auto-corrected, drop any selected game too so a stale paid scan
  // can't keep running against a game that's no longer on the visible slate.
  const dayEvents = eventsByDay[selectedDay] ?? [];
  // Only treat a game as selected while it's actually on the current day's
  // slate — a defensive gate so the credit-priced projection scan never fires
  // for a game outside the visible list.
  const selectedEventValid = dayEvents.some((ev) => ev.id === selectedEventId);

  useEffect(() => {
    if (dayKeys.length > 0 && !dayKeys.includes(selectedDay)) {
      // Day dropped off the slate (its games started) — move to the soonest
      // remaining day and drop the selection with it.
      setSelectedDay(dayKeys[0]);
      setSelectedEventId("");
    } else if (selectedEventId && !selectedEventValid) {
      // Same-day game vanished on refresh — clear it so no stale paid scan
      // lingers and the UI falls back to the "pick a game" prompt.
      setSelectedEventId("");
    }
  }, [dayKeys, selectedDay, selectedEventId, selectedEventValid]);

  const { data: projections, isLoading: loadingProjections, isFetching: fetchingProjections, isError: projectionsError } = useListModelEdges(
    { sport: MODEL_SPORT, eventId: selectedEventId, minEdgePercent: MIN_EDGE_PERCENT, kellyMultiplier: KELLY_MULTIPLIER },
    {
      query: {
        enabled: !!selectedEventId && selectedEventValid && tab === "projections",
        queryKey: getListModelEdgesQueryKey({ sport: MODEL_SPORT, eventId: selectedEventId, minEdgePercent: MIN_EDGE_PERCENT, kellyMultiplier: KELLY_MULTIPLIER }),
      },
    },
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Brain className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Strikeout Model</h1>
        </div>
        <p className="text-muted-foreground">Fundamental pitcher-strikeout projections vs the market, with Kelly staking and beat-the-close validation. MLB only.</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "projections" | "paper" | "performance")}>
        <TabsList className="grid w-full grid-cols-3 sm:w-[30rem]">
          <TabsTrigger value="projections">Projections</TabsTrigger>
          <TabsTrigger value="paper">Paper Trades</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>

        <TabsContent value="projections" className="mt-4 space-y-4">
          <div className="space-y-3">
            {loadingEvents ? (
              <div className="flex gap-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-24" />)}
              </div>
            ) : dayKeys.length > 0 ? (
              <div className="flex gap-2 overflow-x-auto pb-1">
                {dayKeys.map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    variant={k === selectedDay ? "default" : "outline"}
                    className="shrink-0"
                    onClick={() => {
                      setSelectedDay(k);
                      setSelectedEventId("");
                    }}
                  >
                    {formatDayLabel(k)}
                    <Badge variant="secondary" className="ml-2 px-1.5 font-mono text-[10px]">
                      {eventsByDay[k].length}
                    </Badge>
                  </Button>
                ))}
              </div>
            ) : null}

            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
              <div className="w-full sm:w-96">
                <Label className="mb-2 block">Select Game</Label>
                <Select
                  value={selectedEventId}
                  onValueChange={setSelectedEventId}
                  disabled={loadingEvents || dayEvents.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={loadingEvents ? "Loading games..." : "Choose an MLB game"} />
                  </SelectTrigger>
                  <SelectContent>
                    {dayEvents.map((ev) => (
                      <SelectItem key={ev.id} value={ev.id}>
                        {ev.awayTeam} @ {ev.homeTeam} — {formatTimeOnly(ev.commenceTime)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="font-mono text-[10px] text-muted-foreground">Each game scan uses a few odds-API credits.</p>
            </div>
          </div>

          {eventsError && (
            <div className="flex flex-col items-center justify-center h-40 border border-destructive/20 bg-destructive/5 rounded-lg space-y-2">
              <p className="text-destructive font-mono">GAMES_UNAVAILABLE</p>
              <p className="text-sm text-muted-foreground">Could not load upcoming games.</p>
            </div>
          )}

          {!eventsError && events && events.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center h-40 text-muted-foreground">
                <p>No upcoming MLB games listed right now.</p>
              </CardContent>
            </Card>
          )}

          {!selectedEventId && !eventsError && (events?.length ?? 0) > 0 && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-4">
                <Brain className="h-8 w-8 opacity-50" />
                <p>Pick a game to project its starters' strikeouts</p>
              </CardContent>
            </Card>
          )}

          {selectedEventId && loadingProjections && (
            <Card>
              <CardContent className="p-4 space-y-4">
                {[1, 2].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
              </CardContent>
            </Card>
          )}

          {selectedEventId && projectionsError && (
            <div className="flex flex-col items-center justify-center h-64 border border-destructive/20 bg-destructive/5 rounded-lg space-y-2">
              <p className="text-destructive font-mono">PROJECTION_FAILED</p>
              <p className="text-sm text-muted-foreground">Could not project this game.</p>
            </div>
          )}

          {selectedEventId && !loadingProjections && !projectionsError && projections && (
            <div className="space-y-4">
              {fetchingProjections && (
                <div className="flex items-center text-xs text-primary animate-pulse">
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Projecting...
                </div>
              )}
              {projections.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-2 text-center px-6">
                    <Brain className="h-8 w-8 opacity-50" />
                    <p>No strikeout lines available for this game.</p>
                    <p className="text-xs opacity-70">The pitcher-strikeout market may not be posted yet, or probable starters aren't announced.</p>
                  </CardContent>
                </Card>
              ) : (
                projections.map((p) => <ProjectionCard key={`${p.gameId}-${p.pitcher}`} projection={p} />)
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="paper" className="mt-4 space-y-4">
          <ValidationSummary />
          <PaperTradesTable />
        </TabsContent>

        <TabsContent value="performance" className="mt-4 space-y-4">
          <ModelPerformance />
        </TabsContent>
      </Tabs>
    </div>
  );
}
