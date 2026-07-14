import React from 'react';
import { Platform, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import {
  useGetPaperTradeSummary,
  useListPaperTrades,
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

function TradeRow({ trade }: { trade: PaperTrade }) {
  const colors = useColors();
  const s = statusStyle(trade.status, colors);
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
      <Text style={{ fontFamily: fonts.regular, fontSize: 10.5, color: colors.mutedForeground }}>
        {trade.team} vs {trade.opponent} · {formatGameTime(trade.commenceTime)}
      </Text>
    </View>
  );
}

export default function ScorecardScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

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
              {recentTrades.length === 0 ? (
                <Text style={{ fontFamily: fonts.regular, fontSize: 12.5, color: colors.mutedForeground }}>
                  No individual picks to show.
                </Text>
              ) : (
                <View>
                  {recentTrades.map((t) => (
                    <TradeRow key={t.id} trade={t} />
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
