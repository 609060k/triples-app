import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  REQUIRED_COLS,
  detectChronology,
  maxDrawNumber,
  computeTriples,
  gapsBetweenTriples,
  rateInWindow,
  summarizeNextGapsForExactLag,
  detectClusters,
  currentClusterStatus,
  summarizeAfterClusters,
  baselineEvery,
  classifyRate,
} from './logic';
import { exportToXlsx } from './exportXlsx';

function fmtEvery(e) {
  if (e === null) return 'אין שלשות בחלון';
  return `1 ל־${e.toFixed(2)}`;
}

function fmtNum(n) {
  if (n === null || n === undefined) return 'לא זמין';
  return String(n);
}

function heDate(d) {
  if (d === null || d === undefined) return '';
  return String(d);
}

function bucketLine(b) {
  if (!b) return '—';
  return `1–5: ${b['1-5']}%  |  6–10: ${b['6-10']}%  |  11–20: ${b['11-20']}%  |  21+: ${b['21+']}%`;
}

export default function App() {
  const [fileName, setFileName] = useState('');
  const [rawRows, setRawRows] = useState([]);
  const [fileMeta, setFileMeta] = useState({ wasReversed: false, method: '', maxDraw: null });
  const [error, setError] = useState('');

  // Manual input overlay
  const [manualEntries, setManualEntries] = useState([]); // { drawNum:number, hasTriple:boolean, createdAt:number }
  const [showManual, setShowManual] = useState(false);
  const [mDraw, setMDraw] = useState('');
  const [mHasTriple, setMHasTriple] = useState(null); // true/false

  // Historical list modal
  const [showHist, setShowHist] = useState(false);

  async function onFile(e) {
    setError('');
    const f = e.target.files?.[0];
    if (!f) return;

    try {
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws, { defval: '' });

      if (!json.length) throw new Error('הקובץ ריק');
      for (const col of REQUIRED_COLS) {
        if (!(col in json[0])) throw new Error(`חסרה עמודה חובה: ${col}`);
      }

      // Detect chronology (old->new) for analytics
      const chrono = detectChronology(json);
      const maxDraw = maxDrawNumber(json);

      // Reset manual entries ONLY if file progressed (max draw increased)
      setManualEntries(prev => {
        const prevMax = fileMeta.maxDraw;
        if (prevMax !== null && maxDraw !== null && maxDraw > prevMax) {
          return [];
        }
        return prev;
      });

      setFileName(f.name);
      setRawRows(chrono.rowsOldToNew);
      setFileMeta({ wasReversed: chrono.wasReversed, method: chrono.method, maxDraw });

      // Close modals
      setShowManual(false);
      setShowHist(false);

      // Clear manual form fields
      setMDraw('');
      setMHasTriple(null);
    } catch (err) {
      setError(err?.message || 'שגיאה בקריאת הקובץ');
      setFileName('');
      setRawRows([]);
      setFileMeta({ wasReversed: false, method: '', maxDraw: null });
    }
  }

  const fileOnly = useMemo(() => {
    if (!rawRows.length) return null;

    const events = computeTriples(rawRows);
    const gaps = gapsBetweenTriples(events);
    const baseEvery = baselineEvery(rawRows, events);

    const w100 = rateInWindow(rawRows, events, 100);
    const w200 = rateInWindow(rawRows, events, 200);
    const w400 = rateInWindow(rawRows, events, 400);
    const w800 = rateInWindow(rawRows, events, 800);
    const w20000 = rateInWindow(rawRows, events, 20000);

    const lastTriple = events.length ? events[events.length - 1] : null;
    const lastIdx = rawRows.length - 1;
    const currentLag = lastTriple ? (lastIdx - lastTriple.idx) : rawRows.length;

    const maxGap = gaps.length ? Math.max(...gaps.map(g => g.gap)) : null;
    const over100 = gaps.filter(g => g.gap > 100);

    const clusters = detectClusters(gaps, 18);
    const clusterNow = currentClusterStatus(events, gaps, clusters);
    const afterClusters = summarizeAfterClusters(gaps, clusters);

    // 30 last triples (file-only, newest->oldest)
    const last30 = [...events].slice(-30).reverse();

    // Behavior for current lag (exact)
    const behaviorLag = summarizeNextGapsForExactLag(gaps, currentLag);

    return {
      events,
      gaps,
      baseEvery,
      windows: { w100, w200, w400, w800, w20000 },
      classify: {
        w200: classifyRate(w200.every, baseEvery),
        w400: classifyRate(w400.every, baseEvery),
      },
      lastTriple,
      currentLag,
      maxGap,
      over100,
      clusters,
      clusterNow,
      afterClusters,
      last30,
    };
  }, [rawRows]);

  const currentView = useMemo(() => {
    if (!fileOnly) return null;

    // Apply manual entries as an overlay for *current state only*
    // We simulate additional draws appended to end of file.
    const manualSorted = [...manualEntries].sort((a, b) => a.drawNum - b.drawNum);
    const virtualDraws = manualSorted.length;

    // Determine simulated last triple index and simulated triple count in each window
    // Represent manual triple as event at virtual index positions.
    let simLastTripleIdx = fileOnly.lastTriple ? fileOnly.lastTriple.idx : -1;
    let simLastTripleLabel = fileOnly.lastTriple;

    // Build list of virtual events indices relative to full timeline (file rows count + k)
    const baseN = rawRows.length;
    const virtualEvents = [];
    for (let k = 0; k < manualSorted.length; k++) {
      if (manualSorted[k].hasTriple) {
        virtualEvents.push(baseN + k);
        simLastTripleIdx = baseN + k;
        simLastTripleLabel = {
          draw: String(manualSorted[k].drawNum),
          date: 'ידני',
          value: '—',
          size: 3,
          missingCols: [],
        };
      }
    }

    const simN = baseN + virtualDraws;
    const simLag = simLastTripleIdx >= 0 ? (simN - 1 - simLastTripleIdx) : simN;

    // Rates: count file triples inside window + manual triple events that fall into window
    function simRate(windowSize, fileWindow) {
      const start = Math.max(0, simN - windowSize);
      const fileTriplesIn = fileWindow.triples; // already counted in last window in file timeline
      // But fileWindow.triples counts last window in *file only*. If we append virtual draws, the window shifts.
      // So we recompute triple count for file events within shifted window.
      // Efficient: iterate events and count idx>=start && idx<baseN.
      let cFile = 0;
      for (const ev of fileOnly.events) {
        if (ev.idx >= start && ev.idx < baseN) cFile++;
      }
      let cVirtual = 0;
      for (const vi of virtualEvents) {
        if (vi >= start && vi < simN) cVirtual++;
      }
      const c = cFile + cVirtual;
      const draws = simN - start;
      return { draws, triples: c, every: c === 0 ? null : draws / c };
    }

    const w100 = simRate(100, fileOnly.windows.w100);
    const w200 = simRate(200, fileOnly.windows.w200);
    const w400 = simRate(400, fileOnly.windows.w400);

    const baseEvery = fileOnly.baseEvery; // baseline stays file-only

    return {
      simLag,
      w100,
      w200,
      w400,
      baseEvery,
      classify200: classifyRate(w200.every, baseEvery),
      classify400: classifyRate(w400.every, baseEvery),
      manualCount: manualSorted.length,
      manualNoCount: manualSorted.filter(x => !x.hasTriple).length,
      manualYesCount: manualSorted.filter(x => x.hasTriple).length,
      simLastTripleLabel,
    };
  }, [fileOnly, manualEntries, rawRows.length]);

  function addManualEntry() {
    const dn = Number(String(mDraw).trim());
    if (!Number.isFinite(dn)) return;
    if (mHasTriple !== true && mHasTriple !== false) return;

    setManualEntries(prev => {
      // Replace same drawNum if exists (idempotent)
      const next = prev.filter(x => x.drawNum !== dn);
      next.push({ drawNum: dn, hasTriple: mHasTriple, createdAt: Date.now() });
      return next;
    });

    setMDraw('');
    setMHasTriple(null);
  }

  function resetManual() {
    setManualEntries([]);
    setMDraw('');
    setMHasTriple(null);
  }

  function doExport() {
    if (!fileOnly) return;

    const summary = {
      'קובץ': fileName,
      'מספר שורות (הגרלות)': rawRows.length,
      'הגרלה מקסימלית (עמודה B)': fmtNum(fileMeta.maxDraw),
      'סה״כ שלשות/רביעיות בקובץ': fileOnly.events.length,
      'שלשה אחרונה – מספר הגרלה (קובץ)': fileOnly.lastTriple?.draw ?? 'לא נמצאה',
      'שלשה אחרונה – תאריך (קובץ)': fileOnly.lastTriple?.date ?? '—',
      'איחור נוכחי (קובץ)': fmtNum(fileOnly.currentLag),
      'איחור מקסימלי (שלשה→שלשה)': fmtNum(fileOnly.maxGap),
      'מס׳ אירועי איחור >100': fileOnly.over100.length,
      'קצב כללי (קובץ)': fileOnly.baseEvery ? fmtEvery(fileOnly.baseEvery) : 'לא זמין',
      'קצב חלון 100 (קובץ)': `${fileOnly.windows.w100.triples} | ${fmtEvery(fileOnly.windows.w100.every)}`,
      'קצב חלון 200 (קובץ)': `${fileOnly.windows.w200.triples} | ${fmtEvery(fileOnly.windows.w200.every)}`,
      'קצב חלון 400 (קובץ)': `${fileOnly.windows.w400.triples} | ${fmtEvery(fileOnly.windows.w400.every)}`,
      'קצב חלון 800 (קובץ)': `${fileOnly.windows.w800.triples} | ${fmtEvery(fileOnly.windows.w800.every)}`,
      'קצב חלון 20000 (קובץ)': `${fileOnly.windows.w20000.triples} | ${fmtEvery(fileOnly.windows.w20000.every)}`,
      'קלט ידני פעיל': manualEntries.length ? `כן (${manualEntries.length})` : 'לא',
      'הערה': 'הקלט הידני אינו נכלל בנתונים ההיסטוריים או בייצוא (למעט דגל ב״סיכום״).',
    };

    const triplesAll = fileOnly.events.map((t) => ({
      אינדקס_רציף: t.idx,
      הגרלה: t.draw,
      תאריך: t.date,
      ערך_שלשה: t.value,
      גודל: t.size === 4 ? 'רביעייה' : 'שלשה',
      טורים_זהים: t.matchCols.join(', '),
      טורים_חסרים: t.missingCols.join(', '),
      תלתן: t.suits['תלתן'],
      יהלום: t.suits['יהלום'],
      לב: t.suits['לב'],
      עלה: t.suits['עלה'],
    }));

    const triplesLast30 = fileOnly.last30.map((t, i) => ({
      סדר: i + 1,
      הגרלה: t.draw,
      תאריך: t.date,
      ערך_שלשה: t.value,
      גודל: t.size === 4 ? 'רביעייה' : 'שלשה',
      תלתן: t.suits['תלתן'],
      יהלום: t.suits['יהלום'],
      לב: t.suits['לב'],
      עלה: t.suits['עלה'],
    }));

    const gapsOver100 = fileOnly.over100.map((g) => ({
      אחור: g.gap,
      שלשה_קודמת_הגרלה: g.from.draw,
      שלשה_קודמת_תאריך: g.from.date,
      שלשה_קודמת_ערך: g.from.value,
      שלשה_הבאה_הגרלה: g.to.draw,
      שלשה_הבאה_תאריך: g.to.date,
      שלשה_הבאה_ערך: g.to.value,
    }));

    const behaviorLag = (() => {
      const b = fileOnly ? summarizeNextGapsForExactLag(fileOnly.gaps, fileOnly.currentLag) : null;
      if (!b || b.count === 0) {
        return {
          כותרת: `התנהגות היסטורית – איחור ${fileOnly.currentLag}`,
          נמצאו_מקרים: 0,
          הודעה: `לא נמצאו מקרים היסטוריים בקובץ עם איחור ${fileOnly.currentLag}`,
        };
      }
      return {
        כותרת: `התנהגות היסטורית – איחור ${fileOnly.currentLag}`,
        נמצאו_מקרים: b.count,
        ממוצע_עד_שלשה_באה: b.stats.avg,
        חציון_עד_שלשה_באה: b.stats.med,
        מינימום: b.stats.min,
        מקסימום: b.stats.max,
        התפלגות: bucketLine(b.buckets),
      };
    })();

    const behaviorCluster = (() => {
      const ac = fileOnly.afterClusters;
      if (!fileOnly.clusters.length) {
        return {
          כותרת: 'התנהגות היסטורית – אשכול',
          נמצאו_אשכולות: 0,
          הודעה: 'לא נמצאו אשכולות היסטוריים בקובץ לפי ההגדרה',
        };
      }
      if (ac.count === 0 || !ac.stats) {
        return {
          כותרת: 'התנהגות היסטורית – אשכול',
          נמצאו_אשכולות: fileOnly.clusters.length,
          הודעה: 'לא ניתן לחשב "אחרי אשכול" (אין נתונים לאחר סוף אשכול)',
        };
      }
      return {
        כותרת: 'התנהגות היסטורית – אשכול',
        נמצאו_אשכולות: fileOnly.clusters.length,
        ממוצע_עד_שלשה_באה: ac.stats.avg,
        חציון_עד_שלשה_באה: ac.stats.med,
        מינימום: ac.stats.min,
        מקסימום: ac.stats.max,
        התפלגות: bucketLine(ac.buckets),
      };
    })();

    exportToXlsx({ summary, triplesAll, triplesLast30, gapsOver100, behaviorLag, behaviorCluster });
  }

  const canExport = !!fileOnly;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.title}>אפליקציית שלשות</div>

        <div style={styles.controls}>
          <label style={styles.fileLabel}>
            טען קובץ
            <input type="file" accept=".csv,.xlsx,.xls" onChange={onFile} style={{ display: 'none' }} />
          </label>
          <button style={{ ...styles.btn, ...(canExport ? {} : styles.btnDisabled) }} onClick={doExport} disabled={!canExport}>
            ייצוא לאקסל
          </button>
        </div>
      </header>

      {error && (
        <div style={styles.errorBox}>
          <b>שגיאה:</b> {error}
        </div>
      )}

      {!fileOnly && (
        <div style={styles.empty}>
          העלה קובץ CSV/Excel עם העמודות: תאריך | הגרלה | תלתן | יהלום | לב | עלה
        </div>
      )}

      {fileOnly && currentView && (
        <>
          <div style={styles.metaRow}>
            <div><b>קובץ:</b> {fileName}</div>
            <div><b>הגרלה מקסימלית (עמודה B):</b> {fmtNum(fileMeta.maxDraw)}</div>
          </div>

          <div style={styles.grid}>
            {/* Top-right: Current status */}
            <Panel title="מצב נוכחי" right>
              <SectionTitle>שלשה אחרונה</SectionTitle>
              {fileOnly.lastTriple ? (
                <>
                  <Line label="שלשה אחרונה">הגרלה <b>{fileOnly.lastTriple.draw}</b> ({heDate(fileOnly.lastTriple.date)})</Line>
                  <Line label="ערך">{fileOnly.lastTriple.value}</Line>
                  <Line label="טור חסר">{fileOnly.lastTriple.missingCols.join(', ') || '—'}</Line>
                </>
              ) : (
                <Line>לא נמצאה שלשה בקובץ</Line>
              )}

              <SectionTitle>איחור</SectionTitle>
              <Line>חלפו <b>{currentView.simLag}</b> הגרלות מאז השלשה האחרונה</Line>

              <SectionTitle>קצב הופעה</SectionTitle>
              <Line label="חלון 100">{fmtEvery(currentView.w100.every)}</Line>
              <Line label="חלון 200">{fmtEvery(currentView.w200.every)} ({currentView.classify200})</Line>
              <Line label="חלון 400">{fmtEvery(currentView.w400.every)} ({currentView.classify400})</Line>

              <SectionTitle>קלט ידני</SectionTitle>
              {currentView.manualCount ? (
                <Line>קלט ידני פעיל: נוספו <b>{currentView.manualNoCount}</b> הגרלות ללא שלשה</Line>
              ) : (
                <Line>אין קלט ידני פעיל</Line>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button style={styles.btn} onClick={() => setShowManual(true)}>קלט ידני</button>
                {currentView.manualCount ? (
                  <button style={styles.btnSecondary} onClick={resetManual}>איפוס קלט ידני</button>
                ) : null}
              </div>
            </Panel>

            {/* Top-left: Historical behavior for exact lag */}
            <Panel title={`התנהגות היסטורית – איחור ${fileOnly.currentLag}`}>
              {(() => {
                const b = summarizeNextGapsForExactLag(fileOnly.gaps, fileOnly.currentLag);
                if (b.count === 0) {
                  return (
                    <>
                      <Line><b>לא נמצאו מקרים היסטוריים בקובץ עם איחור {fileOnly.currentLag}</b></Line>
                      <SmallMuted>אפס מקרים הוא מידע (מצב שלא תועד בקובץ).</SmallMuted>
                    </>
                  );
                }
                return (
                  <>
                    <Line>נמצאו <b>{b.count}</b> מקרים בקובץ עם איחור מדויק של <b>{fileOnly.currentLag}</b></Line>
                    <SectionTitle>מה קרה לאחר מכן</SectionTitle>
                    <Line label="ממוצע">{b.stats.avg.toFixed(2)}</Line>
                    <Line label="חציון">{b.stats.med}</Line>
                    <Line label="טווח">{b.stats.min}–{b.stats.max}</Line>
                    <SectionTitle>התפלגות</SectionTitle>
                    <Line>{bucketLine(b.buckets)}</Line>
                  </>
                );
              })()}
            </Panel>

            {/* Bottom-right: Cluster status */}
            <Panel title="סטטוס אשכול נוכחי" right>
              {fileOnly.clusterNow.active ? (
                <>
                  <Line><b>אשכול פעיל</b></Line>
                  <Line label="מספר שלשות ברצף">{fileOnly.clusterNow.tripleCount}</Line>
                  <Line label="אורך האשכול">{fileOnly.clusterNow.drawSpan} הגרלות</Line>
                  <Line label="מרווחים">{fileOnly.clusterNow.gaps.join(', ')}</Line>
                </>
              ) : (
                <>
                  <Line><b>אין אשכול פעיל</b></Line>
                  <SmallMuted>אשכול מתחיל רק כאשר מופיעה שלשה בהגרלה העוקבת (מרווח 1), ואז נמשך כל עוד המרווחים ≤ 18.</SmallMuted>
                </>
              )}
            </Panel>

            {/* Bottom-left: Historical behavior after clusters */}
            <Panel title="התנהגות היסטורית – אשכול">
              <Line>נמצאו <b>{fileOnly.clusters.length}</b> אשכולות היסטוריים בקובץ</Line>
              {fileOnly.clusters.length === 0 ? (
                <Line><b>לא נמצאו אשכולות היסטוריים בקובץ לפי ההגדרה</b></Line>
              ) : fileOnly.afterClusters.count === 0 ? (
                <Line>לא ניתן לחשב "אחרי אשכול" (אין נתונים לאחר סוף אשכול)</Line>
              ) : (
                <>
                  <SectionTitle>מה קרה לאחר סיום אשכול</SectionTitle>
                  <Line label="ממוצע">{fileOnly.afterClusters.stats.avg.toFixed(2)}</Line>
                  <Line label="חציון">{fileOnly.afterClusters.stats.med}</Line>
                  <Line label="טווח">{fileOnly.afterClusters.stats.min}–{fileOnly.afterClusters.stats.max}</Line>
                  <SectionTitle>התפלגות</SectionTitle>
                  <Line>{bucketLine(fileOnly.afterClusters.buckets)}</Line>
                </>
              )}

              <div style={{ marginTop: 10 }}>
                <button
                  style={{ ...styles.btn, ...(fileOnly.events.length ? {} : styles.btnDisabled) }}
                  disabled={!fileOnly.events.length}
                  onClick={() => setShowHist(true)}
                  title={fileOnly.events.length ? '' : 'לא נמצאו שלשות בקובץ'}
                >
                  שלשות היסטוריות
                </button>
              </div>
            </Panel>
          </div>
        </>
      )}

      {/* Manual input modal */}
      {showManual && (
        <Modal title="קלט ידני" onClose={() => setShowManual(false)}>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <label style={styles.label}>מספר הגרלה</label>
              <input style={styles.input} value={mDraw} onChange={(e) => setMDraw(e.target.value)} placeholder="למשל 52420" />
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <label style={styles.label}>האם הופיעה שלשה?</label>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label style={styles.radio}>
                  <input type="radio" name="hasTriple" checked={mHasTriple === true} onChange={() => setMHasTriple(true)} />
                  כן
                </label>
                <label style={styles.radio}>
                  <input type="radio" name="hasTriple" checked={mHasTriple === false} onChange={() => setMHasTriple(false)} />
                  לא
                </label>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                style={{ ...styles.btn, ...(!(Number.isFinite(Number(mDraw)) && (mHasTriple === true || mHasTriple === false)) ? styles.btnDisabled : {}) }}
                disabled={!(Number.isFinite(Number(mDraw)) && (mHasTriple === true || mHasTriple === false))}
                onClick={addManualEntry}
              >
                אישור
              </button>
              <button style={styles.btnSecondary} onClick={() => setShowManual(false)}>ביטול</button>
              {manualEntries.length ? (
                <button style={styles.btnSecondary} onClick={resetManual}>איפוס קלט ידני</button>
              ) : null}
            </div>

            <div style={styles.divider} />

            <div>
              <div style={styles.sectionTitle}>קלט ידני פעיל</div>
              {manualEntries.length === 0 ? (
                <SmallMuted>אין קלט ידני פעיל</SmallMuted>
              ) : (
                <ul style={{ margin: 0, paddingInlineStart: 18, display: 'grid', gap: 6 }}>
                  {[...manualEntries]
                    .sort((a, b) => a.drawNum - b.drawNum)
                    .map((x) => (
                      <li key={x.drawNum}>
                        הגרלה <b>{x.drawNum}</b> · שלשה: <b>{x.hasTriple ? 'כן' : 'לא'}</b>
                      </li>
                    ))}
                </ul>
              )}
              <SmallMuted style={{ marginTop: 8 }}>
                הערה: קלט ידני משפיע רק על מצב נוכחי. הוא לא נכנס לניתוח היסטורי ולא ל"שלשות היסטוריות".
              </SmallMuted>
            </div>
          </div>
        </Modal>
      )}

      {/* Historical triples list modal */}
      {showHist && fileOnly && (
        <Modal title="30 השלשות האחרונות" onClose={() => setShowHist(false)}>
          {fileOnly.last30.length === 0 ? (
            <Line><b>לא נמצאו שלשות בקובץ</b></Line>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={styles.histList}>
                {fileOnly.last30.map((t) => (
                  <div key={`${t.idx}-${t.draw}`} style={styles.histItem}>
                    <div style={styles.histTop}>
                      הגרלה <b>{t.draw}</b> · {heDate(t.date)}
                    </div>
                    <div>
                      ערך: <b>{t.value}</b> ({t.size === 4 ? 'רביעייה' : 'שלשה'})
                    </div>
                    <div style={styles.suitsLine}>
                      ♣ {t.suits['תלתן']} · ♦ {t.suits['יהלום']} · ♥ {t.suits['לב']} · ♠ {t.suits['עלה']}
                    </div>
                  </div>
                ))}
              </div>
              <button style={styles.btnSecondary} onClick={() => setShowHist(false)}>סגור</button>
            </div>
          )}
        </Modal>
      )}

      <footer style={styles.footer}>
        <div>עמודה B = מספר הגרלה · עמודות C–F = נתוני הקלפים (שלשה/רביעייה)</div>
      </footer>
    </div>
  );
}

