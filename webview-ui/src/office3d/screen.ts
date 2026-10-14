import { OFFICE3D_COLORS } from '../constants.js';

const MONO = 'ui-monospace, "JetBrains Mono", "Liberation Mono", monospace';

export const cssColor = (hex: number, alpha = 1): string =>
  `#${hex.toString(16).padStart(6, '0')}${
    alpha < 1
      ? Math.round(alpha * 255)
          .toString(16)
          .padStart(2, '0')
      : ''
  }`;

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = line ? `${line} ${word}` : word;
    while (ctx.measureText(rest).width > width) {
      if (line) {
        out.push(line);
        line = '';
        rest = word;
        continue;
      }
      let cut = rest.length - 1;
      while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > width) cut--;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Paint a monitor face: the first line is a header in the accent colour, the
 * rest is body text, wrapped and clipped to the screen. Today the lines are the
 * desk's status and activity; live pane text can be fed through the same call.
 */
export function paintScreen(
  canvas: HTMLCanvasElement,
  lines: readonly string[],
  accent: number,
  lit: boolean,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const pad = Math.round(w * 0.05);
  const headerH = Math.round(h * 0.27);

  ctx.fillStyle = cssColor(lit ? OFFICE3D_COLORS.screenBg : OFFICE3D_COLORS.screenOff);
  ctx.fillRect(0, 0, w, h);

  ctx.globalAlpha = lit ? 1 : 0.45;
  ctx.fillStyle = cssColor(accent);
  ctx.fillRect(0, 0, w, Math.round(h * 0.025));
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(headerH * 0.52)}px ${MONO}`;
  const [header = '', ...body] = lines;
  ctx.fillText(header.toUpperCase(), pad, headerH * 0.62, w - 2 * pad);

  const bodySize = Math.round(h * 0.14);
  ctx.font = `500 ${bodySize}px ${MONO}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = cssColor(lit ? OFFICE3D_COLORS.screenText : OFFICE3D_COLORS.screenDim);
  const lineH = bodySize * 1.3;
  const maxLines = Math.floor((h - headerH - pad) / lineH);
  const wrapped = body.flatMap((l) => wrap(ctx, l, w - 2 * pad));
  wrapped
    .slice(0, maxLines)
    .forEach((l, i) => ctx.fillText(l, pad, headerH + pad * 0.6 + i * lineH));
  ctx.globalAlpha = 1;
}
