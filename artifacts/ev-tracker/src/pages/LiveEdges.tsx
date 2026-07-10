import { useState } from "react";
import { useListSports, useListEdges, useCreateBet, getListEdgesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatOdds, formatPercent, formatPoint } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Plus, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import type { EdgeOpportunity } from "@workspace/api-client-react";

const logBetSchema = z.object({
  units: z.coerce.number().min(0.01, "Must wager at least 0.01 units"),
  notes: z.string().optional(),
});

type LogBetFormValues = z.infer<typeof logBetSchema>;

function LogBetDialog({ edge, children }: { edge: EdgeOpportunity, children: React.ReactNode }) {
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
    createBet.mutate({
      data: {
        sport: edge.sport,
        gameId: edge.gameId,
        commenceTime: edge.commenceTime,
        homeTeam: edge.homeTeam,
        awayTeam: edge.awayTeam,
        market: edge.market,
        selection: edge.selection,
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
          description: `Successfully logged ${data.units}u on ${edge.selection}.`,
        });
        setOpen(false);
        form.reset();
      },
      onError: (err) => {
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
            <span className="text-muted-foreground">{edge.market.toUpperCase()}</span>
            <span className="font-mono">{edge.book}</span>
          </div>
          <div className="flex justify-between items-center text-lg mt-2">
            <span className="font-bold">{edge.selection} {formatPoint(edge.point, edge.market)}</span>
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

export default function LiveEdges() {
  const [selectedSport, setSelectedSport] = useState<string>("");
  
  const { data: sports, isLoading: loadingSports } = useListSports();
  const { data: edges, isLoading: loadingEdges, isFetching: fetchingEdges, isError } = useListEdges(
    { sport: selectedSport },
    { query: { enabled: !!selectedSport, queryKey: getListEdgesQueryKey({ sport: selectedSport }) } }
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">Live Edges</h1>
          <p className="text-muted-foreground">Scan real-time +EV opportunities across markets.</p>
        </div>
        
        <div className="w-full sm:w-64">
          <Label className="mb-2 block">Select Market</Label>
          <Select value={selectedSport} onValueChange={setSelectedSport} disabled={loadingSports}>
            <SelectTrigger>
              <SelectValue placeholder={loadingSports ? "Loading markets..." : "Choose a sport"} />
            </SelectTrigger>
            <SelectContent>
              {sports?.map(sport => (
                <SelectItem key={sport.key} value={sport.key}>
                  {sport.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

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
                  <TableHead className="w-[100px]"></TableHead>
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
                          <br/>
                          {edge.awayTeam}
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
                        <LogBetDialog edge={edge}>
                          <Button size="sm" variant="secondary" className="w-full">
                            Log
                          </Button>
                        </LogBetDialog>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}
    </div>
  );
}
