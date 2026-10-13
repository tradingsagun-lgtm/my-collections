// Where live rows get their titles. Deliberately self-contained (no other
// project file, no dependency): this exact file is also published to the
// GitHub repository, where a scheduled job uses it to refresh the rows while
// the PC is off. Keep it that way.
//
// Sources (see docs/sources.md):
//   cinemeta  Stremio's own lists: Popular, New this year, Top rated. No key.
//   mdblist   Any PUBLIC list on mdblist.com, read through its JSON export. No key.
const CINEMETA = 'https://v3-cinemeta.strem.io';
const TYPES = ['movie', 'series'];
const LISTS = {
  top: 'Popular',
  year: 'New this year',
  imdbRating: 'Top rated'
};
const LIMITS = [25, 50, 100];
const SOURCES = { cinemeta: "Stremio's own lists", mdblist: 'A public MDBList list' };

// Accepts "https://mdblist.com/lists/<user>/<list>" (with or without /json) or "<user>/<list>".
function parseMdblist(text) {
  const m = String(text || '').trim().match(/^(?:https?:\/\/(?:www\.)?mdblist\.com\/lists\/)?([A-Za-z0-9_-]{1,60})\/([A-Za-z0-9_-]{1,100})(?:\/json)?\/?$/i);
  if (!m) throw new Error('that is not an MDBList list address (expected mdblist.com/lists/<user>/<list>)');
  return { user: m[1], slug: m[2] };
}

// Validates a definition and returns it in canonical form. Throws on anything unknown.
function normalise(def) {
  if (!def || !SOURCES[def.source]) throw new Error('unknown live source');
  if (!TYPES.includes(def.type)) throw new Error('unknown live type');
  const limit = LIMITS.includes(Number(def.limit)) ? Number(def.limit) : 50;
  if (def.source === 'mdblist') {
    const { user, slug } = def.url ? parseMdblist(def.url) : parseMdblist(`${def.user}/${def.slug}`);
    return { source: 'mdblist', user, slug, type: def.type, limit };
  }
  if (!LISTS[def.list]) throw new Error('unknown live list');
  // "New this year" is filtered by year, so it cannot also take a genre.
  const genre = def.list === 'year' ? '' : String(def.genre || '').replace(/[^\w &-]/g, '').slice(0, 30);
  return { source: 'cinemeta', list: def.list, type: def.type, genre, limit };
}
const signature = def => JSON.stringify(normalise(def));

// "Popular thriller movies", "New series this year", "MDBList someone/some-list (series)"
function describe(def) {
  const d = normalise(def);
  const kind = d.type === 'movie' ? 'movies' : 'series';
  if (d.source === 'mdblist') return `MDBList ${d.user}/${d.slug} (${kind})`;
  return [LISTS[d.list].replace(' this year', ''), d.genre.toLowerCase(), kind, d.list === 'year' ? 'this year' : ''].filter(Boolean).join(' ');
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`source answered ${res.status}`);
  return res.json();
}

// The fields Stremio shows for a title in a row.
const preview = (m, type) => ({
  id: m.id, type, name: m.name, poster: m.poster, posterShape: 'poster',
  releaseInfo: m.releaseInfo, imdbRating: m.imdbRating, genres: m.genres,
  director: m.director, description: m.description
});

async function fetchCinemetaList(d) {
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
      metas.push(preview(m, d.type));
      if (metas.length >= d.limit) break;
    }
  }
  return metas;
}

// MDBList's export gives ids, titles and years only, so each title's poster and
// rating are looked up on Cinemeta. Titles already known from the previous
// refresh are reused, so a normal run looks up only the newcomers.
async function fetchMdblist(d, known) {
  const list = await getJson(`https://mdblist.com/lists/${d.user}/${d.slug}/json`);
  if (!Array.isArray(list)) throw new Error((list && list.error) || 'MDBList gave an unexpected answer');
  const wanted = d.type === 'movie' ? 'movie' : 'show';
  const picked = [];
  const seen = new Set();
  for (const item of list) {
    if (item.mediatype !== wanted || !/^tt\d+$/.test(item.imdb_id || '') || seen.has(item.imdb_id)) continue;
    seen.add(item.imdb_id);
    picked.push(item);
    if (picked.length >= d.limit) break;
  }
  const metas = new Array(picked.length);
  for (let i = 0; i < picked.length; i += 5) {   // five lookups at a time
    await Promise.all(picked.slice(i, i + 5).map(async (item, j) => {
      const id = item.imdb_id;
      if (known[id]) { metas[i + j] = known[id]; return; }
      try {
        const { meta } = await getJson(`${CINEMETA}/meta/${d.type}/${id}.json`);
        if (!meta || !meta.name) throw new Error('no metadata');
        metas[i + j] = preview({ ...meta, id }, d.type);
      } catch (e) {
        // Not on Cinemeta: still list it, with what MDBList told us.
        metas[i + j] = { id, type: d.type, name: item.title, posterShape: 'poster',
          poster: `https://images.metahub.space/poster/medium/${id}/img`, releaseInfo: item.release_year ? String(item.release_year) : undefined };
      }
    }));
  }
  return metas;
}

// Fetches the current titles for a definition, in the source's order.
// previous: the titles from the last refresh, reused where a source needs per-title lookups.
async function fetchList(def, previous = []) {
  const d = normalise(def);
  const known = Object.fromEntries(previous.filter(m => m && m.id && m.poster && m.type === d.type).map(m => [m.id, m]));
  const metas = d.source === 'mdblist' ? await fetchMdblist(d, known) : await fetchCinemetaList(d);
  if (!metas.length) throw new Error('source returned no titles');
  return metas;
}

// Genres offered per type, for the manager's form.
async function genreOptions() {
  const m = await getJson(`${CINEMETA}/manifest.json`);
  const genresFor = type => ((m.catalogs.find(c => c.type === type && c.id === 'top') || {}).extra || []).find(e => e.name === 'genre');
  return Object.fromEntries(TYPES.map(t => [t, (genresFor(t) || {}).options || []]));
}

module.exports = { SOURCES, LISTS, LIMITS, normalise, signature, describe, fetchList, genreOptions };
