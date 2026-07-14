import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetPaperTradeSummaryQueryKey,
  getListEventsQueryKey,
  getListModelEdgesQueryKey,
  getListPaperTradesQueryKey,
  getListPropEdgesQueryKey,
  useCreatePaperTrade,
  useListEvents,
  useListModelEdges,
  useListPropEdges,
  type EdgeOpportunity,
  type ModelKLine,
  type ModelPitcherProjection,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/fonts';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  ScreenHeader,
  Skeleton,
} from '@/components/ui';
import {
  easternDayKey,
  formatDayLabel,
  formatMarketLabel,
  formatOdds,
  formatPercent,
  formatPoint,
  formatProb,
  formatTimeOnly,
} from '@/lib/format';

const MODEL_SPORT = 'baseball_mlb';
const KELLY_MULTIPLIER = 0.25;
const MIN_EDGE_PERCENT = 1;

function haptic() {
  if (Platform.OS !== 'web') Haptics.selectionAsync();
}

type ScanMode = 'model' | 'props';

/**
 * Segmented switch between the strikeout model and the player-prop scanner.
 * Props are a separate, scan-only surface: they're priced per market when a
 * game is scanned and never feed the paper-trade scorecard or CLV tracking.
 */
function ModeSwitch({
  mode,
  onChange,
}: {
  mode: ScanMode;
  onChange: (mode: ScanMode) => void;
}) {
  const colors = useColors();
  const segment = (value: ScanMode, icon: 'cpu' | 'user', label: string) => {
    const active = mode === value;
    return (
      <Pressable
        onPress={() => onChange(value)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingVertical: 9,
          borderRadius: colors.radius - 2,
          backgroundColor: active ? colors.primary : 'transparent',
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Feather
          name={icon}
          size={13}
          color={active ? colors.primaryForeground : colors.mutedForeground}
        />
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: 13,
            color: active ? colors.primaryForeground : colors.mutedForeground,
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        padding: 3,
        gap: 3,
        borderRadius: colors.radius,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.secondary,
      }}
    >
      {segment('model', 'cpu', 'K Model')}
      {segment('props', 'user', 'Player Props')}
    </View>
  );
}

function PropRow({ edge }: { edge: EdgeOpportunity }) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 8,
      }}
    >
      <View style={{ flex: 1.9 }}>
        <Text
          style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.foreground }}
          numberOfLines={1}
        >
          {edge.player ?? edge.selection}
        </Text>
        <Text
          style={{
            fontFamily: fonts.regular,
            fontSize: 10.5,
            color: colors.mutedForeground,
            marginTop: 1,
          }}
          numberOfLines={1}
        >
          {formatMarketLabel(edge.market)} · {edge.selection}{' '}
          {formatPoint(edge.point, edge.market)} · {edge.book}
        </Text>
      </View>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: 12.5, color: colors.mutedForeground }}>
          {formatOdds(edge.fairOdds)}
        </Text>
      </View>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 12.5, color: colors.primary }}>
          {formatOdds(edge.americanOdds)}
        </Text>
      </View>
      <View style={{ flex: 0.9, alignItems: 'flex-end' }}>
        <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 12.5, color: colors.positive }}>
          {formatPercent(edge.evPercent)}
        </Text>
      </View>
    </View>
  );
}

function PropsHeader() {
  const colors = useColors();
  const cell = {
    fontFamily: fonts.regular,
    fontSize: 9.5,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: colors.mutedForeground,
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingBottom: 6,
        borderBottomWidth: 1,
        borderBottomColor: colors.cardBorder,
      }}
    >
      <Text style={[cell, { flex: 1.9 }]}>Prop</Text>
      <Text style={[cell, { flex: 1, textAlign: 'right' }]}>Fair</Text>
      <Text style={[cell, { flex: 1, textAlign: 'right' }]}>Odds</Text>
      <Text style={[cell, { flex: 0.9, textAlign: 'right' }]}>EV</Text>
    </View>
  );
}

