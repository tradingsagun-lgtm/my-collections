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

  for (const row of rows) {
    const sig = signature(row.live);
    const file = path.join(root, 'catalog', row.live.type, `${row.id}.json`);
    const before = readJson(file, { metas: [] }).metas || [];
    try {
      const metas = await fetchList(row.live);
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
