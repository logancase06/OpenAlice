// Modèle enrichi créateur/holders — exécute le protocole de la partie B de
// data/retro/winner-curse-correction-2026-07-06.md. À lancer le 2026-07-08+ :
//   node scripts/retro/enriched-model.mjs
// Garde-fou automatique : s'arrête si l'échantillon éligible est sous les
// seuils (~800 trades / ~40 positifs) fixés dans le protocole. Plain .mjs
// (pas de deps repo) : il ne lit que ~/.openalice/data.
import { createReadStream } from 'node:fs'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = join(homedir(), '.openalice', 'data')
const CUTOFF = 45.31 // seuil ABSOLU is_top5pct — identique à big-winners-pattern (comparabilité)
const COLLECTION_START = Date.parse('2026-07-06T09:00:00Z')
const MIN_TRADES = 800
const MIN_POSITIVES = 40

// ---------- scan-log : features + stamps créateur/holders ----------
const series = new Map()
for (const f of (await readdir(join(base, 'scan-log'))).filter(f => f.endsWith('.jsonl')).sort()) {
  const rl = createInterface({ input: createReadStream(join(base, 'scan-log', f)) })
  for await (const line of rl) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'scan' || !e.tokenAddress) continue
    const r = e.rawData ?? {}
    ;(series.get(e.tokenAddress) ?? series.set(e.tokenAddress, []).get(e.tokenAddress)).push({
      ts: new Date(e.timestamp).getTime(),
      m5: r.priceChange?.m5 ?? null, h1: r.priceChange?.h1 ?? null,
      volH1: r.volume?.h1 ?? null, liq: e.liquidityUsd ?? 0,
      web: r.hasWebsite === true ? 1 : 0, soc: r.hasSocials === true ? 1 : 0,
      risk: e.nameFilter?.riskScore ?? null, tph: e.velocityContext?.tokensPerHour ?? null,
      creator: e.creatorAddress ?? null, creatorRank: e.creatorRankToday ?? null,
      holders: e.holdersCount ?? null,
      price: e.priceAtScan ?? null,
    })
  }
}
for (const a of series.values()) a.sort((x, y) => x.ts - y.ts)

// ---------- registre créateurs : historique par wallet ----------
const launchesByCreator = new Map() // creator -> [{ts, mint}] triés
try {
  for (const f of (await readdir(join(base, 'creator-launches'))).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of (await readFile(join(base, 'creator-launches', f), 'utf-8')).split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        ;(launchesByCreator.get(e.creatorAddress) ?? launchesByCreator.set(e.creatorAddress, []).get(e.creatorAddress))
          .push({ ts: new Date(e.timestamp).getTime(), mint: e.mintAddress })
      } catch {}
    }
  }
} catch {}
for (const a of launchesByCreator.values()) a.sort((x, y) => x.ts - y.ts)

/** Sort d'un token du registre, dérivé du scan-log (protocole : dernier scan < 30% du prix max observé, ou liq finale < $2k = mort). null = jamais scanné (hors fenêtre / jamais éligible). */
function tokenDied(mint) {
  const arr = series.get(mint)
  if (!arr || arr.length < 2) return null
  const maxPrice = Math.max(...arr.map(p => p.price ?? 0))
  const last = arr[arr.length - 1]
  if (maxPrice <= 0 || last.price == null) return null
  return last.price / maxPrice < 0.3 || last.liq < 2000
}

