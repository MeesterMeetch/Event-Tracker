import { useRef, useState } from "react";
import {
  useGenerateGameAnalysis,
  type EdgeOpportunity,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatGameTime } from "@workspace/format";
import { Sparkles, Loader2 } from "lucide-react";

/**
 * AI write-up for one game on the Top Plays board.
 *
 * Scoped to a game rather than to a play on purpose. The endpoint requires every
 * edge in a request to belong to the same game and caches its answer per game,
 * so sending the whole game's picks costs one call and a second pick from that
 * game reuses it rather than paying again.
 *
 * Nothing runs until the dialog is opened. This is a billed AI call and the
 * board can hold fifteen rows, so firing on render would turn a scan into
 * fifteen requests nobody asked for.
 */
export default function AnalyzeGameDialog({
  edges,
  children,
}: {
  /** Every pick from one game. Must be non-empty and share a gameId. */
  edges: EdgeOpportunity[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const analyze = useGenerateGameAnalysis();
  const started = useRef(false);
  const head = edges[0];

  const run = () => {
    analyze.mutate({
      data: {
        sport: head.sport,
        gameId: head.gameId,
        homeTeam: head.homeTeam,
        awayTeam: head.awayTeam,
        commenceTime: head.commenceTime,
        // Passed through unchanged. Unlike the strikeout dialog, which has to
        // synthesise the market-confidence fields a model projection does not
        // have, these are already real scanner edges.
        edges,
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
            <DialogTitle>
              AI Analysis — {head.awayTeam} at {head.homeTeam}
            </DialogTitle>
          </div>
          <DialogDescription>
            {formatGameTime(head.commenceTime)} ·{" "}
            {edges.length === 1 ? "1 pick" : `${edges.length} picks`} from this game
          </DialogDescription>
        </DialogHeader>

        {analyze.isPending && (
          <div
            className="flex flex-col items-center justify-center py-12 space-y-3 text-muted-foreground"
            data-testid="state-analysis-pending"
          >
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-sm">Reading the matchup and the market…</p>
            <p className="text-xs opacity-70">This can take a few seconds.</p>
          </div>
        )}

        {analyze.isError && (
          <div
            className="rounded-md border border-destructive/20 bg-destructive/5 p-4 text-center"
            data-testid="state-analysis-error"
          >
            <p className="text-destructive font-mono text-sm">ANALYSIS_FAILED</p>
            <p className="text-xs text-muted-foreground mt-1">
              {analyze.error?.data?.error || "Could not generate analysis."}
            </p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={run}>
              Retry
            </Button>
          </div>
        )}

        {data && (
          <div className="space-y-5" data-testid="state-analysis-ready">
            <p className="text-sm leading-relaxed">{data.summary}</p>

            {data.keyFactors.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {data.keyFactors.map((f, i) => (
                  <Badge key={i} variant="secondary" className="font-normal">
                    {f}
                  </Badge>
                ))}
              </div>
            )}

            {data.matchupAnalysis && (
              <div>
                <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">
                  Matchup / Form
                </div>
                <p className="text-sm leading-relaxed text-foreground/90">
                  {data.matchupAnalysis}
                </p>
              </div>
            )}

            {data.bettingAngle && (
              <div>
                <div className="text-xs font-semibold uppercase text-muted-foreground mb-1">
                  Betting Angle
                </div>
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