/** Scanned prop edges for one game — display-only, never logged to the scorecard. */
function PropResultsCard({ edges }: { edges: EdgeOpportunity[] }) {
  const colors = useColors();
  if (edges.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="activity"
          title="No +EV player props found for this game."
          subtitle="Books are aligned. Try another game or check back closer to start."
        />
      </Card>
    );
  }
  return (
    <Card style={{ gap: 10 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Text
          style={{
            fontFamily: fonts.regular,
            fontSize: 10,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: colors.mutedForeground,
          }}
        >
          {edges.length} +EV prop{edges.length === 1 ? '' : 's'}
        </Text>
        <Badge label="Scan only · not in scorecard" mono />
      </View>
      <View>
        <PropsHeader />
        {edges.map((edge, idx) => (
          <PropRow
            key={`${edge.market}-${edge.player}-${edge.selection}-${edge.point}-${edge.book}-${idx}`}
            edge={edge}
          />
        ))}
      </View>
      <Text
        style={{
          fontFamily: fonts.regular,
          fontSize: 10.5,
          color: colors.mutedForeground,
          lineHeight: 15,
        }}
      >
        Fair odds come from devigging each prop across books. Props aren't tracked in the
        Scorecard and are excluded from CLV.
      </Text>
    </Card>
  );
}

type LogState = 'idle' | 'pending' | 'logged';

function LogButton({ state, onPress }: { state: LogState; onPress: () => void }) {
  const colors = useColors();
  const disabled = state !== 'idle';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={state === 'logged' ? 'Logged to scorecard' : 'Log paper trade'}
      style={({ pressed }) => ({
        width: 30,
        height: 30,
        borderRadius: colors.radius,
        borderWidth: 1,
        borderColor:
          state === 'logged' ? 'rgba(0,204,102,0.4)' : colors.border,
        backgroundColor:
          state === 'logged' ? 'rgba(0,204,102,0.1)' : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {state === 'pending' ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : state === 'logged' ? (
        <Feather name="check" size={15} color={colors.positive} />
      ) : (
        <Feather name="plus" size={15} color={colors.primary} />
      )}
    </Pressable>
  );
}

function LineRow({
  line,
  logState,
  onLog,
}: {
  line: ModelKLine;
  logState: LogState;
  onLog: () => void;
}) {
  const colors = useColors();
  const edgeColor =
    (line.edgePercent ?? 0) > 0 ? colors.positive : colors.mutedForeground;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 9,
        paddingHorizontal: 8,
        borderRadius: colors.radius,
        backgroundColor: line.isFlagged ? 'rgba(0,204,102,0.08)' : 'transparent',
      }}
    >
      <View style={{ flex: 1.5 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.foreground }}>
            {line.selection} {line.point}
          </Text>
          {line.isFlagged ? (
            <Feather name="target" size={12} color={colors.positive} />
          ) : null}
        </View>
        <Text style={{ fontFamily: fonts.regular, fontSize: 10.5, color: colors.mutedForeground, marginTop: 1 }}>
          {line.book}
          {line.recommendedUnits > 0 ? ` · ${line.recommendedUnits}u` : ''}
        </Text>
      </View>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: 12.5, color: colors.foreground }}>
          {formatProb(line.modelProb)}
        </Text>
      </View>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 12.5, color: edgeColor }}>
          {formatPercent(line.edgePercent)}
        </Text>
      </View>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 12.5, color: colors.primary }}>
          {formatOdds(line.americanOdds)}
        </Text>
      </View>
      <View style={{ width: 38, alignItems: 'flex-end' }}>
        <LogButton state={logState} onPress={onLog} />
      </View>
    </View>
  );
}

function LinesHeader() {
  const colors = useColors();
  const cell = {
    fontFamily: fonts.regular,
    fontSize: 9.5,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    color: colors.mutedForeground,
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingBottom: 6,
        borderBottomWidth: 1,
        borderBottomColor: colors.cardBorder,
      }}
    >
      <Text style={[cell, { flex: 1.5 }]}>Line</Text>
      <Text style={[cell, { flex: 1, textAlign: 'right' }]}>Model</Text>
      <Text style={[cell, { flex: 1, textAlign: 'right' }]}>Edge</Text>
      <Text style={[cell, { flex: 1, textAlign: 'right' }]}>Odds</Text>
      <Text style={[cell, { width: 38, textAlign: 'right' }]}>Log</Text>
    </View>
  );
}

const lineKey = (line: ModelKLine) =>
  `${line.selection}-${line.point}-${line.book}`;

