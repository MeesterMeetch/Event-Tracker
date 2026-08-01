// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DashboardSummary, SportBreakdown } from "@workspace/api-client-react";

/**
 * Locks in the dashboard's "no green zero before results" rule on the web
 * Performance Terminal, mirroring the mobile ledger-card test: the Total P&L
 * and Yield (ROI) values must stay muted (with an awaiting-results hint)
 * until there is realized settled stake — keyed off summary.totalUnits > 0,
 * NOT the W-L-P count. This covers the API edge case where a bet is settled
 * but its pnl is still null (totalUnits 0): an unmuted "$0.00 / 0.00%" must
 * never render next to a non-zero record as if results were in.
 */

let summaryData: DashboardSummary | undefined;

interface LedgerAudit {
  impossibleOddsBets: number;
  zeroOrNegativeUnitBets: number;
  settledNullPnlBets: number;
  contradictoryPnlBets: number;
  impossibleOddsPaperTrades: number;
  total: number;
}

let auditData: LedgerAudit | undefined;

vi.mock("@workspace/api-client-react", () => ({
  useGetDashboardSummary: () => ({
    data: summaryData,
    isLoading: false,
    isError: false,
  }),
  useListSports: () => ({ data: [] }),
  useGetLedgerAudit: () => ({ data: auditData }),
}));

import Dashboard from "./Dashboard";

function makeSummary(overrides: Partial<DashboardSummary>): DashboardSummary {
  return {
    totalBets: 3,
    won: 0,
    lost: 0,
    push: 0,
    pending: 3,
    totalUnits: 0,
    pendingUnits: 0,
    totalPnl: 0,
    roiPercent: 0,
    avgClvPercent: null,
    clvSampleSize: 0,
    bySport: [],
    ...overrides,
  };
}

/**
 * The four stat-card values all render as `.text-2xl.font-mono` divs in a
 * fixed order: Total P&L, Settled Stake, Yield (ROI), Average CLV.
 */
function statValues(container: HTMLElement) {
  const els = container.querySelectorAll<HTMLElement>("div.text-2xl.font-mono");
  expect(els.length).toBe(4);
  return { pnl: els[0], roi: els[2] };
}

// No vitest globals, so testing-library's auto-cleanup never registers —
// unmount explicitly or renders leak across tests.
afterEach(() => {
  cleanup();
  auditData = undefined;
});

describe("Dashboard corrupt-ledger banner", () => {
  it("renders no banner when the audit is clean or still loading", () => {
    summaryData = makeSummary({});
    auditData = undefined; // audit not loaded yet
    const first = render(<Dashboard />);
    expect(first.container.querySelector('[data-testid="alert-ledger-audit"]')).toBeNull();
    first.unmount();

    auditData = {
      impossibleOddsBets: 0,
      zeroOrNegativeUnitBets: 0,
      settledNullPnlBets: 0,
      contradictoryPnlBets: 0,
      impossibleOddsPaperTrades: 0,
      total: 0,
    };
    const second = render(<Dashboard />);
    expect(second.container.querySelector('[data-testid="alert-ledger-audit"]')).toBeNull();
  });

  it("surfaces per-category counts when corrupt rows exist", () => {
    summaryData = makeSummary({});
    auditData = {
      impossibleOddsBets: 2,
      zeroOrNegativeUnitBets: 0,
      settledNullPnlBets: 1,
      contradictoryPnlBets: 0,
      impossibleOddsPaperTrades: 1,
      total: 4,
    };
    const { container, getByText } = render(<Dashboard />);

    const banner = container.querySelector('[data-testid="alert-ledger-audit"]');
    expect(banner).not.toBeNull();
    expect(getByText(/4 corrupt ledger entries are skewing profit\/ROI/)).toBeTruthy();
    // Only non-zero categories are listed.
    const description = banner!.textContent ?? "";
    expect(description).toContain("2 bet(s) with impossible odds");
    expect(description).toContain("1 settled bet(s) missing P&L");
    expect(description).toContain("1 paper trade(s) with impossible odds");
    expect(description).not.toContain("zero or negative units");
    expect(description).not.toContain("contradicts their result");
  });
});

