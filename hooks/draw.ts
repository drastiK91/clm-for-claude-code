// The drawings' pure parts: bars, sparklines, percentiles and the latency chart, as plain strings
// a test can read. The trees that hold them are built in register.tsx.

import type { ClmCall, ClmSource, ClmTone } from '../types'

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/**
 * p in [0, 1] as a bar `width` cells wide: the filled part to an eighth of a cell, then a thin
 * track. A line, not a shade (░): a shade turns into a dotted pattern in a desktop font.
 */
export function bar(p: number, width: number): { filled: string; track: string } {
  const cells = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0)) * width
  let full = Math.floor(cells)
  let eighth = Math.round((cells - full) * 8)

  if (eighth === 8) {
    full += 1
    eighth = 0
  }

  return {
    filled: `${'█'.repeat(full)}${EIGHTHS[eighth] ?? ''}`,
    track: '─'.repeat(Math.max(0, width - full - (eighth > 0 ? 1 : 0))),
  }
}

const TICKS = '▁▂▃▄▅▆▇█'

/** The last `width` values, oldest first, as block ticks on a log scale: latencies span decades. */
export function sparkline(values: number[], width: number): string {
  const shown = values.slice(-Math.max(0, width)).map(v => Math.log10(Math.max(1, v)))

  if (shown.length === 0) return ''

  const lo = Math.min(...shown)
  const hi = Math.max(...shown)

  return shown.map(v => TICKS[hi - lo < 1e-9 ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)] ?? '▁').join('')
}

/** The nearest-rank percentile q in (0, 1] of `values`; 0 for none. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((a, b) => a - b)

  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0
}

export function fmtMs(value: number): string {
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`
}

/** Each source's color: a theme key, so it follows the person's theme. */
export const SOURCE_COLOR: Record<ClmSource, string> = { tool: 'suggestion', guard: 'warning', check: 'autoAccept', test: 'subtle' }

export const TONE_COLOR: Record<ClmTone, string> = { good: 'success', warn: 'warning', bad: 'error', neutral: 'suggestion' }

// Pictures are drawn outside the theme: mid tones that read on a light and a dark background alike.
export const TONE_HEX: Record<ClmTone, string> = { good: '#3fb950', warn: '#d29922', bad: '#e5534b', neutral: '#4f8ef7' }
export const MUTED_HEX = '#8b949e'
const ACCENT_HEX = TONE_HEX.neutral
const ERROR_HEX = TONE_HEX.bad
const GRID_HEX = MUTED_HEX

/** p in [0, 1] as a pill-shaped meter `width` by `height` pixels: a faint track, then the fill. */
export function meterSvg(p: number, width: number, height: number, hex: string): string {
  const v = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0))
  const r = height / 2
  // Under half a pixel there is nothing to fill; above it, at least a dot, so a small value still shows.
  const fill = v * width < 0.5 ? '' : `<rect width="${Math.max(height, v * width).toFixed(1)}" height="${height}" rx="${r}" fill="${hex}"/>`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" rx="${r}" fill="${MUTED_HEX}" fill-opacity="0.22"/>${fill}</svg>`
  )
}
// Room on the left for the gridlines' labels, so a chart wider than its slot loses its newest bars, never its scale.
const LABELS_PX = 44

/**
 * The calls' latencies, oldest first, as an SVG bar chart on a log scale (10 ms, 100 ms and 1 s
 * gridlines), in one color: the filters above say which source is shown. A failed call is a red
 * tick on the baseline, since it has no latency to draw.
 */
export function latencyChart(points: Pick<ClmCall, 'clientMs' | 'source' | 'ok'>[], width: number, height: number): string {
  const plotWidth = width - LABELS_PX
  const top = 6
  const bottom = height - 4
  const logs = points.filter(p => p.ok).map(p => Math.log10(Math.max(1, p.clientMs)))
  // At least up to 1 s, so a quiet log does not blow tens of milliseconds up to full height.
  const scale = Math.max(3, ...logs)
  const y = (log: number) => bottom - (log / scale) * (bottom - top)
  const slot = plotWidth / Math.max(points.length, 24)
  const barWidth = Math.max(1, Math.min(14, slot * 0.7))
  const grid = [1, 2, 3]
    .filter(g => g <= scale)
    .map(g => {
      const at = y(g).toFixed(1)

      return (
        `<line x1="${LABELS_PX}" x2="${width}" y1="${at}" y2="${at}" stroke="${GRID_HEX}" stroke-opacity="0.25" stroke-dasharray="2 3"/>` +
        `<text x="${LABELS_PX - 6}" y="${(y(g) + 3.5).toFixed(1)}" font-size="10" font-family="sans-serif" text-anchor="end" fill="${GRID_HEX}">${['', '10 ms', '100 ms', '1 s'][g]}</text>`
      )
    })
  const bars = points.map((p, i) => {
    const x = (LABELS_PX + i * slot + (slot - barWidth) / 2).toFixed(1)

    if (!p.ok) return `<rect x="${x}" y="${bottom - 3}" width="${barWidth.toFixed(1)}" height="3" rx="1" fill="${ERROR_HEX}"/>`

    const h = Math.max(2, (Math.log10(Math.max(1, p.clientMs)) / scale) * (bottom - top))

    return `<rect x="${x}" y="${(bottom - h).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${ACCENT_HEX}" fill-opacity="0.85"/>`
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `${grid.join('')}${bars.join('')}` +
    `<line x1="${LABELS_PX}" x2="${width}" y1="${bottom}" y2="${bottom}" stroke="${GRID_HEX}" stroke-opacity="0.45"/>` +
    '</svg>'
  )
}
