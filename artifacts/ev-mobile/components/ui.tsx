import React, { useEffect, type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  Text,
  View,
  type DimensionValue,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/fonts';

type FeatherName = keyof typeof Feather.glyphMap;

/** Elevated surface matching the web Card. */
export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: ViewStyle;
}) {
  const colors = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderColor: colors.cardBorder,
          borderWidth: 1,
          borderRadius: colors.radius,
          padding: 16,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Small outlined pill. */
export function Badge({
  label,
  color,
  borderColor,
  mono,
}: {
  label: string;
  color?: string;
  borderColor?: string;
  mono?: boolean;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: borderColor ?? colors.border,
        borderRadius: colors.radius,
        paddingHorizontal: 6,
        paddingVertical: 2,
        alignSelf: 'flex-start',
      }}
    >
      <Text
        style={{
          fontFamily: mono ? fonts.monoMedium : fonts.medium,
          fontSize: 10,
          letterSpacing: 0.5,
          color: color ?? colors.mutedForeground,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/** Pulsing placeholder block. */
export function Skeleton({
  height,
  width,
  style,
}: {
  height: number;
  width?: DimensionValue;
  style?: ViewStyle;
}) {
  const colors = useColors();
  const opacity = useSharedValue(0.4);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.85, { duration: 750 }), -1, true);
  }, [opacity]);
  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[
        {
          height,
          width: width ?? '100%',
          backgroundColor: colors.muted,
          borderRadius: colors.radius,
        },
        animStyle,
        style,
      ]}
    />
  );
}

/** Icon + uppercase section title. */
export function SectionHeader({
  icon,
  title,
}: {
  icon: FeatherName;
  title: string;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 14,
      }}
    >
      <Feather name={icon} size={16} color={colors.primary} />
      <Text
        style={{
          fontFamily: fonts.semibold,
          fontSize: 13,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          color: colors.foreground,
        }}
      >
        {title}
      </Text>
    </View>
  );
}

/** A single stat: big mono value over an uppercase label. */
export function StatTile({
  label,
  value,
  tone,
  muted,
  big,
  hint,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg' | 'primary';
  muted?: boolean;
  big?: boolean;
  hint?: string;
}) {
  const colors = useColors();
  const valueColor = muted
    ? colors.mutedForeground
    : tone === 'pos'
      ? colors.positive
      : tone === 'neg'
        ? colors.destructive
        : tone === 'primary'
          ? colors.primary
          : colors.foreground;
  return (
    <View style={{ opacity: muted ? 0.7 : 1 }}>
      <Text
        style={{
          fontFamily: fonts.monoBold,
          fontSize: big ? 34 : 20,
          color: valueColor,
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          fontFamily: fonts.regular,
          fontSize: 10,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          color: colors.mutedForeground,
          marginTop: 2,
        }}
      >
        {label}
      </Text>
      {hint ? (
        <Text
          style={{
            fontFamily: fonts.regular,
            fontSize: 10,
            color: colors.mutedForeground,
            marginTop: 2,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** Centered icon + text empty state. */
export function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: FeatherName;
  title: string;
  subtitle?: string;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 48,
        paddingHorizontal: 24,
        gap: 10,
      }}
    >
      <Feather name={icon} size={30} color={colors.mutedForeground} style={{ opacity: 0.5 }} />
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 15,
          color: colors.foreground,
          textAlign: 'center',
        }}
      >
        {title}
      </Text>
      {subtitle ? (
        <Text
          style={{
            fontFamily: fonts.regular,
            fontSize: 12.5,
            color: colors.mutedForeground,
            textAlign: 'center',
            lineHeight: 18,
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

/** Error card with a monospace code, message, and optional retry. */
export function ErrorState({
  code,
  message,
  onRetry,
}: {
  code: string;
  message: string;
  onRetry?: () => void;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: 'rgba(239,68,68,0.25)',
        backgroundColor: 'rgba(239,68,68,0.06)',
        borderRadius: colors.radius,
        paddingVertical: 32,
        paddingHorizontal: 20,
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Text style={{ fontFamily: fonts.monoSemibold, fontSize: 13, color: colors.destructive }}>
        {code}
      </Text>
      <Text
        style={{
          fontFamily: fonts.regular,
          fontSize: 12.5,
          color: colors.mutedForeground,
          textAlign: 'center',
        }}
      >
        {message}
      </Text>
      {onRetry ? (
        <Pressable
          onPress={() => {
            if (Platform.OS !== 'web') Haptics.selectionAsync();
            onRetry();
          }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            marginTop: 6,
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: colors.radius,
            borderWidth: 1,
            borderColor: colors.border,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Feather name="refresh-cw" size={13} color={colors.foreground} />
          <Text style={{ fontFamily: fonts.medium, fontSize: 12.5, color: colors.foreground }}>
            Retry
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Custom top header with safe-area handling (works on native + web). */
export function ScreenHeader({
  icon,
  title,
  subtitle,
}: {
  icon: FeatherName;
  title: string;
  subtitle?: string;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top + 10;
  return (
    <View
      style={{
        paddingTop: topPad,
        paddingHorizontal: 16,
        paddingBottom: 14,
        backgroundColor: colors.card,
        borderBottomWidth: 1,
        borderBottomColor: colors.cardBorder,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
        <Feather name={icon} size={22} color={colors.primary} />
        <Text style={{ fontFamily: fonts.bold, fontSize: 22, color: colors.foreground }}>
          {title}
        </Text>
      </View>
      {subtitle ? (
        <Text
          style={{
            fontFamily: fonts.regular,
            fontSize: 12.5,
            color: colors.mutedForeground,
            marginTop: 5,
            lineHeight: 17,
          }}
        >
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
