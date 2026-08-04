import { describe, it, expect } from 'vitest';
import { masterScaleReport, requiredMasterScale, targetMasterDimensions } from './print-assets-master-scale';
import type { PrintLayout } from './print-assets-prepare';

// fap01's actual tracked layout (config/print-assets/fap01.json) — shared by
// every fap0N design (fap02/fap03 use the identical fractions).
const LAYOUT: PrintLayout = {
  sideMargin: 0.035,
  topMargin: 0.025,
  bottomMargin: 0.058,
  gapAboveSignature: 0.03,
  signatureZoneHeight: 0.017,
  artworkMaxWidth: 0.93,
  artworkMaxHeight: 0.87,
};

// The two largest fap01 profiles (70x100 unframed/framed-no-mount canvas,
// plus a much smaller one so "max across profiles" is actually exercised).
const PROFILES = [
  { profileKey: '8400x12000', w: 8400, h: 12000 },
  { profileKey: '3600x4800', w: 3600, h: 4800 },
];

describe('masterScaleReport', () => {
  it('computes the artwork box independent of source size', () => {
    const report = masterScaleReport(LAYOUT, PROFILES, { w: 1, h: 1 }, true);
    const largest = report.find((p) => p.profileKey === '8400x12000')!;
    expect(largest.box).toEqual({ width: 7812, height: 10440 });
  });

  it('reports scale > 1 for an undersized Lightroom export', () => {
    const report = masterScaleReport(LAYOUT, PROFILES, { w: 3850, h: 5180 }, true);
    const largest = report.find((p) => p.profileKey === '8400x12000')!;
    // min(7812/3850, 10440/5180) = min(2.0292, 2.0154) = 2.0154
    expect(largest.scale).toBeCloseTo(2.0154, 3);
    expect(largest.scale).toBeGreaterThan(1);
  });

  it('reports scale <= 1 once the source already covers every profile box', () => {
    const report = masterScaleReport(LAYOUT, PROFILES, { w: 8000, h: 11313 }, true);
    for (const p of report) expect(p.scale).toBeLessThanOrEqual(1);
  });
});

describe('requiredMasterScale', () => {
  it('takes the max scale across every profile', () => {
    const report = masterScaleReport(LAYOUT, PROFILES, { w: 3850, h: 5180 }, true);
    expect(requiredMasterScale(report)).toBeCloseTo(2.0154, 3);
  });

  it('floors at 1 — never reports a required upscale below the source itself', () => {
    const report = masterScaleReport(LAYOUT, PROFILES, { w: 8000, h: 11313 }, true);
    expect(requiredMasterScale(report)).toBe(1);
  });
});

describe('targetMasterDimensions', () => {
  it('scales the source and applies headroom, preserving aspect ratio', () => {
    const dims = targetMasterDimensions({ w: 3850, h: 5180 }, 2, 1.05);
    expect(dims).toEqual({ width: 8085, height: 10878 });
  });

  it('defaults headroom to 1 (no buffer)', () => {
    expect(targetMasterDimensions({ w: 100, h: 200 }, 2)).toEqual({ width: 200, height: 400 });
  });
});