describe("Dashboard stat cards — realized-stake muting", () => {
  it("mutes P&L and ROI with the awaiting hint when nothing is settled", () => {
    summaryData = makeSummary({});
    const { container, getByText } = render(<Dashboard />);

    const { pnl, roi } = statValues(container);
    expect(pnl.className).toContain("text-muted-foreground");
    expect(pnl.className).not.toContain("text-positive");
    expect(roi.className).toContain("text-muted-foreground");
    expect(roi.className).not.toContain("text-positive");
    expect(getByText(/Awaiting results ·/)).toBeTruthy();
    expect(getByText(/Awaiting results — no settled stake yet/)).toBeTruthy();
  });

  it("stays muted when bets are settled but no stake is realized (pnl still null)", () => {
    // API edge case: W-L-P is non-zero but totalUnits (settled stake with a
    // real pnl) is 0 — the exact "green zero next to a 2-1-0 record" trap.
    summaryData = makeSummary({ won: 2, lost: 1, pending: 0 });
    const { container, getByText } = render(<Dashboard />);

    expect(getByText(/Record: 2-1-0/)).toBeTruthy();
    const { pnl, roi } = statValues(container);
    expect(pnl.textContent).toBe("$0.00");
    expect(pnl.className).toContain("text-muted-foreground");
    expect(pnl.className).not.toContain("text-positive");
    expect(pnl.className).not.toContain("text-negative");
    expect(roi.textContent).toBe("0.00%");
    expect(roi.className).toContain("text-muted-foreground");
    expect(roi.className).not.toContain("text-positive");
    expect(getByText(/Awaiting results — no settled stake yet/)).toBeTruthy();
  });

  it("shows unmuted green P&L and ROI once realized stake is positive", () => {
    summaryData = makeSummary({
      won: 2,
      lost: 1,
      pending: 0,
      totalUnits: 3,
      totalPnl: 1.85,
      roiPercent: 61.7,
    });
    const { container, queryByText } = render(<Dashboard />);

    const { pnl, roi } = statValues(container);
    expect(pnl.textContent).toBe("+$1.85");
    expect(pnl.className).toContain("text-positive");
    expect(pnl.className).not.toContain("text-muted-foreground");
    expect(roi.textContent).toBe("+61.70%");
    expect(roi.className).toContain("text-positive");
    expect(roi.className).not.toContain("text-muted-foreground");
    expect(queryByText(/Awaiting results/)).toBeNull();
  });

  it("shows unmuted red P&L and ROI for a losing realized ledger", () => {
    summaryData = makeSummary({
      won: 0,
      lost: 3,
      pending: 0,
      totalUnits: 3,
      totalPnl: -3,
      roiPercent: -100,
    });
    const { container } = render(<Dashboard />);

    const { pnl, roi } = statValues(container);
    expect(pnl.className).toContain("text-negative");
    expect(pnl.className).not.toContain("text-muted-foreground");
    expect(roi.className).toContain("text-negative");
    expect(roi.className).not.toContain("text-muted-foreground");
  });

  it("keeps a realized break-even ledger neutral (no tone) but unmuted", () => {
    summaryData = makeSummary({
      won: 1,
      lost: 1,
      pending: 0,
      totalUnits: 2,
      totalPnl: 0,
      roiPercent: 0,
    });
    const { container, queryByText } = render(<Dashboard />);

    const { pnl, roi } = statValues(container);
    expect(pnl.className).not.toContain("text-positive");
    expect(pnl.className).not.toContain("text-negative");
    expect(pnl.className).not.toContain("text-muted-foreground");
    expect(roi.className).not.toContain("text-positive");
    expect(roi.className).not.toContain("text-negative");
    expect(roi.className).not.toContain("text-muted-foreground");
    expect(queryByText(/Awaiting results/)).toBeNull();
  });
});

