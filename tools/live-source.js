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

// Rules that narrow one of Stremio's lists into a list of our own, e.g.
// "popular series from the last two years" or "top rated South Korean movies".
const FILTERS = {
  sinceYears: [0, 1, 2, 3, 5, 10],          // 0 = any year; 2 = this year and last year
  minRating: [0, 6, 6.5, 7, 7.5, 8],        // IMDb rating; unrated titles are dropped when above 0
  countries: ['South Korea', 'Japan', 'India', 'China', 'Hong Kong', 'Thailand', 'United Kingdom', 'United States',
    'France', 'Spain', 'Germany', 'Italy', 'Denmark', 'Sweden', 'Norway', 'Turkey', 'Mexico', 'Brazil', 'Australia', 'Canada'],
  sort: { source: 'In list order', rating: 'Best rated first' }
};
// How far down a list to look for titles that pass the rules: 20 pages is about
// 1,000 titles. Movie pages are slow (about 2 seconds each), so this is also a time limit.
const MAX_SCAN_PAGES = 20;
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
  const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
  const country = pick(def.country, FILTERS.countries, '');
  return {
    source: 'cinemeta', list: def.list, type: def.type, genre, limit,
    sinceYears: pick(Number(def.sinceYears), FILTERS.sinceYears, 0),
    minRating: pick(Number(def.minRating), FILTERS.minRating, 0),
    country,
    countryOnly: Boolean(country && def.countryOnly),   // true = made in that country alone, no co-productions
    sort: pick(def.sort, Object.keys(FILTERS.sort), 'source')
  };
}
const hasRules = d => Boolean(d.sinceYears || d.minRating || d.country || d.sort === 'rating');
const signature = def => JSON.stringify(normalise(def));

// "Popular thriller movies", "New series this year", "MDBList someone/some-list (series)"
function describe(def) {
  const d = normalise(def);
  const kind = d.type === 'movie' ? 'movies' : 'series';
  if (d.source === 'mdblist') return `MDBList ${d.user}/${d.slug} (${kind})`;
  const base = [LISTS[d.list].replace(' this year', ''), d.genre.toLowerCase(), kind, d.list === 'year' ? 'this year' : ''].filter(Boolean).join(' ');
  const rules = [
    d.sinceYears === 1 ? 'this year only' : d.sinceYears ? `last ${d.sinceYears} years` : '',
    d.minRating ? `rated ${d.minRating}+` : '',
    d.country ? d.country + (d.countryOnly ? ' only' : ' incl. co-productions') : '',
    d.sort === 'rating' ? 'best rated first' : ''
  ].filter(Boolean);
  return [base, ...rules].join(', ');
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
  // The rules of this row. A series counts by the year it started.
  const firstYear = new Date().getFullYear() - d.sinceYears + 1;
  const passes = m => {
    if (d.sinceYears && !((parseInt(m.releaseInfo, 10) || Number(m.year) || 0) >= firstYear)) return false;
    if (d.minRating && !(parseFloat(m.imdbRating) >= d.minRating)) return false;
    if (d.country) {
      const made = String(m.country || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!made.includes(d.country) || (d.countryOnly && made.length !== 1)) return false;
    }
    return true;
  };
  const byRating = d.sort === 'rating';
  const maxPages = hasRules(d) ? MAX_SCAN_PAGES : Math.ceil(d.limit / 50) + 2;
  const metas = [];
  const seen = new Set();
  // Sorting by rating needs the whole pool first; otherwise stop as soon as the row is full.
  for (let page = 0; page < maxPages && (byRating || metas.length < d.limit); page++) {
    const extra = [filter, page ? `skip=${page * 50}` : ''].filter(Boolean).join('&');
    const items = (await getJson(`${CINEMETA}/catalog/${d.type}/${d.list}${extra ? '/' + extra : ''}.json`)).metas || [];
    if (!items.length) break;
    for (const m of items) {
      if (!/^tt\d+$/.test(m.id || '') || !m.name || !m.poster || seen.has(m.id) || !passes(m)) continue;
      seen.add(m.id);
      metas.push(preview(m, d.type));
      if (!byRating && metas.length >= d.limit) break;
    }
  }
  if (byRating) metas.sort((a, b) => (parseFloat(b.imdbRating) || 0) - (parseFloat(a.imdbRating) || 0));
  return metas.slice(0, d.limit);
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

module.exports = { SOURCES, LISTS, LIMITS, FILTERS, normalise, signature, describe, fetchList, genreOptions };
