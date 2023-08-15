import { Sponsorship, defineConfig, presets } from 'sponsorkit'

export default defineConfig({
  onSponsorsReady(sponsors) {
    sponsors.forEach((sponsor) => {
      if (sponsor.isOneTime) {
        sponsor.monthlyDollars = getMonthlyDollars(sponsor)
      }
    })
    return sponsors
  },
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
      preset: presets.base
    },
    {
      title: 'Silver Sponsors',
      monthlyDollars: 50,
      preset: presets.medium
    },
    {
      title: 'Gold Sponsors',
      monthlyDollars: 100,
      preset: presets.large
    },
    {
      title: 'Platinum Sponsors',
      monthlyDollars: 500,
      preset: presets.xl
    }
  ]
})

function getMonthlyDollars({ monthlyDollars, createdAt }: Sponsorship) {
  if (monthlyDollars <= 0 || !createdAt) return -1
  const monthlySplit: number[] = []

  let left = monthlyDollars
  while (left > 0) {
    if (left > 500) {
      monthlySplit.push(500)
      left -= 500
    } else if (left > 100) {
      monthlySplit.push(100)
      left -= 100
    } else if (left > 50) {
      monthlySplit.push(50)
      left -= 50
    } else if (left > 10) {
      monthlySplit.push(10)
      left -= 10
    } else if (left > 0) {
      monthlySplit.push(left)
      left = 0
    }
  }

  const index = Math.floor((Date.now() - +new Date(createdAt)) / 2.628e9)
  return monthlySplit[index] || -1
}
