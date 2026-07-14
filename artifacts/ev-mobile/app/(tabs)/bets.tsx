import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetDashboardSummaryQueryKey,
  getListBetsQueryKey,
  useDeleteBet,
  useGetDashboardSummary,
  useListBets,
  useListSports,
  useRestoreBet,
  useUpdateBet,
  type Bet,
  type BetStatus,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/fonts';
import { Badge, Card, EmptyState, ErrorState, ScreenHeader, SectionHeader, Skeleton, StatTile } from '@/components/ui';
import {
  formatGameTime,
  formatMarketLabel,
  formatOdds,
  formatPercent,
  formatPnlUnits,
  formatPoint,
  formatSportKey,
} from '@/lib/format';
import { parseOddsInput, parsePnlInput, parseUnitsInput } from '@/lib/inputs';

function haptic() {
  if (Platform.OS !== 'web') Haptics.selectionAsync();
}

type StatusFilter = BetStatus | 'all';

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'push', label: 'Push' },
];

/** Settled statuses a bet can be moved to from the settle chips. */
const SETTLE_OPTIONS: { value: BetStatus; label: string }[] = [
  { value: 'pending', label: 'PENDING' },
  { value: 'won', label: 'WON' },
  { value: 'lost', label: 'LOST' },
  { value: 'push', label: 'PUSH' },
];

function statusStyle(status: BetStatus, colors: ReturnType<typeof useColors>) {
  switch (status) {
    case 'won':
      return { label: 'Won', color: colors.positive, border: 'rgba(0,204,102,0.35)' };
    case 'lost':
      return { label: 'Lost', color: colors.destructive, border: 'rgba(239,68,68,0.35)' };
    case 'push':
      return { label: 'Push', color: colors.mutedForeground, border: colors.border };
    default:
      return { label: 'Pending', color: colors.primary, border: 'rgba(26,140,255,0.35)' };
  }
}