// ---------- trades fermés éligibles ----------
const closed = []
for (const f of (await readdir(join(base, 'positions', 'closed'))).filter(f => f.endsWith('.jsonl')).sort()) {
  for (const line of (await readFile(join(base, 'positions', 'closed', f), 'utf-8')).split('\n')) {
    if (line.trim()) { try { const c = JSON.parse(line); if (['early', 'early_strict', 'web_lowvol', 'jackpot'].includes(c.strategy)) closed.push(c) } catch {} }
  }
}
const rows = []
let sinceStart = 0, noCreatorStamp = 0
const control = [] // groupe témoin : trades post-collecte SANS stamp créateur (rapportés séparément, jamais imputés)
for (const c of closed) {
  if (c.entryTimestamp < COLLECTION_START) continue
  sinceStart++
  const arr = series.get(c.tokenAddress)
  let f = null, prev = null
  if (arr) for (const p of arr) { if (p.ts <= c.entryTimestamp + 60_000) { prev = f; f = p } else break }
  if (!f || c.entryTimestamp - f.ts > 30 * 60_000) continue
  if (f.m5 == null || f.h1 == null || f.volH1 == null || f.liq <= 0 || f.risk == null || f.tph == null) continue
  const y = c.returnPct >= CUTOFF ? 1 : 0
  if (!f.creator) { noCreatorStamp++; control.push({ y, ret: c.returnPct }); continue }
  const hist = launchesByCreator.get(f.creator) ?? []
  const prior = hist.filter(l => l.ts < c.entryTimestamp && l.mint !== c.tokenAddress)
  const priorFates = prior.map(l => tokenDied(l.mint)).filter(v => v != null)
  rows.push({
    y, ret: c.returnPct, ts: c.entryTimestamp,
    feats: {
      logLiq: Math.log10(c.entryLiquidityUsd), age: c.entryAgeMinutes,
      hourSin: Math.sin(2 * Math.PI * new Date(c.entryTimestamp).getUTCHours() / 24),
      hourCos: Math.cos(2 * Math.PI * new Date(c.entryTimestamp).getUTCHours() / 24),
      m5: f.m5, h1: f.h1, volLiq: f.volH1 / f.liq, risk: f.risk, tph: f.tph, web: f.web, soc: f.soc,
      isStrict: c.strategy === 'early_strict' ? 1 : 0, isWlv: c.strategy === 'web_lowvol' ? 1 : 0,
      // nouvelles colonnes (protocole partie B)
      creatorRankToday: f.creatorRank ?? 1,
      creatorPriorLaunches: prior.length,
      creatorPriorFate: priorFates.length ? priorFates.filter(Boolean).length / priorFates.length : 0.5, // 0.5 = inconnu (pas d'historique scanné)
      holdersCount: f.holders ?? -1, // -1 = non mesuré (sentinelle explicite, PAS une imputation à 0)
      deltaHolders: f.holders != null && prev?.holders != null ? f.holders - prev.holders : 0,
    },
  })
}

// ---------- GARDE-FOU AUTOMATIQUE ----------
const positives = rows.filter(r => r.y === 1).length
console.log(`Trades depuis le début des collectes (${new Date(COLLECTION_START).toISOString()}) : ${sinceStart}`)
console.log(`Éligibles (stamp créateur + features complètes) : ${rows.length} | positifs is_top5pct : ${positives} | groupe témoin sans stamp : ${control.length}`)
if (rows.length < MIN_TRADES || positives < MIN_POSITIVES) {
  console.log(`\n⛔ ARRÊT (garde-fou du protocole) : il faut >= ${MIN_TRADES} trades éligibles ET >= ${MIN_POSITIVES} positifs.`)
  console.log(`   Attendre 24-48 h de collecte supplémentaire plutôt que de conclure sur un échantillon insuffisant.`)
  process.exit(0)
}

