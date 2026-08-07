import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  GetDashboardSummaryParams,
  GetDashboardSummaryBasis,
} from "@workspace/api-client-react";

/**
 * Range control for the dashboard.
 *
 * The two bases are not cosmetic. A bet logged in June for a July game belongs
 * to July when you ask how you did last month, and to June when you ask how
 * much you were betting. Game date is the default because "how did I do in
 * July" is the question almost everyone is actually asking.
 */

/** Reuses the generated enum so the control cannot drift from the API. */
export type Basis = GetDashboardSummaryBasis;
export type PresetKey = "7d" | "30d" | "month" | "season" | "all" | "custom";

export interface RangeState {
  preset: PresetKey;
  basis: Basis;
  /** Only meaningful when preset is "custom". Local yyyy-mm-dd. */
  customFrom: string;
  customTo: string;
}

export const DEFAULT_RANGE: RangeState = {
  preset: "30d",
  basis: "game",
  customFrom: "",
  customTo: "",
};

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "month", label: "This month" },
  { key: "season", label: "Season" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom" },
];

function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * Turns the control's state into query params.
 *
 * Bounds are computed from local midnights and sent as instants, because a day
 * is a local idea and the server runs in UTC. The upper bound is exclusive and
 * set to the start of tomorrow, so "today" means all of today rather than
 * everything up to this moment.
 */
export function paramsFor(state: RangeState, now = new Date()): GetDashboardSummaryParams {
  const basis = state.basis;
  const endOfToday = startOfLocalDay(now);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const daysBack = (n: number) => {
    const d = startOfLocalDay(now);
    d.setDate(d.getDate() - n);
    return d;
  };

  switch (state.preset) {
    case "all":
      return { basis };
    case "7d":
      return { basis, from: daysBack(6).toISOString(), to: endOfToday.toISOString() };
    case "30d":
      return { basis, from: daysBack(29).toISOString(), to: endOfToday.toISOString() };
    case "month": {
      const first = startOfLocalDay(now);
      first.setDate(1);
      return { basis, from: first.toISOString(), to: endOfToday.toISOString() };
    }
    case "season": {
      // Calendar year. Deliberately not a sport-specific season: this ledger
      // holds several sports whose seasons do not share a start date, so any
      // single "season" boundary would be wrong for most of them.
      const jan = startOfLocalDay(now);
      jan.setMonth(0, 1);
      return { basis, from: jan.toISOString(), to: endOfToday.toISOString() };
    }
    case "custom": {
      const params: GetDashboardSummaryParams = { basis };
      if (state.customFrom) params.from = new Date(`${state.customFrom}T00:00:00`).toISOString();
      if (state.customTo) {
        // Exclusive, so a custom end date includes the whole of that day.
        const end = new Date(`${state.customTo}T00:00:00`);
        end.setDate(end.getDate() + 1);
        params.to = end.toISOString();
      }
      return params;
    }
  }
}

export default function DateRangeFilter({
  value,
  onChange,
}: {
  value: RangeState;
  onChange: (next: RangeState) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant={p.key === value.preset ? "default" : "outline"}
            onClick={() => onChange({ ...value, preset: p.key })}
            aria-pressed={p.key === value.preset}
            data-testid={`button-range-${p.key}`}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={value.basis === "game" ? "secondary" : "ghost"}
            onClick={() => onChange({ ...value, basis: "game" })}
            aria-pressed={value.basis === "game"}
            data-testid="button-basis-game"
          >
            By game date
          </Button>
          <Button
            size="sm"
            variant={value.basis === "logged" ? "secondary" : "ghost"}
            onClick={() => onChange({ ...value, basis: "logged" })}
            aria-pressed={value.basis === "logged"}
            data-testid="button-basis-logged"
          >
            By date logged
          </Button>
        </div>

        {value.preset === "custom" && (
          <div className="flex items-center gap-2" data-testid="group-custom-range">
            <Input
              type="date"
              className="h-8 w-auto"
              value={value.customFrom}
              onChange={(e) => onChange({ ...value, customFrom: e.target.value })}
              data-testid="input-range-from"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              className="h-8 w-auto"
              value={value.customTo}
              onChange={(e) => onChange({ ...value, customTo: e.target.value })}
              data-testid="input-range-to"
            />
          </div>
        )}
      </div>
    </div>
  );
}