function ProjectionCard({ projection }: { projection: ModelPitcherProjection }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const createPaperTrade = useCreatePaperTrade();

  // Track logging locally: which lines are logged (so the button can't fire a
  // duplicate insert — the backend happily accepts repeats), which one is
  // in-flight, and a transient toast-style banner for confirmation/errors.
  const [logged, setLogged] = useState<Set<string>>(new Set());
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (feedback?.type !== 'success') return;
    const t = setTimeout(() => setFeedback(null), 4000);
    return () => clearTimeout(t);
  }, [feedback]);

  const logTrade = (line: ModelKLine) => {
    const key = lineKey(line);
    if (pendingKey || logged.has(key)) return;
    haptic();
    setPendingKey(key);
    setFeedback(null);
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
          setLogged((prev) => new Set(prev).add(key));
          setFeedback({
            type: 'success',
            text: `Logged ${line.selection} ${line.point}K @ ${formatOdds(line.americanOdds)} — see Scorecard`,
          });
          if (Platform.OS !== 'web') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          queryClient.invalidateQueries({ queryKey: getListPaperTradesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetPaperTradeSummaryQueryKey() });
        },
        onError: (err) => {
          if (err?.status === 409) {
            // The pick is already in the scorecard (logged from another
            // session or device) — reflect that on the button so it can't be
            // re-tapped, and let the server's message explain why.
            setLogged((prev) => new Set(prev).add(key));
          }
          setFeedback({
            type: 'error',
            text: err?.data?.error || 'Could not log this pick. Try again.',
          });
        },
        onSettled: () => setPendingKey(null),
      },
    );
  };

  const logStateFor = (line: ModelKLine): LogState => {
    const key = lineKey(line);
    if (logged.has(key)) return 'logged';
    if (pendingKey === key) return 'pending';
    return 'idle';
  };

  if (projection.insufficientData) {
    return (
      <Card
        style={{
          borderColor: 'rgba(245,158,11,0.3)',
          backgroundColor: 'rgba(245,158,11,0.05)',
          gap: 8,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 15, color: colors.foreground }}>
            {projection.pitcher}
          </Text>
          {projection.throws ? <Badge label={`${projection.throws}HP`} mono /> : null}
        </View>
        <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground }}>
          {projection.team}
          {projection.opponent ? ` · vs ${projection.opponent}` : ''}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <Feather name="alert-triangle" size={14} color={colors.warning} style={{ marginTop: 1 }} />
          <Text style={{ flex: 1, fontFamily: fonts.regular, fontSize: 12.5, color: colors.warning, lineHeight: 17 }}>
            Insufficient data — no recent or season strikeout inputs, so the model won't project this
            start.
          </Text>
        </View>
      </Card>
    );
  }

  const stat = (value: string, label: string, tone?: string) => (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 15, color: tone ?? colors.foreground }}>
        {value}
      </Text>
      <Text
        style={{
          fontFamily: fonts.regular,
          fontSize: 9.5,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: colors.mutedForeground,
          marginTop: 2,
        }}
      >
        {label}
      </Text>
    </View>
  );

  return (
    <Card style={{ gap: 14 }}>
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 15, color: colors.foreground }}>
            {projection.pitcher}
          </Text>
          {projection.throws ? <Badge label={`${projection.throws}HP`} mono /> : null}
        </View>
        <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground, marginTop: 2 }}>
          {projection.team} · vs {projection.opponent}
        </Text>
      </View>

      <View style={{ flexDirection: 'row' }}>
        {stat(projection.expectedStrikeouts.toFixed(2), 'Proj K', colors.primary)}
        {stat(projection.projectedBattersFaced.toFixed(1), 'Proj BF')}
        {stat(`${projection.opponentFactor.toFixed(2)}×`, 'Opp Adj')}
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.mutedForeground }}>
          K/BF {(projection.ratePerBF * 100).toFixed(1)}%
        </Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.mutedForeground }}>
          {projection.sampleStarts} starts / {projection.sampleBattersFaced} BF
        </Text>
        {!projection.opponentDataAvailable ? (
          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.warning }}>
            opp split N/A
          </Text>
        ) : null}
      </View>

      {projection.lines.length > 0 ? (
        <View>
          <LinesHeader />
          {projection.lines.map((line, idx) => (
            <LineRow
              key={`${line.point}-${line.selection}-${idx}`}
              line={line}
              logState={logStateFor(line)}
              onLog={() => logTrade(line)}
            />
          ))}
        </View>
      ) : (
        <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.mutedForeground }}>
          No qualifying lines at the current edge threshold.
        </Text>
      )}

      {feedback ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 10,
            paddingVertical: 9,
            borderRadius: colors.radius,
            borderWidth: 1,
            borderColor:
              feedback.type === 'success'
                ? 'rgba(0,204,102,0.35)'
                : 'rgba(239,68,68,0.35)',
            backgroundColor:
              feedback.type === 'success'
                ? 'rgba(0,204,102,0.08)'
                : 'rgba(239,68,68,0.08)',
          }}
        >
          <Feather
            name={feedback.type === 'success' ? 'check-circle' : 'alert-circle'}
            size={14}
            color={feedback.type === 'success' ? colors.positive : colors.destructive}
          />
          <Text
            style={{
              flex: 1,
              fontFamily: fonts.regular,
              fontSize: 12,
              color: feedback.type === 'success' ? colors.positive : colors.destructive,
            }}
          >
            {feedback.text}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

