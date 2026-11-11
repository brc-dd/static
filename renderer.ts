import type { Sponsor, SponsorkitConfig, Sponsorship, SvgComposer, Tier } from 'sponsorkit'
import type { SponsorshipWithTotal } from './totals.ts'
import { Buffer } from 'node:buffer'
import { partitionTiers, resizeImage, svgToWebp } from 'sponsorkit'

/**
 * Grid renderer for sponsorkit.
 *
 * Every sponsor is a tile on one shared lattice, with no labels and no names. A tier picks how
 * many cells its tiles span and, optionally, a colour. Tiles are packed in tier order, and the
 * column count is chosen so the block comes out as a full rectangle: only the last row runs short.
 */

export interface GridTier extends Tier {
  /**
   * How many lattice cells each tile of this tier spans, per side.
   *
   * @default 1
   */
  span?: 1 | 2 | 4
  /**
   * Colour that marks the tier, drawn around each tile (see `marker`). A pair of colours
   * fades from the first, at the top left, to the second, at the bottom right.
   */
  color?: string | [from: string, to: string]
  /** Tone the tier down (see `past`). Meant for past sponsors. */
  muted?: boolean
}

/** Where a logo sits inside its tile. */
export interface LogoPlacement {
  /**
   * How much of its tile the logo fills. Lower it for artwork that runs edge to edge,
   * which the tile's shape would otherwise cut.
   *
   * @default 1
   */
  logoScale?: number
  /**
   * Nudge the logo inside its tile, as fractions of the tile's size: `[right, down]`.
   * A shape like a downward triangle looks centred a little below the middle.
   *
   * @default [0, 0]
   */
  logoOffset?: [x: number, y: number]
}

/** A sponsor entered by hand, see `manualSponsor`. */
export interface ManualSponsor extends Omit<Sponsor, 'avatarBuffer'>, LogoPlacement {}

/** A picture to give a sponsor, see `replaceLogo`. */
export interface Logo extends LogoPlacement {
  avatarUrl: string
}

export interface MutedStyle {
  /** 0 is greyscale, 1 keeps full colour. */
  saturate?: number
  opacity?: number
  /** Size of the picture inside its cell, 1 fills it. */
  scale?: number
}

const mutedStyles = {
  soft: { saturate: 0.35, opacity: 0.7, scale: 1 },
  smaller: { saturate: 0.35, opacity: 0.75, scale: 0.75 },
  faded: { saturate: 1, opacity: 0.5, scale: 1 },
  grey: { saturate: 0, opacity: 0.6, scale: 1 },
} satisfies Record<string, Required<MutedStyle>>

