// Where live rows get their titles. Uses Node built-ins and title-index.js
// only, never another project file: both files are also published to the
// GitHub repository, where a scheduled job uses them to refresh the rows while
// the PC is off. Keep it that way.
//
// Sources (see docs/sources.md):
//   index     Our own index of every movie and series (IMDb data files), with
//             country and language from Wikidata. No key.
//   cinemeta  Stremio's own lists: Popular, New this year, Top rated. No key.
//   mdblist   Any PUBLIC list on mdblist.com, read through its JSON export. No key.
const titleIndex = require('./title-index');

const CINEMETA = 'https://v3-cinemeta.strem.io';
const TYPES = ['movie', 'series'];
const LISTS = {
  top: 'Popular',
  year: 'New this year',
  imdbRating: 'Top rated'
};
const LIMITS = [25, 50, 100];
const SOURCES = { index: 'Our own index (every title)', cinemeta: "Stremio's own lists", mdblist: 'A public MDBList list' };

// Rules that narrow a source into a list of our own, e.g. "popular series from
// the last two years" or "top rated Korean-language thrillers".
const FILTERS = {
  sinceYears: [0, 1, 2, 3, 5, 10],          // 0 = any year; 2 = this year and last year
  minRating: [0, 6, 6.5, 7, 7.5, 8],        // IMDb rating; unrated titles are dropped when above 0
  maxRating: [0, 5, 6, 6.5, 7, 7.5, 8],     // 0 = no upper limit
  runtimeMin: [0, 60, 90, 120],             // minutes; titles with no known runtime are dropped when set
  runtimeMax: [0, 90, 120, 150, 180],       // 0 = no upper limit
  countries: Object.keys(titleIndex.COUNTRIES),
  sort: { source: 'In list order', rating: 'Best rated first', newest: 'Newest first', title: 'Title A–Z' },
  // Only for the index source:
  minVotes: [100, 1000, 5000, 25000, 100000],   // how well known a title must be
  languages: Object.keys(titleIndex.LANGUAGES),
  indexGenres: titleIndex.GENRES,
  indexSort: { votes: 'Most voted first', rating: 'Best rated first', newest: 'Newest first', title: 'Title A–Z' }
};
const MAX_GENRES = 6;
// How far down one of Stremio's lists to look for titles that pass the rules:
// 20 pages is about 1,000 titles. Movie pages are slow (about 2 seconds each).
const MAX_SCAN_PAGES = 20;

// Accepts "https://mdblist.com/lists/<user>/<list>" (with or without /json) or "<user>/<list>".
function parseMdblist(text) {
  const m = String(text || '').trim().match(/^(?:https?:\/\/(?:www\.)?mdblist\.com\/lists\/)?([A-Za-z0-9_-]{1,60})\/([A-Za-z0-9_-]{1,100})(?:\/json)?\/?$/i);
  if (!m) throw new Error('that is not an MDBList list address (expected mdblist.com/lists/<user>/<list>)');
  return { user: m[1], slug: m[2] };
}

const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

// The rules shared by the index and Stremio-list sources, in canonical form.
function rulesOf(def) {
  const year = value => { const n = Math.trunc(Number(value)); return n >= 1900 && n <= 2100 ? n : 0; };
  const genres = value => [...new Set((Array.isArray(value) ? value : []).map(g => String(g).replace(/[^\w &-]/g, '').slice(0, 30)).filter(Boolean))].slice(0, MAX_GENRES);
  const country = pick(def.country, FILTERS.countries, '');
  return {
    sinceYears: pick(Number(def.sinceYears), FILTERS.sinceYears, 0),
    yearFrom: year(def.yearFrom),                       // exact years; 0 = open-ended
    yearTo: year(def.yearTo),
    minRating: pick(Number(def.minRating), FILTERS.minRating, 0),
    maxRating: pick(Number(def.maxRating), FILTERS.maxRating, 0),
    includeGenres: genres(def.includeGenres),           // must have every one of these
    excludeGenres: genres(def.excludeGenres),           // must have none of these
    country,
    excludeCountries: (Array.isArray(def.excludeCountries) ? def.excludeCountries : []).filter(c => FILTERS.countries.includes(c) && c !== country),
    runtimeMin: pick(Number(def.runtimeMin), FILTERS.runtimeMin, 0),
    runtimeMax: pick(Number(def.runtimeMax), FILTERS.runtimeMax, 0),
    excludeMyRows: Boolean(def.excludeMyRows)           // leave out titles already in the hand-picked rows
  };
}

