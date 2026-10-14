// Runs inside the GitHub repository on a schedule (see the workflow next to it)
// to keep live rows current while the PC is off. Published as
// tools/refresh-live-rows.js; edit the copy in the project (src/hosted/), not
// the one in the repository, which is overwritten on every publish.
//
// Reads live-rows.json, fetches each row from its source, and rewrites
// catalog/<type>/<row>.json and live-status.json only where something changed.
const fs = require('fs');
const path = require('path');
const { fetchList, signature, titleLine, plainName, rowFiles, normalise, indexFilter } = require('./live-source');

const root = path.join(__dirname, '..');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };

(async () => {
  const settings = readJson(path.join(root, 'live-rows.json'), {});
  const { rows = [] } = settings;
  // Rating and year in front of each name, exactly as the PC writes them for the hand-picked rows.
  const named = m => ({ ...m, name: settings.titleLine !== false ? titleLine(m) : plainName(m.name) });
  const shown = list => JSON.stringify(list.map(m => [m.id, m.name]));
  const statusFile = path.join(root, 'live-status.json');
  const status = readJson(statusFile, {});
  let changed = 0, failed = 0;
  const shownIn = {};   // row id -> the titles it shows after this run

  // For the "not already in my rows" rule: every title in a row that is not live.
  // Rows are published under their type (movie, series) or, with a Discover entry of our own, under its name.
  // row.folder: the row's own Discover entry ("Collections · Movie Picks"); older lists gave one name for all.
  const folderOf = row => row.folder || settings.catalogType || row.live.type;
  const liveFiles = new Set(rows.map(r => path.join('catalog', folderOf(r), `${r.id}.json`)));
  const handPicked = [];
  // With Discover entries of our own, every folder but movie and series counts: those two then
  // hold copies kept for devices that have not reinstalled the addon yet.
  const allFolders = fs.existsSync(path.join(root, 'catalog')) ? fs.readdirSync(path.join(root, 'catalog')) : [];
  const folders = settings.catalogType ? allFolders.filter(t => !['movie', 'series'].includes(t)) : allFolders;
  for (const type of folders.filter(t => fs.existsSync(path.join(root, 'catalog', t)))) {
    for (const f of fs.readdirSync(path.join(root, 'catalog', type))) {
      if (liveFiles.has(path.join('catalog', type, f))) continue;
      for (const m of readJson(path.join(root, 'catalog', type, f), { metas: [] }).metas || []) handPicked.push(m.id);
    }
  }

  for (const row of rows) {
    const sig = signature(row.live);
    // row.dir: rows of the second addon ("My Collections: Explore") are published under explore/.
    const folder = path.join(root, row.dir || '', 'catalog', folderOf(row));
    const file = path.join(folder, `${row.id}.json`);
    const before = readJson(file, { metas: [] }).metas || [];
    try {
      // Pinned picks (hand-picked on the PC) stay on top; the rules fill in below without repeating them.
      // Under a Discover entry of our own, a row holds every type; otherwise only the row's own type lives in this file.
      const pinned = (row.pinned || []).filter(m => settings.catalogType || m.type === row.live.type);
      const pinIds = new Set(pinned.map(m => m.id));
      const found = await fetchList(row.live, before, handPicked);
      const matched = typeof found.matched === 'number' ? found.matched : null;   // how many titles met the rules, where the source can tell
      const metas = [...pinned, ...found.filter(m => !pinIds.has(m.id))].map(named);
      shownIn[row.id] = new Set(metas.map(m => m.id));   // for re-evaluate below
      const same = shown(before) === shown(metas);   // the same titles, in the same order, with the same labels
      if (!same || !status[row.id] || status[row.id].sig !== sig || status[row.id].error) {
        // The row and, with the genre filter on, one file per genre: the same layout the PC writes.
        for (const [name, list] of Object.entries(rowFiles(row.id, metas, settings.genreFilter === true))) {
          fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
          fs.writeFileSync(path.join(folder, name), JSON.stringify({ metas: list }));
        }
        status[row.id] = { sig, updatedAt: new Date().toISOString(), error: null, matched };
        changed++;
      } else status[row.id].matched = matched;   // the titles shown are the same, but the count behind them may have moved
      console.log(`${row.name}: ${metas.length} titles, ${same ? 'unchanged' : 'updated'}`);
    } catch (e) {
      // Keep the last good list online; just record why this run failed.
      failed++;
      status[row.id] = { ...(status[row.id] || { sig, updatedAt: null }), error: e.message };
      console.log(`${row.name}: FAILED (${e.message}); keeping the last good list`);
    }
  }

  // Re-evaluate on schedule (every 2 weeks or month, set in the manager), so it works with the PC off:
  // for each hand-picked or pinned title, the rule-based rows whose own rules it meets and that do not
  // show it yet. Written to reevaluate-suggestions.json for the manager to offer; nothing is added here.
  // The job cannot see the library, so the manager drops watched titles when it shows them.
  const re = settings.reevaluate;
  const EVERY = { '14d': 14, '30d': 30 };
  if (re && EVERY[re.every]) {
    const sugFile = path.join(root, 'reevaluate-suggestions.json');
    const prev = readJson(sugFile, null);
    const last = [prev && prev.at, re.lastRun].filter(Boolean).sort().pop();
    if (!last || Date.now() - Date.parse(last) >= EVERY[re.every] * 864e5) {
      const titleIndex = require('./title-index');
      await titleIndex.ensureIndex();
      const index = new Map(titleIndex.loadIndex().map(t => [t.id, t]));
      const tests = [];
      for (const row of rows) { const d = normalise(row.live); if (d.source === 'index') tests.push({ row, fits: await indexFilter(d) }); }
      const items = (re.titles || []).map(t => {
        const ti = index.get(t.id);
        const fit = ti ? tests.filter(x => !(t.in || []).includes(x.row.id) && !(shownIn[x.row.id] || new Set()).has(t.id) && x.fits(ti)) : [];
        return { id: t.id, type: t.type, name: t.name, rows: fit.map(x => ({ row: x.row.id, rowName: x.row.name })) };
      }).filter(x => x.rows.length);
      fs.writeFileSync(sugFile, JSON.stringify({ at: new Date().toISOString(), by: 'GitHub', titles: (re.titles || []).length, placements: items.reduce((k, x) => k + x.rows.length, 0), items }));
      console.log(`Re-evaluate: ${(re.titles || []).length} titles checked, ${items.length} with rows to suggest`);
    }
  }

  // Drop status for rows that no longer exist.
  for (const id of Object.keys(status)) if (!rows.some(r => r.id === id)) delete status[id];
  fs.writeFileSync(statusFile, JSON.stringify(status));
  console.log(`${rows.length} live row(s): ${changed} updated, ${failed} failed`);
  if (rows.length && failed === rows.length) process.exit(1);   // every row failed: make the run show as failed
})();
