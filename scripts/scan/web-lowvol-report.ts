/**
 * Suivi du pilote WEB_LOWVOL — évalue mécaniquement la barre de graduation
 * écrite dans la docstring de `WEB_LOWVOL_CONFIG` (live-scan.ts), pour que le
 * bilan du pilote soit un calcul, pas une relecture d'historique :
 *
 *   1. n >= 30 tokens uniques tradés en live
 *   2. retour moyen PONDÉRÉ PAR TOKEN > 0 (chaque token compte une fois,
 *      pas une fois par trade — même convention que le bilan qui a suspendu
 *      early_web_filtered)
 *   3. split chronologique en quartiles (par token) sans inversion de signe
 *      positif→négatif entre quartiles adjacents (le pattern Q3→Q4 qui a
 *      coulé early_web_filtered)
 *
 * Tout est lu depuis les fichiers persistés (positions fermées/ouvertes,
 * scan-log) — aucune dépendance au process scanner. Le filtre est le label
 * 'web_lowvol' lui-même : il n'existait pas avant le pilote (2026-07-05),
 * donc pas de contamination par des trades antérieurs. La fenêtre de
 * comparaison EARLY/EARLY_STRICT démarre au premier trade web_lowvol, même
 * convention que le bilan d'early_web_filtered.
 *
 * Rapporte aussi la part d'entrées passées par le chemin « volume manquant »
 * du guard (check vol/liq sauté faute de données) — la docstring de
 * WEB_LOWVOL_CONFIG demande explicitement de vérifier ce chemin avant de
 * conclure à un échec du signal, puisque le backtest exigeait la donnée.
 *
 * Usage : pnpm pilot:web-lowvol
 */
import { readFile, readdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { dataPath } from '@/core/paths.js'
import type { ClosedPosition } from '../../services/uta/src/domain/trading/brokers/dex/position-tracker.js'

export const GRADUATION_MIN_UNIQUE_TOKENS = 30

export interface TokenWeightedStats {
  nTrades: number
  nTokens: number
  /** Moyenne des moyennes par token — chaque token pèse 1. */
  tokenWeightedAvgPct: number
  tradeWeightedAvgPct: number
  /** Part des tokens dont la moyenne est > 0. */
  tokenWinRatePct: number
  worstTokenPct: number
  bestTokenPct: number
}

interface TokenAgg {
  tokenAddress: string
  firstEntryTimestamp: number
  avgReturnPct: number
}

function aggregateByToken(trades: ClosedPosition[]): TokenAgg[] {
  const byToken = new Map<string, ClosedPosition[]>()
  for (const t of trades) {
    const arr = byToken.get(t.tokenAddress) ?? []
    arr.push(t)
    byToken.set(t.tokenAddress, arr)
  }
  return [...byToken.entries()].map(([tokenAddress, arr]) => ({
    tokenAddress,
    firstEntryTimestamp: Math.min(...arr.map(t => t.entryTimestamp)),
    avgReturnPct: arr.reduce((a, t) => a + t.returnPct, 0) / arr.length,
  }))
}

export function tokenWeightedStats(trades: ClosedPosition[]): TokenWeightedStats | null {
  if (trades.length === 0) return null
  const tokens = aggregateByToken(trades)
  const avgs = tokens.map(t => t.avgReturnPct)
  return {
    nTrades: trades.length,
    nTokens: tokens.length,
    tokenWeightedAvgPct: avgs.reduce((a, b) => a + b, 0) / tokens.length,
    tradeWeightedAvgPct: trades.reduce((a, t) => a + t.returnPct, 0) / trades.length,
    tokenWinRatePct: (avgs.filter(a => a > 0).length / tokens.length) * 100,
    worstTokenPct: Math.min(...avgs),
    bestTokenPct: Math.max(...avgs),
  }
}

/**
 * Split chronologique par token (ordre du premier trade de chaque token),
 * 4 buckets aussi égaux que possible, moyenne pondérée par token dans
 * chacun. Moins de 4 tokens ⇒ [] (un quartile vide n'a pas de sens).
 */
export function quartileSplit(trades: ClosedPosition[]): number[] {
  const tokens = aggregateByToken(trades).sort((a, b) => a.firstEntryTimestamp - b.firstEntryTimestamp)
  if (tokens.length < 4) return []
  const buckets: TokenAgg[][] = [[], [], [], []]
  for (let i = 0; i < tokens.length; i++) {
    buckets[Math.floor((i * 4) / tokens.length)]!.push(tokens[i]!)
  }
  return buckets.map(b => b.reduce((a, t) => a + t.avgReturnPct, 0) / b.length)
}

/**
 * Inversion = un quartile positif suivi d'un quartile négatif (la
 * dégradation Q3→Q4 qui a suspendu early_web_filtered). Une amélioration
 * négatif→positif n'est PAS une inversion — c'est le sens attendu d'un
 * signal qui se confirme.
 */
export function hasSignReversal(quartiles: number[]): boolean {
  for (let i = 0; i + 1 < quartiles.length; i++) {
    if (quartiles[i]! > 0 && quartiles[i + 1]! < 0) return true
  }
  return false
}

export type GraduationVerdict = 'in_progress' | 'graduate' | 'suspend'

export interface GraduationBar {
  nTokens: number
  nOk: boolean
  tokenWeightedAvgPct: number | null
  avgOk: boolean
  quartiles: number[]
  quartilesOk: boolean
  verdict: GraduationVerdict
}

/** Verdict mécanique : sous la barre de volume ⇒ in_progress ; sinon les trois critères décident graduate/suspend. */
export function evaluateGraduationBar(trades: ClosedPosition[]): GraduationBar {
  const stats = tokenWeightedStats(trades)
  const quartiles = quartileSplit(trades)
  const nTokens = stats?.nTokens ?? 0
  const nOk = nTokens >= GRADUATION_MIN_UNIQUE_TOKENS
  const avgOk = (stats?.tokenWeightedAvgPct ?? 0) > 0
  const quartilesOk = quartiles.length === 4 && !hasSignReversal(quartiles)
  return {
    nTokens,
    nOk,
    tokenWeightedAvgPct: stats?.tokenWeightedAvgPct ?? null,
    avgOk,
    quartiles,
    quartilesOk,
    verdict: !nOk ? 'in_progress' : avgOk && quartilesOk ? 'graduate' : 'suspend',
  }
}

// ==================== rapport (I/O) ====================

async function readAllClosed(): Promise<ClosedPosition[]> {
  const dir = dataPath('positions', 'closed')
  let files: string[]
  try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort() } catch { return [] }
  const all: ClosedPosition[] = []
  for (const f of files) {
    for (const line of (await readFile(join(dir, f), 'utf-8')).split('\n')) {
      if (line.trim()) { try { all.push(JSON.parse(line)) } catch { /* ligne corrompue — ignorée */ } }
    }
  }
  return all
}

