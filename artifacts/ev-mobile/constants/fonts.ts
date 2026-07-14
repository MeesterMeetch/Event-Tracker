/**
 * Font family names, matching the EV Tracker web artifact:
 *   --app-font-sans: 'Geist'
 *   --app-font-mono: 'Geist Mono'
 *
 * Numbers/odds/stats use the mono family for the terminal aesthetic; labels
 * and prose use the sans family. Loaded in app/_layout.tsx.
 */
export const fonts = {
  regular: 'Geist_400Regular',
  medium: 'Geist_500Medium',
  semibold: 'Geist_600SemiBold',
  bold: 'Geist_700Bold',

  mono: 'GeistMono_400Regular',
  monoMedium: 'GeistMono_500Medium',
  monoSemibold: 'GeistMono_600SemiBold',
  monoBold: 'GeistMono_700Bold',
} as const;