function BetRow({
  bet,
  busy,
  onSettle,
  onDelete,
  onEdit,
}: {
  bet: Bet;
  busy: boolean;
  onSettle: (status: BetStatus) => void;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const colors = useColors();
  const s = statusStyle(bet.status, colors);
  // Inline expanders — only one open at a time per row.
  const [settling, setSettling] = useState(false);
  // Two-step confirm: first tap arms the row, second tap deletes.
  const [confirming, setConfirming] = useState(false);

  const pnlColor =
    bet.pnl == null ? colors.mutedForeground : bet.pnl > 0 ? colors.positive : bet.pnl < 0 ? colors.destructive : colors.mutedForeground;

  return (
    <View
      style={{
        paddingVertical: 11,
        borderTopWidth: 1,
        borderTopColor: colors.cardBorder,
        gap: 6,
        opacity: busy ? 0.45 : 1,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text
          style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13.5, color: colors.foreground }}
          numberOfLines={1}
        >
          {bet.selection} {formatPoint(bet.point, bet.market)}
        </Text>
        <Badge label={s.label} color={s.color} borderColor={s.border} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text
          style={{ flex: 1, fontFamily: fonts.mono, fontSize: 11.5, color: colors.mutedForeground }}
          numberOfLines={1}
        >
          {formatMarketLabel(bet.market)}
          {bet.book ? ` · ${bet.book}` : ''} · {formatOdds(bet.americanOdds)}
        </Text>
        <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 12, color: pnlColor }}>
          {bet.units}u{bet.pnl != null ? ` · ${formatPnlUnits(bet.pnl)}` : ''}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text
          style={{ flex: 1, fontFamily: fonts.regular, fontSize: 10.5, color: colors.mutedForeground }}
          numberOfLines={1}
        >
          {bet.awayTeam} @ {bet.homeTeam} · {formatGameTime(bet.commenceTime)}
        </Text>
        {confirming ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.destructive }}>
              REMOVE?
            </Text>
            <Pressable
              hitSlop={8}
              disabled={busy}
              onPress={() => {
                haptic();
                setConfirming(false);
                onDelete();
              }}
              style={({ pressed }) => ({
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: colors.radius,
                borderWidth: 1,
                borderColor: 'rgba(239,68,68,0.4)',
                backgroundColor: 'rgba(239,68,68,0.08)',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 10.5, color: colors.destructive }}>
                DELETE
              </Text>
            </Pressable>
            <Pressable
              hitSlop={8}
              onPress={() => {
                haptic();
                setConfirming(false);
              }}
              style={({ pressed }) => ({
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: colors.radius,
                borderWidth: 1,
                borderColor: colors.border,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 10.5, color: colors.mutedForeground }}>
                KEEP
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 12 }}>
            <Pressable
              hitSlop={10}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={settling ? 'Hide settle options' : `Settle ${bet.selection}`}
              onPress={() => {
                haptic();
                setSettling((v) => !v);
              }}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <Feather
                name="check-circle"
                size={14}
                color={settling ? colors.primary : colors.mutedForeground}
              />
            </Pressable>
            <Pressable
              hitSlop={10}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${bet.selection}`}
              onPress={() => {
                haptic();
                setSettling(false);
                onEdit();
              }}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <Feather name="edit-2" size={14} color={colors.mutedForeground} />
            </Pressable>
            <Pressable
              hitSlop={10}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${bet.selection}`}
              onPress={() => {
                haptic();
                setSettling(false);
                setConfirming(true);
              }}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <Feather name={busy ? 'loader' : 'trash-2'} size={14} color={colors.mutedForeground} />
            </Pressable>
          </View>
        )}
      </View>
      {settling ? (
        <View
          style={{
            marginTop: 4,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.mutedForeground }}>
            MARK:
          </Text>
          {SETTLE_OPTIONS.map((opt) => {
            const active = bet.status === opt.value;
            const optColor = statusStyle(opt.value, colors).color;
            return (
              <Pressable
                key={opt.value}
                hitSlop={6}
                disabled={busy || active}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Mark ${bet.selection} as ${opt.label.toLowerCase()}`}
                onPress={() => {
                  haptic();
                  setSettling(false);
                  onSettle(opt.value);
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: colors.radius,
                  borderWidth: 1,
                  borderColor: active ? optColor : colors.border,
                  backgroundColor: active ? `${colors.secondary}` : 'transparent',
                  opacity: pressed ? 0.6 : active ? 0.9 : 1,
                })}
              >
                <Text
                  style={{
                    fontFamily: fonts.monoSemibold,
                    fontSize: 10.5,
                    color: active ? optColor : colors.mutedForeground,
                  }}
                >
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Bottom-sheet form for correcting a logged bet's details (units, odds,
 * notes), mirroring the web EditBetDialog and the LogPropSheet layout on the
 * Edges tab. Status changes stay on the row's settle chips; when odds or
 * units change on a settled bet, the server recomputes pnl in lockstep.
 */
function EditBetSheet({
  bet,
  onClose,
  onSaved,
}: {
  bet: Bet;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const updateBet = useUpdateBet();
  const [units, setUnits] = useState(String(bet.units));
  const [odds, setOdds] = useState(String(bet.americanOdds));
  const [notes, setNotes] = useState(bet.notes ?? '');
  // Manual P&L override (settled bets only). Starts empty on purpose: an
  // untouched field means "keep the server's automatic lockstep pnl", so we
  // must not prefill it with the current value and accidentally freeze it.
  const [pnlText, setPnlText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { value: parsedUnits, valid: unitsValid } = parseUnitsInput(units);
  const { value: parsedOdds, valid: oddsValid } = parseOddsInput(odds);
  const isSettled = bet.status !== 'pending';
  const { value: parsedPnl, valid: pnlValid, provided: pnlProvided } = parsePnlInput(
    isSettled ? pnlText : '',
  );

  const submit = () => {
    if (!unitsValid || !oddsValid || !pnlValid || updateBet.isPending) return;
    haptic();
    setError(null);
    // pnl is omitted unless the bettor typed a correction: the server keeps
    // it in lockstep with the new odds/units on a settled bet (and null while
    // pending), but an explicit pnl takes precedence as a manual override.
    updateBet.mutate(
      {
        id: bet.id,
        data: {
          americanOdds: parsedOdds,
          units: parsedUnits,
          notes: notes.trim() ? notes.trim() : null,
          ...(pnlProvided ? { pnl: parsedPnl } : {}),
        },
      },
      {
        onSuccess: (updated) => {
          if (Platform.OS !== 'web') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          queryClient.invalidateQueries({ queryKey: getListBetsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          onSaved(
            pnlProvided
              ? `Updated ${bet.selection} — P&L corrected to ${formatPnlUnits(updated.pnl ?? parsedPnl)}`
              : `Updated ${bet.selection}${updated.pnl != null ? ` — P&L now ${formatPnlUnits(updated.pnl)}` : ''}`,
          );
        },
        onError: (err) => {
          setError(err?.data?.error || 'Could not update this bet. Try again.');
        },
      },
    );
  };

  const label = {
    fontFamily: fonts.regular,
    fontSize: 10.5,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: colors.mutedForeground,
    marginBottom: 6,
  };
  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.input,
    borderRadius: colors.radius,
    backgroundColor: colors.secondary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.foreground,
  };

  const canSave = unitsValid && oddsValid && pnlValid && !updateBet.isPending;

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}
        >
          <Pressable
            onPress={() => {}}
            style={{
              backgroundColor: colors.card,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              borderWidth: 1,
              borderColor: colors.cardBorder,
              padding: 20,
              paddingBottom: Platform.OS === 'ios' ? 34 : 24,
              gap: 14,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ fontFamily: fonts.semibold, fontSize: 16, color: colors.foreground }}>
                Edit Bet
              </Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>

            {/* Bet summary */}
            <View
              style={{
                borderRadius: colors.radius,
                backgroundColor: colors.secondary,
                padding: 12,
                gap: 8,
              }}
            >
              <Text
                style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.foreground }}
                numberOfLines={1}
              >
                {bet.selection} {formatPoint(bet.point, bet.market)}
              </Text>
              <Text
                style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.mutedForeground }}
                numberOfLines={1}
              >
                {formatMarketLabel(bet.market)}
                {bet.book ? ` · ${bet.book}` : ''} · {bet.awayTeam} @ {bet.homeTeam}
              </Text>
            </View>

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={label}>Units</Text>
                <TextInput
                  value={units}
                  onChangeText={setUnits}
                  keyboardType="decimal-pad"
                  inputMode="decimal"
                  selectTextOnFocus
                  accessibilityLabel="Units"
                  style={inputStyle}
                  placeholderTextColor={colors.mutedForeground}
                />
                {!unitsValid ? (
                  <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.destructive, marginTop: 4 }}>
                    Must be at least 0.01 units.
                  </Text>
                ) : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={label}>Odds (American)</Text>
                <TextInput
                  value={odds}
                  onChangeText={setOdds}
                  keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
                  autoCapitalize="none"
                  autoCorrect={false}
                  selectTextOnFocus
                  accessibilityLabel="American odds"
                  placeholder="e.g. -110"
                  style={inputStyle}
                  placeholderTextColor={colors.mutedForeground}
                />
                {!oddsValid ? (
                  <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.destructive, marginTop: 4 }}>
                    Enter odds of -100 or below, or +100 and up, e.g. -110.
                  </Text>
                ) : null}
              </View>
            </View>

            {isSettled ? (
              <View>
                <Text style={label}>P&L (units) — optional override</Text>
                <TextInput
                  value={pnlText}
                  onChangeText={setPnlText}
                  keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
                  autoCapitalize="none"
                  autoCorrect={false}
                  selectTextOnFocus
                  accessibilityLabel="P&L in units"
                  placeholder={
                    bet.pnl != null ? `Auto: ${formatPnlUnits(bet.pnl)}` : 'e.g. -0.5'
                  }
                  style={inputStyle}
                  placeholderTextColor={colors.mutedForeground}
                />
                {!pnlValid ? (
                  <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.destructive, marginTop: 4 }}>
                    Enter a number in units, e.g. -0.5, or leave blank for automatic.
                  </Text>
                ) : null}
              </View>
            ) : null}

            <View>
              <Text style={label}>Notes (optional)</Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                multiline
                accessibilityLabel="Notes"
                placeholder="e.g. Corrected the price actually taken at the book"
                placeholderTextColor={colors.mutedForeground}
                style={[inputStyle, { fontFamily: fonts.regular, minHeight: 64, textAlignVertical: 'top' }]}
              />
            </View>

            {error ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Feather name="alert-circle" size={14} color={colors.destructive} />
                <Text style={{ flex: 1, fontFamily: fonts.regular, fontSize: 12, color: colors.destructive }}>
                  {error}
                </Text>
              </View>
            ) : null}

            <Pressable
              onPress={submit}
              disabled={!canSave}
              accessibilityRole="button"
              accessibilityLabel="Save changes"
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                paddingVertical: 13,
                borderRadius: colors.radius,
                backgroundColor: colors.primary,
                opacity: !canSave ? 0.5 : pressed ? 0.75 : 1,
              })}
            >
              {updateBet.isPending ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Feather name="save" size={15} color={colors.primaryForeground} />
              )}
              <Text style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.primaryForeground }}>
                Save Changes
              </Text>
            </Pressable>

            {isSettled ? (
              <Text style={{ fontFamily: fonts.regular, fontSize: 10.5, color: colors.mutedForeground, lineHeight: 15 }}>
                This bet is settled — changing odds or units recomputes its P&L automatically.
                Fill in P&L only to override the payout (boosts, partial cash-outs, voided legs).
              </Text>
            ) : null}
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function BetsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<StatusFilter>('all');
  const {
    data: bets,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useListBets(filter === 'all' ? undefined : { status: filter });

  // All-time ledger rollup — deliberately independent of the status filter,
  // and kept fresh by the same getGetDashboardSummaryQueryKey() invalidation
  // that settle/delete/undo already trigger.
  const {
    data: summary,
    isLoading: loadingSummary,
    isError: summaryError,
    refetch: refetchSummary,
    isRefetching: summaryRefetching,
  } = useGetDashboardSummary();
  const settledCount = summary ? summary.won + summary.lost + summary.push : 0;

  // The free in-season sports list resolves keys like "baseball_mlb" to
  // display titles; formatSportKey covers keys that have dropped off the
  // list (out-of-season leagues still present in the ledger history).
  const { data: sports } = useListSports();
  const sportTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sports ?? []) map.set(s.key, s.title);
    return map;
  }, [sports]);
  const [showBySport, setShowBySport] = useState(false);
  const bySport = summary?.bySport ?? [];
  // Realized stake (server-side: settled AND pnl != null) is the ROI
  // denominator. Muting keys off it — not the W-L-P count — so an API-edge
  // settled bet with a null pnl can't render an unmuted zero P&L/ROI next to
  // a non-zero record.
  const realized = (summary?.totalUnits ?? 0) > 0;

  const updateBet = useUpdateBet();
  const deleteBet = useDeleteBet();
  const restoreBet = useRestoreBet();
  const [busyId, setBusyId] = useState<Bet['id'] | null>(null);
  const [editingBet, setEditingBet] = useState<Bet | null>(null);
  // `undoId` on a success banner offers a short window to restore the bet.
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
    undoId?: Bet['id'];
  } | null>(null);

  useEffect(() => {
    if (feedback?.type !== 'success') return;
    // Give the banner a little longer when it carries the Undo action.
    const t = setTimeout(() => setFeedback(null), feedback.undoId != null ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [feedback]);

  const invalidateBets = () => {
    queryClient.invalidateQueries({ queryKey: getListBetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  };

  const settleBet = (bet: Bet, status: BetStatus) => {
    if (busyId) return;
    setBusyId(bet.id);
    setFeedback(null);
    // Sending status alone is enough — the server keeps pnl in lockstep,
    // computing it from odds and units (and clearing it back to null when a
    // bet is reopened to pending).
    updateBet.mutate(
      { id: bet.id, data: { status } },
      {
        onSuccess: (updated) => {
          if (Platform.OS !== 'web') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          setFeedback({
            type: 'success',
            text:
              status === 'pending'
                ? `Reopened ${bet.selection} — P&L cleared`
                : `Marked ${bet.selection} ${status}${updated.pnl != null ? ` (${formatPnlUnits(updated.pnl)})` : ''}`,
          });
          invalidateBets();
        },
        onError: (err) => {
          setFeedback({
            type: 'error',
            text: err?.data?.error || 'Could not update this bet. Try again.',
          });
        },
        onSettled: () => setBusyId(null),
      },
    );
  };

  const removeBet = (bet: Bet) => {
    if (busyId) return;
    setBusyId(bet.id);
    setFeedback(null);
    deleteBet.mutate(
      { id: bet.id },
      {
        onSuccess: () => {
          if (Platform.OS !== 'web') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          setFeedback({
            type: 'success',
            text: `Deleted ${bet.selection} from the bet log`,
            undoId: bet.id,
          });
          invalidateBets();
        },
        onError: (err) => {
          setFeedback({
            type: 'error',
            text: err?.data?.error || 'Could not delete this bet. Try again.',
          });
        },
        onSettled: () => setBusyId(null),
      },
    );
  };

  const undoDelete = (id: Bet['id']) => {
    if (restoreBet.isPending) return;
    haptic();
    // Swap the banner to a transient "restoring" note; the mutation result
    // replaces it either way, so a stale Undo can't be tapped twice.
    setFeedback({ type: 'success', text: 'Restoring bet…' });
    restoreBet.mutate(
      { id },
      {
        onSuccess: (restored) => {
          if (Platform.OS !== 'web') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          setFeedback({
            type: 'success',
            text: `Restored ${restored.selection} to the bet log`,
          });
          invalidateBets();
        },
        onError: (err) => {
          setFeedback({
            type: 'error',
            text: err?.data?.error || 'Could not undo — this bet can no longer be restored.',
          });
        },
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        icon="book-open"
        title="Bet Log"
        subtitle="Real bets logged from the scanner — settle results and keep the ledger honest."
      />
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          gap: 16,
          paddingBottom: Platform.OS === 'web' ? 110 : insets.bottom + 90,
        }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching || summaryRefetching}
            onRefresh={() => {
              refetch();
              refetchSummary();
            }}
            tintColor={colors.primary}
          />
        }
      >
        {/* Ledger summary — all-time rollup, unaffected by the filter below */}
        {loadingSummary ? (
          <Card>
            <Skeleton height={84} />
          </Card>
        ) : summaryError ? (
          <Card>
            <ErrorState
              code="ERR_FETCH_SUMMARY"
              message="Could not load the ledger summary."
              onRetry={() => refetchSummary()}
            />
          </Card>
        ) : summary && summary.totalBets > 0 ? (
          <Card style={{ gap: 16 }}>
            <SectionHeader icon="trending-up" title="Ledger · All Time" />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <StatTile
                big
                label="Total P&L"
                value={formatPnlUnits(summary.totalPnl)}
                tone={
                  !realized || summary.totalPnl === 0
                    ? undefined
                    : summary.totalPnl > 0
                      ? 'pos'
                      : 'neg'
                }
                muted={!realized}
                hint={!realized ? 'awaiting results' : 'all bets, any filter'}
              />
              <StatTile
                big
                label="ROI"
                value={formatPercent(summary.roiPercent)}
                tone={
                  !realized || summary.roiPercent === 0
                    ? undefined
                    : summary.roiPercent > 0
                      ? 'pos'
                      : 'neg'
                }
                muted={!realized}
                hint="on settled stake"
              />
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 18 }}>
              {[
                {
                  label: 'Record',
                  value: `${summary.won}-${summary.lost}-${summary.push}`,
                  muted: settledCount === 0,
                },
                {
                  // Server semantics: totalUnits sums SETTLED stake only — it
                  // is the ROI denominator, not the pending exposure.
                  label: 'Settled Stake',
                  value: `${Math.round(summary.totalUnits * 100) / 100}u`,
                  muted: !realized,
                },
                {
                  label: 'Pending',
                  value: String(summary.pending),
                  tone: summary.pending > 0 ? ('primary' as const) : undefined,
                  muted: summary.pending === 0,
                },
              ].map((s) => (
                <View key={s.label} style={{ width: '33.33%' }}>
                  <StatTile label={s.label} value={s.value} tone={s.tone} muted={s.muted} />
                </View>
              ))}
            </View>

            {/* Per-sport breakdown — collapsed by default; hidden when the
                summary has no per-sport rows (no bets at all). */}
            {bySport.length > 0 ? (
              <View
                style={{
                  borderTopWidth: 1,
                  borderTopColor: colors.cardBorder,
                  paddingTop: 12,
                  marginTop: -2,
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showBySport }}
                  accessibilityLabel={showBySport ? 'Hide sport breakdown' : 'Show sport breakdown'}
                  onPress={() => {
                    haptic();
                    setShowBySport((v) => !v);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Text
                    style={{
                      fontFamily: fonts.regular,
                      fontSize: 10.5,
                      letterSpacing: 0.5,
                      textTransform: 'uppercase',
                      color: colors.mutedForeground,
                    }}
                  >
                    By Sport · {bySport.length}
                  </Text>
                  <Feather
                    name={showBySport ? 'chevron-up' : 'chevron-down'}
                    size={15}
                    color={colors.mutedForeground}
                  />
                </Pressable>
                {showBySport ? (
                  <View style={{ marginTop: 4 }}>
                    {bySport.map((row) => {
                      // Mirror the ledger card's muting: a sport with nothing
                      // settled yet shows a neutral 0 P&L/ROI, never a green
                      // or red number off zero results.
                      const sportSettled = row.won + row.lost + row.push > 0;
                      const pnlTone = !sportSettled || row.pnl === 0
                        ? colors.mutedForeground
                        : row.pnl > 0
                          ? colors.positive
                          : colors.destructive;
                      const roiTone = !sportSettled || row.roiPercent === 0
                        ? colors.mutedForeground
                        : row.roiPercent > 0
                          ? colors.positive
                          : colors.destructive;
                      return (
                        <View
                          key={row.sport}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                            paddingVertical: 9,
                            borderTopWidth: 1,
                            borderTopColor: colors.cardBorder,
                          }}
                        >
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text
                              style={{ fontFamily: fonts.medium, fontSize: 12.5, color: colors.foreground }}
                              numberOfLines={1}
                            >
                              {sportTitles.get(row.sport) ?? formatSportKey(row.sport)}
                            </Text>
                            <Text
                              style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.mutedForeground, marginTop: 2 }}
                              numberOfLines={1}
                            >
                              {row.won}-{row.lost}-{row.push}
                              {row.pending > 0 ? ` · ${row.pending} pending` : ''}
                            </Text>
                          </View>
                          <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 12, color: roiTone }}>
                            {formatPercent(row.roiPercent)}
                          </Text>
                          <Text
                            style={{
                              fontFamily: fonts.monoSemibold,
                              fontSize: 12,
                              color: pnlTone,
                              minWidth: 64,
                              textAlign: 'right',
                            }}
                          >
                            {formatPnlUnits(row.pnl)}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            ) : null}
          </Card>
        ) : null}

        {/* Status filter chips */}
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
          {FILTERS.map((f) => {
            const active = filter === f.value;
            return (
              <Pressable
                key={f.value}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => {
                  haptic();
                  setFilter(f.value);
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: colors.radius,
                  borderWidth: 1,
                  borderColor: active ? colors.primary : colors.border,
                  backgroundColor: active ? 'rgba(26,140,255,0.1)' : 'transparent',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: active ? colors.primary : colors.mutedForeground,
                  }}
                >
                  {f.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Card>
          <SectionHeader icon="list" title="Logged Bets" />
          {feedback ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 7,
                marginBottom: 10,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: colors.radius,
                borderWidth: 1,
                borderColor:
                  feedback.type === 'success' ? 'rgba(0,204,102,0.35)' : 'rgba(239,68,68,0.35)',
                backgroundColor:
                  feedback.type === 'success' ? 'rgba(0,204,102,0.07)' : 'rgba(239,68,68,0.07)',
              }}
            >
              <Feather
                name={feedback.type === 'success' ? 'check-circle' : 'alert-triangle'}
                size={13}
                color={feedback.type === 'success' ? colors.positive : colors.destructive}
              />
              <Text
                style={{
                  fontFamily: fonts.regular,
                  fontSize: 11.5,
                  color: feedback.type === 'success' ? colors.positive : colors.destructive,
                  flex: 1,
                }}
              >
                {feedback.text}
              </Text>
              {feedback.undoId != null ? (
                <Pressable
                  hitSlop={8}
                  disabled={restoreBet.isPending}
                  accessibilityRole="button"
                  accessibilityLabel="Undo delete"
                  onPress={() => undoDelete(feedback.undoId!)}
                  style={({ pressed }) => ({
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: colors.radius,
                    borderWidth: 1,
                    borderColor: 'rgba(26,140,255,0.4)',
                    backgroundColor: 'rgba(26,140,255,0.08)',
                    opacity: pressed || restoreBet.isPending ? 0.6 : 1,
                  })}
                >
                  <Text
                    style={{ fontFamily: fonts.monoSemibold, fontSize: 10.5, color: colors.primary }}
                  >
                    UNDO
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {isLoading ? (
            <View style={{ gap: 10 }}>
              <Skeleton height={64} />
              <Skeleton height={64} />
              <Skeleton height={64} />
            </View>
          ) : isError ? (
            <ErrorState
              code="ERR_FETCH_BETS"
              message="Could not load the bet log."
              onRetry={() => refetch()}
            />
          ) : !bets || bets.length === 0 ? (
            <EmptyState
              icon="book-open"
              title={filter === 'all' ? 'No bets logged yet' : `No ${filter} bets`}
              subtitle={
                filter === 'all'
                  ? 'Scan a game on the Edges tab and log a promising prop to start the ledger.'
                  : 'Try a different status filter.'
              }
            />
          ) : (
            <View>
              {bets.map((bet) => (
                <BetRow
                  key={bet.id}
                  bet={bet}
                  busy={busyId === bet.id}
                  onSettle={(status) => settleBet(bet, status)}
                  onDelete={() => removeBet(bet)}
                  onEdit={() => {
                    setFeedback(null);
                    setEditingBet(bet);
                  }}
                />
              ))}
            </View>
          )}
        </Card>
      </ScrollView>
      {editingBet ? (
        <EditBetSheet
          bet={editingBet}
          onClose={() => setEditingBet(null)}
          onSaved={(message) => {
            setEditingBet(null);
            setFeedback({ type: 'success', text: message });
          }}
        />
      ) : null}
    </View>
  );
}
