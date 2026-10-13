// Runs inside the GitHub repository after the rows are refreshed (see the
// workflow). Published as tools/rate-posters.js; edit the copy in the project
// (src/hosted/), not the one in the repository.
//
// For every title in every row it makes a poster with the IMDb rating drawn in
// the corner, stored in posters/<imdb id>-<rating x10>.jpg, and points the
// title at it. A rating change gives a new file name, so no device shows a
// stale image. Posters no row uses any more are deleted. If a poster cannot be
// made, the title keeps its ordinary one.
//
// Needs ImageMagick ("convert"), which GitHub's Ubuntu runners have.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ratedPosterFile, plainPoster } = require('./live-source');

const root = path.join(__dirname, '..');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };

// https://<owner>.github.io/<repo>, or https://<owner>.github.io for a user site.
function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) throw new Error('cannot tell where this site is published (GITHUB_REPOSITORY is not set)');
  return `https://${owner.toLowerCase()}.github.io` + (repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? '' : `/${repo}`);
}

const W = 400, H = 600;                                    // poster size
const BADGE = { x: 12, y: H - 12 - 54, w: 124, h: 54 };    // bottom-left corner
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'].find(f => fs.existsSync(f));

// A five-pointed star as polygon points, so no font needs to have the glyph.
function star(cx, cy, outer, inner) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer, a = -Math.PI / 2 + i * Math.PI / 5;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return 'polygon ' + pts.join(' ');
}

async function makePoster(meta, outFile, tmpDir) {
  const res = await fetch(plainPoster(meta.id));
  if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) throw new Error(`no source poster (${res.status})`);
  const src = path.join(tmpDir, meta.id);
  fs.writeFileSync(src, Buffer.from(await res.arrayBuffer()));
  const rating = parseFloat(meta.imdbRating).toFixed(1);
  const cy = BADGE.y + BADGE.h / 2;
  execFileSync('convert', [
    src, '-resize', `${W}x${H}^`, '-gravity', 'center', '-extent', `${W}x${H}`,
    '-gravity', 'NorthWest',
    '-fill', 'rgba(0,0,0,0.78)', '-draw', `roundrectangle ${BADGE.x},${BADGE.y} ${BADGE.x + BADGE.w},${BADGE.y + BADGE.h} 14,14`,
    '-fill', '#F5C518', '-draw', star(BADGE.x + 26, cy, 14, 6),
    ...(FONT ? ['-font', FONT] : []), '-pointsize', '30', '-fill', 'white', '-draw', `text ${BADGE.x + 48},${cy + 11} '${rating}'`,
    '-strip', '-quality', '84', outFile
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
  fs.rmSync(src, { force: true });
}

(async () => {
  const wanted = readJson(path.join(root, 'live-rows.json'), {}).ratingPosters !== false;
  const site = siteUrl();
  const postersDir = path.join(root, 'posters');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posters-'));
  const files = [];
  const catalogDir = path.join(root, 'catalog');
  for (const type of fs.existsSync(catalogDir) ? fs.readdirSync(catalogDir) : []) {
    for (const f of fs.readdirSync(path.join(catalogDir, type))) files.push(path.join(catalogDir, type, f));
  }

  const used = new Set();
  const failed = new Set();
  let made = 0, pointed = 0, rewritten = 0;
  for (const file of files) {
    const doc = readJson(file, null);
    if (!doc || !Array.isArray(doc.metas)) continue;
    let changed = false;
    for (const meta of doc.metas) {
      const name = wanted ? ratedPosterFile(meta) : null;
      let poster = meta.poster;
      if (name) {
        const out = path.join(root, name);
        if (!fs.existsSync(out) && !failed.has(name)) {
          try { fs.mkdirSync(postersDir, { recursive: true }); await makePoster(meta, out, tmpDir); made++; }
          catch (e) { failed.add(name); fs.rmSync(out, { force: true }); if (failed.size <= 5) console.log(`could not make a poster for ${meta.name}: ${String(e.message).split('\n')[0]}`); }
        }
        if (fs.existsSync(out)) { poster = `${site}/${name}`; used.add(path.basename(name)); pointed++; }
      }
      // No rated poster for this title (switched off, unrated, or it failed): never leave it pointing at one of ours.
      if (!used.has(path.basename(String(poster || ''))) && /\/posters\/tt\d+-\d+\.jpg$/.test(poster || '')) poster = plainPoster(meta.id);
      if (poster !== meta.poster) { meta.poster = poster; changed = true; }
    }
    if (changed) { fs.writeFileSync(file, JSON.stringify(doc)); rewritten++; }
  }

  // Posters nothing points at any more (the title left every row, or its rating changed).
  let removed = 0;
  for (const f of fs.existsSync(postersDir) ? fs.readdirSync(postersDir) : []) {
    if (!used.has(f)) { fs.rmSync(path.join(postersDir, f)); removed++; }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`rating posters ${wanted ? 'on' : 'off'}: ${pointed} titles use one, ${made} made, ${removed} removed, ${failed.size} could not be made, ${rewritten} row files updated`);
})().catch(e => { console.error('rating posters failed:', e.message); process.exit(1); });