// Validates a definition and returns it in canonical form. Throws on anything unknown.
function normalise(def) {
  if (!def || !SOURCES[def.source]) throw new Error('unknown live source');
  if (!TYPES.includes(def.type)) throw new Error('unknown live type');
  const limit = pick(Number(def.limit), LIMITS, 50);
  if (def.source === 'mdblist') {
    const { user, slug } = def.url ? parseMdblist(def.url) : parseMdblist(`${def.user}/${def.slug}`);
    return { source: 'mdblist', user, slug, type: def.type, limit };
  }
  if (def.source === 'index') {
    return {
      source: 'index', type: def.type, limit, ...rulesOf(def),
      minVotes: pick(Number(def.minVotes), FILTERS.minVotes, 1000),
      language: pick(def.language, FILTERS.languages, ''),   // original language
      sort: pick(def.sort, Object.keys(FILTERS.indexSort), 'votes')
    };
  }
  if (!LISTS[def.list]) throw new Error('unknown live list');
  // "New this year" is filtered by year, so it cannot also take a genre.
  const genre = def.list === 'year' ? '' : String(def.genre || '').replace(/[^\w &-]/g, '').slice(0, 30);
  const rules = rulesOf(def);
  return {
    source: 'cinemeta', list: def.list, type: def.type, genre, limit, ...rules,
    countryOnly: Boolean(rules.country && def.countryOnly),   // true = made in that country alone, no co-productions
    sort: pick(def.sort, Object.keys(FILTERS.sort), 'source')
  };
}
const hasRules = d => Boolean(d.sinceYears || d.yearFrom || d.yearTo || d.minRating || d.maxRating || d.includeGenres.length ||
  d.excludeGenres.length || d.country || d.excludeCountries.length || d.runtimeMin || d.runtimeMax || d.excludeMyRows || d.sort !== 'source');

// Identifies a definition. Rules left at "off" are omitted, so adding a new
// kind of rule later does not change the signature of existing rows.
const signature = def => {
  const d = normalise(def);
  const on = Object.keys(d).sort().filter(k => !(d[k] === 0 || d[k] === '' || d[k] === false || (Array.isArray(d[k]) && !d[k].length) || (k === 'sort' && d[k] === 'source')));
  return JSON.stringify(Object.fromEntries(on.map(k => [k, d[k]])));
};

// The rules of a definition in words, e.g. ["last 2 years", "rated 7+"].
function ruleWords(d) {
  return [
    d.sinceYears === 1 ? 'this year only' : d.sinceYears ? `last ${d.sinceYears} years` : '',
    d.yearFrom && d.yearTo ? `${d.yearFrom}–${d.yearTo}` : d.yearFrom ? `from ${d.yearFrom}` : d.yearTo ? `up to ${d.yearTo}` : '',
    d.minRating && d.maxRating ? `rated ${d.minRating}–${d.maxRating}` : d.minRating ? `rated ${d.minRating}+` : d.maxRating ? `rated up to ${d.maxRating}` : '',
    d.includeGenres.length ? (d.source === 'index' ? '' : 'also ') + d.includeGenres.join(' + ').toLowerCase() : '',
    d.excludeGenres.length ? 'no ' + d.excludeGenres.join(', ').toLowerCase() : '',
    d.language ? `${d.language}-language` : '',
    d.country ? d.country + (d.source === 'index' ? '' : d.countryOnly ? ' only' : ' incl. co-productions') : '',
    d.excludeCountries.length ? 'not ' + d.excludeCountries.join(', ') : '',
    d.runtimeMin && d.runtimeMax ? `${d.runtimeMin}–${d.runtimeMax} min` : d.runtimeMin ? `${d.runtimeMin}+ min` : d.runtimeMax ? `up to ${d.runtimeMax} min` : '',
    d.excludeMyRows ? 'not already in my rows' : ''
  ].filter(Boolean);
}

