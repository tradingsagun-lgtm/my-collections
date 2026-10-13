// Where live rows get their titles. Deliberately self-contained (no other
// project file, no dependency): this exact file is also published to the
// GitHub repository, where a scheduled job uses it to refresh the rows while
// the PC is off. Keep it that way.
//
// Sources so far: Cinemeta's lists (no key needed). See docs/sources.md.
const CINEMETA = 'https://v3-cinemeta.strem.io';
const TYPES = ['movie', 'series'];
const LISTS = {
  top: 'Popular',
  year: 'New this year',
  imdbRating: 'Top rated'
};
const LIMITS = [25, 50, 100];

// Validates a definition and returns it in canonical form. Throws on anything unknown.
function normalise(def) {
  if (!def || def.source !== 'cinemeta') throw new Error('unknown live source');
  if (!LISTS[def.list]) throw new Error('unknown live list');
  if (!TYPES.includes(def.type)) throw new Error('unknown live type');
  const limit = LIMITS.includes(Number(def.limit)) ? Number(def.limit) : 50;
  // "New this year" is filtered by year, so it cannot also take a genre.
  const genre = def.list === 'year' ? '' : String(def.genre || '').replace(/[^\w &-]/g, '').slice(0, 30);
  return { source: 'cinemeta', list: def.list, type: def.type, genre, limit };
}
const signature = def => JSON.stringify(normalise(def));

// "Popular thriller movies", "New series this year", ...
function describe(def) {
  const d = normalise(def);
  const kind = d.type === 'movie' ? 'movies' : 'series';
  return [LISTS[d.list].replace(' this year', ''), d.genre.toLowerCase(), kind, d.list === 'year' ? 'this year' : ''].filter(Boolean).join(' ');
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`source answered ${res.status}`);
  return res.json();
}

// Fetches the current titles for a definition, in the source's order.
async function fetchList(def) {
  const d = normalise(def);
  const filter = d.list === 'year' ? `genre=${new Date().getFullYear()}` : d.genre ? `genre=${encodeURIComponent(d.genre)}` : '';
  const metas = [];
  const seen = new Set();
  for (let skip = 0; metas.length < d.limit && skip < d.limit + 100; skip += 50) {
    const extra = [filter, skip ? `skip=${skip}` : ''].filter(Boolean).join('&');
    const page = (await getJson(`${CINEMETA}/catalog/${d.type}/${d.list}${extra ? '/' + extra : ''}.json`)).metas || [];
    if (!page.length) break;
    for (const m of page) {
      if (!/^tt\d+$/.test(m.id || '') || !m.name || !m.poster || seen.has(m.id)) continue;
      seen.add(m.id);
      metas.push({
        id: m.id, type: d.type, name: m.name, poster: m.poster, posterShape: 'poster',
        releaseInfo: m.releaseInfo, imdbRating: m.imdbRating, genres: m.genres,
        director: m.director, description: m.description
      });
      if (metas.length >= d.limit) break;
    }
  }
  if (!metas.length) throw new Error('source returned no titles');
  return metas;
}

// Genres offered per type, for the manager's form.
async function genreOptions() {
  const m = await getJson(`${CINEMETA}/manifest.json`);
  const genresFor = type => ((m.catalogs.find(c => c.type === type && c.id === 'top') || {}).extra || []).find(e => e.name === 'genre');
  return Object.fromEntries(TYPES.map(t => [t, (genresFor(t) || {}).options || []]));
}

module.exports = { LISTS, LIMITS, normalise, signature, describe, fetchList, genreOptions };