interface ScanFunnel {
  evaluations: number
  passes: number
  passedTokens: Set<string>
  /** Passes où rawData.volume.h1 manquait — le chemin permissif du guard que la docstring demande de surveiller. */
  passesWithoutVolumeData: number
  rejectReasons: Map<string, number>
}

async function readScanFunnel(): Promise<ScanFunnel> {
  const funnel: ScanFunnel = { evaluations: 0, passes: 0, passedTokens: new Set(), passesWithoutVolumeData: 0, rejectReasons: new Map() }
  const dir = dataPath('scan-log')
  let files: string[]
  try { files = (await readdir(dir)).filter(f => f.endsWith('.jsonl')).sort() } catch { return funnel }
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(join(dir, f)) })
    for await (const line of rl) {
      if (!line.includes('web_lowvol')) continue // pré-filtre avant le JSON.parse — la clé n'existe que sur les entrées post-pilote
      let e: { type?: string; tokenAddress?: string; web_lowvol?: { pass: boolean; reason: string }; rawData?: { volume?: { h1?: number } } }
      try { e = JSON.parse(line) } catch { continue }
      if (e.type !== 'scan' || !e.web_lowvol || !e.tokenAddress) continue
      funnel.evaluations++
      if (e.web_lowvol.pass) {
        funnel.passes++
        funnel.passedTokens.add(e.tokenAddress)
        if (e.rawData?.volume?.h1 == null) funnel.passesWithoutVolumeData++
      } else {
        // Normalise les nombres pour agréger les raisons ("liq $12345 below…" → une seule ligne)
        const key = e.web_lowvol.reason.split(';')[0]!.replace(/\$?[\d.,]+/g, 'N').trim().slice(0, 70)
        funnel.rejectReasons.set(key, (funnel.rejectReasons.get(key) ?? 0) + 1)
      }
    }
  }
  return funnel
}