function makeSportRow(overrides: Partial<SportBreakdown>): SportBreakdown {
  return {
    sport: "baseball_mlb",
    bets: 3,
    won: 0,
    lost: 0,
    push: 0,
    pending: 3,
    pendingUnits: 0,
    settledUnits: 0,
    roiPercent: 0,
    pnl: 0,
    ...overrides,
  };
}

/**
 * Returns the ROI and P&L cells of the single Sport Breakdown row. Column
 * order is fixed in Dashboard.tsx: Sport, Bets, Record, Pending, ROI, P&L —
 * so ROI is the 5th cell and P&L the 6th (last).
 */
function sportRowCells(container: HTMLElement) {
  const rows = container.querySelectorAll("tbody tr");
  expect(rows.length).toBe(1);
  const cells = rows[0].querySelectorAll<HTMLElement>("td");
  expect(cells.length).toBe(6);
  return { roi: cells[4], pnl: cells[5] };
}

describe("Sport Breakdown rows — realized-stake tinting", () => {
  it("leaves ROI and P&L untinted when bets settled but no stake realized (pnl still null)", () => {
    // Same API edge case as the stat cards, one level down: the sport shows a
    // 2-1-0 record but settledUnits is 0 because every settled bet still has
    // a null pnl. The $0.00 / 0.00% cells must carry no green/red class next
    // to that record.
    summaryData = makeSummary({
      won: 2,
      lost: 1,
      pending: 0,
      bySport: [makeSportRow({ won: 2, lost: 1, pending: 0, settledUnits: 0 })],
    });
    const { container, getByText } = render(<Dashboard />);

    expect(getByText("2-1-0")).toBeTruthy();
    const { roi, pnl } = sportRowCells(container);
    expect(roi.textContent).toBe("0.00%");
    expect(roi.className).not.toContain("text-positive");
    expect(roi.className).not.toContain("text-negative");
    expect(pnl.textContent).toBe("$0.00");
    expect(pnl.className).not.toContain("text-positive");
    expect(pnl.className).not.toContain("text-negative");
  });

  it("tints ROI and P&L green once the sport has positive realized stake", () => {
    summaryData = makeSummary({
      won: 2,
      lost: 1,
      pending: 0,
      totalUnits: 3,
      totalPnl: 1.85,
      roiPercent: 61.7,
      bySport: [
        makeSportRow({
          won: 2,
          lost: 1,
          pending: 0,
          settledUnits: 3,
          pnl: 1.85,
          roiPercent: 61.7,
        }),
      ],
    });
    const { container } = render(<Dashboard />);

    const { roi, pnl } = sportRowCells(container);
    expect(roi.textContent).toBe("+61.70%");
    expect(roi.className).toContain("text-positive");
    expect(pnl.textContent).toBe("+$1.85");
    expect(pnl.className).toContain("text-positive");
  });

  it("tints a losing sport row red off realized stake", () => {
    summaryData = makeSummary({
      won: 0,
      lost: 3,
      pending: 0,
      totalUnits: 3,
      totalPnl: -3,
      roiPercent: -100,
      bySport: [
        makeSportRow({
          lost: 3,
          pending: 0,
          settledUnits: 3,
          pnl: -3,
          roiPercent: -100,
        }),
      ],
    });
    const { container } = render(<Dashboard />);

    const { roi, pnl } = sportRowCells(container);
    expect(roi.className).toContain("text-negative");
    expect(pnl.className).toContain("text-negative");
  });

  it("keeps a realized break-even sport row neutral (no tone)", () => {
    summaryData = makeSummary({
      won: 1,
      lost: 1,
      pending: 0,
      totalUnits: 2,
      bySport: [makeSportRow({ won: 1, lost: 1, pending: 0, settledUnits: 2 })],
    });
    const { container } = render(<Dashboard />);

    const { roi, pnl } = sportRowCells(container);
    expect(roi.className).not.toContain("text-positive");
    expect(roi.className).not.toContain("text-negative");
    expect(pnl.className).not.toContain("text-positive");
    expect(pnl.className).not.toContain("text-negative");
  });
});