// "Popular thriller movies", "Our index: series, last 2 years, most voted first", ...
function describe(def) {
  const d = normalise(def);
  const kind = d.type === 'movie' ? 'movies' : 'series';
  if (d.source === 'mdblist') return `MDBList ${d.user}/${d.slug} (${kind})`;
  if (d.source === 'index') return [`Our index: ${kind}`, ...ruleWords(d), `${d.minVotes.toLocaleString('en')}+ votes`, FILTERS.indexSort[d.sort].toLowerCase()].join(', ');
  const base = [LISTS[d.list].replace(' this year', ''), d.genre.toLowerCase(), kind, d.list === 'year' ? 'this year' : ''].filter(Boolean).join(' ');
  return [base, ...ruleWords(d), d.sort !== 'source' ? FILTERS.sort[d.sort].toLowerCase() : ''].filter(Boolean).join(', ');
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

// Posters and descriptions for a list of ids, from Cinemeta, five at a time.
// Titles already known from the previous refresh are reused, so a normal run
// looks up only the newcomers. basic(i) supplies what to show if Cinemeta has nothing.
async function enrich(ids, type, known, basic) {
  const metas = new Array(ids.length);
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map(async (id, j) => {
      if (known[id]) { metas[i + j] = known[id]; return; }
      try {
        const { meta } = await getJson(`${CINEMETA}/meta/${type}/${id}.json`);
        if (!meta || !meta.name) throw new Error('no metadata');
        metas[i + j] = preview({ ...meta, id }, type);
      } catch (e) {
        metas[i + j] = { id, type, posterShape: 'poster', poster: `https://images.metahub.space/poster/medium/${id}/img`, ...basic(i + j) };
      }
    }));
  }
  return metas;
}

// ---- source: our own index ----
async function fetchIndexList(d, known, exclude) {
  await titleIndex.ensureIndex();
  const inCountry = d.country ? await titleIndex.wikidataSet('country', d.country) : null;
  const inLanguage = d.language ? await titleIndex.wikidataSet('language', d.language) : null;
  const notCountries = await Promise.all(d.excludeCountries.map(c => titleIndex.wikidataSet('country', c)));
  const firstYear = new Date().getFullYear() - d.sinceYears + 1;
  const picked = titleIndex.loadIndex().filter(t =>
    t.type === d.type && t.votes >= d.minVotes &&
    (!d.sinceYears || t.year >= firstYear) && (!d.yearFrom || t.year >= d.yearFrom) && (!d.yearTo || t.year <= d.yearTo) &&
    (!d.minRating || t.rating >= d.minRating) && (!d.maxRating || t.rating <= d.maxRating) &&
    d.includeGenres.every(g => t.genres.includes(g)) && !d.excludeGenres.some(g => t.genres.includes(g)) &&
    (!d.runtimeMin || t.runtime >= d.runtimeMin) && (!d.runtimeMax || (t.runtime && t.runtime <= d.runtimeMax)) &&
    (!inCountry || inCountry.has(t.id)) && (!inLanguage || inLanguage.has(t.id)) && !notCountries.some(s => s.has(t.id)) &&
    !(d.excludeMyRows && exclude.has(t.id)));
  const order = {
    votes: (a, b) => b.votes - a.votes,
    rating: (a, b) => b.rating - a.rating || b.votes - a.votes,
    newest: (a, b) => b.year - a.year || b.votes - a.votes,
    title: (a, b) => a.name.localeCompare(b.name)
  }[d.sort];
  const top = picked.sort(order).slice(0, d.limit);
  const metas = await enrich(top.map(t => t.id), d.type, known, i => ({
    name: top[i].name, genres: top[i].genres,
    releaseInfo: d.type !== 'series' || top[i].endYear === top[i].year ? String(top[i].year) : `${top[i].year}–${top[i].endYear || ''}`
  }));
  // The index is refreshed daily, so its rating is the current one.
  return metas.map((m, i) => ({ ...m, imdbRating: String(top[i].rating) }));
}

