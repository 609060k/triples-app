// Core analytics (file-only)

export const REQUIRED_COLS = ['תאריך', 'הגרלה', 'תלתן', 'יהלום', 'לב', 'עלה'];

export function normVal(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim().toUpperCase();
  if (!s) return '';
  // Normalize common variants
  if (s === 'ט' || s === '10') return '10';
  if (s === 'J' || s === 'ג' || s === 'ג׳' || s === "ג\"") return 'J';
  if (s === 'Q' || s === 'ק' || s === 'ק׳') return 'Q';
  if (s === 'K' || s === 'כ' || s === 'כ׳') return 'K';
  if (s === 'A' || s === 'א') return 'A';
  return s;
}

export function parseDateSafe(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === 'number' && isFinite(v)) {
    // Excel serial date
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + v * 86400000);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\s*$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    let yy = Number(m[3]);
    if (yy < 100) yy += 2000;
    const d = new Date(yy, mm - 1, dd);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function maxDrawNumber(rows) {
  let max = null;
  for (const r of rows) {
    const n = Number(String(r['הגרלה'] ?? '').trim());
    if (!Number.isFinite(n)) continue;
    if (max === null || n > max) max = n;
  }
  return max;
}

export function detectChronology(rows) {
  // Determine whether file is old->new or new->old.
  // We use date if available, else draw number trend.
  if (rows.length < 2) return { rowsOldToNew: rows, wasReversed: false, method: 'none' };

  const dFirst = parseDateSafe(rows[0]?.['תאריך']);
  const dLast = parseDateSafe(rows[rows.length - 1]?.['תאריך']);

  if (dFirst && dLast) {
    // If first date > last date => newest->oldest, reverse
    if (dFirst.getTime() > dLast.getTime()) {
      return { rowsOldToNew: [...rows].reverse(), wasReversed: true, method: 'date' };
    }
    return { rowsOldToNew: rows, wasReversed: false, method: 'date' };
  }

  // Fallback to draw number monotonicity (not guaranteed but useful)
  const nFirst = Number(String(rows[0]?.['הגרלה'] ?? '').trim());
  const nLast = Number(String(rows[rows.length - 1]?.['הגרלה'] ?? '').trim());
  if (Number.isFinite(nFirst) && Number.isFinite(nLast)) {
    if (nFirst > nLast) {
      return { rowsOldToNew: [...rows].reverse(), wasReversed: true, method: 'draw' };
    }
    return { rowsOldToNew: rows, wasReversed: false, method: 'draw' };
  }

  // Can't decide
  return { rowsOldToNew: rows, wasReversed: false, method: 'unknown' };
}

export function isTripleRow(r) {
  // Uses columns C-F (תלתן/יהלום/לב/עלה). Column B is draw number.
  const club = normVal(r['תלתן']);
  const dia = normVal(r['יהלום']);
  const heart = normVal(r['לב']);
  const spade = normVal(r['עלה']);
  const vals = [
    { col: 'תלתן', v: club },
    { col: 'יהלום', v: dia },
    { col: 'לב', v: heart },
    { col: 'עלה', v: spade },
  ];
  const counts = new Map();
  for (const x of vals) {
    if (!x.v) continue;
    counts.set(x.v, (counts.get(x.v) || 0) + 1);
  }
  let bestVal = null;
  let bestCount = 0;
  for (const [v, c] of counts.entries()) {
    if (c > bestCount) {
      bestVal = v;
      bestCount = c;
    }
  }
  if (bestCount >= 3 && bestVal) {
    const matchCols = vals.filter(x => x.v === bestVal).map(x => x.col);
    const missingCols = vals.filter(x => x.v !== bestVal).map(x => x.col);
    return {
      isTriple: true,
      value: bestVal,
      size: bestCount, // 3 or 4
      matchCols,
      missingCols,
      suits: { 'תלתן': club, 'יהלום': dia, 'לב': heart, 'עלה': spade },
    };
  }
  return { isTriple: false };
}

export function computeTriples(rowsOldToNew) {
  const events = [];
  for (let idx = 0; idx < rowsOldToNew.length; idx++) {
    const r = rowsOldToNew[idx];
    const t = isTripleRow(r);
    if (!t.isTriple) continue;
    events.push({
      idx,
      draw: String(r['הגרלה'] ?? '').trim(),
      drawNum: Number(String(r['הגרלה'] ?? '').trim()),
      date: r['תאריך'],
      value: t.value,
      size: t.size,
      matchCols: t.matchCols,
      missingCols: t.missingCols,
      suits: t.suits,
    });
  }
  return events;
}

export function gapsBetweenTriples(events) {
  const gaps = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const cur = events[i];
    gaps.push({
      from: prev,
      to: cur,
      gap: cur.idx - prev.idx,
    });
  }
  return gaps;
}

export function rateInWindow(rowsOldToNew, events, windowSize) {
  const n = rowsOldToNew.length;
  const start = Math.max(0, n - windowSize);
  let c = 0;
  for (const ev of events) {
    if (ev.idx >= start && ev.idx < n) c++;
  }
  const draws = n - start;
  const every = c === 0 ? null : (draws / c);
  return { draws, triples: c, every };
}

