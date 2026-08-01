import { useState } from "react";
import {
  useListRankingsSports,
  useListStandings,
  useListLeaders,
  getListStandingsQueryKey,
  getListLeadersQueryKey,
} from "@workspace/api-client-react";
import type { StandingsGroup, LeaderCategory } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy } from "lucide-react";

// Standings move ~daily and are cached server-side anyway; keep them fresh
// for a while client-side so flipping between sports is instant.
const RANKINGS_STALE_MS = 10 * 60 * 1000;

function StandingsTable({ group }: { group: StandingsGroup }) {
  // Leagues differ in which columns exist (soccer has points but no GB/streak,
  // MLB has no ties, NHL counts OT losses) — show only columns with data.
  const hasTies = group.teams.some((t) => t.ties !== null && t.ties > 0);
  const hasPct = group.teams.some((t) => t.winPct !== null);
  const hasGb = group.teams.some((t) => t.gamesBack !== null);
  const hasPts = group.teams.some((t) => t.points !== null);
  const hasStreak = group.teams.some((t) => t.streak !== null);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="py-3 px-4 border-b border-border">
        <CardTitle className="text-sm font-mono uppercase tracking-wide">{group.name}</CardTitle>
      </CardHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">#</TableHead>
            <TableHead>Team</TableHead>
            <TableHead className="text-right">W</TableHead>
            <TableHead className="text-right">L</TableHead>
            {hasTies && <TableHead className="text-right">T/OT</TableHead>}
            {hasPct && <TableHead className="text-right">PCT</TableHead>}
            {hasGb && <TableHead className="text-right">GB</TableHead>}
            {hasPts && <TableHead className="text-right">PTS</TableHead>}
            {hasStreak && <TableHead className="text-right">STRK</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.teams.map((t) => (
            <TableRow key={t.team}>
              <TableCell className="font-mono text-xs text-muted-foreground">{t.rank}</TableCell>
              <TableCell className="font-medium text-xs whitespace-nowrap">{t.team}</TableCell>
              <TableCell className="text-right font-mono text-xs">{t.wins}</TableCell>
              <TableCell className="text-right font-mono text-xs">{t.losses}</TableCell>
              {hasTies && (
                <TableCell className="text-right font-mono text-xs">{t.ties ?? "—"}</TableCell>
              )}
              {hasPct && (
                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                  {t.winPct ?? "—"}
                </TableCell>
              )}
              {hasGb && (
                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                  {t.gamesBack ?? "—"}
                </TableCell>
              )}
              {hasPts && (
                <TableCell className="text-right font-mono text-xs font-semibold">
                  {t.points ?? "—"}
                </TableCell>
              )}
              {hasStreak && (
                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                  {t.streak ?? "—"}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function LeadersCard({ category }: { category: LeaderCategory }) {
  return (
    <Card>
      <CardHeader className="py-3 px-4 border-b border-border">
        <CardTitle className="text-sm font-mono uppercase tracking-wide">{category.label}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-2.5">
        {category.leaders.map((l) => (
          <div key={`${l.rank}-${l.player}`} className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-4 shrink-0 font-mono text-xs text-muted-foreground">{l.rank}</span>
              <div className="min-w-0">
                <div className="text-xs font-medium truncate">{l.player}</div>
                {l.team && <div className="text-[10px] text-muted-foreground truncate">{l.team}</div>}
              </div>
            </div>
            <span className="font-mono text-sm font-semibold text-primary">{l.value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function Rankings() {
  const [sport, setSport] = useState<string>("");

  const { data: sports, isLoading: loadingSports } = useListRankingsSports();
  const { data: standings, isLoading: loadingStandings, isError: standingsError } = useListStandings(
    { sport },
    {
      query: {
        enabled: !!sport,
        queryKey: getListStandingsQueryKey({ sport }),
        staleTime: RANKINGS_STALE_MS,
      },
    },
  );
  const { data: leaders, isLoading: loadingLeaders, isError: leadersError } = useListLeaders(
    { sport },
    {
      query: {
        enabled: !!sport,
        queryKey: getListLeadersQueryKey({ sport }),
        staleTime: RANKINGS_STALE_MS,
      },
    },
  );

  const sportsByGroup = new Map<string, NonNullable<typeof sports>>();
  for (const s of sports ?? []) {
    const list = sportsByGroup.get(s.group) ?? [];
    list.push(s);
    sportsByGroup.set(s.group, list);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">Rankings</h1>
          <p className="text-muted-foreground">League standings and stat leaders for context on your edges.</p>
        </div>

        <div className="w-full sm:w-64">
          <Label className="mb-2 block">Select League</Label>
          <Select value={sport} onValueChange={setSport} disabled={loadingSports}>
            <SelectTrigger>
              <SelectValue placeholder={loadingSports ? "Loading leagues..." : "Choose a league"} />
            </SelectTrigger>
            <SelectContent>
              {Array.from(sportsByGroup.entries()).map(([group, items]) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {items.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.title}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!sport && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-4">
            <Trophy className="h-8 w-8 opacity-50" />
            <p>Select a league to view standings and leaders</p>
          </CardContent>
        </Card>
      )}

      {sport && loadingStandings && (
        <div className="grid gap-4 md:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardContent className="p-4 space-y-3">
                {[1, 2, 3, 4, 5].map((j) => (
                  <Skeleton key={j} className="h-8 w-full" />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {sport && standingsError && (
        <div className="flex flex-col items-center justify-center h-64 border border-destructive/20 bg-destructive/5 rounded-lg space-y-2">
          <p className="text-destructive font-mono">STANDINGS_UNAVAILABLE</p>
          <p className="text-sm text-muted-foreground">Could not retrieve standings from the feed.</p>
        </div>
      )}

      {sport && !loadingStandings && !standingsError && standings && (
        <div className={standings.length > 1 ? "grid gap-4 md:grid-cols-2" : "grid gap-4"}>
          {standings.map((group) => (
            <StandingsTable key={group.name} group={group} />
          ))}
        </div>
      )}

      {sport && !loadingLeaders && leadersError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-center">
          <p className="text-destructive font-mono text-sm">LEADERS_UNAVAILABLE</p>
          <p className="text-xs text-muted-foreground mt-1">Could not retrieve stat leaders from the feed.</p>
        </div>
      )}

      {sport && leaders && leaders.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">Stat Leaders</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {leaders.map((category) => (
              <LeadersCard key={category.key} category={category} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
