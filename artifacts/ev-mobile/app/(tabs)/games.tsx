import React, { useState } from 'react';
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useListMlbGames, type GameSummary } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/fonts';
import { Feather } from '@expo/vector-icons';
import {
  Card,
  EmptyState,
  ErrorState,
  ScreenHeader,
  Skeleton,
} from '@/components/ui';

// ─── Date helpers ────────────────────────────────────────────────────────────

function todayEastern(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function shiftDate(dateStr: string, days: number): string {
  // Parse as local wall-clock to avoid timezone shift
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function formatDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatGameTime(gameDate: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(gameDate));
}

function haptic() {
  if (Platform.OS !== 'web') Haptics.selectionAsync();
}

// ─── Date navigator ───────────────────────────────────────────────────────────

function DateNavigator({
  date,
  onPrev,
  onNext,
}: {
  date: string;
  onPrev: () => void;
  onNext: () => void;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: colors.card,
        borderBottomWidth: 1,
        borderBottomColor: colors.cardBorder,
      }}
    >
      <Pressable
        onPress={() => { haptic(); onPrev(); }}
        style={({ pressed }) => ({
          padding: 8,
          borderRadius: colors.radius,
          opacity: pressed ? 0.5 : 1,
        })}
        accessibilityLabel="Previous day"
      >
        <Feather name="chevron-left" size={20} color={colors.foreground} />
      </Pressable>

      <Text
        style={{
          fontFamily: fonts.semibold,
          fontSize: 15,
          color: colors.foreground,
        }}
      >
        {formatDateLabel(date)}
      </Text>

      <Pressable
        onPress={() => { haptic(); onNext(); }}
        style={({ pressed }) => ({
          padding: 8,
          borderRadius: colors.radius,
          opacity: pressed ? 0.5 : 1,
        })}
        accessibilityLabel="Next day"
      >
        <Feather name="chevron-right" size={20} color={colors.foreground} />
      </Pressable>
    </View>
  );
}

// ─── Game card ────────────────────────────────────────────────────────────────

type StatusStyle = { label: string; color: string; border: string };

function gameStatusStyle(abstractState: string, colors: ReturnType<typeof useColors>): StatusStyle {
  switch (abstractState) {
    case 'Live':
      return { label: 'Live', color: colors.positive, border: 'rgba(0,204,102,0.35)' };
    case 'Final':
      return { label: 'Final', color: colors.mutedForeground, border: colors.border };
    default:
      return { label: 'Scheduled', color: colors.primary, border: 'rgba(26,140,255,0.35)' };
  }
}

function GameCard({ game }: { game: GameSummary }) {
  const colors = useColors();
  const hasScore =
    game.status.abstractGameState === 'Live' ||
    game.status.abstractGameState === 'Final';
  const st = gameStatusStyle(game.status.abstractGameState, colors);

  return (
    <Card style={{ marginBottom: 10 }}>
      {/* Start time + status badge */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Feather name="clock" size={11} color={colors.mutedForeground} />
          <Text
            style={{
              fontFamily: fonts.regular,
              fontSize: 11.5,
              color: colors.mutedForeground,
            }}
          >
            {formatGameTime(game.gameDate)}
          </Text>
        </View>

        {/* Status pill */}
        <View
          style={{
            borderWidth: 1,
            borderColor: st.border,
            borderRadius: colors.radius,
            paddingHorizontal: 7,
            paddingVertical: 2,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 10,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              color: st.color,
            }}
          >
            {st.label}
          </Text>
        </View>
      </View>

      {/* Away row */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 5,
        }}
      >
        <Text
          style={{ fontFamily: fonts.medium, fontSize: 15, color: colors.foreground, flex: 1 }}
          numberOfLines={1}
        >
          {game.awayTeam}
        </Text>
        {hasScore && game.awayScore != null && (
          <Text
            style={{
              fontFamily: fonts.monoBold,
              fontSize: 18,
              color: colors.foreground,
              minWidth: 24,
              textAlign: 'right',
            }}
          >
            {game.awayScore}
          </Text>
        )}
      </View>

      {/* Home row */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Text
          style={{ fontFamily: fonts.medium, fontSize: 15, color: colors.foreground, flex: 1 }}
          numberOfLines={1}
        >
          {game.homeTeam}
        </Text>
        {hasScore && game.homeScore != null && (
          <Text
            style={{
              fontFamily: fonts.monoBold,
              fontSize: 18,
              color: colors.foreground,
              minWidth: 24,
              textAlign: 'right',
            }}
          >
            {game.homeScore}
          </Text>
        )}
      </View>

      {/* Probable pitchers */}
      {(game.awayProbablePitcher || game.homeProbablePitcher) && (
        <View
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            gap: 3,
          }}
        >
          {game.awayProbablePitcher && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Feather name="user" size={10} color={colors.mutedForeground} />
              <Text
                style={{
                  fontFamily: fonts.regular,
                  fontSize: 11.5,
                  color: colors.mutedForeground,
                  flex: 1,
                }}
                numberOfLines={1}
              >
                {game.awayTeam.split(' ').slice(-1)[0]}: {game.awayProbablePitcher.name}
              </Text>
            </View>
          )}
          {game.homeProbablePitcher && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Feather name="user" size={10} color={colors.mutedForeground} />
              <Text
                style={{
                  fontFamily: fonts.regular,
                  fontSize: 11.5,
                  color: colors.mutedForeground,
                  flex: 1,
                }}
                numberOfLines={1}
              >
                {game.homeTeam.split(' ').slice(-1)[0]}: {game.homeProbablePitcher.name}
              </Text>
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function GamesScreen() {
  const [selectedDate, setSelectedDate] = useState(todayEastern);
  const colors = useColors();

  const {
    data: games,
    isLoading,
    isError,
    refetch,
  } = useListMlbGames({ date: selectedDate });

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScreenHeader
        icon="calendar"
        title="MLB Games"
        subtitle="Schedule, starters & scores"
      />

      <DateNavigator
        date={selectedDate}
        onPrev={() => setSelectedDate((d) => shiftDate(d, -1))}
        onNext={() => setSelectedDate((d) => shiftDate(d, 1))}
      />

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={refetch}
            tintColor={colors.primary}
          />
        }
      >
        {isLoading && (
          <View style={{ gap: 10 }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} height={110} />
            ))}
          </View>
        )}

        {isError && (
          <ErrorState
            code="SCHEDULE_ERROR"
            message="Could not load the schedule. Pull down to retry."
            onRetry={refetch}
          />
        )}

        {!isLoading && !isError && games != null && games.length === 0 && (
          <EmptyState
            icon="calendar"
            title="No games scheduled"
            subtitle="Try a different date."
          />
        )}

        {!isLoading && !isError && games != null && games.length > 0 && (
          <View>
            {games.map((game) => (
              <GameCard key={game.gamePk} game={game} />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
