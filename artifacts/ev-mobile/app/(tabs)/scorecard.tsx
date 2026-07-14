import React, { useEffect, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetPaperTradeSummaryQueryKey,
  getListPaperTradesQueryKey,
  useDeletePaperTrade,
  useGetPaperTradeSummary,
  useListPaperTrades,
  useRestorePaperTrade,
  type PaperTrade,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/fonts';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  ScreenHeader,
  SectionHeader,
  Skeleton,
  StatTile,
} from '@/components/ui';
import { formatGameTime, formatOdds, formatPercent, formatRate } from '@/lib/format';

const SMALL_SAMPLE = 20;

function statusStyle(status: PaperTrade['status'], colors: ReturnType<typeof useColors>) {
  switch (status) {
    case 'closed':
      return { label: 'Closed', color: colors.positive, border: 'rgba(0,204,102,0.35)' };
    case 'expired':
      return { label: 'Expired', color: colors.mutedForeground, border: colors.border };
    default:
      return { label: 'Open', color: colors.primary, border: 'rgba(26,140,255,0.35)' };
  }
}

function haptic() {
  if (Platform.OS !== 'web') Haptics.selectionAsync();
}

function TradeRow({
  trade,
  onDelete,
  deleting,
}: {
  trade: PaperTrade;
  onDelete: () => void;
  deleting: boolean;
}) {
  const colors = useColors();
  const s = statusStyle(trade.status, colors);
  // Two-step confirm: first tap arms the row, second tap deletes.
  const [confirming, setConfirming] = useState(false);
  // Closed picks are graded — deleting one rewrites the scorecard's
  // beat-close rate and avg CLV, so they get a stronger, explicit warning.
  const isGraded = trade.status === 'closed';
  const clvColor =
    trade.clvPercent == null
      ? colors.mutedForeground
      : trade.clvPercent > 0
        ? colors.positive
        : colors.destructive;
  return (
    <View
      style={{
        paddingVertical: 11,
        borderTopWidth: 1,
        borderTopColor: colors.cardBorder,
        gap: 6,
        opacity: deleting ? 0.45 : 1,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontFamily: fonts.medium, fontSize: 13.5, color: colors.foreground }}>
            {trade.pitcher}
          </Text>
          {trade.isFlagged ? <Feather name="target" size={11} color={colors.positive} /> : null}
        </View>
        <Badge label={s.label} color={s.color} borderColor={s.border} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: 11.5, color: colors.mutedForeground }}>
          {trade.selection} {trade.point} · {formatOdds(trade.americanOdds)} · {trade.book}
        </Text>
        <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 12, color: clvColor }}>
          {trade.clvPercent == null ? 'CLV —' : `CLV ${formatPercent(trade.clvPercent)}`}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text
          style={{
            fontFamily: fonts.regular,
            fontSize: 10.5,
            color: colors.mutedForeground,
            flex: 1,
          }}
        >
          {trade.team} vs {trade.opponent} · {formatGameTime(trade.commenceTime)}
        </Text>
        {confirming && !isGraded ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.destructive }}>
              REMOVE?
            </Text>
            <Pressable
              hitSlop={8}
              disabled={deleting}
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
        ) : confirming && isGraded ? null : (
          <Pressable
            hitSlop={10}
            disabled={deleting}
            onPress={() => {
              haptic();
              setConfirming(true);
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingLeft: 12 })}
          >
            <Feather
              name={deleting ? 'loader' : 'trash-2'}
              size={14}
              color={colors.mutedForeground}
            />
          </Pressable>
        )}
      </View>
      {confirming && isGraded ? (
        <View
          style={{
            marginTop: 4,
            padding: 10,
            gap: 8,
            borderRadius: colors.radius,
            borderWidth: 1,
            borderColor: 'rgba(239,68,68,0.4)',
            backgroundColor: 'rgba(239,68,68,0.08)',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 7 }}>
            <Feather name="alert-triangle" size={13} color={colors.destructive} style={{ marginTop: 1 }} />
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 11.5,
                color: colors.destructive,
                flex: 1,
              }}
            >
              This pick is already graded. Deleting it changes the scorecard's beat-close rate and
              average CLV — the model's validation stats.
            </Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
            <Pressable
              hitSlop={8}
              onPress={() => {
                haptic();
                setConfirming(false);
              }}
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 5,
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
            <Pressable
              hitSlop={8}
              disabled={deleting}
              onPress={() => {
                haptic();
                setConfirming(false);
                onDelete();
              }}
              style={({ pressed }) => ({
                paddingHorizontal: 12,
                paddingVertical: 5,
                borderRadius: colors.radius,
                borderWidth: 1,
                borderColor: 'rgba(239,68,68,0.5)',
                backgroundColor: 'rgba(239,68,68,0.14)',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 10.5, color: colors.destructive }}>
                DELETE GRADED PICK
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default function ScorecardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const deleteTrade = useDeletePaperTrade();
  const restoreTrade = useRestorePaperTrade();
  const [deletingId, setDeletingId] = useState<PaperTrade['id'] | null>(null);
  // `undoId` on a success banner offers a short window to restore the pick.
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
    undoId?: PaperTrade['id'];
  } | null>(null);

  useEffect(() => {
    if (feedback?.type !== 'success') return;
    // Give the banner a little longer when it carries the Undo action.
    const t = setTimeout(() => setFeedback(null), feedback.undoId != null ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [feedback]);

  const invalidateTrades = () => {
    queryClient.invalidateQueries({ queryKey: getListPaperTradesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPaperTradeSummaryQueryKey() });
  };

  const removeTrade = (trade: PaperTrade) => {
    if (deletingId) return;
    setDeletingId(trade.id);
    setFeedback(null);
    deleteTrade.mutate(
      { id: trade.id },
      {
        onSuccess: () => {
          if (Platform.OS !== 'web') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          setFeedback({
            type: 'success',
            text: `Removed ${trade.pitcher} ${trade.selection} ${trade.point}K from the scorecard`,
            undoId: trade.id,
          });
          invalidateTrades();
        },
        onError: (err) => {
          setFeedback({
            type: 'error',
            text: err?.data?.error || 'Could not remove this pick. Try again.',
          });
        },
        onSettled: () => setDeletingId(null),
      },
    );
  };

  const undoRemove = (id: PaperTrade['id']) => {
    if (restoreTrade.isPending) return;
    haptic();
    // Swap the banner to a transient "restoring" note; the mutation result
    // replaces it either way, so a stale Undo can't be tapped twice.
    setFeedback({ type: 'success', text: 'Restoring pick…' });
    restoreTrade.mutate(
      { id },
      {
        onSuccess: (restored) => {
          if (Platform.OS !== 'web') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          setFeedback({
            type: 'success',
            text: `Restored ${restored.pitcher} ${restored.selection} ${restored.point}K to the scorecard`,
          });
          invalidateTrades();
        },
        onError: (err) => {
          setFeedback({
            type: 'error',
            text: err?.data?.error || 'Could not undo — this pick can no longer be restored.',
          });
        },
      },
    );
  };

  const {
    data: summary,
    isLoading: loadingSummary,
    isError: summaryError,
    refetch: refetchSummary,
    isRefetching,
  } = useGetPaperTradeSummary();

  const { data: trades, refetch: refetchTrades } = useListPaperTrades();

  const gradedNote =
    summary && summary.gradedCount > 0 && summary.gradedCount < SMALL_SAMPLE
      ? `Small sample — only ${summary.gradedCount} graded pick${summary.gradedCount === 1 ? '' : 's'} so far.`
      : undefined;

  const recentTrades = (trades ?? []).slice(0, 30);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        icon="bar-chart-2"
        title="Paper Scorecard"
        subtitle="How the model's logged picks are tracking against the closing line — the real test of edge."
      />
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          gap: 16,
          paddingBottom: Platform.OS === 'web' ? 110 : insets.bottom + 90,
        }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => {
              refetchSummary();
              refetchTrades();
            }}
            tintColor={colors.primary}
          />
        }
      >
        {loadingSummary ? (
          <>
            <Card>
              <Skeleton height={96} />
            </Card>
            <Card>
              <Skeleton height={120} />
            </Card>
          </>
        ) : summaryError ? (
          <ErrorState
            code="SUMMARY_UNAVAILABLE"
            message="Could not load the paper-trade scorecard."
            onRetry={() => refetchSummary()}
          />
        ) : !summary || summary.total === 0 ? (
          <Card>
            <EmptyState
              icon="clipboard"
              title="No paper trades logged yet"
              subtitle="Once flagged edges are logged from the web app, beat-close rate and CLV will accumulate here."
            />
          </Card>
        ) : (
          <>
            {/* Hero: the two headline validation metrics */}
            <Card style={{ gap: 16 }}>
              <SectionHeader icon="award" title="Model Validation" />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <StatTile
                  big
                  label="Beat Close Rate"
                  value={formatRate(summary.beatCloseRate)}
                  tone={
                    summary.beatCloseRate == null
                      ? undefined
                      : summary.beatCloseRate >= 0.5
                        ? 'pos'
                        : 'neg'
                  }
                  muted={summary.beatCloseRate == null}
                  hint={`${summary.beatCloseCount}/${summary.gradedCount} graded`}
                />
                <StatTile
                  big
                  label="Avg CLV"
                  value={formatPercent(summary.avgClvPercent)}
                  tone={
                    summary.avgClvPercent == null
                      ? undefined
                      : summary.avgClvPercent > 0
                        ? 'pos'
                        : 'neg'
                  }
                  muted={summary.avgClvPercent == null}
                  hint="vs closing line"
                />
              </View>
              {gradedNote ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <Feather name="info" size={12} color={colors.warning} />
                  <Text style={{ fontFamily: fonts.regular, fontSize: 11.5, color: colors.warning, flex: 1 }}>
                    {gradedNote}
                  </Text>
                </View>
              ) : summary.gradedCount === 0 ? (
                <Text style={{ fontFamily: fonts.regular, fontSize: 11.5, color: colors.mutedForeground }}>
                  No picks graded yet — metrics appear once trades close with a captured closing line.
                </Text>
              ) : null}
            </Card>

            {/* Breakdown grid */}
            <Card>
              <SectionHeader icon="grid" title="Breakdown" />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 18 }}>
                {[
                  { label: 'Total Picks', value: String(summary.total) },
                  { label: 'Open', value: String(summary.open), tone: 'primary' as const },
                  { label: 'Closed', value: String(summary.closed) },
                  { label: 'Expired', value: String(summary.expired), muted: true },
                  { label: 'Graded', value: String(summary.gradedCount) },
                  { label: 'Avg Edge', value: formatPercent(summary.avgEdgePercent) },
                ].map((s) => (
                  <View key={s.label} style={{ width: '33.33%' }}>
                    <StatTile label={s.label} value={s.value} tone={s.tone} muted={s.muted} />
                  </View>
                ))}
              </View>
            </Card>

            {/* Recent trades */}
            <Card>
              <SectionHeader icon="list" title="Recent Picks" />
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
                      disabled={restoreTrade.isPending}
                      onPress={() => undoRemove(feedback.undoId!)}
                      style={({ pressed }) => ({
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                        borderRadius: colors.radius,
                        borderWidth: 1,
                        borderColor: 'rgba(26,140,255,0.4)',
                        backgroundColor: 'rgba(26,140,255,0.08)',
                        opacity: pressed || restoreTrade.isPending ? 0.6 : 1,
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
              {recentTrades.length === 0 ? (
                <Text style={{ fontFamily: fonts.regular, fontSize: 12.5, color: colors.mutedForeground }}>
                  No individual picks to show.
                </Text>
              ) : (
                <View>
                  {recentTrades.map((t) => (
                    <TradeRow
                      key={t.id}
                      trade={t}
                      deleting={deletingId === t.id}
                      onDelete={() => removeTrade(t)}
                    />
                  ))}
                </View>
              )}
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}