function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function summarizeNextGapsForExactLag(gaps, lagX) {
  // Find all gaps with gap==lagX and summarize the NEXT gap (to the next triple after the closing triple).
  // For gap i (from events[i-1] to events[i]), the next gap is gap i+1.
  const next = [];
  for (let i = 0; i < gaps.length - 1; i++) {
    if (gaps[i].gap === lagX) {
      next.push(gaps[i + 1].gap);
    }
  }

  if (!next.length) {
    return {
      lag: lagX,
      count: 0,
      stats: null,
      buckets: null,
    };
  }

  const avg = next.reduce((a, b) => a + b, 0) / next.length;
  const med = median(next);
  const min = Math.min(...next);
  const max = Math.max(...next);

  const b = {
    '1-5': 0,
    '6-10': 0,
    '11-20': 0,
    '21+': 0,
  };
  for (const g of next) {
    if (g <= 5) b['1-5']++;
    else if (g <= 10) b['6-10']++;
    else if (g <= 20) b['11-20']++;
    else b['21+']++;
  }

  const buckets = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round((v / next.length) * 100)]));

  return {
    lag: lagX,
    count: next.length,
    stats: { avg, med, min, max },
    buckets,
  };
}

export function detectClusters(gaps, clusterMaxGap = 18) {
  // Cluster definition:
  // 1) A cluster can only START at a place where gap==1 (triple in consecutive draws)
  // 2) It then continues forward while subsequent gaps <= clusterMaxGap
  // 3) Ends at first gap > clusterMaxGap

  const clusters = [];
  let i = 0;
  while (i < gaps.length) {
    if (gaps[i].gap !== 1) {
      i++;
      continue;
    }
    // Start cluster at gaps[i]: between events[i] and events[i+1]
    const startGapIndex = i;
    let endGapIndex = i;
    while (endGapIndex + 1 < gaps.length && gaps[endGapIndex + 1].gap <= clusterMaxGap) {
      endGapIndex++;
    }
    const startEvent = gaps[startGapIndex].from;
    const endEvent = gaps[endGapIndex].to;

    // Cluster includes events from startEvent through endEvent
    const gapsIn = gaps.slice(startGapIndex, endGapIndex + 1).map(g => g.gap);
    const tripleCount = gapsIn.length + 1;
    const drawSpan = endEvent.idx - startEvent.idx;

    clusters.push({
      startEvent,
      endEvent,
      startGapIndex,
      endGapIndex,
      tripleCount,
      drawSpan,
      gaps: gapsIn,
    });

    i = endGapIndex + 1;
  }
  return clusters;
}

export function currentClusterStatus(events, gaps, clusters) {
  // Determine if the latest triple is inside an active cluster.
  // Active means: the last triple is within a cluster and the cluster has not ended before the last triple.
  if (!events.length) return { active: false };
  const last = events[events.length - 1];

  // Find a cluster whose endEvent is >= last (must include last). But clusters are fully determined by file; if last is inside a cluster, it will be endEvent.
  const c = clusters.find(cl => cl.endEvent.idx === last.idx);
  if (!c) return { active: false };

  return {
    active: true,
    tripleCount: c.tripleCount,
    drawSpan: c.drawSpan,
    gaps: c.gaps,
    startDraw: c.startEvent.draw,
    endDraw: c.endEvent.draw,
  };
}

export function summarizeAfterClusters(gaps, clusters) {
  // For each cluster, compute the gap AFTER cluster ends (next gap after endGapIndex)
  const after = [];
  for (const cl of clusters) {
    const nextGap = gaps[cl.endGapIndex + 1];
    if (nextGap) after.push(nextGap.gap);
  }

  if (!after.length) {
    return { count: 0, stats: null, buckets: null };
  }

  const avg = after.reduce((a, b) => a + b, 0) / after.length;
  const med = median(after);
  const min = Math.min(...after);
  const max = Math.max(...after);

  const b = { '1-5': 0, '6-10': 0, '11-20': 0, '21+': 0 };
  for (const g of after) {
    if (g <= 5) b['1-5']++;
    else if (g <= 10) b['6-10']++;
    else if (g <= 20) b['11-20']++;
    else b['21+']++;
  }
  const buckets = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round((v / after.length) * 100)]));

  return { count: after.length, stats: { avg, med, min, max }, buckets };
}

export function baselineEvery(rowsOldToNew, events) {
  if (!rowsOldToNew.length) return null;
  if (!events.length) return null;
  return rowsOldToNew.length / events.length;
}

export function classifyRate(windowEvery, baseline) {
  if (windowEvery === null || baseline === null) return 'לא זמין';
  const ratio = windowEvery / baseline;
  if (ratio <= 0.9) return 'מהיר מהבסיס';
  if (ratio >= 1.1) return 'איטי מהבסיס';
  return 'תואם בסיס';
}
