import sharp from 'sharp';

/* ------------------------------------------------------------------
   Mockup composition core for the print-assets:mockups pipeline step.
   Frame masters are OPAQUE mockup blanks (design/print-assets/
   frames_blanks/): baked background + shadow + moulding, any canvas
   ratio (the real ones are square). The sheet is composited OVER the
   master's window rect (fractions of the master canvas, configured per
   master in config/print-assets/frames.json), then the canvas is
   centre-cropped to the canonical 7:10 anchored on the window centre.
   Fail-closed on ratio mismatches so a misconfigured window can never
   ship a distorted sheet.
   ------------------------------------------------------------------ */

export interface MockupWindow {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MOCKUP_RATIO = 0.7; // canonical 7:10 output (width / height)
export const MOCKUP_RATIO_TOLERANCE = 0.02;
export const MOCKUP_DEFAULT_BACKGROUND = '#F1EFEA';

export async function composeMockup(opts: {
  master: Buffer;
  sheet: Buffer;
  window: MockupWindow;
  outWidth?: number;
  background?: string;
}): Promise<Buffer> {
  const outWidth = opts.outWidth ?? 2000;
  const background = opts.background ?? MOCKUP_DEFAULT_BACKGROUND;
  const win = opts.window;
  if (win.left < 0 || win.top < 0 || win.left + win.width > 1 || win.top + win.height > 1) {
    throw new Error(`window exceeds the master canvas: ${JSON.stringify(win)}`);
  }

  const masterMeta = await sharp(opts.master).metadata();
  if (!masterMeta.width || !masterMeta.height) throw new Error('master has no dimensions');
  const W = masterMeta.width;
  const H = masterMeta.height;

  const wx = Math.round(W * win.left);
  const wy = Math.round(H * win.top);
  const ww = Math.round(W * win.width);
  const wh = Math.round(H * win.height);

  const sheetMeta = await sharp(opts.sheet).metadata();
  if (!sheetMeta.width || !sheetMeta.height) throw new Error('sheet has no dimensions');
  const sheetRatio = sheetMeta.width / sheetMeta.height;
  const windowRatio = ww / wh;
  if (Math.abs(sheetRatio - windowRatio) / windowRatio > MOCKUP_RATIO_TOLERANCE) {
    throw new Error(
      `window ratio ${windowRatio.toFixed(4)} does not match sheet ratio ${sheetRatio.toFixed(4)} — fix the window in frames.json`,
    );
  }

  const sheetResized = await sharp(opts.sheet).resize(ww, wh, { fit: 'fill' }).png().toBuffer();
  const composed = await sharp(opts.master)
    .composite([{ input: sheetResized, left: wx, top: wy }])
    .flatten({ background }) // no-op for opaque masters; safety for alpha PNGs
    .png()
    .toBuffer();

  // Centre-crop to the canonical 7:10, anchored on the window centre (clamped).
  let cropLeft = 0;
  let cropTop = 0;
  let cropW = W;
  let cropH = H;
  if (W / H > MOCKUP_RATIO) {
    cropW = Math.round(H * MOCKUP_RATIO);
    const cx = wx + ww / 2;
    cropLeft = Math.min(Math.max(Math.round(cx - cropW / 2), 0), W - cropW);
  } else if (W / H < MOCKUP_RATIO) {
    cropH = Math.round(W / MOCKUP_RATIO);
    const cy = wy + wh / 2;
    cropTop = Math.min(Math.max(Math.round(cy - cropH / 2), 0), H - cropH);
  }

  return sharp(composed)
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .resize(outWidth, Math.round(outWidth / MOCKUP_RATIO), { fit: 'fill' })
    .png()
    .toBuffer();
}
