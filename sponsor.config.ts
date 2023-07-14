import { defineConfig, presets } from 'sponsorkit'

export default defineConfig({
  tiers: [
    {
      title: 'Past Sponsors',
      monthlyDollars: -1,
      preset: presets.xs
    },
    {
      title: 'Backers',
      monthlyDollars: 0,
      preset: presets.small
    },
    {
      title: 'Sponsors',
      monthlyDollars: 10,
      preset: presets.medium
    },
    {
      title: 'Silver Sponsors',
      monthlyDollars: 50,
      preset: presets.large
    },
    {
      title: 'Gold Sponsors',
      monthlyDollars: 100,
      preset: presets.xl
    }
  ]
})
