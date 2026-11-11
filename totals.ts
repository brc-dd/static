import type { Sponsorship } from 'sponsorkit'
import process from 'node:process'

/**
 * Lifetime totals for sponsorkit.
 *
 * sponsorkit knows what a sponsor pays per month, not what they have paid in all. `addLifetimeTotals`
 * works that out once per fetch and records it on each sponsorship. The grid renderer orders the
 * tiles inside a tier by it.
 */

export interface SponsorshipWithTotal extends Sponsorship {
  /** Everything this sponsor has paid so far, in dollars. An estimate for GitHub Sponsors. */
  totalDollars?: number
}

const MONTH = 365.25 / 12 * 24 * 60 * 60 * 1000

function env(name: string) {
  const value = process.env[name]
  if (!value)
    throw new Error(`${name} is not set; it is needed to look up lifetime totals`)
  return value
}

async function query<T>(url: string, headers: Record<string, string>, body: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query: body }),
  })
  const result = await response.json().catch(() => ({})) as { data?: T | null, errors?: { message: string }[] }
  if (!response.ok || result.errors?.length || !result.data) {
    const reason = result.errors?.map(error => error.message).join('; ') || response.statusText
    throw new Error(`Lifetime totals: ${new URL(url).host} answered ${response.status} ${reason}`)
  }
  return result.data
}

interface GitHubActivity {
  sponsorsActivities: {
    pageInfo: { hasNextPage: boolean, endCursor: string | null }
    nodes: ({
      action: string
      timestamp: string | null
      sponsor: { login?: string } | null
      sponsorsTier: { monthlyPriceInCents: number, isOneTime: boolean } | null
    } | null)[]
  }
}

/**
 * What each sponsor has paid through GitHub Sponsors, in cents, by login.
 *
 * GitHub has exact lifetime values, but blanks them for a token with just the `read:user` and
 * `read:org` scopes sponsorkit asks for. So this replays the sponsorship activity log instead: a
 * one-time payment counts once, and a monthly tier counts for as long as it ran, across
 * cancellations and restarts. Refunds are not subtracted, so read it as a close estimate.
 */
async function githubTotals() {
  const login = env('SPONSORKIT_GITHUB_LOGIN')
  const type = process.env['SPONSORKIT_GITHUB_TYPE'] === 'organization' ? 'organization' : 'user'
  const totals = new Map<string, number>()
  const running = new Map<string, { cents: number, since: number }>()
  const add = (sponsor: string, cents: number) => totals.set(sponsor, (totals.get(sponsor) ?? 0) + cents)
  // end a sponsor's monthly tier, counting the months it ran
  const settle = (sponsor: string, until: number) => {
    const tier = running.get(sponsor)
    if (tier)
      add(sponsor, tier.cents * (until - tier.since) / MONTH)
    running.delete(sponsor)
  }

  let cursor: string | null = null
  do {
    const data: Record<string, GitHubActivity | null> = await query('https://api.github.com/graphql', { Authorization: `bearer ${env('SPONSORKIT_GITHUB_TOKEN')}` }, `{
      ${type}(login: ${JSON.stringify(login)}) {
        sponsorsActivities(period: ALL, first: 100, orderBy: { field: TIMESTAMP, direction: ASC }${cursor ? `, after: ${JSON.stringify(cursor)}` : ''}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            action timestamp
            sponsor { ... on User { login } ... on Organization { login } }
            sponsorsTier { monthlyPriceInCents isOneTime }
          }
        }
      }
    }`)
    const page = data[type]?.sponsorsActivities
    if (!page)
      throw new Error(`Lifetime totals: GitHub has no ${type} called ${login}`)
    // GitHub blanks what a token may not see rather than reporting an error
    if (page.nodes.length && page.nodes.every(node => !node))
      throw new Error('Lifetime totals: GitHub hid the sponsorship activity log from this token')

    for (const node of page.nodes) {
      const sponsor = node?.sponsor?.login
      const at = Date.parse(node?.timestamp ?? '')
      if (!node || !sponsor || !at)
        continue
      const { action, sponsorsTier: tier } = node
      if (action === 'NEW_SPONSORSHIP' && tier?.isOneTime) {
        // paid once, alongside any monthly tier that is running
        add(sponsor, tier.monthlyPriceInCents)
      }
      else if (action === 'NEW_SPONSORSHIP' || action === 'TIER_CHANGE' || action === 'CANCELLED_SPONSORSHIP') {
        settle(sponsor, at)
        if (action !== 'CANCELLED_SPONSORSHIP' && tier)
          running.set(sponsor, { cents: tier.monthlyPriceInCents, since: at })
      }
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)

  // whatever is still running has been paid up to now
  for (const sponsor of [...running.keys()])
    settle(sponsor, Date.now())
  return totals
}

interface OpenCollectiveCredits {
  account: {
    transactions: {
      totalCount: number
      nodes: { amount: { value: number | null }, fromAccount: { slug: string } | null }[]
    }
  } | null
}

/** What each account has paid this one through OpenCollective, in cents, by slug. */
async function openCollectiveTotals() {
  const slug = env('SPONSORKIT_OPENCOLLECTIVE_SLUG')
  const totals = new Map<string, number>()
  for (let offset = 0, more = true; more;) {
    const data: OpenCollectiveCredits = await query('https://api.opencollective.com/graphql/v2', { 'Api-Key': env('SPONSORKIT_OPENCOLLECTIVE_KEY') }, `{
      account(slug: ${JSON.stringify(slug)}) {
        transactions(limit: 1000, offset: ${offset}, type: CREDIT) {
          totalCount
          nodes { amount { value } fromAccount { slug } }
        }
      }
    }`)
    const page = data.account?.transactions
    if (!page)
      throw new Error(`Lifetime totals: OpenCollective has no account called ${slug}`)
    for (const { amount, fromAccount } of page.nodes) {
      if (fromAccount)
        totals.set(fromAccount.slug, (totals.get(fromAccount.slug) ?? 0) + (amount.value ?? 0) * 100)
    }
    offset += page.nodes.length
    more = page.nodes.length > 0 && offset < page.totalCount
  }
  return totals
}

const sources: Record<string, () => Promise<Map<string, number>>> = {
  github: githubTotals,
  opencollective: openCollectiveTotals,
}

/**
 * Record on each sponsorship what its sponsor has paid in all. Use it as sponsorkit's
 * `onSponsorsAllFetched`, so the totals are stored in the cache with everything else.
 */
export async function addLifetimeTotals(sponsors: SponsorshipWithTotal[]) {
  for (const [provider, fetchTotals] of Object.entries(sources)) {
    const ships = sponsors.filter(ship => ship.provider === provider)
    if (!ships.length)
      continue
    const totals = await fetchTotals()
    for (const ship of ships) {
      const cents = totals.get(ship.sponsor.login)
      if (cents !== undefined)
        ship.totalDollars = Math.round(cents) / 100
    }
  }
}