const pct = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`

export async function runReport(): Promise<void> {
  const all = await readAllClosed()
  const pilot = all.filter(t => t.strategy === 'web_lowvol')

  console.log('=== PILOTE WEB_LOWVOL — suivi de graduation ===\n')

  // --- entonnoir scan-log ---
  const funnel = await readScanFunnel()
  console.log(`Entonnoir scanner : ${funnel.evaluations} évaluations, ${funnel.passes} passes (${funnel.passedTokens.size} tokens uniques)`)
  if (funnel.passes > 0) {
    const noVolPct = (funnel.passesWithoutVolumeData / funnel.passes) * 100
    console.log(`  chemin « volume manquant » (check vol/liq sauté) : ${funnel.passesWithoutVolumeData}/${funnel.passes} passes (${noVolPct.toFixed(0)}%)${noVolPct > 25 ? ' ⚠ au-dessus de 25% — les résultats live ne testent plus vraiment la règle du backtest' : ''}`)
  }
  const topRejects = [...funnel.rejectReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (topRejects.length) {
    console.log('  top raisons de rejet :')
    for (const [r, n] of topRejects) console.log(`    ${String(n).padStart(6)}  ${r}`)
  }

  // --- trades fermés ---
  const stats = tokenWeightedStats(pilot)
  if (!stats) {
    console.log('\nAucun trade web_lowvol fermé pour l\'instant — verdict : EN COURS (barre à n>=30 tokens).')
    return
  }
  const reasons = new Map<string, number>()
  for (const t of pilot) reasons.set(t.exitReason, (reasons.get(t.exitReason) ?? 0) + 1)
  console.log(`\nTrades fermés : ${stats.nTrades} (${stats.nTokens} tokens uniques)`)
  console.log(`  retour moyen pondéré token : ${pct(stats.tokenWeightedAvgPct)} | pondéré trade : ${pct(stats.tradeWeightedAvgPct)}`)
  console.log(`  tokens gagnants : ${stats.tokenWinRatePct.toFixed(0)}% | best ${pct(stats.bestTokenPct)} | worst ${pct(stats.worstTokenPct)}`)
  console.log(`  sorties : ${[...reasons.entries()].map(([r, n]) => `${r}:${n}`).join('  ')}`)

  // --- comparaison même fenêtre ---
  const windowStart = Math.min(...pilot.map(t => t.entryTimestamp))
  for (const label of ['early', 'early_strict'] as const) {
    const s = tokenWeightedStats(all.filter(t => t.strategy === label && t.entryTimestamp >= windowStart))
    console.log(s
      ? `  vs ${label.padEnd(12)} (même fenêtre) : ${pct(s.tokenWeightedAvgPct)} pondéré token (${s.nTokens} tokens)`
      : `  vs ${label.padEnd(12)} (même fenêtre) : aucun trade`)
  }

  // --- barre de graduation ---
  const bar = evaluateGraduationBar(pilot)
  console.log('\nBarre de graduation (docstring WEB_LOWVOL_CONFIG) :')
  console.log(`  [${bar.nOk ? 'x' : ' '}] n >= ${GRADUATION_MIN_UNIQUE_TOKENS} tokens uniques : ${bar.nTokens}/${GRADUATION_MIN_UNIQUE_TOKENS}`)
  console.log(`  [${bar.avgOk ? 'x' : ' '}] moyenne pondérée token > 0 : ${bar.tokenWeightedAvgPct != null ? pct(bar.tokenWeightedAvgPct) : 'n/a'}`)
  console.log(`  [${bar.quartilesOk ? 'x' : ' '}] quartiles sans inversion +→− : ${bar.quartiles.length ? bar.quartiles.map(pct).join(' → ') : 'pas encore 4 tokens'}`)
  const verdictText = bar.verdict === 'in_progress'
    ? `EN COURS — ${GRADUATION_MIN_UNIQUE_TOKENS - bar.nTokens} tokens restants avant le bilan`
    : bar.verdict === 'graduate'
      ? 'BARRE FRANCHIE — envisager la promotion de la conjonction en filtre EARLY/EARLY_STRICT (décision humaine, pas automatique)'
      : 'ÉCHEC DE LA BARRE — suspendre l\'entrée (pattern EARLY_WEB_FILTERED_ENTRY_SUSPENDED) et documenter le bilan dans la docstring'
  console.log(`\nVerdict : ${verdictText}`)
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
if (isMainModule) {
  runReport().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
