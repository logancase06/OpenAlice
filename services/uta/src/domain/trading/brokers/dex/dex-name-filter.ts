/**
 * Token name/symbol heuristic scam filter — catches copycat tickers
 * (Levenshtein-near matches to well-known tokens), scam-adjacent wording,
 * and celebrity-impersonation naming patterns that GoPlus/DexScreener don't
 * flag directly. Pure additive risk score, never a hard reject on its own —
 * callers gate via `TokenSecurityConfig.maxNameRiskScore`.
 */

export interface NameFilterResult {
  passed: boolean
  reason?: string
  riskScore: number
  flags: string[]
}

const KNOWN_TOKENS = [
  'BONK', 'WIF', 'POPCAT', 'BOME', 'MEW', 'TRUMP', 'PEPE',
  'DOGE', 'SHIB', 'SOL', 'BTC', 'ETH', 'USDC', 'USDT',
]

const SCAM_WORDS = [
  'airdrop', 'claim', 'free', 'giveaway', 'presale',
  'whitelist', 'official', 'verified', 'safe', 'guaranteed',
]

const CELEBRITY_NAMES = ['elon', 'musk', 'trump', 'biden', 'taylor', 'swift', 'maga', 'putin', 'xi']
const CRYPTO_SUFFIXES = ['inu', 'coin', 'token', 'ai', 'sol', 'meme']

/** Iterative edit distance, single-row DP — no external lib needed for strings this short. */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let prevDiag = dp[0]!
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j]!, dp[j - 1]!)
      prevDiag = temp
    }
  }
  return dp[n]!
}

export function checkTokenName(symbol: string, name: string): NameFilterResult {
  const flags: string[] = []
  let riskScore = 0
  const upperSymbol = symbol.toUpperCase()
  const combined = `${symbol} ${name}`.toLowerCase()

  // High suspicion (+30 each)
  for (const known of KNOWN_TOKENS) {
    if (upperSymbol === known) continue
    if (levenshtein(upperSymbol, known) <= 2) {
      flags.push(`name-copy:${known}`)
      riskScore += 30
      break
    }
  }

  for (const word of SCAM_WORDS) {
    if (combined.includes(word)) {
      flags.push(`scam-word:${word}`)
      riskScore += 30
      break
    }
  }

  outer: for (const celeb of CELEBRITY_NAMES) {
    if (!combined.includes(celeb)) continue
    for (const suffix of CRYPTO_SUFFIXES) {
      if (combined.includes(suffix)) {
        flags.push(`celebrity-suffix:${celeb}+${suffix}`)
        riskScore += 30
        break outer
      }
    }
  }

  // Moderate suspicion (+15 each)
  if (symbol.length > 8 && symbol === upperSymbol) {
    flags.push('symbol-long-uppercase')
    riskScore += 15
  }
  if (/\d/.test(symbol)) {
    flags.push('symbol-has-digits')
    riskScore += 15
  }
  if (name.length > 40) {
    flags.push('name-too-long')
    riskScore += 15
  }
  const symbolWords = new Set(upperSymbol.match(/[A-Z]+/g) ?? [upperSymbol])
  const nameWords = new Set(name.toUpperCase().split(/\s+/).filter(Boolean))
  const hasCommonWord = [...symbolWords].some(w => nameWords.has(w))
  if (!hasCommonWord) {
    flags.push('symbol-name-mismatch')
    riskScore += 15
  }

  return {
    passed: riskScore === 0,
    reason: flags.length > 0 ? flags.join(', ') : undefined,
    riskScore,
    flags,
  }
}
