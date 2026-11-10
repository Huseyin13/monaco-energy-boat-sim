// Canvas 2D charts, no library.
// One series per chart (small multiples, never mixed scales on one
// axis), thin lines, faint grid, colour follows the series:
// speed = blue, power = teal, energy = amber. Hover shows a guide line
// and value label.

export const INK = {
  text: '#ffffff',
  soft: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
};
export const SERIES = {
  speed: '#3987e5',
  power: '#199e70',
  energy: '#c98500',
};
// Single-hue blue ramp for the track map (dark = slow, light = fast)
const RAMP = ['#184f95', '#1c5cab', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'];

function prep(canvas) {
  // Match the backing store to CSS size x DPR for sharp lines.
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// Axis-less mini line for the live HUD.
export function sparkline(canvas, values, color) {
  const { ctx, w, h } = prep(canvas);
  if (values.length < 2) return;
  let min = Math.min(...values), max = Math.max(...values);
  if (max - min < 1e-6) { max += 1; min -= 1; }
  const px = (i) => (i / (values.length - 1)) * (w - 4) + 2;
  const py = (v) => h - 3 - ((v - min) / (max - min)) * (h - 6);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.stroke();
  // dot at the latest value
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px(values.length - 1), py(values[values.length - 1]), 2.5, 0, 7);
  ctx.fill();
}

// Time series chart for the run report.
// cfg: { times, values, color, unit, fmt, yMin, yMax, hoverPx }
export function lineChart(canvas, cfg) {
  const { ctx, w, h } = prep(canvas);
  const m = { l: 42, r: 10, t: 8, b: 22 };
  const pw = w - m.l - m.r, ph = h - m.t - m.b;
  const { times, values, color } = cfg;
  if (times.length < 2) {
    ctx.fillStyle = INK.muted;
    ctx.font = '12px Consolas, monospace';
    ctx.fillText('waiting for data…', m.l, h / 2);
    return;
  }
  const tMax = times[times.length - 1];
  let yMin = cfg.yMin ?? Math.min(...values);
  let yMax = cfg.yMax ?? Math.max(...values);
  if (yMax - yMin < 1e-6) yMax = yMin + 1;
  if (cfg.yMin === undefined) { // 5% headroom
    const pad = (yMax - yMin) * 0.05;
    yMin -= pad; yMax += pad;
  }
  const px = (t) => m.l + (t / tMax) * pw;
  const py = (v) => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;

  ctx.font = '10px Consolas, monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (i / 4) * (yMax - yMin);
    const y = py(v);
    ctx.strokeStyle = INK.grid;
    ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke();
    ctx.fillStyle = INK.muted;
    ctx.textAlign = 'right';
    ctx.fillText(cfg.fmt(v), m.l - 5, y + 3);
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const t = (i / 4) * tMax;
    ctx.fillText(t.toFixed(0) + 's', px(t), h - 8);
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  times.forEach((t, i) => (i ? ctx.lineTo(px(t), py(values[i])) : ctx.moveTo(px(t), py(values[i]))));
  ctx.stroke();

  // Hover: guide line and label at the nearest sample
  if (cfg.hoverPx != null && cfg.hoverPx >= m.l && cfg.hoverPx <= w - m.r) {
    const tH = ((cfg.hoverPx - m.l) / pw) * tMax;
    let i = times.findIndex((t) => t >= tH);
    if (i < 0) i = times.length - 1;
    const cx = px(times[i]), cy = py(values[i]);
    ctx.strokeStyle = INK.axis;
    ctx.beginPath(); ctx.moveTo(cx, m.t); ctx.lineTo(cx, m.t + ph); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 7); ctx.fill();
    ctx.strokeStyle = '#141b22'; ctx.lineWidth = 2; ctx.stroke();

    const label = `${times[i].toFixed(1)}s  ${cfg.fmt(values[i])}${cfg.unit}`;
    ctx.font = '11px Consolas, monospace';
    const tw = ctx.measureText(label).width + 12;
    const bx = Math.min(Math.max(cx - tw / 2, m.l), w - m.r - tw);
    ctx.fillStyle = '#242c34';
    ctx.fillRect(bx, m.t + 2, tw, 18);
    ctx.fillStyle = INK.text;
    ctx.textAlign = 'left';
    ctx.fillText(label, bx + 6, m.t + 15);
  }
}

// Track map: (x,z) path coloured by speed.
export function trackMap(canvas, xs, zs, speeds) {
  const { ctx, w, h } = prep(canvas);
  if (xs.length < 2) {
    ctx.fillStyle = INK.muted;
    ctx.font = '12px Consolas, monospace';
    ctx.fillText('waiting for data…', 12, h / 2);
    return;
  }
  // Equal scale on both axes so the map is not distorted
  const pad = 14;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const scale = Math.min((w - 2 * pad) / Math.max(maxX - minX, 1),
                         (h - 2 * pad) / Math.max(maxZ - minZ, 1));
  const px = (x) => w / 2 + (x - (minX + maxX) / 2) * scale;
  const pz = (z) => h / 2 - (z - (minZ + maxZ) / 2) * scale; // +z up

  const vMax = Math.max(...speeds, 0.1);
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  for (let i = 1; i < xs.length; i++) {
    const k = Math.min(RAMP.length - 1, Math.floor((speeds[i] / vMax) * RAMP.length));
    ctx.strokeStyle = RAMP[k];
    ctx.beginPath();
    ctx.moveTo(px(xs[i - 1]), pz(zs[i - 1]));
    ctx.lineTo(px(xs[i]), pz(zs[i]));
    ctx.stroke();
  }
  ctx.font = '11px Consolas, monospace';
  ctx.fillStyle = INK.soft;
  ctx.fillText('S', px(xs[0]) - 3, pz(zs[0]) - 6);
  ctx.fillStyle = INK.text;
  ctx.beginPath(); ctx.arc(px(xs[xs.length - 1]), pz(zs[zs.length - 1]), 4, 0, 7); ctx.fill();

  // Legend: slow -> fast
  RAMP.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(w - 90 + i * 12, h - 14, 12, 6);
  });
  ctx.fillStyle = INK.muted;
  ctx.textAlign = 'right'; ctx.fillText('slow', w - 94, h - 8);
  ctx.textAlign = 'left'; ctx.fillText('fast', w - 14, h - 8);
}
