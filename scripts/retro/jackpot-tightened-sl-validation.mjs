// VOLET 4 du protocole du 2026-07-08 — variante « cellule jackpot + stop-loss
// resserré à -10% ». Miroir de jackpot-quartile-validation.mjs (double
// garde-fou : taux de jackpots par quartile ET rentabilité agrégée), appliqué
// à la même cellule figée mais avec un SL -10% simulé tick-à-tick.
//
// CE QUE CE VOLET TESTE : le signal de FRÉQUENCE de jackpots de la cellule est
// confirmé hors-échantillon (lift ×2.16, hold-out temporel du 06) mais la
// cellule n'est pas rentable en moyenne sous les exits standard. Le test
// exploratoire du 06 (jackpot-stoploss-sim) a montré qu'un SL -10% triple la
// moyenne SANS coûter un seul top (taux top5 identique aux 3 stops testés) —
// MAIS ce -10% a été choisi sur l'échantillon jugé (winner's curse identifié)
// et son walk-forward y échouait (Q3 négatif). D'où ce volet : re-tester la
// variante UNIQUEMENT sur des données jamais vues par ce choix.
//
// FRAÎCHEUR : seuls les trades entrés APRÈS 2026-07-06T12:00Z comptent (le
// test qui a choisi -10% a été généré à 11:53Z le 06).
//
// UN « PASSÉ » ICI NE DÉCLENCHE AUCUNE ACTIVATION : il ouvre seulement la
// possibilité d'ENVISAGER un shadow pilot bis pour cette variante — décision
// humaine séparée, distincte de l'activation de jackpot_paper standard
// (laquelle reste gouvernée par le volet 0 et sa propre double condition).
//   node scripts/retro/jackpot-tightened-sl-validation.mjs
import { createReadStream } from 'node:fs'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = join(homedir(), '.openalice', 'data')
const CUTOFF = 45.31            // is_top5pct — seuil absolu (big-winners-pattern)
const MIN_AGE = 30, MAX_AGE = 54.2, MIN_M5 = 3.90 // cellule FIGÉE (dérivation pré-coupure du 06)
const SL = -10                  // la variante testée — choisie le 06, jugée ici sur du frais
const FRESH_CUTOFF = Date.parse('2026-07-06T12:00:00Z') // après la génération du test qui a choisi -10%
const MIN_CELL_PER_QUARTILE = 25

// ---------- dataset : trades frais + m5 d'entrée + trajectoires ----------
const series = new Map()
for (const f of (await readdir(join(base, 'scan-log'))).filter(f => f.endsWith('.jsonl')).sort()) {
  const rl = createInterface({ input: createReadStream(join(base, 'scan-log', f)) })
  for await (const line of rl) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'scan' || !e.tokenAddress) continue
    ;(series.get(e.tokenAddress) ?? series.set(e.tokenAddress, []).get(e.tokenAddress))
      .push({ ts: new Date(e.timestamp).getTime(), m5: e.rawData?.priceChange?.m5 ?? null })
  }
}
for (const a of series.values()) a.sort((x, y) => x.ts - y.ts)
const closed = []
for (const f of (await readdir(join(base, 'positions', 'closed'))).filter(f => f.endsWith('.jsonl')).sort()) {
  for (const line of (await readFile(join(base, 'positions', 'closed', f), 'utf-8')).split('\n')) {
    if (line.trim()) { try { const c = JSON.parse(line); if (['early', 'early_strict', 'web_lowvol', 'jackpot'].includes(c.strategy)) closed.push(c) } catch {} }
  }
}
const fresh = []
for (const c of closed) {
  if (c.entryTimestamp < FRESH_CUTOFF) continue
  const arr = series.get(c.tokenAddress)
  let f = null
  if (arr) for (const p of arr) { if (p.ts <= c.entryTimestamp + 60_000) f = p; else break }
  if (!f || c.entryTimestamp - f.ts > 30 * 60_000 || f.m5 == null) continue
  fresh.push({ c, m5: f.m5, inCell: c.entryAgeMinutes >= MIN_AGE && c.entryAgeMinutes < MAX_AGE && f.m5 > MIN_M5 })
}
const cellIds = new Set(fresh.filter(r => r.inCell).map(r => r.c.id))
const ticksById = new Map()
for (const f of (await readdir(join(base, 'position-trajectory'))).filter(f => f.endsWith('.jsonl')).sort()) {
  const rl = createInterface({ input: createReadStream(join(base, 'position-trajectory', f)) })
  for await (const line of rl) {
    if (!line.trim()) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (!cellIds.has(e.positionId)) continue
    ;(ticksById.get(e.positionId) ?? ticksById.set(e.positionId, []).get(e.positionId))
      .push({ ts: new Date(e.timestamp).getTime(), ret: e.returnPct })
  }
}
/** SL resserré simulé causalement : sortie au premier tick <= SL, valorisée à CE tick (gap inclus) ; sinon sortie réelle. */
function retWithTightSL(c) {
  const ticks = ticksById.get(c.id)
  if (!ticks || ticks.length < 3) return null // pas de trajectoire = pas simulable
  ticks.sort((a, b) => a.ts - b.ts)
  for (const t of ticks) if (t.ret <= SL) return t.ret
  return c.returnPct
}

