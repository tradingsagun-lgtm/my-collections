// Runs inside the GitHub repository on a schedule (see the workflow next to it)
// to keep live rows current while the PC is off. Published as
// tools/refresh-live-rows.js; edit the copy in the project (src/hosted/), not
// the one in the repository, which is overwritten on every publish.
//
// Reads live-rows.json, fetches each row from its source, and rewrites
// catalog/<type>/<row>.json and live-status.json only where something changed.
const fs = require('fs');
const path = require('path');
const { fetchList, signature, titleLine, plainName, rowFiles } = require('./live-source');

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

  // For the "not already in my rows" rule: every title in a row that is not live.
  // Rows are published under their type (movie, series) or, with a Discover entry of our own, under its name.
  const folderOf = row => settings.catalogType || row.live.type;
  const liveFiles = new Set(rows.map(r => path.join('catalog', folderOf(r), `${r.id}.json`)));
  const handPicked = [];
  // With a Discover entry of our own, only its folder counts: the movie and series folders then
  // hold copies kept for devices that have not reinstalled the addon yet.
  const folders = settings.catalogType ? [settings.catalogType] : fs.existsSync(path.join(root, 'catalog')) ? fs.readdirSync(path.join(root, 'catalog')) : [];
  for (const type of folders.filter(t => fs.existsSync(path.join(root, 'catalog', t)))) {
    for (const f of fs.readdirSync(path.join(root, 'catalog', type))) {
      if (liveFiles.has(path.join('catalog', type, f))) continue;
      for (const m of readJson(path.join(root, 'catalog', type, f), { metas: [] }).metas || []) handPicked.push(m.id);
    }
  }

  for (const row of rows) {
    const sig = signature(row.live);
    const folder = path.join(root, 'catalog', folderOf(row));
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

  // Drop status for rows that no longer exist.
  for (const id of Object.keys(status)) if (!rows.some(r => r.id === id)) delete status[id];
  fs.writeFileSync(statusFile, JSON.stringify(status));
  console.log(`${rows.length} live row(s): ${changed} updated, ${failed} failed`);
  if (rows.length && failed === rows.length) process.exit(1);   // every row failed: make the run show as failed
})();