// ---------- modèle : référence locale puis enrichi ----------
function auc(scores, labels) {
  const idx = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0])
  let rankSum = 0, np = 0, nn = 0
  for (let i = 0; i < idx.length; i++) { if (idx[i][1] === 1) { rankSum += i + 1; np++ } else nn++ }
  return np && nn ? (rankSum - np * (np + 1) / 2) / (np * nn) : 0.5
}
function trainAndTest(rows, featKeys) {
  const nTrain = Math.floor(rows.length * 0.7)
  const train = rows.slice(0, nTrain), test = rows.slice(nTrain)
  const stats = {}
  for (const k of featKeys) {
    const v = train.map(r => r.feats[k])
    const m = v.reduce((a, b) => a + b, 0) / v.length
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1
    stats[k] = { m, sd }
  }
  let w = new Array(featKeys.length).fill(0), b = Math.log(0.05 / 0.95)
  const X = train.map(r => featKeys.map(k => (r.feats[k] - stats[k].m) / stats[k].sd))
  const y = train.map(r => r.y)
  for (let it = 0; it < 400; it++) {
    const gw = new Array(featKeys.length).fill(0)
    let gb = 0
    for (let i = 0; i < X.length; i++) {
      const z = X[i].reduce((a, x, j) => a + x * w[j], b)
      const p = 1 / (1 + Math.exp(-z))
      const d = p - y[i]
      for (let j = 0; j < featKeys.length; j++) gw[j] += d * X[i][j]
      gb += d
    }
    for (let j = 0; j < featKeys.length; j++) w[j] -= 0.5 * gw[j] / X.length
    b -= 0.5 * gb / X.length
  }
  const score = r => featKeys.reduce((a, k, j) => a + (r.feats[k] - stats[k].m) / stats[k].sd * w[j], b)
  return { aucTrain: auc(train.map(score), train.map(r => r.y)), aucTest: auc(test.map(score), test.map(r => r.y)) }
}
rows.sort((a, b) => a.ts - b.ts)
const BASE = ['logLiq', 'age', 'hourSin', 'hourCos', 'm5', 'h1', 'volLiq', 'risk', 'tph', 'web', 'soc', 'isStrict', 'isWlv']
const NEW = ['creatorRankToday', 'creatorPriorLaunches', 'creatorPriorFate', 'holdersCount', 'deltaHolders']
const out = []
out.push(`# Modèle enrichi créateur/holders — exécution du protocole (partie B, winner-curse-correction)`)
out.push(`Généré le ${new Date().toISOString()}. Éligibles : ${rows.length} trades (${positives} positifs), témoin sans stamp : ${control.length} (taux top5% témoin : ${control.length ? (control.filter(r => r.y === 1).length / control.length * 100).toFixed(1) : '—'}%).`)
const ref = trainAndTest(rows, BASE)
out.push(`\nRéférence LOCALE (features existantes, mêmes trades) : AUC train ${ref.aucTrain.toFixed(3)} | **test ${ref.aucTest.toFixed(3)}** (c'est CE chiffre qu'il faut battre, pas 0,629)`)
const full = trainAndTest(rows, [...BASE, ...NEW])
out.push(`Modèle enrichi (+5 colonnes) : AUC train ${full.aucTrain.toFixed(3)} | **test ${full.aucTest.toFixed(3)}** | ΔAUC test ${(full.aucTest - ref.aucTest >= 0 ? '+' : '')}${(full.aucTest - ref.aucTest).toFixed(3)}`)
out.push(`\nPouvoir marginal (chaque nouvelle colonne ajoutée SEULE à la référence) :`)
out.push('| Feature | AUC test | ΔAUC vs référence |')
out.push('|---|---|---|')
for (const k of NEW) {
  const m = trainAndTest(rows, [...BASE, k])
  out.push(`| ${k} | ${m.aucTest.toFixed(3)} | ${(m.aucTest - ref.aucTest >= 0 ? '+' : '')}${(m.aucTest - ref.aucTest).toFixed(3)} |`)
}
out.push(`\nRappels du protocole : tout lift de cellule dérivé d'ici suit la procédure moitié-recherche/moitié-mesure (winner-curse-correction) ; ne pas comparer à ×1,93.`)
const date = new Date().toISOString().slice(0, 10)
await mkdir(join(base, 'retro'), { recursive: true })
await writeFile(join(base, 'retro', `enriched-model-${date}.md`), out.join('\n') + '\n', 'utf-8')
console.log('\n' + out.join('\n'))
