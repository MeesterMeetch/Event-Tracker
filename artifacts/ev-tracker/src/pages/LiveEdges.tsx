import { useState, useRef, useMemo } from "react";
import { useListSports, useListEdges, useListEvents, useListPropEdges, useListRankingsSports, useListStandings, useCreateBet, useGenerateGameAnalysis, getListEdgesQueryKey, getListEventsQueryKey, getListPropEdgesQueryKey, getListStandingsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatOdds, formatPercent, formatPoint, formatGameTime, formatMarketLabel } from "@/lib/utils";
import { isValidUnitsStake, propSelectionLabel } from "@workspace/format";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Plus, Loader2, Sparkles } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import type { EdgeOpportunity, ProbablePitcher } from "@workspace/api-client-react";

const logBetSchema = z.object({
  // Shared rule from @workspace/format keeps this form and the phone's
  // LogPropSheet agreeing on the minimum stake.
  units: z.coerce.number().refine(isValidUnitsStake, "Must wager at least 0.01 units"),
  notes: z.string().optional(),
});

type LogBetFormValues = z.infer<typeof logBetSchema>;

export function LogBetDialog({ edge, children }: { edge: EdgeOpportunity, children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const createBet = useCreateBet();
  
  const form = useForm<LogBetFormValues>({
    resolver: zodResolver(logBetSchema),
    defaultValues: {
      units: 1,
      notes: "",
    },
  });

  const onSubmit = (data: LogBetFormValues) => {
    // Prop bets carry the player in the logged selection so the bet log
    // reads "Aaron Judge Over 1.5", not just "Over 1.5". Shared with mobile —
    // the server's duplicate-open-bet guard keys off this exact string.
    const selectionLabel = propSelectionLabel(edge);
    createBet.mutate({
      data: {
        sport: edge.sport,
        gameId: edge.gameId,
        commenceTime: edge.commenceTime,
        homeTeam: edge.homeTeam,
        awayTeam: edge.awayTeam,
        market: edge.market,
        selection: selectionLabel,
        point: edge.point,
        americanOdds: edge.americanOdds,
        units: data.units,
        fairOdds: edge.fairOdds,
        evPercent: edge.evPercent,
        book: edge.book,
        notes: data.notes || null,
      }
    }, {
      onSuccess: () => {
        toast({
          title: "Bet Logged",
          description: `Successfully logged ${data.units}u on ${selectionLabel}.`,
        });
        setOpen(false);
        form.reset();
      },
      onError: (err) => {
        if (err.status === 409) {
          // The identical bet is still open in the log — the server blocks
          // the repeat so units can't be double-counted. Close the dialog:
          // retrying can't succeed until the earlier bet settles.
          toast({
            title: "Already in your bet log",
            description: err.data?.error || `${selectionLabel} is already logged and still open.`,
          });
          setOpen(false);
          form.reset();
          return;
        }
        toast({
          title: "Failed to log bet",
          description: err.data?.error || "An unknown error occurred.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log Bet</DialogTitle>
          <DialogDescription>
            Record this +EV opportunity in your tracking terminal.
          </DialogDescription>
        </DialogHeader>
        
        <div className="rounded-md bg-muted p-4 space-y-2 mb-4">
          <div className="flex justify-between items-start text-sm">
            <span className="font-semibold">{edge.homeTeam} vs {edge.awayTeam}</span>
            <Badge variant="outline" className="uppercase font-mono text-[10px]">{edge.sport}</Badge>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">{formatMarketLabel(edge.market).toUpperCase()}</span>
            <span className="font-mono">{edge.book}</span>
          </div>
          <div className="flex justify-between items-center text-lg mt-2">
            <span className="font-bold">{edge.player ? `${edge.player} · ` : ""}{edge.selection} {formatPoint(edge.point, edge.market)}</span>
            <span className="font-mono text-primary">{formatOdds(edge.americanOdds)}</span>
          </div>
          <div className="flex justify-between text-xs mt-2 pt-2 border-t border-border">
            <span className="text-muted-foreground">Fair: {formatOdds(edge.fairOdds)}</span>
            <span className="text-positive font-mono font-semibold">EV: {formatPercent(edge.evPercent)}</span>
          </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="units"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Units</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (Optional)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="e.g. Line moving quickly, best price available" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className="mt-6">
              <Button type="submit" disabled={createBet.isPending} className="w-full sm:w-auto">
                {createBet.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                Log Bet
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function decisionClass(d: string): string {
  if (d === "W") return "text-positive";
  if (d === "L") return "text-destructive";
  return "text-muted-foreground";
}

function PitcherCard({ label, pitcher }: { label: string; pitcher: ProbablePitcher | null }) {
  if (!pitcher) {
    return (
      <div className="rounded-md border border-border p-3">
        <div className="text-[10px] uppercase text-muted-foreground mb-1">{label}</div>
        <div className="text-sm text-muted-foreground">Probable starter not announced.</div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
          <div className="font-semibold leading-tight">{pitcher.name}</div>
          <div className="text-xs text-muted-foreground">{pitcher.team}</div>
        </div>
        <Badge variant="outline" className="font-mono text-[10px]">{pitcher.seasonRecord ?? "—"}</Badge>
      </div>
      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-sm font-mono font-semibold">{pitcher.seasonEra ?? "—"}</div>
          <div className="text-[10px] text-muted-foreground">ERA</div>
        </div>
        <div>
          <div className="text-sm font-mono font-semibold">{pitcher.seasonWhip ?? "—"}</div>
          <div className="text-[10px] text-muted-foreground">WHIP</div>
        </div>
        <div>
          <div className="text-sm font-mono font-semibold">{pitcher.seasonStrikeouts ?? "—"}</div>
          <div className="text-[10px] text-muted-foreground">K</div>
        </div>
        <div>
          <div className="text-sm font-mono font-semibold">{pitcher.inningsPitched ?? "—"}</div>
          <div className="text-[10px] text-muted-foreground">IP</div>
        </div>
      </div>
      {pitcher.recentStarts.length > 0 && (
        <div className="pt-2 border-t border-border space-y-1">
          <div className="text-[10px] uppercase text-muted-foreground">Last {pitcher.recentStarts.length} Starts</div>
          {pitcher.recentStarts.map((s, i) => (
            <div key={i} className="flex items-center justify-between text-[11px] font-mono gap-2">
              <span className="text-muted-foreground truncate">{s.date.slice(5)} · {s.opponent}</span>
              <span className="whitespace-nowrap">
                {s.inningsPitched} IP, {s.earnedRuns} ER, {s.strikeOuts} K{" "}
                <span className={decisionClass(s.decision)}>{s.decision}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AnalyzeGameDialog({ edge, gameEdges, children }: { edge: EdgeOpportunity; gameEdges: EdgeOpportunity[]; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const analyze = useGenerateGameAnalysis();
  const started = useRef(false);

  const run = () => {
    analyze.mutate({
      data: {
        sport: edge.sport,
        gameId: edge.gameId,
        homeTeam: edge.homeTeam,
        awayTeam: edge.awayTeam,
        commenceTime: edge.commenceTime,
        edges: gameEdges,
      },
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && !started.current) {
      started.current = true;
      run();
    }
  };

  const data = analyze.data;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <DialogTitle>AI Game Analysis</DialogTitle>
          </div>
          <DialogDescription>{edge.awayTeam} @ {edge.homeTeam} · {formatGameTime(edge.commenceTime)}</DialogDescription>
        </DialogHeader>

        {analyze.isPending && (
          <div className="flex flex-col items-center justify-center py-12 space-y-3 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm">Scouting matchup, pitchers, and market signals…</p>
            <p className="text-xs opacity-70">This can take a few seconds.</p>
          </div>
        )}

        {analyze.isError && (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 p-4 text-center">
            <p className="text-destructive font-mono text-sm">ANALYSIS_FAILED</p>
            <p className="text-xs text-muted-foreground mt-1">{analyze.error?.data?.error || "Could not generate analysis."}</p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={run}>Retry</Button>
          </div>
        )}

        {data && (
          <div className="space-y-5">
            <p className="text-sm leading-relaxed">{data.summary}</p>

            {data.keyFactors.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {data.keyFactors.map((f, i) => (
                  <Badge key={i} variant="secondary" className="font-normal">{f}</Badge>
                ))}
              </div>
            )}

            {(data.homePitcher || data.awayPitcher) && (
              <div>
                <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Probable Starters</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <PitcherCard label={`Away — ${edge.awayTeam}`} pitcher={data.awayPitcher} />
                  <PitcherCard label={`Home — ${edge.homeTeam}`} pitcher={data.homePitcher} />
                </div>
              </div>
            )}

            {data.pitchingAnalysis && (
              <div>
                <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Pitching / Form</div>
                <p className="text-sm leading-relaxed text-foreground/90">{data.pitchingAnalysis}</p>
              </div>
            )}

            {data.bettingAngle && (
              <div>
                <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">Betting Angle</div>
                <p className="text-sm leading-relaxed text-foreground/90">{data.bettingAngle}</p>
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-border text-[10px] text-muted-foreground">
              <span>Model: {data.model}</span>
              <span>AI-generated — verify before betting</span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function LiveEdges() {
  const [selectedSport, setSelectedSport] = useState<string>("");
  const [tab, setTab] = useState<"games" | "props">("games");
  const [selectedEventId, setSelectedEventId] = useState<string>("");

  const { data: sports, isLoading: loadingSports } = useListSports();
  // Paid scans are gated on the active tab, so browsing props never triggers
  // a sport-wide game-lines scan (and vice versa). With focus refetches off
  // and a 60s staleTime, flipping tabs only re-scans once data is stale.
  const { data: edges, isLoading: loadingEdges, isFetching: fetchingEdges, isError } = useListEdges(
    { sport: selectedSport },
    { query: { enabled: !!selectedSport && tab === "games", queryKey: getListEdgesQueryKey({ sport: selectedSport }) } }
  );

  const currentSport = sports?.find((s) => s.key === selectedSport);
  const propsSupported = !!currentSport?.supportsProps;

  // The events listing is free on the Odds API, so it can prefetch as soon
  // as a props-capable sport is chosen. Scanning a game's props costs
  // credits, so that only fires once a specific game is picked.
  const { data: events, isLoading: loadingEvents, isError: eventsError } = useListEvents(
    { sport: selectedSport },
    { query: { enabled: !!selectedSport && propsSupported, queryKey: getListEventsQueryKey({ sport: selectedSport }) } }
  );
  const { data: propEdges, isLoading: loadingPropEdges, isFetching: fetchingPropEdges, isError: propEdgesError } = useListPropEdges(
    { sport: selectedSport, eventId: selectedEventId },
    { query: { enabled: !!selectedSport && !!selectedEventId && tab === "props", queryKey: getListPropEdgesQueryKey({ sport: selectedSport, eventId: selectedEventId }) } }
  );

  // Standings are free and cached server-side; they only decorate matchups
  // with team records. Variant keys (e.g. NFL preseason) share the base
  // league's standings, so match on the base-key prefix too.
  const { data: rankingsSports } = useListRankingsSports();
  const recordsAvailable = !!rankingsSports?.some(
    (s) => selectedSport === s.key || selectedSport.startsWith(`${s.key}_`),
  );
  const { data: sportStandings } = useListStandings(
    { sport: selectedSport },
    { query: { enabled: !!selectedSport && recordsAvailable, queryKey: getListStandingsQueryKey({ sport: selectedSport }), staleTime: 10 * 60 * 1000 } }
  );
  const teamRecords = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of sportStandings ?? []) {
      for (const t of group.teams) map.set(t.team.trim().toLowerCase(), t.record);
    }
    return map;
  }, [sportStandings]);
  // Exact normalized name match only — a missing record beats a wrong one.
  const recordFor = (team: string) => teamRecords.get(team.trim().toLowerCase());

  const handleSportChange = (value: string) => {
    setSelectedSport(value);
    setSelectedEventId("");
  };

  const sportsByGroup = new Map<string, NonNullable<typeof sports>>();
  for (const sport of sports ?? []) {
    const list = sportsByGroup.get(sport.group) ?? [];
    list.push(sport);
    sportsByGroup.set(sport.group, list);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">Live Edges</h1>
          <p className="text-muted-foreground">Scan real-time +EV opportunities across markets.</p>
        </div>
        
        <div className="w-full sm:w-64">
          <Label className="mb-2 block">Select Market</Label>
          <Select value={selectedSport} onValueChange={handleSportChange} disabled={loadingSports}>
            <SelectTrigger>
              <SelectValue placeholder={loadingSports ? "Loading markets..." : "Choose a sport"} />
            </SelectTrigger>
            <SelectContent>
              {Array.from(sportsByGroup.entries()).map(([group, items]) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {items.map(sport => (
                    <SelectItem key={sport.key} value={sport.key}>
                      {sport.title}
                      {sport.supportsProps && <span className="ml-2 font-mono text-[9px] uppercase text-primary/70">props</span>}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "games" | "props")}>
        <TabsList className="grid w-full grid-cols-2 sm:w-80">
          <TabsTrigger value="games">Game Lines</TabsTrigger>
          <TabsTrigger value="props">Player Props</TabsTrigger>
        </TabsList>

        <TabsContent value="games" className="mt-4 space-y-6">

      {!selectedSport && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-4">
            <Activity className="h-8 w-8 opacity-50" />
            <p>Select a sport to scan for live edges</p>
          </CardContent>
        </Card>
      )}

      {selectedSport && (loadingEdges) && (
        <Card>
          <CardContent className="p-0">
            <div className="p-4 space-y-4">
              {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          </CardContent>
        </Card>
      )}

      {selectedSport && isError && (
        <div className="flex flex-col items-center justify-center h-64 border border-destructive/20 bg-destructive/5 rounded-lg space-y-2">
          <p className="text-destructive font-mono">SCAN_FAILED</p>
          <p className="text-sm text-muted-foreground">Could not retrieve live odds data.</p>
        </div>
      )}

      {selectedSport && !loadingEdges && !isError && edges && (
        <div className="space-y-4">
          {fetchingEdges && (
            <div className="flex items-center text-xs text-primary animate-pulse">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Updating live odds...
            </div>
          )}
          
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Matchup</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead>Selection</TableHead>
                  <TableHead>Book</TableHead>
                  <TableHead className="text-right">Fair</TableHead>
                  <TableHead className="text-right">Odds</TableHead>
                  <TableHead className="text-right">EV%</TableHead>
                  <TableHead className="w-[130px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {edges.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-12">
                      <div className="flex flex-col items-center justify-center space-y-2">
                        <Activity className="h-6 w-6 opacity-30" />
                        <p>No +EV edges found right now.</p>
                        <p className="text-xs opacity-70">Markets are efficient. Wait for line movement.</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  edges.map((edge, idx) => (
                    <TableRow key={`${edge.gameId}-${edge.selection}-${edge.book}-${idx}`}>
                      <TableCell>
                        <div className="font-sans font-medium text-xs whitespace-nowrap">
                          {edge.homeTeam}
                          {recordFor(edge.homeTeam) && (
                            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{recordFor(edge.homeTeam)}</span>
                          )}
                          <br/>
                          {edge.awayTeam}
                          {recordFor(edge.awayTeam) && (
                            <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{recordFor(edge.awayTeam)}</span>
                          )}
                        </div>
                        <div className="mt-1 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                          {formatGameTime(edge.commenceTime)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[10px] uppercase font-mono">{edge.market}</Badge>
                      </TableCell>
                      <TableCell className="font-medium">
                        {edge.selection} {formatPoint(edge.point, edge.market)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{edge.book}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {formatOdds(edge.fairOdds)}
                      </TableCell>
                      <TableCell className="text-right text-primary font-bold">
                        {formatOdds(edge.americanOdds)}
                      </TableCell>
                      <TableCell className="text-right text-positive font-bold">
                        {formatPercent(edge.evPercent)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <AnalyzeGameDialog edge={edge} gameEdges={edges.filter((e) => e.gameId === edge.gameId)}>
                            <Button size="sm" variant="outline" className="w-full">
                              <Sparkles className="mr-1 h-3 w-3" />
                              Analyze
                            </Button>
                          </AnalyzeGameDialog>
                          <LogBetDialog edge={edge}>
                            <Button size="sm" variant="secondary" className="w-full">
                              Log
                            </Button>
                          </LogBetDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}

        </TabsContent>

        <TabsContent value="props" className="mt-4 space-y-4">
          {!selectedSport && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-4">
                <Activity className="h-8 w-8 opacity-50" />
                <p>Select a sport to browse player props</p>
              </CardContent>
            </Card>
          )}

          {selectedSport && sports && !propsSupported && (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-2 text-center px-6">
                <Activity className="h-8 w-8 opacity-50" />
                <p>Player props aren't available for this sport.</p>
                <p className="text-xs opacity-70">Props cover the major US leagues — look for the <span className="font-mono uppercase text-primary/70">props</span> tag in the sport picker.</p>
              </CardContent>
            </Card>
          )}

          {selectedSport && propsSupported && (
            <>
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2">
                <div className="w-full sm:w-96">
                  <Label className="mb-2 block">Select Game</Label>
                  <Select value={selectedEventId} onValueChange={setSelectedEventId} disabled={loadingEvents}>
                    <SelectTrigger>
                      <SelectValue placeholder={loadingEvents ? "Loading games..." : "Choose a game"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(events ?? []).map((ev) => (
                        <SelectItem key={ev.id} value={ev.id}>
                          {ev.awayTeam}{recordFor(ev.awayTeam) ? ` (${recordFor(ev.awayTeam)})` : ""} @ {ev.homeTeam}{recordFor(ev.homeTeam) ? ` (${recordFor(ev.homeTeam)})` : ""} — {formatGameTime(ev.commenceTime)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground">Each game scan uses a few odds-API credits.</p>
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
                    <p>No upcoming games listed for this sport.</p>
                  </CardContent>
                </Card>
              )}

              {!selectedEventId && !eventsError && (events?.length ?? 0) > 0 && (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-4">
                    <Activity className="h-8 w-8 opacity-50" />
                    <p>Pick a game to scan its player props</p>
                  </CardContent>
                </Card>
              )}

              {selectedEventId && loadingPropEdges && (
                <Card>
                  <CardContent className="p-0">
                    <div className="p-4 space-y-4">
                      {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
                    </div>
                  </CardContent>
                </Card>
              )}

              {selectedEventId && propEdgesError && (
                <div className="flex flex-col items-center justify-center h-64 border border-destructive/20 bg-destructive/5 rounded-lg space-y-2">
                  <p className="text-destructive font-mono">SCAN_FAILED</p>
                  <p className="text-sm text-muted-foreground">Could not retrieve player prop odds.</p>
                </div>
              )}

              {selectedEventId && !loadingPropEdges && !propEdgesError && propEdges && (
                <div className="space-y-4">
                  {fetchingPropEdges && (
                    <div className="flex items-center text-xs text-primary animate-pulse">
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Updating props...
                    </div>
                  )}

                  <Card className="overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Player</TableHead>
                          <TableHead>Market</TableHead>
                          <TableHead>Selection</TableHead>
                          <TableHead>Book</TableHead>
                          <TableHead className="text-right">Fair</TableHead>
                          <TableHead className="text-right">Odds</TableHead>
                          <TableHead className="text-right">EV%</TableHead>
                          <TableHead className="w-[130px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {propEdges.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={8} className="text-center text-muted-foreground py-12">
                              <div className="flex flex-col items-center justify-center space-y-2">
                                <Activity className="h-6 w-6 opacity-30" />
                                <p>No +EV player props found for this game.</p>
                                <p className="text-xs opacity-70">Books are aligned. Try another game or check back closer to start.</p>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : (
                          propEdges.map((edge, idx) => (
                            <TableRow key={`${edge.gameId}-${edge.market}-${edge.player}-${edge.selection}-${edge.book}-${idx}`}>
                              <TableCell>
                                <div className="font-sans font-medium text-xs whitespace-nowrap">{edge.player}</div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-[10px] uppercase font-mono">{formatMarketLabel(edge.market)}</Badge>
                              </TableCell>
                              <TableCell className="font-medium">
                                {edge.selection} {formatPoint(edge.point, edge.market)}
                              </TableCell>
                              <TableCell className="text-muted-foreground">{edge.book}</TableCell>
                              <TableCell className="text-right text-muted-foreground">
                                {formatOdds(edge.fairOdds)}
                              </TableCell>
                              <TableCell className="text-right text-primary font-bold">
                                {formatOdds(edge.americanOdds)}
                              </TableCell>
                              <TableCell className="text-right text-positive font-bold">
                                {formatPercent(edge.evPercent)}
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col gap-1">
                                  <AnalyzeGameDialog edge={edge} gameEdges={propEdges}>
                                    <Button size="sm" variant="outline" className="w-full">
                                      <Sparkles className="mr-1 h-3 w-3" />
                                      Analyze
                                    </Button>
                                  </AnalyzeGameDialog>
                                  <LogBetDialog edge={edge}>
                                    <Button size="sm" variant="secondary" className="w-full">
                                      Log
                                    </Button>
                                  </LogBetDialog>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </Card>
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
