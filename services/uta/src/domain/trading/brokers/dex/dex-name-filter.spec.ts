import { describe, it, expect } from 'vitest'
import { checkTokenName, levenshtein } from './dex-name-filter.js'

describe('levenshtein', () => {
  it('is 0 for identical strings', () => {
    expect(levenshtein('BONK', 'BONK')).toBe(0)
  })

  it('is 1 for a single trailing character insertion', () => {
    expect(levenshtein('BONK', 'BONK2')).toBe(1)
  })

  it('is symmetric', () => {
    expect(levenshtein('BONK', 'WIF')).toBe(levenshtein('WIF', 'BONK'))
  })
})

describe('checkTokenName', () => {
  it('flags a near-copy of a known token (BONK2) with riskScore >= 30', () => {
    const result = checkTokenName('BONK2', 'Bonk2 Coin')
    expect(result.riskScore).toBeGreaterThanOrEqual(30)
    expect(result.flags.some(f => f.startsWith('name-copy:'))).toBe(true)
    expect(result.passed).toBe(false)
  })

  it('gives a clean, unrelated token a riskScore of 0', () => {
    const result = checkTokenName('SHROOM', 'Shroom')
    expect(result.riskScore).toBe(0)
    expect(result.flags).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('flags scam wording ("free airdrop claim") with riskScore >= 30', () => {
    const result = checkTokenName('CLAIM', 'Free Airdrop Claim')
    expect(result.riskScore).toBeGreaterThanOrEqual(30)
    expect(result.flags.some(f => f.startsWith('scam-word:'))).toBe(true)
  })

  it('detects a celebrity-name + crypto-suffix pattern ("ElonSol")', () => {
    const result = checkTokenName('ELONSOL', 'ElonSol')
    expect(result.riskScore).toBeGreaterThanOrEqual(30)
    expect(result.flags.some(f => f.startsWith('celebrity-suffix:'))).toBe(true)
  })

  it('flags a long, all-uppercase symbol with digits as moderate suspicion', () => {
    const result = checkTokenName('SUPERLONGTOKEN99', 'Super Long Token')
    expect(result.riskScore).toBeGreaterThan(0)
    expect(result.flags).toContain('symbol-long-uppercase')
    expect(result.flags).toContain('symbol-has-digits')
  })

  it('flags a name longer than 40 characters', () => {
    const result = checkTokenName('XYZ', 'A'.repeat(41))
    expect(result.flags).toContain('name-too-long')
  })

  it('flags symbol/name with no common word', () => {
    const result = checkTokenName('XYZ', 'Completely Different Wording')
    expect(result.flags).toContain('symbol-name-mismatch')
  })

  it('does not flag symbol-name-mismatch when symbol appears in the name', () => {
    const result = checkTokenName('FOO', 'Foo Coin')
    expect(result.flags).not.toContain('symbol-name-mismatch')
  })
})
