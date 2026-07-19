import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { composeMockup } from './print-mockups-compose';

// Window on a square 1000×1000 master: 400×571 px → ratio 0.7005 (sheet 0.7).
const WINDOW = { left: 0.3, top: 0.15, width: 0.4, height: 0.571 };

/** Opaque square blank like the real ones: grey bg, dark moulding, white window. */
async function syntheticMaster(): Promise<Buffer> {
  const moulding = await sharp({
    create: { width: 480, height: 651, channels: 3, background: { r: 25, g: 25, b: 25 } },
  }).png().toBuffer();
  const window = await sharp({
    create: { width: 400, height: 571, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();
  return sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .composite([
      { input: moulding, left: 260, top: 110 },
      { input: window, left: 300, top: 150 },
    ])
    .png()
    .toBuffer();
}

/** Solid red sheet at the FAP 7:10 ratio. */
async function syntheticSheet(): Promise<Buffer> {
  return sharp({
    create: { width: 350, height: 500, channels: 3, background: { r: 220, g: 30, b: 30 } },
  }).jpeg().toBuffer();
}

async function px(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return { r: data[i], g: data[i + 1], b: data[i + 2] };
}

describe('composeMockup', () => {
  it('pastes the sheet over the window and centre-crops the square master to 7:10', async () => {
    const out = await composeMockup({
      master: await syntheticMaster(),
      sheet: await syntheticSheet(),
      window: WINDOW,
      outWidth: 700,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(700);
    expect(meta.height).toBe(1000);

    // Square master (1000×1000) → crop is 700 wide, anchored on the window
    // centre x=500 → cropLeft = 150. Master (x,y) maps to crop (x-150, y).
    const centre = await px(out, 350, 435); // window centre (500, 435) → red sheet
    expect(centre.r).toBeGreaterThan(180);
    expect(centre.g).toBeLessThan(80);

    const moulding = await px(out, 120, 435); // master (270, 435) → dark moulding
    expect(moulding.r).toBeLessThan(60);

    const air = await px(out, 10, 50); // master (160, 50) → grey blank background
    expect(air.r).toBeGreaterThan(225);
  });

  it('crops a narrow master vertically and still outputs outWidth × outWidth/0.7', async () => {
    // 600×1000 grey master, window 400×571 centred: W/H = 0.6 < 0.7 → vertical crop.
    const window = await sharp({
      create: { width: 400, height: 571, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();
    const master = await sharp({
      create: { width: 600, height: 1000, channels: 3, background: { r: 240, g: 240, b: 240 } },
    })
      .composite([{ input: window, left: 100, top: 150 }])
      .png()
      .toBuffer();
    const out = await composeMockup({
      master,
      sheet: await syntheticSheet(),
      window: { left: 100 / 600, top: 0.15, width: 400 / 600, height: 0.571 },
      outWidth: 700,
    });
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(700);
    expect(meta.height).toBe(1000);

    // Window-anchored crop (cropTop=7) maps output (350, 800) to master
    // y≈693 — inside the pasted red sheet. A canvas-centre anchor
    // (cropTop=72, i.e. ignoring the window) would instead land on master
    // y≈758, outside the window (grey background) — this probe discriminates
    // the two anchoring strategies where test 1's window/canvas centres coincide.
    const probe = await px(out, 350, 800);
    expect(probe.r).toBeGreaterThan(180);
    expect(probe.g).toBeLessThan(80);
  });

  it('throws when the window has a non-finite or non-positive dimension', async () => {
    await expect(
      composeMockup({
        master: await syntheticMaster(),
        sheet: await syntheticSheet(),
        window: { left: 0.3, top: 0.15, width: 0.4, height: 0 },
      }),
    ).rejects.toThrow(/non-finite or non-positive/);
  });

  it('throws when the window ratio does not match the sheet ratio', async () => {
    await expect(
      composeMockup({
        master: await syntheticMaster(),
        sheet: await syntheticSheet(), // 0.7
        window: { left: 0.3, top: 0.15, width: 0.4, height: 0.4 }, // ratio 1.0
      }),
    ).rejects.toThrow(/window ratio/);
  });

  it('throws when the window exceeds the master canvas', async () => {
    await expect(
      composeMockup({
        master: await syntheticMaster(),
        sheet: await syntheticSheet(),
        window: { left: 0.8, top: 0.15, width: 0.4, height: 0.571 },
      }),
    ).rejects.toThrow(/exceeds/);
  });
});
