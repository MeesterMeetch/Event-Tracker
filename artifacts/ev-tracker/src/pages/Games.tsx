import { useState } from "react";
import { CalendarIcon, Clock, User } from "lucide-react";
import { useListMlbGames } from "@workspace/api-client-react";
import type { GameSummary } from "@workspace/api-client-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Returns today's date as YYYY-MM-DD in US Eastern time. */
function todayEastern(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Parses a YYYY-MM-DD date string as a local (wall-clock) Date so the
 * Calendar widget doesn't shift the displayed day due to timezone offset.
 */
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDateLabel(dateStr: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parseLocalDate(dateStr));
}

function formatGameTime(gameDate: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(gameDate));
}

type StatusVariant = "default" | "secondary" | "outline";

function statusVariant(state: string): StatusVariant {
  if (state === "Live") return "default";
  if (state === "Final") return "secondary";
  return "outline";
}

function GameCard({ game }: { game: GameSummary }) {
  const hasScore =
    game.status.abstractGameState === "Live" ||
    game.status.abstractGameState === "Final";

  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {/* Start time */}
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              <span>{formatGameTime(game.gameDate)}</span>
            </div>

            {/* Matchup with scores */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{game.awayTeam}</span>
                {hasScore && game.awayScore != null && (
                  <span className="font-mono font-bold text-lg tabular-nums leading-none">
                    {game.awayScore}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium truncate">{game.homeTeam}</span>
                {hasScore && game.homeScore != null && (
                  <span className="font-mono font-bold text-lg tabular-nums leading-none">
                    {game.homeScore}
                  </span>
                )}
              </div>
            </div>

            {/* Probable pitchers */}
            {(game.awayProbablePitcher || game.homeProbablePitcher) && (
              <div className="mt-3 pt-3 border-t border-border space-y-1">
                {game.awayProbablePitcher && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <User className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {game.awayTeam.split(" ").slice(-1)[0]}:{" "}
                      {game.awayProbablePitcher.name}
                    </span>
                  </div>
                )}
                {game.homeProbablePitcher && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <User className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {game.homeTeam.split(" ").slice(-1)[0]}:{" "}
                      {game.homeProbablePitcher.name}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Status badge */}
          <Badge variant={statusVariant(game.status.abstractGameState)} className="shrink-0 mt-0.5">
            {game.status.detailedState}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Games() {
  const [selectedDate, setSelectedDate] = useState(todayEastern);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const { data: games, isLoading, isError } = useListMlbGames({ date: selectedDate });

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold font-mono">MLB Games</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Schedule, probable starters, and live scores
          </p>
        </div>

        {/* Date picker */}
        <div className="sm:ml-auto">
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-[210px] justify-start gap-2 font-normal">
                <CalendarIcon className="h-4 w-4 shrink-0" />
                {formatDateLabel(selectedDate)}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar
                mode="single"
                selected={parseLocalDate(selectedDate)}
                onSelect={(date) => {
                  if (!date) return;
                  const y = date.getFullYear();
                  const m = String(date.getMonth() + 1).padStart(2, "0");
                  const d = String(date.getDate()).padStart(2, "0");
                  setSelectedDate(`${y}-${m}-${d}`);
                  setCalendarOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="text-center py-16 space-y-2">
          <p className="font-medium text-destructive">Failed to load schedule.</p>
          <p className="text-sm text-muted-foreground">Check your connection and try again.</p>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && games != null && games.length === 0 && (
        <div className="text-center py-16 space-y-2">
          <p className="font-medium">No games scheduled for this date.</p>
          <p className="text-sm text-muted-foreground">Try a different date.</p>
        </div>
      )}

      {/* Game grid */}
      {!isLoading && !isError && games != null && games.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {games.map((game) => (
            <GameCard key={game.gamePk} game={game} />
          ))}
        </div>
      )}
    </div>
  );
}