// ---- source: Stremio's own lists ----
async function fetchCinemetaList(d, exclude) {
  const filter = d.list === 'year' ? `genre=${new Date().getFullYear()}` : d.genre ? `genre=${encodeURIComponent(d.genre)}` : '';
  // The rules of this row. A series counts by the year it started.
  const firstYear = new Date().getFullYear() - d.sinceYears + 1;
  const yearOf = m => parseInt(m.releaseInfo, 10) || Number(m.year) || 0;
  const passes = m => {
    const year = yearOf(m);
    if (d.sinceYears && !(year >= firstYear)) return false;
    if (d.yearFrom && !(year >= d.yearFrom)) return false;
    if (d.yearTo && !(year && year <= d.yearTo)) return false;
    const rating = parseFloat(m.imdbRating);
    if (d.minRating && !(rating >= d.minRating)) return false;
    if (d.maxRating && !(rating <= d.maxRating)) return false;
    const has = m.genres || m.genre || [];
    if (!d.includeGenres.every(g => has.includes(g)) || d.excludeGenres.some(g => has.includes(g))) return false;
    if (d.country || d.excludeCountries.length) {
      const made = String(m.country || '').split(',').map(s => s.trim()).filter(Boolean);
      if (d.country && (!made.includes(d.country) || (d.countryOnly && made.length !== 1))) return false;
      if (d.excludeCountries.some(c => made.includes(c))) return false;
    }
    const minutes = parseInt(m.runtime, 10);
    if (d.runtimeMin && !(minutes >= d.runtimeMin)) return false;
    if (d.runtimeMax && !(minutes <= d.runtimeMax)) return false;
    if (d.excludeMyRows && exclude.has(m.id)) return false;
    return true;
  };
  const reorder = d.sort !== 'source';   // any re-ordering needs the whole pool first
  const maxPages = hasRules(d) ? MAX_SCAN_PAGES : Math.ceil(d.limit / 50) + 2;
  const metas = [];
  const seen = new Set();
  for (let page = 0; page < maxPages && (reorder || metas.length < d.limit); page++) {
    const extra = [filter, page ? `skip=${page * 50}` : ''].filter(Boolean).join('&');
    const items = (await getJson(`${CINEMETA}/catalog/${d.type}/${d.list}${extra ? '/' + extra : ''}.json`)).metas || [];
    if (!items.length) break;
    for (const m of items) {
      if (!/^tt\d+$/.test(m.id || '') || !m.name || !m.poster || seen.has(m.id) || !passes(m)) continue;
      seen.add(m.id);
      metas.push(preview(m, d.type));
      if (!reorder && metas.length >= d.limit) break;
    }
  }
  if (d.sort === 'rating') metas.sort((a, b) => (parseFloat(b.imdbRating) || 0) - (parseFloat(a.imdbRating) || 0));
  if (d.sort === 'newest') metas.sort((a, b) => yearOf(b) - yearOf(a));
  if (d.sort === 'title') metas.sort((a, b) => a.name.localeCompare(b.name));
  return metas.slice(0, d.limit);
}

// ---- source: a public MDBList list ----
// MDBList's export gives ids, titles and years only; the rest is looked up.
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
  return enrich(picked.map(p => p.imdb_id), d.type, known, i => ({
    name: picked[i].title, releaseInfo: picked[i].release_year ? String(picked[i].release_year) : undefined
  }));
}

// Fetches the current titles for a definition, in the source's order.
// previous: the titles from the last refresh, reused where a source needs per-title lookups.
// excludeIds: ids of the titles in the hand-picked rows, for the "not already in my rows" rule.
async function fetchList(def, previous = [], excludeIds = []) {
  const d = normalise(def);
  const known = Object.fromEntries(previous.filter(m => m && m.id && m.poster && m.type === d.type).map(m => [m.id, m]));
  const exclude = new Set(excludeIds);
  const metas = d.source === 'mdblist' ? await fetchMdblist(d, known)
    : d.source === 'index' ? await fetchIndexList(d, known, exclude)
    : await fetchCinemetaList(d, exclude);
  if (!metas.length) throw new Error('source returned no titles');
  return metas;
}

// Genres offered per type by Stremio's lists, for the manager's form.
async function genreOptions() {
  const m = await getJson(`${CINEMETA}/manifest.json`);
  const genresFor = type => ((m.catalogs.find(c => c.type === type && c.id === 'top') || {}).extra || []).find(e => e.name === 'genre');
  return Object.fromEntries(TYPES.map(t => [t, (genresFor(t) || {}).options || []]));
}

module.exports = { SOURCES, LISTS, LIMITS, FILTERS, normalise, signature, describe, fetchList, genreOptions };