export interface GridOptions {
  /**
   * Width of the image in px. It stays the same however many sponsors there are,
   * and the grid is centred in it.
   *
   * @default sponsorkit's `width`, which is 800 unless `--width` is passed
   */
  width?: number
  /**
   * Lattice step in px. A tile spanning `s` cells is `s * pitch - gap` wide,
   * so this sets the overall scale: 32 is compact, 40 regular, 48 large.
   *
   * @default 40
   */
  pitch?: number
  /**
   * Space between tiles in px.
   *
   * @default 8
   */
  gap?: number
  /** Use exactly this many columns instead of choosing a count that fits the list. */
  columns?: number
  /**
   * Corner radius: `'round'` for circles, or a number of px applied to every tile whatever its size.
   *
   * @default 'round'
   */
  radius?: number | 'round'
  /**
   * How a tier's `color` is shown: a `'ring'` around the tile, a `'frame'` on its edge, or `'none'`.
   *
   * @default 'ring'
   */
  marker?: 'ring' | 'frame' | 'none'
  /**
   * How `muted` tiers are toned down: a preset, or your own values.
   *
   * @default 'soft'
   */
  past?: keyof typeof mutedStyles | MutedStyle
  /**
   * Blank space above and below the grid in px, and the least kept at its sides.
   *
   * @default 2
   */
  padding?: number
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n = (v: number) => +v.toFixed(2)

/**
 * Place square tiles on a grid `cols` wide, first fit in reading order, and return each with its cell.
 * A tile of span s only starts on multiples of s, so small tiles always nest cleanly beside big ones.
 */
function pack<T extends { span: number }>(tiles: T[], cols: number) {
  const grid: Uint8Array[] = []
  const cells = (r: number) => grid[r] ??= new Uint8Array(cols)
  const from: Record<number, number> = {}
  const placed: (T & { col: number, row: number })[] = []
  for (const tile of tiles) {
    const s = tile.span
    for (let r = from[s] ?? 0, done = false; !done; r += s) {
      for (let c = 0; c + s <= cols && !done; c += s) {
        let free = true
        for (let i = 0; i < s && free; i++) {
          for (let j = 0; j < s && free; j++)
            free = !cells(r + i)[c + j]
        }
        if (!free)
          continue
        for (let i = 0; i < s; i++)
          cells(r + i).fill(1, c, c + s)
        placed.push({ ...tile, col: c, row: r })
        from[s] = r
        done = true
      }
    }
  }
  return { placed, rows: grid.length }
}

/** Pick the column count whose packing wastes the fewest cells, leaning towards a wide, README-shaped block. */
function chooseColumns(tiles: { span: number }[], maxCols: number, pitch: number, gap: number) {
  const widest = Math.max(2, ...tiles.map(tile => tile.span))
  const used = tiles.reduce((sum, tile) => sum + tile.span * tile.span, 0)
  let best: { cols: number, score: number } | undefined
  for (let cols = widest; cols <= maxCols; cols += 2) {
    const { rows } = pack(tiles, cols)
    const ratio = (cols * pitch - gap) / (rows * pitch - gap)
    // skip tall, narrow blocks while there is still room to widen
    if (ratio < 1.4 && cols + 2 <= maxCols)
      continue
    const score = (cols * rows - used) / (cols * rows) * 10 + Math.abs(Math.log(ratio / 3))
    if (!best || score < best.score)
      best = { cols, score }
  }
  return best?.cols ?? widest
}

/**
 * Order inside a tier. Sponsors entered by hand lead, in the order they were listed. The rest go by
 * what they have paid in all (see totals.ts), then by who started first, then by name.
 */
function compareStanding(a: SponsorshipWithTotal, b: SponsorshipWithTotal) {
  const manual = Number(b.provider === 'manual') - Number(a.provider === 'manual')
  if (manual || a.provider === 'manual')
    return manual
  const started = (ship: Sponsorship) => Date.parse(ship.createdAt ?? '') || Infinity
  const name = (ship: Sponsorship) => ship.sponsor.name || ship.sponsor.login
  return (b.totalDollars ?? 0) - (a.totalDollars ?? 0)
    || started(a) - started(b)
    || name(a).localeCompare(name(b), 'en')
}

/** Pixel width of a WebP image, which is what sponsorkit stores avatars as. */
function sourceSize(image: Buffer) {
  if (image.length > 30 && image.toString('latin1', 0, 4) === 'RIFF' && image.toString('latin1', 8, 12) === 'WEBP') {
    const kind = image.toString('latin1', 12, 16)
    if (kind === 'VP8 ')
      return image.readUInt16LE(26) & 0x3FFF
    if (kind === 'VP8L')
      return (image.readUInt32LE(21) & 0x3FFF) + 1
    if (kind === 'VP8X')
      return image.readUIntLE(24, 3) + 1
  }
  return 120
}

/** Whether a WebP image carries transparency, so a logo drawn for a white page still reads on a dark one. */
function hasAlpha(image: Buffer) {
  return image.length > 21 && image.toString('latin1', 12, 16) === 'VP8X' && (image.readUInt8(20) & 0x10) !== 0
}

export function gridComposer(options: GridOptions = {}) {
  const { pitch = 40, gap = 8, columns, radius = 'round', marker = 'ring', past = 'soft', padding = 2 } = options
  const tone = typeof past === 'string' ? mutedStyles[past] : { saturate: 1, opacity: 1, scale: 1, ...past }
  // a px radius is capped at 40% of the tile so the smallest tiles stay square rather than turning into circles
  const corner = (size: number) => radius === 'round' ? size / 2 : Math.min(radius, size * 0.4)
  const rect = (x: number, y: number, size: number, rx: number, attrs: string) =>
    `<rect x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}" rx="${n(rx)}" ${attrs}/>`

  return async (composer: SvgComposer, sponsors: Sponsorship[], config: SponsorkitConfig) => {
    // sponsorkit's partitioning re-sorts by start date, so note the order the sponsors arrived in:
    // it is the order hand-entered ones were listed in, and the last word between equals
    const listed = new Map(sponsors.map((ship, i) => [ship, i]))
    const tiles = partitionTiers(sponsors, config.tiers ?? [], config.includePastSponsors)
      .flatMap(({ tier, sponsors }) => sponsors
        .sort((a, b) => compareStanding(a, b) || (listed.get(a) ?? 0) - (listed.get(b) ?? 0))
        .map(({ sponsor }) => ({ sponsor, tier: tier as GridTier, span: (tier as GridTier).span ?? 1 })))
    const width = options.width ?? composer.config.width
    const maxCols = Math.max(2, Math.floor((width - padding * 2 + gap) / pitch / 2) * 2)
    const { placed, rows } = pack(tiles, columns ?? chooseColumns(tiles, maxCols, pitch, gap))
    // the image keeps its width, so centre the grid on the columns it actually uses
    const cols = Math.max(0, ...placed.map(tile => tile.col + tile.span))
    const left = Math.round((width - (cols * pitch - gap)) / 2)

    const clips = new Map<string, number>()
    // a colour pair is painted through a gradient, defined once however many tiles share it
    const gradients = new Map<string, string>()
    const paint = (color: NonNullable<GridTier['color']>) => {
      if (typeof color === 'string')
        return escape(color)
      const stops = `<stop stop-color="${escape(color[0])}"/><stop offset="1" stop-color="${escape(color[1])}"/>`
      const id = gradients.get(stops) ?? `g${gradients.size}`
      gradients.set(stops, id)
      return `url(#${id})`
    }
    const drawn = await Promise.all(placed.map(async ({ sponsor, tier, span, col, row }) => {
      const cell = span * pitch - gap
      const cx = left + col * pitch
      const cy = padding + row * pitch
      const color = marker !== 'none' && tier.color ? paint(tier.color) : undefined
      const line = span > 2 ? 3 : 2
      // a ring sits on the cell edge, so the picture steps in to leave room for it
      const room = color && marker === 'ring' ? line * 2 : 0
      const inset = room + (tier.muted ? Math.round(cell * (1 - tone.scale) / 2) : 0)
      const size = cell - inset * 2
      const x = cx + inset
      const y = cy + inset
      const rx = corner(size)
      const ratio = n(rx / size)
      const clip = `r${Math.round(ratio * 1000)}`
      clips.set(clip, ratio)

      // every picture gets a faint edge, so a white logo still has a shape on a white page
      let mark = rect(x + 0.5, y + 0.5, size - 1, rx - 0.5, 'class="edge"')
      if (color && marker === 'ring')
        mark += rect(cx + line / 2, cy + line / 2, cell - line, radius === 'round' ? (cell - line) / 2 : rx + room - line / 2, `fill="none" stroke="${color}" stroke-width="${line}"`)
      else if (color)
        mark = rect(x + line / 2, y + line / 2, size - line, rx - line / 2, `fill="none" stroke="${color}" stroke-width="${line}"`)

      let image = ''
      let plate = ''
      const source = sponsor.avatarBuffer
      if (source) {
        // twice the drawn size for sharp screens, but never larger than the picture we have
        const format = composer.config.imageFormat
        const px = Math.min(sourceSize(source), Math.round(size * 2))
        const data = format === 'webp' && px === sourceSize(source) ? source : await resizeImage(source, px, format)
        image = `<image x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}" href="data:image/${format};base64,${data.toString('base64')}" clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"/>`
        if (hasAlpha(source))
          plate = rect(x, y, size, rx, 'fill="#fff"')
      }

      const url = sponsor.websiteUrl || sponsor.linkUrl
      const name = (sponsor.name || sponsor.login).trim()
      const title = tier.title ? `${name} · ${tier.title}` : name
      const svg = `<a${url ? ` href="${escape(url)}" target="_blank"` : ''}><title>${escape(title)}</title>${plate}${image}${mark}</a>`
      return { svg, muted: !!tier.muted }
    }))

    const live = drawn.filter(tile => !tile.muted).map(tile => tile.svg)
    const muted = drawn.filter(tile => tile.muted).map(tile => tile.svg)
    const fade = tone.saturate < 1
      ? `<filter id="fade" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="${tone.saturate}"/></filter>`
      : ''
    const defs = [
      ...Array.from(clips, ([id, r]) => `<clipPath id="${id}" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="${r}"/></clipPath>`),
      ...Array.from(gradients, ([stops, id]) => `<linearGradient id="${id}" x2="1" y2="1">${stops}</linearGradient>`),
      fade,
    ].join('')

    composer.addRaw(`<title>Sponsors</title>\n<defs>${defs}</defs>\n${live.join('\n')}`)
    if (muted.length)
      composer.addRaw(`\n<g opacity="${tone.opacity}"${fade ? ' filter="url(#fade)"' : ''}>\n${muted.join('\n')}\n</g>`)

    // sponsorkit sizes the SVG from these: the width is fixed, the height follows the rows
    composer.config.width = width
    composer.height = Math.max(1, rows * pitch - gap + padding * 2)
    composer.config.svgInlineCSS = '.edge{fill:none;stroke:#8b949e;stroke-opacity:.32}a{cursor:pointer}'
  }
}

/**
 * Fetch a picture for a tile, large enough to stay sharp on any of them.
 *
 * An SVG, or any picture given a scale or an offset, is drawn whole onto a square transparent
 * canvas, so it is never cropped. Anything else is treated as a square avatar and used as it is.
 */
async function loadLogo({ avatarUrl, logoScale = 1, logoOffset = [0, 0] }: Logo) {
  const response = await fetch(avatarUrl)
  if (!response.ok)
    throw new Error(`Failed to fetch ${avatarUrl}: ${response.status} ${response.statusText}`)
  let source: Buffer = Buffer.from(await response.arrayBuffer())
  let type = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim() || 'image/png'
  if (/^\s*<(?:\?xml|!--|!doctype|svg)/i.test(source.toString('utf8', 0, 256)))
    type = 'image/svg+xml'
  if (type !== 'image/svg+xml' && logoScale === 1 && !logoOffset[0] && !logoOffset[1])
    return resizeImage(source, 384, 'webp')

  // the canvas is itself an SVG, and the rasteriser behind it cannot read WebP
  if (source.toString('latin1', 8, 12) === 'WEBP') {
    source = await resizeImage(source, 512, 'png')
    type = 'image/png'
  }
  const side = 512 * logoScale
  const x = (512 - side) / 2 + logoOffset[0] * 512
  const y = (512 - side) / 2 + logoOffset[1] * 512
  const canvas = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><image x="${n(x)}" y="${n(y)}" width="${n(side)}" height="${n(side)}" href="data:${type};base64,${source.toString('base64')}"/></svg>`
  return resizeImage(await svgToWebp(canvas), 384, 'webp')
}

/**
 * A sponsor the providers don't return, entered by hand. `monthlyDollars` decides its tier,
 * and it leads that tier.
 */
export async function manualSponsor(sponsor: ManualSponsor, monthlyDollars = Infinity): Promise<Sponsorship> {
  const avatarBuffer = await loadLogo(sponsor)
  return { sponsor: { ...sponsor, avatarBuffer }, monthlyDollars, privacyLevel: 'PUBLIC', provider: 'manual' }
}

/** Give a sponsor the providers do return a different picture, placed the same way as a manual sponsor's. */
export async function replaceLogo(sponsors: Sponsorship[], login: string, logo: Logo) {
  const matches = sponsors.filter(({ sponsor }) => sponsor.login === login)
  if (!matches.length)
    return
  const avatarBuffer = await loadLogo(logo)
  for (const { sponsor } of matches)
    Object.assign(sponsor, { avatarUrl: logo.avatarUrl, avatarBuffer })
}