export default function EdgesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<ScanMode>('model');
  const [selectedDay, setSelectedDay] = useState<string>('');
  const [selectedEventId, setSelectedEventId] = useState<string>('');

  const {
    data: events,
    isLoading: loadingEvents,
    isError: eventsError,
    refetch: refetchEvents,
    isRefetching: refetchingEvents,
  } = useListEvents(
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
  const dayEvents = eventsByDay[selectedDay] ?? [];

  // Default to the soonest day with games and keep the selection valid as the
  // event list refreshes. When the day auto-corrects, drop any selected game so
  // a credit-priced scan can't linger on a game that's off the visible slate.
  useEffect(() => {
    if (dayKeys.length > 0 && !dayKeys.includes(selectedDay)) {
      setSelectedDay(dayKeys[0]);
      setSelectedEventId('');
    }
  }, [dayKeys, selectedDay]);

  const selectedEventValid = dayEvents.some((ev) => ev.id === selectedEventId);

  const {
    data: projections,
    isLoading: loadingProjections,
    isError: projectionsError,
    refetch: refetchProjections,
  } = useListModelEdges(
    {
      sport: MODEL_SPORT,
      eventId: selectedEventId,
      minEdgePercent: MIN_EDGE_PERCENT,
      kellyMultiplier: KELLY_MULTIPLIER,
    },
    {
      query: {
        // Gated on the active mode so browsing props can't trigger a model scan.
        enabled: mode === 'model' && !!selectedEventId && selectedEventValid,
        queryKey: getListModelEdgesQueryKey({
          sport: MODEL_SPORT,
          eventId: selectedEventId,
          minEdgePercent: MIN_EDGE_PERCENT,
          kellyMultiplier: KELLY_MULTIPLIER,
        }),
      },
    },
  );

  // Player props are priced per market×region when a game is scanned, so the
  // query only runs after an explicit game tap while the Props mode is active.
  const {
    data: propEdges,
    isLoading: loadingPropEdges,
    isFetching: fetchingPropEdges,
    isError: propEdgesError,
    refetch: refetchPropEdges,
  } = useListPropEdges(
    { sport: MODEL_SPORT, eventId: selectedEventId },
    {
      query: {
        enabled: mode === 'props' && !!selectedEventId && selectedEventValid,
        queryKey: getListPropEdgesQueryKey({
          sport: MODEL_SPORT,
          eventId: selectedEventId,
        }),
      },
    },
  );

  const selectMode = (next: ScanMode) => {
    if (next === mode) return;
    haptic();
    setMode(next);
    // Drop the game selection so switching surfaces never auto-fires the other
    // mode's credit-priced scan — every scan stays an explicit tap.
    setSelectedEventId('');
  };

  const selectDay = (key: string) => {
    haptic();
    setSelectedDay(key);
    setSelectedEventId('');
  };

  const selectGame = (id: string) => {
    haptic();
    setSelectedEventId((cur) => (cur === id ? '' : id));
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        icon={mode === 'model' ? 'cpu' : 'user'}
        title={mode === 'model' ? 'Strikeout Model' : 'Player Props'}
        subtitle={
          mode === 'model'
            ? 'Fundamental pitcher-K projections vs the market, with Kelly staking. MLB only.'
            : 'Devig-based +EV player props, scanned per game. Scan-only — props stay out of the Scorecard and CLV. MLB only.'
        }
      />
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          gap: 16,
          paddingBottom: Platform.OS === 'web' ? 110 : insets.bottom + 90,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refetchingEvents}
            onRefresh={() => {
              refetchEvents();
              if (selectedEventId && selectedEventValid) {
                if (mode === 'model') refetchProjections();
                else refetchPropEdges();
              }
            }}
            tintColor={colors.primary}
          />
        }
      >
        <ModeSwitch mode={mode} onChange={selectMode} />

        {/* Day selector */}
        {loadingEvents ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} height={34} width={92} />
            ))}
          </View>
        ) : dayKeys.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8 }}
          >
            {dayKeys.map((k) => {
              const active = k === selectedDay;
              return (
                <Pressable
                  key={k}
                  onPress={() => selectDay(k)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: colors.radius,
                    borderWidth: 1,
                    borderColor: active ? colors.primary : colors.border,
                    backgroundColor: active ? colors.primary : 'transparent',
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: 13,
                      color: active ? colors.primaryForeground : colors.foreground,
                    }}
                  >
                    {formatDayLabel(k)}
                  </Text>
                  <View
                    style={{
                      paddingHorizontal: 5,
                      paddingVertical: 1,
                      borderRadius: colors.radius,
                      backgroundColor: active
                        ? 'rgba(0,18,46,0.18)'
                        : colors.secondary,
                    }}
                  >
                    <Text
                      style={{
                        fontFamily: fonts.monoMedium,
                        fontSize: 10,
                        color: active ? colors.primaryForeground : colors.mutedForeground,
                      }}
                    >
                      {eventsByDay[k].length}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        {/* Errors / empty games */}
        {eventsError ? (
          <ErrorState
            code="GAMES_UNAVAILABLE"
            message="Could not load upcoming games."
            onRetry={() => refetchEvents()}
          />
        ) : null}

        {!eventsError && !loadingEvents && (events?.length ?? 0) === 0 ? (
          <Card>
            <EmptyState icon="calendar" title="No upcoming MLB games listed right now." />
          </Card>
        ) : null}

        {/* Game picker */}
        {!eventsError && dayEvents.length > 0 ? (
          <View style={{ gap: 8 }}>
            <Text
              style={{
                fontFamily: fonts.regular,
                fontSize: 11,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: colors.mutedForeground,
              }}
            >
              Select game — each scan uses a few odds-API credits
            </Text>
            {dayEvents.map((ev) => {
              const active = ev.id === selectedEventId;
              return (
                <Pressable
                  key={ev.id}
                  onPress={() => selectGame(ev.id)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    borderRadius: colors.radius,
                    borderWidth: 1,
                    borderColor: active ? colors.primary : colors.cardBorder,
                    backgroundColor: active ? 'rgba(26,140,255,0.08)' : colors.card,
                    opacity: pressed ? 0.75 : 1,
                  })}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.foreground }}>
                      {ev.awayTeam} @ {ev.homeTeam}
                    </Text>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.mutedForeground, marginTop: 2 }}>
                      {formatTimeOnly(ev.commenceTime)}
                    </Text>
                  </View>
                  <Feather
                    name={active ? 'chevron-down' : 'chevron-right'}
                    size={18}
                    color={active ? colors.primary : colors.mutedForeground}
                  />
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* Results */}
        {!selectedEventId && !eventsError && (events?.length ?? 0) > 0 ? (
          <Card>
            <EmptyState
              icon={mode === 'model' ? 'cpu' : 'user'}
              title={
                mode === 'model'
                  ? 'Pick a game to project its starters'
                  : "Pick a game to scan its player props"
              }
              subtitle={
                mode === 'model'
                  ? "The model projects both probable starters' strikeouts and compares them to the market."
                  : 'Props are devigged across books to find +EV lines. Scans are read-only — nothing here is logged to the Scorecard.'
              }
            />
          </Card>
        ) : null}

        {mode === 'model' ? (
          <>
            {selectedEventId && loadingProjections ? (
              <View style={{ gap: 16 }}>
                {[1, 2].map((i) => (
                  <Card key={i}>
                    <Skeleton height={120} />
                  </Card>
                ))}
              </View>
            ) : null}

            {selectedEventId && projectionsError ? (
              <ErrorState
                code="PROJECTION_FAILED"
                message="Could not project this game. Try again shortly."
                onRetry={() => refetchProjections()}
              />
            ) : null}

            {selectedEventId && !loadingProjections && !projectionsError && projections
              ? projections.map((p) => <ProjectionCard key={p.pitcher + p.team} projection={p} />)
              : null}
          </>
        ) : (
          <>
            {selectedEventId && loadingPropEdges ? (
              <Card style={{ gap: 12 }}>
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} height={38} />
                ))}
              </Card>
            ) : null}

            {selectedEventId && propEdgesError ? (
              <ErrorState
                code="SCAN_FAILED"
                message="Could not retrieve player prop odds."
                onRetry={() => refetchPropEdges()}
              />
            ) : null}

            {selectedEventId && !loadingPropEdges && !propEdgesError && propEdges ? (
              <>
                {fetchingPropEdges ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.primary }}>
                      Updating props...
                    </Text>
                  </View>
                ) : null}
                <PropResultsCard edges={propEdges} />
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
