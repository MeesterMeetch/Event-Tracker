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
  getGetPaperTradeSummaryQueryKey,
  getListBetsQueryKey,
  getListEventsQueryKey,
  getListModelEdgesQueryKey,
  getListPaperTradesQueryKey,
  getListPropEdgesQueryKey,
  useCreateBet,
  useCreatePaperTrade,
  useListEvents,
  useListModelEdges,
  useListPropEdges,
  useListSports,
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
 * Props are a separate surface: they're priced per market when a game is
 * scanned, and promising ones can be logged to the bet log — but they never
 * feed the paper-trade scorecard or CLV tracking.
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

/** Bet-log selection label matching the web convention: "Aaron Judge Over 1.5". */
const propSelectionLabel = (edge: EdgeOpportunity) =>
  edge.player ? `${edge.player} ${edge.selection}` : edge.selection;

function PropRow({
  edge,
  logState,
  onLog,
}: {
  edge: EdgeOpportunity;
  logState: LogState;
  onLog: () => void;
}) {
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
      <View style={{ width: 38, alignItems: 'flex-end' }}>
        <LogButton
          state={logState}
          onPress={onLog}
          loggedLabel="Logged to bet log"
          idleLabel={`Log ${propSelectionLabel(edge)} to bet log`}
        />
      </View>
    </View>
  );
}

/**
 * Bottom-sheet form for logging a scanned prop to the bet log (units + notes),
 * mirroring the web LogBetDialog. Props go to the bet log only — never the
 * paper-trade scorecard, which stays reserved for the K model.
 */
function LogPropSheet({
  edge,
  onClose,
  onLogged,
}: {
  edge: EdgeOpportunity;
  onClose: () => void;
  onLogged: (edge: EdgeOpportunity, units: number) => void;
}) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const createBet = useCreateBet();
  const [units, setUnits] = useState('1');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const parsedUnits = Number(units.replace(',', '.'));
  const unitsValid = Number.isFinite(parsedUnits) && parsedUnits >= 0.01;
  const selectionLabel = propSelectionLabel(edge);

  const submit = () => {
    if (!unitsValid || createBet.isPending) return;
    haptic();
    setError(null);
    createBet.mutate(
      {
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
          units: parsedUnits,
          fairOdds: edge.fairOdds,
          evPercent: edge.evPercent,
          book: edge.book,
          notes: notes.trim() ? notes.trim() : null,
        },
      },
      {
        onSuccess: () => {
          if (Platform.OS !== 'web') {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          queryClient.invalidateQueries({ queryKey: getListBetsQueryKey() });
          onLogged(edge, parsedUnits);
        },
        onError: (err) => {
          setError(err?.data?.error || 'Could not log this bet. Try again.');
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
                Log Bet
              </Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
                <Feather name="x" size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>

            {/* Prop summary */}
            <View
              style={{
                borderRadius: colors.radius,
                backgroundColor: colors.secondary,
                padding: 12,
                gap: 8,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text
                  style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.foreground }}
                  numberOfLines={1}
                >
                  {selectionLabel} {formatPoint(edge.point, edge.market)}
                </Text>
                <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 13, color: colors.primary }}>
                  {formatOdds(edge.americanOdds)}
                </Text>
              </View>
              <Text
                style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.mutedForeground }}
                numberOfLines={1}
              >
                {formatMarketLabel(edge.market)} · {edge.book} · {edge.awayTeam} @ {edge.homeTeam}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingTop: 8,
                  borderTopWidth: 1,
                  borderTopColor: colors.cardBorder,
                }}
              >
                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.mutedForeground }}>
                  Fair {formatOdds(edge.fairOdds)}
                </Text>
                <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 11, color: colors.positive }}>
                  EV {formatPercent(edge.evPercent)}
                </Text>
              </View>
            </View>

            <View>
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
                  Must wager at least 0.01 units.
                </Text>
              ) : null}
            </View>

            <View>
              <Text style={label}>Notes (optional)</Text>
              <TextInput
                value={notes}
                onChangeText={setNotes}
                multiline
                accessibilityLabel="Notes"
                placeholder="e.g. Line moving quickly, best price available"
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
              disabled={!unitsValid || createBet.isPending}
              accessibilityRole="button"
              accessibilityLabel="Log bet"
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                paddingVertical: 13,
                borderRadius: colors.radius,
                backgroundColor: colors.primary,
                opacity: !unitsValid || createBet.isPending ? 0.5 : pressed ? 0.75 : 1,
              })}
            >
              {createBet.isPending ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Feather name="plus" size={15} color={colors.primaryForeground} />
              )}
              <Text style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.primaryForeground }}>
                Log Bet
              </Text>
            </Pressable>

            <Text style={{ fontFamily: fonts.regular, fontSize: 10.5, color: colors.mutedForeground, lineHeight: 15 }}>
              Logged to your bet log — props stay out of the paper-trade Scorecard and CLV.
            </Text>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
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
      <Text style={[cell, { width: 38, textAlign: 'right' }]}>Log</Text>
    </View>
  );
}

