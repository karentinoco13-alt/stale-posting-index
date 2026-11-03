// Candidate satisfaction (CSAT) with an employer's recruiting team.
// Job seekers rate their experience 1-5 and answer a few quick questions.
// CSAT = share of ratings that are 4 or 5 (the standard CSAT definition).

const fs = require('node:fs');
const path = require('node:path');

const STAGES = ['applied', 'screen', 'interview', 'final', 'offer'];
const MIN_FOR_SCORE = 3; // don't show a % until there are a few ratings

function createStore(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new store */ }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };

  function add(domain, input) {
    const score = Number(input.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error('Rating must be 1 to 5 stars');
    const clientId = String(input.clientId || '').slice(0, 64);
    if (!/^[a-z0-9-]{8,64}$/i.test(clientId)) throw new Error('Missing reviewer id');
    const bool = (v) => (v === true || v === false ? v : null);
    const entry = {
      score,
      stage: STAGES.includes(input.stage) ? input.stage : null,
      responded: bool(input.responded),
      ghosted: bool(input.ghosted),
      respectful: bool(input.respectful),
      comment: String(input.comment || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      clientId,
      at: new Date().toISOString(),
    };
    const list = (data[domain] ||= []);
    // One rating per person per company; a new one replaces the old.
    const i = list.findIndex((r) => r.clientId === clientId);
    if (i >= 0) list[i] = entry; else list.push(entry);
    save();
    return summary(domain);
  }

  function summary(domain) {
    const list = data[domain] || [];
    const n = list.length;
    const pct = (pred, base = list) => (base.length ? Math.round((base.filter(pred).length / base.length) * 100) : null);
    const answered = (k) => list.filter((r) => r[k] !== null && r[k] !== undefined);
    return {
      count: n,
      csat: n >= MIN_FOR_SCORE ? pct((r) => r.score >= 4) : null,
      average: n ? Math.round((list.reduce((s, r) => s + r.score, 0) / n) * 10) / 10 : null,
      respondedPct: n >= MIN_FOR_SCORE ? pct((r) => r.responded, answered('responded')) : null,
      ghostedPct: n >= MIN_FOR_SCORE ? pct((r) => r.ghosted, answered('ghosted')) : null,
      respectfulPct: n >= MIN_FOR_SCORE ? pct((r) => r.respectful, answered('respectful')) : null,
      recent: list.filter((r) => r.comment).slice(-5).reverse().map(({ score, stage, comment, at }) => ({ score, stage, comment, at })),
      minForScore: MIN_FOR_SCORE,
    };
  }

  return { add, summary, domains: () => Object.keys(data) };
}

module.exports = { createStore, STAGES, MIN_FOR_SCORE };