const out = []
out.push(`# VOLET 4 (2026-07-08) — cellule jackpot + stop-loss resserré à ${SL}%`)
out.push(`Généré le ${new Date().toISOString()}.`)
out.push('')
out.push(`> Teste si un SL plus serré convertit le signal de fréquence de jackpots (confirmé ×2.16`)
out.push(`> hors-échantillon le 06) en rentabilité réelle. Données STRICTEMENT postérieures au`)
out.push(`> ${new Date(FRESH_CUTOFF).toISOString()} — jamais vues par le test qui a choisi ${SL}%.`)
out.push(`> Un PASSÉ n'active RIEN : il permet seulement d'envisager un shadow pilot bis pour cette`)
out.push(`> variante (décision humaine séparée de l'activation de jackpot_paper standard, volet 0).`)
out.push('')
const cellFresh = fresh.filter(r => r.inCell)
const simmed = cellFresh.map(r => ({ ...r, simRet: retWithTightSL(r.c) })).filter(r => r.simRet != null)
out.push(`Trades frais : ${fresh.length} au total, cellule : ${cellFresh.length}, dont **${simmed.length} simulables** (trajectoire tick-à-tick présente).`)
out.push('')
// ---------- garde-fou d'effectif ----------
if (simmed.length < 4 * MIN_CELL_PER_QUARTILE) {
  out.push(`## Verdict : INSUFFISANT — ${simmed.length} trades de cellule simulables, il en faut >= ${4 * MIN_CELL_PER_QUARTILE} (${MIN_CELL_PER_QUARTILE}/quartile) pour un walk-forward interprétable. Attendre plus de données ; NE PAS conclure.`)
  const date = new Date().toISOString().slice(0, 10)
  await mkdir(join(base, 'retro'), { recursive: true })
  await writeFile(join(base, 'retro', `jackpot-tightened-sl-validation-${date}.md`), out.join('\n') + '\n', 'utf-8')
  console.log(out.join('\n'))
  process.exit(0)
}
// ---------- quartiles chronologiques sur les trades frais ----------
simmed.sort((a, b) => a.c.entryTimestamp - b.c.entryTimestamp)
// base rate top5 des trades frais HORS cellule (référence de lift, même convention que le volet 0)
const freshSorted = [...fresh].sort((a, b) => a.c.entryTimestamp - b.c.entryTimestamp)
out.push('| Quartile (chrono, trades frais) | n cellule | taux top5 (SL serré) | base top5 (hors cellule, même fenêtre) | lift | retour moyen (SL serré) |')
out.push('|---|---|---|---|---|---|')
const lifts = []
for (let q = 0; q < 4; q++) {
  const sub = simmed.slice(Math.floor(q * simmed.length / 4), Math.floor((q + 1) * simmed.length / 4))
  const t0 = sub[0].c.entryTimestamp, t1 = sub[sub.length - 1].c.entryTimestamp
  const baseWin = freshSorted.filter(r => !r.inCell && r.c.entryTimestamp >= t0 && r.c.entryTimestamp <= t1)
  const baseRate = baseWin.length ? baseWin.filter(r => r.c.returnPct >= CUTOFF).length / baseWin.length * 100 : 0
  const cellRate = sub.filter(r => r.simRet >= CUTOFF).length / sub.length * 100
  const lift = baseRate > 0 ? cellRate / baseRate : (cellRate > 0 ? Infinity : 0)
  lifts.push(lift)
  const mean = sub.reduce((a, r) => a + r.simRet, 0) / sub.length
  out.push(`| Q${q + 1} | ${sub.length} | ${cellRate.toFixed(1)}% | ${baseRate.toFixed(1)}% (n=${baseWin.length}) | **×${Number.isFinite(lift) ? lift.toFixed(2) : '∞'}** | ${mean >= 0 ? '+' : ''}${mean.toFixed(2)}% |`)
}
const meanAll = simmed.reduce((a, r) => a + r.simRet, 0) / simmed.length
out.push('')
out.push(`Retour moyen AGRÉGÉ de la cellule sous SL ${SL}% : **${meanAll >= 0 ? '+' : ''}${meanAll.toFixed(2)}%** (n=${simmed.length})`)
out.push('')
let verdict
if (!lifts.every(l => l > 1)) {
  verdict = `ÉCHEC (taux) — lift <= 1 dans au moins un quartile (${lifts.map(l => Number.isFinite(l) ? '×' + l.toFixed(2) : '×∞').join(', ')}). La variante n'est pas retenue.`
} else if (meanAll <= 0) {
  verdict = `ÉCHEC (rentabilité) — le taux passe mais le retour moyen agrégé est ${meanAll.toFixed(2)}% <= 0 : le SL resserré ne suffit pas à rendre la cellule viable sur données fraîches. La variante n'est pas retenue.`
} else {
  verdict = `PASSÉ — lift > 1 dans les 4 quartiles ET retour moyen agrégé +${meanAll.toFixed(2)}% > 0 sur données jamais vues par le choix du SL. La variante devient CANDIDATE à un shadow pilot bis — décision humaine séparée ; AUCUNE activation automatique, jackpot_paper standard reste gouverné par le volet 0. Juger sur la distribution complète (médiane, queues), pas seulement ces agrégats.`
}
out.push(`## Verdict : ${verdict}`)
const date = new Date().toISOString().slice(0, 10)
await mkdir(join(base, 'retro'), { recursive: true })
await writeFile(join(base, 'retro', `jackpot-tightened-sl-validation-${date}.md`), out.join('\n') + '\n', 'utf-8')
console.log(out.join('\n'))