const propKey = (edge: EdgeOpportunity) =>
  `${edge.market}-${edge.player}-${edge.selection}-${edge.point}-${edge.book}`;

/**
 * Scanned prop edges for one game. Each row can be logged to the bet log
 * (units + notes) — props still never touch the paper-trade scorecard or CLV.
 */
function PropResultsCard({ edges }: { edges: EdgeOpportunity[] }) {
  const colors = useColors();
  // The sheet edits one prop at a time; `logged` keeps the row's button in a
  // checked state so the same scan can't double-log a prop by accident.
  const [logging, setLogging] = useState<EdgeOpportunity | null>(null);
  const [logged, setLogged] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    if (!confirmation) return;
    const t = setTimeout(() => setConfirmation(null), 4000);
    return () => clearTimeout(t);
  }, [confirmation]);

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

  const logStateFor = (edge: EdgeOpportunity): LogState =>
    logged.has(propKey(edge)) ? 'logged' : 'idle';

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
        <Badge label="Logs to bet log · not scorecard" mono />
      </View>
      <View>
        <PropsHeader />
        {edges.map((edge, idx) => (
          <PropRow
            key={`${propKey(edge)}-${idx}`}
            edge={edge}
            logState={logStateFor(edge)}
            onLog={() => {
              haptic();
              setLogging(edge);
            }}
          />
        ))}
      </View>
      {confirmation ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 10,
            paddingVertical: 9,
            borderRadius: colors.radius,
            borderWidth: 1,
            borderColor: 'rgba(0,204,102,0.35)',
            backgroundColor: 'rgba(0,204,102,0.08)',
          }}
        >
          <Feather name="check-circle" size={14} color={colors.positive} />
          <Text style={{ flex: 1, fontFamily: fonts.regular, fontSize: 12, color: colors.positive }}>
            {confirmation}
          </Text>
        </View>
      ) : null}
      <Text
        style={{
          fontFamily: fonts.regular,
          fontSize: 10.5,
          color: colors.mutedForeground,
          lineHeight: 15,
        }}
      >
        Fair odds come from devigging each prop across books. Logged props go to the bet log —
        they aren't tracked in the Scorecard and are excluded from CLV.
      </Text>
      {logging ? (
        <LogPropSheet
          edge={logging}
          onClose={() => setLogging(null)}
          onLogged={(edge, units) => {
            setLogged((prev) => new Set(prev).add(propKey(edge)));
            setLogging(null);
            setConfirmation(
              `Logged ${units}u on ${propSelectionLabel(edge)} ${formatPoint(edge.point, edge.market)} @ ${formatOdds(edge.americanOdds)}`,
            );
          }}
        />
      ) : null}
    </Card>
  );
}

type LogState = 'idle' | 'pending' | 'logged';

