import { useState } from "react";
import { useListBets, useUpdateBet, useDeleteBet, useRestoreBet, getListBetsQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatOdds, formatPercent, formatPoint, formatCurrency, formatMarketLabel } from "@/lib/utils";
import { isValidAmericanOdds, isValidUnitsStake } from "@workspace/format";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MoreHorizontal, Pencil, Trash2, Loader2, ListTodo } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import * as z from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import type { Bet, BetStatus } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const editBetSchema = z.object({
  status: z.enum(['pending', 'won', 'lost', 'push']),
  // Shared rules from @workspace/format keep this form and the phone's
  // EditBetSheet agreeing on what counts as a valid price and stake.
  americanOdds: z.coerce
    .number()
    .refine(isValidAmericanOdds, "Odds must be -100 or below, or +100 and up (e.g. -110)"),
  units: z.coerce.number().refine(isValidUnitsStake, "Must wager at least 0.01 units"),
  pnl: z.coerce.number().nullable().optional(),
  notes: z.string().optional().nullable(),
});

type EditBetFormValues = z.infer<typeof editBetSchema>;

function EditBetDialog({ bet, open, onOpenChange }: { bet: Bet, open: boolean, onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const updateBet = useUpdateBet();
  const queryClient = useQueryClient();
  
  const form = useForm<EditBetFormValues>({
    resolver: zodResolver(editBetSchema),
    defaultValues: {
      status: bet.status,
      americanOdds: bet.americanOdds,
      units: bet.units,
      pnl: bet.pnl,
      notes: bet.notes,
    },
  });

  const onSubmit = (data: EditBetFormValues) => {
    updateBet.mutate({
      id: bet.id,
      data: {
        status: data.status,
        americanOdds: data.americanOdds,
        units: data.units,
        pnl: data.pnl !== undefined ? data.pnl : null,
        notes: data.notes || null,
      }
    }, {
      onSuccess: () => {
        toast({ title: "Bet Updated" });
        queryClient.invalidateQueries({ queryKey: getListBetsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        onOpenChange(false);
      },
      onError: (err) => {
        toast({
          title: "Update failed",
          description: err.data?.error || "An unknown error occurred.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Bet</DialogTitle>
          <DialogDescription>
            Update status or modify wager details.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="won">Won</SelectItem>
                        <SelectItem value="lost">Lost</SelectItem>
                        <SelectItem value="push">Push</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="americanOdds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Odds</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
                name="pnl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>P&L</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : null)} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea value={field.value ?? ""} onChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={updateBet.isPending}>
                {updateBet.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteBetDialog({ bet, open, onOpenChange, onUndo }: { bet: Bet, open: boolean, onOpenChange: (open: boolean) => void, onUndo: (bet: Bet) => void }) {
  const { toast } = useToast();
  const deleteBet = useDeleteBet();
  const queryClient = useQueryClient();

  const onDelete = () => {
    deleteBet.mutate({ id: bet.id }, {
      onSuccess: () => {
        // The server soft-deletes for a grace period, so the toast offers a
        // quick Undo that restores the exact row — odds, P&L, and CLV data.
        // onUndo lives in the page (which outlives this dialog), so the
        // restore still fires after the dialog unmounts.
        toast({
          title: "Bet Deleted",
          description: `${bet.selection} removed from the bet log.`,
          action: (
            <ToastAction altText="Undo delete" onClick={() => onUndo(bet)}>
              Undo
            </ToastAction>
          ),
        });
        queryClient.invalidateQueries({ queryKey: getListBetsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        onOpenChange(false);
      },
      onError: (err) => {
        toast({
          title: "Delete failed",
          description: err.data?.error || "An unknown error occurred.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Bet</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this bet? It will stop counting toward your dashboard stats. You can undo right after deleting.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-muted p-4 my-2 text-sm space-y-1">
          <p><span className="font-semibold">Matchup:</span> {bet.homeTeam} vs {bet.awayTeam}</p>
          <p><span className="font-semibold">Selection:</span> {bet.selection} @ {formatOdds(bet.americanOdds)}</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={deleteBet.isPending} onClick={onDelete}>
            {deleteBet.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BetStatusBadge({ status }: { status: BetStatus }) {
  if (status === 'won') return <Badge variant="positive">WON</Badge>;
  if (status === 'lost') return <Badge variant="negative">LOST</Badge>;
  if (status === 'push') return <Badge variant="secondary">PUSH</Badge>;
  return <Badge variant="pending">PENDING</Badge>;
}

export default function BetLog() {
  const [filter, setFilter] = useState<BetStatus | 'all'>('all');
  const params = filter === 'all' ? undefined : { status: filter };
  
  const { data: bets, isLoading, isError } = useListBets(params);
  
  const [editingBet, setEditingBet] = useState<Bet | null>(null);
  const [deletingBet, setDeletingBet] = useState<Bet | null>(null);

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const restoreBet = useRestoreBet();

  // Undo a delete: the server soft-deletes for a grace period, so restore
  // brings back the exact row — logged odds, units, P&L, and CLV data.
  // Lives here (not in the dialog) so it survives the dialog unmounting.
  const undoDelete = (bet: Bet) => {
    restoreBet.mutate(
      { id: bet.id },
      {
        onSuccess: () => {
          toast({
            title: "Bet restored",
            description: `${bet.selection} is back in the bet log.`,
          });
          queryClient.invalidateQueries({ queryKey: getListBetsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        },
        onError: (err) => {
          toast({
            title: "Could not undo",
            description: err.data?.error || "This bet can no longer be restored.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">Bet Log</h1>
          <p className="text-muted-foreground">Historical ledger of all tracked edges.</p>
        </div>

        <div className="w-full sm:w-48">
          <Label className="mb-2 block">Filter Status</Label>
          <Select value={filter} onValueChange={(val) => setFilter(val as any)}>
            <SelectTrigger>
              <SelectValue placeholder="All Bets" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Bets</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="won">Won</SelectItem>
              <SelectItem value="lost">Lost</SelectItem>
              <SelectItem value="push">Push</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="p-4 space-y-4">
            {[1,2,3,4,5,6].map(i => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : isError ? (
          <div className="flex items-center justify-center h-64 text-destructive font-mono p-4">
            ERR_FETCH_BETS
          </div>
        ) : bets && bets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground p-4">
            <ListTodo className="h-12 w-12 opacity-20 mb-4" />
            <p>No bets logged yet.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Matchup</TableHead>
                <TableHead>Selection</TableHead>
                <TableHead className="text-right">Odds</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">CLV</TableHead>
                <TableHead className="text-right">P&L</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bets?.map((bet) => (
                <TableRow key={bet.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(bet.createdAt).toLocaleDateString()}<br/>
                    {new Date(bet.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </TableCell>
                  <TableCell>
                    <div className="font-sans font-medium text-xs whitespace-nowrap">
                      {bet.homeTeam}<br/>{bet.awayTeam}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{bet.selection} {formatPoint(bet.point, bet.market)}</div>
                    <div className="text-[10px] text-muted-foreground font-mono uppercase">{formatMarketLabel(bet.market)} • {bet.book}</div>
                  </TableCell>
                  <TableCell className="text-right font-bold text-primary">
                    {formatOdds(bet.americanOdds)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {bet.units}u
                  </TableCell>
                  <TableCell className={`text-right ${bet.clvPercent && bet.clvPercent > 0 ? 'text-positive' : bet.clvPercent && bet.clvPercent < 0 ? 'text-negative' : 'text-muted-foreground'}`}>
                    {bet.clvPercent != null ? formatPercent(bet.clvPercent) : '-'}
                  </TableCell>
                  <TableCell className={`text-right font-bold ${bet.pnl && bet.pnl > 0 ? 'text-positive' : bet.pnl && bet.pnl < 0 ? 'text-negative' : 'text-muted-foreground'}`}>
                    {bet.pnl != null ? `${bet.pnl > 0 ? '+' : ''}${formatCurrency(bet.pnl)}` : '-'}
                  </TableCell>
                  <TableCell className="text-center">
                    <BetStatusBadge status={bet.status} />
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Open menu</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => setEditingBet(bet)}>
                          <Pencil className="mr-2 h-4 w-4" /> Edit Bet
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setDeletingBet(bet)} className="text-destructive focus:bg-destructive focus:text-destructive-foreground">
                          <Trash2 className="mr-2 h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {editingBet && (
        <EditBetDialog 
          bet={editingBet} 
          open={!!editingBet} 
          onOpenChange={(open) => !open && setEditingBet(null)} 
        />
      )}
      
      {deletingBet && (
        <DeleteBetDialog 
          bet={deletingBet} 
          open={!!deletingBet} 
          onOpenChange={(open) => !open && setDeletingBet(null)} 
          onUndo={undoDelete}
        />
      )}
    </div>
  );
}
