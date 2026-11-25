import type { Provider, Sponsorship } from 'sponsorkit'
import type { SponsorshipWithTotal } from './totals.ts'
import { Buffer } from 'node:buffer'

/**
 * thanks.dev for sponsorkit.
 *
 * thanks.dev pools donations and passes them on through GitHub Sponsors, so GitHub only ever names
 * thanks.dev itself. Its public API names the donors behind those payments. The `thanksDev` provider
 * lists them as sponsors in their own right, and `withoutThanksDevPool` drops the pooled entry they
 * stand in for.
 */

const NAME = 'thanks.dev'
/** The GitHub account thanks.dev pays its pooled donations from. */
const POOL = 'thnxdev'

interface Donor {
  /** base64, and for a GitHub organisation it says so */
  id?: string
  /** `gh` for GitHub, `gl` for GitLab */
  gType: string
  login: string
  name?: string | null
  avatar?: string | null
  url?: string | null
  /** one entry per calendar month they paid in, with the amount in dollars */
  payments?: { month: string, amount: string }[]
}

/** The calendar month a date falls in, as thanks.dev writes it: `2026-11`. */
const monthOf = (date: Date) => date.toISOString().slice(0, 7)

/**
 * Lists the donors behind thanks.dev's payments. Add it to sponsorkit's `providers`.
 *
 * thanks.dev spreads donations thin, so an account collects a tail of donors worth a fraction of a
 * cent each. They are all listed here; `withoutTotalsBelow` is what leaves them out.
 */
export const thanksDev: Provider = {
  name: NAME,
  async fetchSponsors(config) {
    const login = config.github?.login
    if (!login)
      throw new Error('thanks.dev: the GitHub login is not set, and it is the account donors are looked up by')
    const response = await fetch(`https://api.thanks.dev/v1/entity/gh/${encodeURIComponent(login)}/donors`)
    const body = await response.json().catch(() => ({})) as { donors?: Record<string, Donor> | null, description?: string }
    if (!response.ok || !body.donors || typeof body.donors !== 'object')
      throw new Error(`thanks.dev answered ${response.status} ${body.description ?? response.statusText}`)

    // a month's payment keeps a donor current until the next one would be due
    const now = new Date()
    const current = [monthOf(now), monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1)))]

    const ships: SponsorshipWithTotal[] = []
    for (const donor of Object.values(body.donors)) {
      const payments = (donor.payments ?? [])
        .map(payment => ({ month: payment.month, dollars: Number(payment.amount) }))
        .filter(payment => payment.dollars > 0)
        .sort((a, b) => a.month.localeCompare(b.month))
      const first = payments[0]
      const last = payments.at(-1)
      if (!first || !last)
        continue
      const site = donor.gType === 'gl' ? 'gitlab.com' : 'github.com'
      ships.push({
        sponsor: {
          type: Buffer.from(donor.id ?? '', 'base64').toString().startsWith('GH:ORG:') ? 'Organization' : 'User',
          login: donor.login,
          name: donor.name || donor.login,
          avatarUrl: donor.avatar ?? '',
          linkUrl: `https://${site}/${donor.login}`,
          ...(donor.url ? { websiteUrl: donor.url } : {}),
        },
        // the latest month's payment sets the tier, and nothing lately makes them a past sponsor
        monthlyDollars: current.includes(last.month) ? last.dollars : -1,
        totalDollars: Math.round(payments.reduce((sum, payment) => sum + payment.dollars, 0) * 100) / 100,
        createdAt: `${first.month}-01T00:00:00.000Z`,
        privacyLevel: 'PUBLIC',
        isOneTime: false,
        raw: donor,
      })
    }
    return ships
  },
}

/** Drop thanks.dev's own GitHub sponsorship once the donors behind it are listed, so no money shows twice. */
export function withoutThanksDevPool<T extends Sponsorship>(sponsors: T[]) {
  return sponsors.some(ship => ship.provider === NAME)
    ? sponsors.filter(ship => !(ship.provider === 'github' && ship.sponsor.login === POOL))
    : sponsors
}