function LogButton({
  state,
  onPress,
  loggedLabel = 'Logged to scorecard',
  idleLabel = 'Log paper trade',
}: {
  state: LogState;
  onPress: () => void;
  loggedLabel?: string;
  idleLabel?: string;
}) {
  const colors = useColors();
  const disabled = state !== 'idle';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={state === 'logged' ? loggedLabel : idleLabel}
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
  // Props mode can scan any props-capable league; the K model itself stays
  // MLB-only. Defaults to MLB and auto-corrects below if MLB is out of season.
  const [propSport, setPropSport] = useState<string>(MODEL_SPORT);

  // The in-season sport list is free on the Odds API, so it loads eagerly and
  // the picker only ever offers leagues that are actually posting odds.
  const {
    data: sports,
    isLoading: loadingSports,
    isError: sportsError,
    refetch: refetchSports,
  } = useListSports();
  const propsSports = useMemo(
    () => (sports ?? []).filter((s) => s.supportsProps),
    [sports],
  );
  const propSportValid = propsSports.some((s) => s.key === propSport);

  // Keep the props sport valid as the live list shifts (e.g. MLB drops off
  // over the All-Star break): fall back to the first props-capable sport. Any
  // time Props mode is left without a valid sport — including a failed or
  // empty sports list — drop the selected game too, so no stale event id can
  // feed a later credit-priced scan.
  useEffect(() => {
    if (propSportValid) return;
    if (mode === 'props' && selectedEventId) setSelectedEventId('');
    if (propsSports.length > 0) setPropSport(propsSports[0].key);
  }, [propsSports, propSportValid, mode, selectedEventId]);

  const activeSport = mode === 'model' ? MODEL_SPORT : propSport;
  const activeSportTitle =
    mode === 'model'
      ? 'MLB'
      : (propsSports.find((s) => s.key === propSport)?.title ?? '');
  // Everything below the pickers (days, games, results) hangs off the active
  // sport; in Props mode that sport must be confirmed props-capable, or stale
  // cached data for an invalid sport could render a contradictory slate.
  const slateReady = mode === 'model' || propSportValid;

  const {
    data: events,
    isLoading: loadingEvents,
    isError: eventsError,
    refetch: refetchEvents,
    isRefetching: refetchingEvents,
  } = useListEvents(
    { sport: activeSport },
    {
      query: {
        // In Props mode, wait until the sport is confirmed props-capable so a
        // stale default (e.g. out-of-season MLB) never fires a doomed fetch.
        enabled: mode === 'model' || propSportValid,
        queryKey: getListEventsQueryKey({ sport: activeSport }),
      },
    },
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
    { sport: propSport, eventId: selectedEventId },
    {
      query: {
        enabled:
          mode === 'props' && propSportValid && !!selectedEventId && selectedEventValid,
        queryKey: getListPropEdgesQueryKey({
          sport: propSport,
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

  const selectPropSport = (key: string) => {
    if (key === propSport) return;
    haptic();
    setPropSport(key);
    // New sport, new slate — drop the game selection so the old sport's
    // credit-priced scan can't linger or misfire on a mismatched event id.
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
            : 'Devig-based +EV player props in any in-season league, scanned per game. Log picks to the bet log — props stay out of the Scorecard and CLV.'
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
              // Manual refetches bypass react-query's `enabled` gates, so they
              // must re-apply the same eligibility rules: no events fetch for
              // an invalid props sport, and a prop re-scan (credit-priced)
              // only for a still-valid sport + explicitly selected game.
              if (mode === 'props') refetchSports();
              if (mode === 'model' || propSportValid) refetchEvents();
              if (selectedEventId && selectedEventValid) {
                if (mode === 'model') refetchProjections();
                else if (propSportValid) refetchPropEdges();
              }
            }}
            tintColor={colors.primary}
          />
        }
      >
        <ModeSwitch mode={mode} onChange={selectMode} />

        {/* Sport picker — props can be scanned in any props-capable league */}
        {mode === 'props' ? (
          loadingSports ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} height={34} width={76} />
              ))}
            </View>
          ) : sportsError ? (
            <ErrorState
              code="SPORTS_UNAVAILABLE"
              message="Could not load the in-season sport list."
              onRetry={() => refetchSports()}
            />
          ) : propsSports.length === 0 ? (
            <Card>
              <EmptyState
                icon="user"
                title="No props-capable sports are in season right now."
              />
            </Card>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {propsSports.map((s) => {
                const active = s.key === propSport;
                return (
                  <Pressable
                    key={s.key}
                    onPress={() => selectPropSport(s.key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={({ pressed }) => ({
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
                      {s.title}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )
        ) : null}

        {/* Day selector */}
        {!slateReady ? null : loadingEvents ? (
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
        {slateReady && eventsError ? (
          <ErrorState
            code="GAMES_UNAVAILABLE"
            message="Could not load upcoming games."
            onRetry={() => refetchEvents()}
          />
        ) : null}

        {slateReady && !eventsError && !loadingEvents && events && events.length === 0 ? (
          <Card>
            <EmptyState
              icon="calendar"
              title={
                activeSportTitle
                  ? `No upcoming ${activeSportTitle} games listed right now.`
                  : 'No upcoming games listed right now.'
              }
            />
          </Card>
        ) : null}

        {/* Game picker */}
        {slateReady && !eventsError && dayEvents.length > 0 ? (
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
        {slateReady && !selectedEventId && !eventsError && (events?.length ?? 0) > 0 ? (
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
                  : 'Props are devigged across books to find +EV lines. Log promising ones to the bet log — nothing here touches the Scorecard.'
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
