import { defineConfig } from 'sponsorkit'
import { type GridTier, gridComposer, manualSponsor, replaceLogo } from './renderer.ts'
import { addLifetimeTotals } from './totals.ts'

// `span` is how many grid cells a tile takes per side (1, 2 or 4). `color` is the ring around it:
// one colour, or a pair it fades between. These pairs are Radix Colors steps, light to dark.
// Titles are not drawn; they show as tooltips when the SVG is opened on its own.
const tiers: GridTier[] = [
  { title: 'Past Sponsor', monthlyDollars: -1, muted: true },
  { title: 'Backer', monthlyDollars: 0 },
  { title: 'Sponsor', monthlyDollars: 10, span: 2, color: ['#cea37e', '#815e46'] }, // brown 8 → 11
  { title: 'Silver Sponsor', monthlyDollars: 50, span: 2, color: ['#cdced6', '#80838d'] }, // slate 7 → 10
  { title: 'Gold Sponsor', monthlyDollars: 100, span: 2, color: ['#e9c162', '#ab6400'] }, // amber 7 → 11
  { title: 'Platinum Sponsor', monthlyDollars: 500, span: 2, color: ['#abbdf9', '#3e63dd'] }, // indigo 7 → 9
  { title: 'Special Sponsor', monthlyDollars: Infinity, span: 2, color: ['#e592a3', '#dc3b5d'] }, // ruby 8 → 10
]

export default defineConfig({
  tiers,
  customComposer: gridComposer({
    radius: 'round',
    past: 'soft',
    marker: 'ring',
    pitch: 40,
  }),
  onSponsorsAllFetched: addLifetimeTotals, // what each sponsor has paid in all, which orders a tier
  async onSponsorsReady(sponsors) {
    await replaceLogo(sponsors, 'vuejs', {
      avatarUrl: 'https://raw.githubusercontent.com/vuejs/art/master/logo.svg',
      logoScale: 0.66,
      logoOffset: [0, 0.055], // a little below the middle, where a downward triangle looks centred
    })
    const manual = await Promise.all([
      manualSponsor({
        type: 'Organization',
        login: 'globalbrain',
        name: 'Global Brain',
        avatarUrl: 'https://globalbrains.com/favicon.svg',
        websiteUrl: 'https://globalbrains.com/',
        linkUrl: 'https://github.com/globalbrain',
      }),
      manualSponsor({
        type: 'Organization',
        login: 'vite-ecosystem-fund',
        name: 'Vite Ecosystem Fund',
        avatarUrl: 'https://images.opencollective.com/vite-ecosystem-fund/logo/460.png',
        linkUrl: 'https://opencollective.com/cloudflare/projects/vite-ecosystem-fund',
        logoScale: 0.78, // the cloud runs edge to edge, so shrink it to sit inside the tile
      }, 500),
    ])
    return [...manual, ...sponsors]
  },
  prorateOnetime: true,
  outputDir: '.',
})
