// Runs inside the GitHub repository on a schedule (see the workflow next to it)
// to keep live rows current while the PC is off. Published as
// tools/refresh-live-rows.js; edit the copy in the project (src/hosted/), not
// the one in the repository, which is overwritten on every publish.
//
// Reads live-rows.json, fetches each row from its source, and rewrites
// catalog/<type>/<row>.json and live-status.json only where something changed.
const fs = require('fs');
const path = require('path');
const { fetchList, signature } = require('./live-source');

const root = path.join(__dirname, '..');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };

(async () => {
  const { rows = [] } = readJson(path.join(root, 'live-rows.json'), {});
  const statusFile = path.join(root, 'live-status.json');
  const status = readJson(statusFile, {});
  let changed = 0, failed = 0;

  // For the "not already in my rows" rule: every title in a row that is not live.
  const liveFiles = new Set(rows.map(r => path.join('catalog', r.live.type, `${r.id}.json`)));
  const handPicked = [];
  for (const type of fs.existsSync(path.join(root, 'catalog')) ? fs.readdirSync(path.join(root, 'catalog')) : []) {
    for (const f of fs.readdirSync(path.join(root, 'catalog', type))) {
      if (liveFiles.has(path.join('catalog', type, f))) continue;
      for (const m of readJson(path.join(root, 'catalog', type, f), { metas: [] }).metas || []) handPicked.push(m.id);
    }
  }

  for (const row of rows) {
    const sig = signature(row.live);
    const file = path.join(root, 'catalog', row.live.type, `${row.id}.json`);
    const before = readJson(file, { metas: [] }).metas || [];
    try {
      // Pinned picks (hand-picked on the PC) stay on top; the rules fill in below without repeating them.
      const pinned = (row.pinned || []).filter(m => m.type === row.live.type);
      const pinIds = new Set(pinned.map(m => m.id));
      const metas = [...pinned, ...(await fetchList(row.live, before, handPicked)).filter(m => !pinIds.has(m.id))];
      const same = JSON.stringify(before.map(m => m.id)) === JSON.stringify(metas.map(m => m.id));
      if (!same || !status[row.id] || status[row.id].sig !== sig || status[row.id].error) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ metas }));
        status[row.id] = { sig, updatedAt: new Date().toISOString(), error: null };
        changed++;
      }
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
