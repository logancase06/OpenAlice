// Walk-forward en QUARTILES chronologiques de la cellule jackpot FIGÉE
// (âge < 55.4 min × m5 > 3.55% — les seuils de JACKPOT_CONFIG, aucune
// re-sélection, donc pas de winner's curse dans CE test). Condition
// d'activation non négociable enregistrée le 2026-07-06 dans
// winner-curse-correction-2026-07-06.md : lift > 1 dans CHAQUE quartile,
// aucune inversion, sinon jackpot reste en shadow indéfiniment.
//   node scripts/retro/jackpot-quartile-validation.mjs
import { createReadStream } from 'node:fs'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = join(homedir(), '.openalice', 'data')
const CUTOFF = 45.31          // is_top5pct — seuil absolu de big-winners-pattern
const MAX_AGE = 55.4          // borne exacte du tercile jeune (JACKPOT_CONFIG: 30-55min)
const MIN_AGE = 30
const MIN_M5 = 3.55           // borne exacte du tercile m5 fort
const MIN_CELL_PER_QUARTILE = 25

// ---------- dataset : trades fermés + m5 d'entrée via featAt() ----------
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
const rows = []
for (const c of closed) {
  const arr = series.get(c.tokenAddress)
  let f = null
  if (arr) for (const p of arr) { if (p.ts <= c.entryTimestamp + 60_000) f = p; else break }
  if (!f || c.entryTimestamp - f.ts > 30 * 60_000 || f.m5 == null) continue
  rows.push({
    ts: c.entryTimestamp,
    y: c.returnPct >= CUTOFF ? 1 : 0,
    ret: c.returnPct,
    inCell: c.entryAgeMinutes >= MIN_AGE && c.entryAgeMinutes < MAX_AGE && f.m5 > MIN_M5,
  })
}
rows.sort((a, b) => a.ts - b.ts)

// ---------- quartiles chronologiques ----------
const out = []
out.push(`# Walk-forward en quartiles — cellule jackpot figée (âge ${MIN_AGE}-${MAX_AGE}min × m5 > ${MIN_M5}%)`)
out.push(`Généré le ${new Date().toISOString()}. Dataset : ${rows.length} trades avec m5 d'entrée résolu ; cible is_top5pct = retour >= +${CUTOFF}%.`)
out.push(`Seuils FIGÉS (JACKPOT_CONFIG) — aucune re-sélection dans ce test.`)
out.push('')
out.push('| Quartile (chrono) | n total | n cellule | taux top5 cellule | taux top5 base | lift | retour moyen cellule |')
out.push('|---|---|---|---|---|---|---|')
const lifts = []
let insufficient = false
for (let q = 0; q < 4; q++) {
  const sub = rows.slice(Math.floor(q * rows.length / 4), Math.floor((q + 1) * rows.length / 4))
  const cell = sub.filter(r => r.inCell)
  const basePos = sub.filter(r => r.y === 1).length
  const baseRate = basePos / sub.length * 100
  if (cell.length < MIN_CELL_PER_QUARTILE) {
    insufficient = true
    out.push(`| Q${q + 1} | ${sub.length} | ${cell.length} | INSUFFISANT (< ${MIN_CELL_PER_QUARTILE}) | ${baseRate.toFixed(1)}% | — | — |`)
    continue
  }
  const cellRate = cell.filter(r => r.y === 1).length / cell.length * 100
  const lift = baseRate > 0 ? cellRate / baseRate : 0
  lifts.push(lift)
  const avg = cell.reduce((a, r) => a + r.ret, 0) / cell.length
  out.push(`| Q${q + 1} | ${sub.length} | ${cell.length} | ${cellRate.toFixed(1)}% | ${baseRate.toFixed(1)}% | **×${lift.toFixed(2)}** | ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}% |`)
}
out.push('')
let verdict
if (insufficient) {
  verdict = `INSUFFISANT — au moins un quartile sous ${MIN_CELL_PER_QUARTILE} membres de cellule. Attendre plus de données ; NE PAS activer.`
} else if (lifts.every(l => l > 1)) {
  verdict = `PASSÉ — lift > 1 dans les 4 quartiles (${lifts.map(l => '×' + l.toFixed(2)).join(', ')}), aucune inversion. La condition quartile de l'activation est remplie (les AUTRES volets du 8 juillet restent requis).`
} else {
  verdict = `ÉCHEC — lift <= 1 dans au moins un quartile (${lifts.map(l => '×' + l.toFixed(2)).join(', ')}). Jackpot reste en shadow INDÉFINIMENT (pattern EARLY_WEB_FILTERED), quels que soient les résultats du shadow/modèle enrichi.`
}
out.push(`## Verdict : ${verdict}`)
const date = new Date().toISOString().slice(0, 10)
await mkdir(join(base, 'retro'), { recursive: true })
await writeFile(join(base, 'retro', `jackpot-quartile-validation-${date}.md`), out.join('\n') + '\n', 'utf-8')
console.log(out.join('\n'))