function Panel({ title, children, right = false }) {
  return (
    <div style={{ ...styles.panel, ...(right ? styles.panelRight : {}) }}>
      <div style={styles.panelTitle}>{title}</div>
      <div style={{ display: 'grid', gap: 6 }}>{children}</div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div style={styles.sectionTitle}>{children}</div>;
}

function Line({ label, children }) {
  if (label) {
    return (
      <div style={styles.line}>
        <span style={styles.labelInline}>{label}:</span>
        <span>{children}</span>
      </div>
    );
  }
  return <div style={styles.line}>{children}</div>;
}

function SmallMuted({ children, style }) {
  return <div style={{ ...styles.muted, ...style }}>{children}</div>;
}

function Modal({ title, children, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div style={styles.modalBackdrop} onMouseDown={onClose}>
      <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <div style={styles.modalTitle}>{title}</div>
          <button style={styles.modalClose} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div style={{ padding: 14 }}>{children}</div>
      </div>
    </div>
  );
}

const styles = {
  page: {
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial',
    padding: 16,
    direction: 'rtl',
    maxWidth: 1200,
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  title: { fontSize: 20, fontWeight: 800 },
  controls: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
  fileLabel: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #ddd',
    cursor: 'pointer',
    fontWeight: 700,
  },
  btn: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #111',
    background: '#111',
    color: '#fff',
    cursor: 'pointer',
    fontWeight: 700,
  },
  btnSecondary: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #ddd',
    background: '#fff',
    color: '#111',
    cursor: 'pointer',
    fontWeight: 700,
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  errorBox: {
    border: '1px solid #c00',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    background: '#fff5f5',
  },
  empty: {
    padding: 18,
    border: '1px dashed #bbb',
    borderRadius: 12,
    marginTop: 14,
  },
  metaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 10,
    opacity: 0.85,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
  },
  panel: {
    border: '1px solid #ddd',
    borderRadius: 14,
    padding: 12,
    background: '#fff',
    minHeight: 220,
  },
  panelRight: {
    // no-op; placeholder for future RTL tweaks
  },
  panelTitle: { fontWeight: 900, marginBottom: 8, fontSize: 15 },
  sectionTitle: { marginTop: 8, fontWeight: 800, opacity: 0.9 },
  line: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' },
  labelInline: { opacity: 0.75, fontWeight: 700 },
  muted: { opacity: 0.75, fontSize: 13, marginTop: 6 },
  footer: { marginTop: 14, opacity: 0.7, fontSize: 12 },

  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.35)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
    zIndex: 50,
  },
  modal: {
    width: 'min(720px, 100%)',
    background: '#fff',
    borderRadius: 16,
    border: '1px solid #ddd',
    overflow: 'hidden',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 14px',
    borderBottom: '1px solid #eee',
  },
  modalTitle: { fontWeight: 900 },
  modalClose: {
    border: '1px solid #ddd',
    borderRadius: 10,
    background: '#fff',
    cursor: 'pointer',
    width: 34,
    height: 34,
    fontSize: 18,
    lineHeight: '18px',
  },
  label: { fontWeight: 800 },
  input: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #ddd',
    fontSize: 14,
  },
  radio: { display: 'flex', gap: 6, alignItems: 'center' },
  divider: { height: 1, background: '#eee', margin: '8px 0' },

  histList: { display: 'grid', gap: 10, maxHeight: '60vh', overflow: 'auto', padding: 2 },
  histItem: { border: '1px solid #eee', borderRadius: 12, padding: 12 },
  histTop: { fontWeight: 800, marginBottom: 4 },
  suitsLine: { opacity: 0.85, marginTop: 4 },
};
