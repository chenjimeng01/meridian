// Presentation formatting (SPEC §8). Two rules carry most of the weight:
// a number never appears without its currency symbol, and figures that line up
// in a column use tabular-lining figures.
import type { Money } from "../engine/fx.ts";

const SYMBOLS: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", JPY: "¥", CHF: "CHF " };

export const esc = (value: unknown): string =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function symbol(currency: string): string {
  return SYMBOLS[currency] ?? `${currency} `;
}

/** e.g. £442,559.54 — always with the symbol, never a bare number. */
export function money(value: Money | undefined, decimals = 2): string {
  if (!value) return "—";
  const formatted = Math.abs(value.amount).toLocaleString("en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${value.amount < 0 ? "−" : ""}${symbol(value.currency)}${formatted}`;
}

/** Rounded to the nearest unit — for chart labels and long tables. */
export const moneyShort = (value: Money | undefined): string => money(value, 0);

export function percent(fraction: number, decimals = 1): string {
  return `${(fraction * 100).toFixed(decimals)}%`;
}

export function bps(value: number): string {
  return `${value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} bps`;
}

/**
 * Wrapper enums are the ledger's vocabulary, not the client's. A report that
 * says "bank_savings" is showing the reader how the system is built.
 */
const WRAPPER_LABELS: Record<string, string> = {
  gia: "General investment account",
  isa: "Stocks & shares ISA",
  sipp: "SIPP",
  uk_bond_onshore: "Onshore investment bond",
  uk_bond_offshore: "Offshore investment bond",
  us_brokerage: "US brokerage",
  ira_trad: "Traditional IRA",
  ira_roth: "Roth IRA",
  "401k": "401(k)",
  "529": "529 education plan",
  bank_current: "Current account",
  bank_savings: "Savings account",
  property: "Property",
  private_holding: "Private holding",
};

export function wrapperLabel(wrapper: string): string {
  return WRAPPER_LABELS[wrapper] ?? wrapper.replace(/_/g, " ");
}

/** 30 June 2026 — long form, unambiguous across UK/US readers. */
export function longDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${day} ${months[(month ?? 1) - 1]} ${year}`;
}

/** How stale a figure is, in words, for the §8 per-account freshness line. */
export function freshness(asof: string, reportDate: string): string {
  const days = Math.round(
    (Date.parse(`${reportDate}T00:00:00Z`) - Date.parse(`${asof}T00:00:00Z`)) / 86_400_000
  );
  if (days <= 0) return "current";
  if (days === 1) return "1 day old";
  if (days < 31) return `${days} days old`;
  const months = Math.round(days / 30);
  return months === 1 ? "1 month old" : `${months} months old`;
}
