/** Display units and number formatting. Internal unit is the millimetre. */
import type { Unit } from './measure';

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in';

export const settings = {
  length: 'mm' as LengthUnit,
  decimals: 3,
};

const FACTOR: Record<LengthUnit, number> = { mm: 1, cm: 0.1, m: 0.001, in: 1 / 25.4 };

export function fmtNumber(v: number, decimals = settings.decimals): string {
  if (!Number.isFinite(v)) return '—';
  const s = v.toFixed(decimals);
  return s === '-' + (0).toFixed(decimals) ? (0).toFixed(decimals) : s;
}

export function fmtLength(mm: number): string {
  return `${fmtNumber(mm * FACTOR[settings.length])} ${settings.length}`;
}

export function fmtArea(mm2: number): string {
  const f = FACTOR[settings.length];
  return `${fmtNumber(mm2 * f * f)} ${settings.length}²`;
}

export function fmtVolume(mm3: number): string {
  const f = FACTOR[settings.length];
  return `${fmtNumber(mm3 * f * f * f)} ${settings.length}³`;
}

export function fmtValue(value: number | string, unit: Unit): string {
  if (typeof value === 'string') return value;
  if (unit === 'mm') return fmtLength(value);
  if (unit === 'mm2') return fmtArea(value);
  if (unit === 'deg') return `${fmtNumber(value, Math.min(settings.decimals, 2))}°`;
  return fmtNumber(value);
}
