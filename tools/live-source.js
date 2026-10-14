// Where live rows get their titles. Uses Node built-ins and title-index.js
// only, never another project file: both files are also published to the
// GitHub repository, where a scheduled job uses them to refresh the rows while
// the PC is off. Keep it that way.
//
// Sources (see docs/sources.md):
//   index     Our own index of every movie and series (IMDb data files), with
//             country and language from Wikidata. No key.
//   wikipedia Latest releases in one language, from Wikipedia's yearly film lists,
//             matched to our index. No key.
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
const LIMITS = [25, 50, 100, 200, 300];
const SOURCES = { index: 'Our own index (every title)', wikipedia: 'Latest releases by language', cinemeta: "Stremio's own lists", mdblist: 'A public MDBList list' };

// Rules that narrow a source into a list of our own, e.g. "popular series from
// the last two years" or "top rated Korean-language thrillers".
const FILTERS = {
  sinceYears: [0, 1, 2, 3, 5, 10, 15, 20, 30],   // 0 = any year; 2 = this year and last year
  minRating: [0, 6, 6.5, 7, 7.5, 8],        // IMDb rating; unrated titles are dropped when above 0
  maxRating: [0, 5, 6, 6.5, 7, 7.5, 8, 8.5, 9],   // 0 = no upper limit. 9 is useful with few votes: scores above it are rarely genuine
  runtimeMin: [0, 60, 90, 120],             // minutes; titles with no known runtime are dropped when set
  runtimeMax: [0, 90, 120, 150, 180],       // 0 = no upper limit
  countries: Object.keys(titleIndex.COUNTRIES),
  sort: { source: 'In list order', rating: 'Best rated first', newest: 'Newest first', title: 'Title A–Z' },
  // Only for the index source:
  minVotes: [100, 1000, 5000, 10000, 25000, 100000],   // how well known a title must be
  maxVotes: [0, 5000, 10000, 25000, 100000],            // 0 = no ceiling; a ceiling finds the well rated titles few have seen
  languages: Object.keys(titleIndex.LANGUAGES),
  platforms: Object.keys(titleIndex.PLATFORMS),       // made for or distributed by; not current availability
  indexGenres: titleIndex.GENRES,
  indexSort: { votes: 'Most voted first', rating: 'Best rated first', newest: 'Newest first', title: 'Title A–Z' },
  // Only for the latest-releases source:
  releaseLanguages: titleIndex.WIKIPEDIA_LANGUAGES
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
  if (def.source === 'wikipedia') {
    if (!FILTERS.releaseLanguages.includes(def.language)) throw new Error('choose a language for the latest-releases row');
    if (def.type !== 'movie') throw new Error('latest releases are available for movies only');
    return {
      source: 'wikipedia', type: 'movie', limit, language: def.language,
      minRating: pick(Number(def.minRating), FILTERS.minRating, 0),
      minVotes: pick(Number(def.minVotes), FILTERS.minVotes, 100),
      excludeMyRows: Boolean(def.excludeMyRows)
    };
  }
  if (def.source === 'index') {
    return {
      source: 'index', type: def.type, limit, ...rulesOf(def),
      minVotes: pick(Number(def.minVotes), FILTERS.minVotes, 1000),
      language: pick(def.language, FILTERS.languages, ''),   // original language
      // ...or any of these. With both given, a title in any of them counts.
      languages: [...new Set(Array.isArray(def.languages) ? def.languages : [])].filter(l => FILTERS.languages.includes(l) && l !== def.language),
      maxVotes: pick(Number(def.maxVotes), FILTERS.maxVotes, 0),
      platform: pick(def.platform, FILTERS.platforms, ''),   // made for or distributed by this platform
      // ...or by any of these. With both given, a title on any of them counts.
      platforms: [...new Set(Array.isArray(def.platforms) ? def.platforms : [])].filter(p => FILTERS.platforms.includes(p) && p !== def.platform),
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
    d.platform || (d.platforms || []).length ? `${[d.platform, ...(d.platforms || [])].filter(Boolean).join(', ')} originals and exclusives` : '',
    (d.languages || []).length > 3 ? `in any of ${d.languages.length + (d.language ? 1 : 0)} languages`
      : d.language || (d.languages || []).length ? `${[d.language, ...(d.languages || [])].filter(Boolean).join(' or ')}-language` : '',
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
  if (d.source === 'wikipedia') return [`Latest ${d.language} movies, newest release first`, d.minRating ? `rated ${d.minRating}+` : '',
    d.minVotes > 100 ? `${d.minVotes.toLocaleString('en')}+ votes` : '', d.excludeMyRows ? 'not already in my rows' : ''].filter(Boolean).join(', ');
  if (d.source === 'index') {
    const votes = d.maxVotes ? `${d.minVotes.toLocaleString('en')} to ${d.maxVotes.toLocaleString('en')} votes` : `${d.minVotes.toLocaleString('en')}+ votes`;
    return [`Our index: ${kind}`, ...ruleWords(d), votes, FILTERS.indexSort[d.sort].toLowerCase()].join(', ');
  }
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
  director: m.director, description: m.description,
  released: m.released   // the release date, where Stremio's metadata has one: the index only knows the year
});

// Posters, descriptions and release dates for a list of ids, from Cinemeta,
// eight at a time. A title is looked up once: first the row's own previous
// titles are reused, then a store shared by every row (many titles sit in
// several rows), and only then the network. basic(i) supplies what to show if
// Cinemeta has nothing. needDate: also look up titles whose stored copy has no
// release date, for rows ordered by it.
async function enrich(ids, type, known, basic, needDate = false) {
  const shared = titleIndex.readMetaStore();
  const usable = m => m && m.poster && (!needDate || m.released);
  const metas = new Array(ids.length);
  let fetched = 0;
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async (id, j) => {
      const have = usable(known[id]) ? known[id] : shared[`${type}:${id}`];
      if (usable(have)) { metas[i + j] = have; return; }
      try {
        const { meta } = await getJson(`${CINEMETA}/meta/${type}/${id}.json`);
        if (!meta || !meta.name) throw new Error('no metadata');
        metas[i + j] = shared[`${type}:${id}`] = preview({ ...meta, id }, type);
        fetched++;
      } catch (e) {
        metas[i + j] = known[id] || { id, type, posterShape: 'poster', poster: `https://images.metahub.space/poster/medium/${id}/img`, ...basic(i + j) };
      }
    }));
  }
  if (fetched) titleIndex.writeMetaStore(shared);
  return metas;
}

// ---- source: our own index ----
async function fetchIndexList(d, known, exclude) {
  await titleIndex.ensureIndex();
  const inCountry = d.country ? await titleIndex.wikidataSet('country', d.country) : null;
  let inLanguage = d.language ? await titleIndex.wikidataSet('language', d.language) : null;
  // Wikidata is slow to record the language of recent regional films; Wikipedia's
  // yearly lists know them. Where the row covers ten years or fewer, add those lists.
  if (inLanguage && titleIndex.WIKIPEDIA_LANGUAGES.includes(d.language) && d.type === 'movie') {
    const thisYear = new Date().getFullYear();
    const from = Math.max(d.yearFrom || 0, d.sinceYears ? thisYear - d.sinceYears + 1 : 0);
    const to = Math.min(d.yearTo || thisYear, thisYear);
    if (from && to - from < 10) {
      inLanguage = new Set(inLanguage);
      // If a list cannot be had at all, this throws and the row keeps its last good titles. Carrying
      // on with Wikidata alone would quietly publish a thinner list, and the PC and GitHub could disagree.
      for (let y = to; y >= from; y--) for (const film of await titleIndex.wikipediaFilms(d.language, y)) inLanguage.add(film.id);
    }
  }
  // Several languages: a title counts if it is in any of them.
  if (d.languages.length) {
    inLanguage = new Set(inLanguage || []);
    for (const l of d.languages) for (const id of await titleIndex.wikidataSet('language', l)) inLanguage.add(id);
  }
  // One platform or several: a title counts if it belongs to any of them.
  const wanted = [d.platform, ...d.platforms].filter(Boolean);
  let onPlatform = null;
  if (wanted.length) {
    onPlatform = new Set();
    for (const p of wanted) for (const id of await titleIndex.wikidataSet('platform', p)) onPlatform.add(id);
  }
  const notCountries = await Promise.all(d.excludeCountries.map(c => titleIndex.wikidataSet('country', c)));
  const firstYear = new Date().getFullYear() - d.sinceYears + 1;
  const picked = titleIndex.loadIndex().filter(t =>
    t.type === d.type && t.votes >= d.minVotes && (!d.maxVotes || t.votes < d.maxVotes) &&
    (!d.sinceYears || t.year >= firstYear) && (!d.yearFrom || t.year >= d.yearFrom) && (!d.yearTo || t.year <= d.yearTo) &&
    (!d.minRating || t.rating >= d.minRating) && (!d.maxRating || t.rating <= d.maxRating) &&
    d.includeGenres.every(g => t.genres.includes(g)) && !d.excludeGenres.some(g => t.genres.includes(g)) &&
    (!d.runtimeMin || t.runtime >= d.runtimeMin) && (!d.runtimeMax || (t.runtime && t.runtime <= d.runtimeMax)) &&
    (!inCountry || inCountry.has(t.id)) && (!inLanguage || inLanguage.has(t.id)) && (!onPlatform || onPlatform.has(t.id)) && !notCountries.some(s => s.has(t.id)) &&
    !(d.excludeMyRows && exclude.has(t.id)));
  const order = {
    votes: (a, b) => b.votes - a.votes,
    rating: (a, b) => b.rating - a.rating || b.votes - a.votes,
    newest: (a, b) => b.year - a.year || b.votes - a.votes,
    title: (a, b) => a.name.localeCompare(b.name)
  }[d.sort];
  const top = picked.sort(order).slice(0, d.limit);
  const byDate = d.sort === 'newest';
  const metas = await enrich(top.map(t => t.id), d.type, known, i => ({
    name: top[i].name, genres: top[i].genres,
    releaseInfo: d.type !== 'series' || top[i].endYear === top[i].year ? String(top[i].year) : `${top[i].year}–${top[i].endYear || ''}`
  }), byDate);
  // The index is refreshed daily, so its title and rating are the current ones.
  const out = metas.map((m, i) => ({ ...m, name: top[i].name, imdbRating: String(top[i].rating), year: top[i].year, votes: top[i].votes }));
  // "Newest first": the index knows only the year, so the titles chosen are put in order of their
  // actual release date where Stremio's metadata has one (a title without one goes to the start of its year).
  if (byDate) {
    const date = m => (m.released ? String(m.released).slice(0, 10) : `${m.year}-00-00`);
    out.sort((a, b) => date(b).localeCompare(date(a)) || b.votes - a.votes);
  }
  const result = out.map(({ year, votes, ...m }) => m);
  result.matched = picked.length;   // how many titles met the rules, before the row was cut to its size
  return result;
}

// ---- source: latest releases in one language ----
// Wikipedia's lists for this year and last say which films exist and when they
// released; our index says which of them are real, rated movies. A film shows
// up once it has released and has at least 100 IMDb votes.
async function fetchLatestReleases(d, known, exclude) {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  const listed = [...await titleIndex.wikipediaFilms(d.language, year), ...await titleIndex.wikipediaFilms(d.language, year - 1)];
  await titleIndex.ensureIndex();
  const index = new Map(titleIndex.loadIndex().map(t => [t.id, t]));
  const seen = new Set();
  const picked = [];
  for (const film of listed) {
    const t = index.get(film.id);
    if (!t || t.type !== 'movie' || seen.has(film.id)) continue;
    seen.add(film.id);
    if (t.year < year - 1 || t.votes < d.minVotes || (d.minRating && t.rating < d.minRating)) continue;
    if (film.date && film.date > today) continue;                 // announced, not out yet
    if (d.excludeMyRows && exclude.has(film.id)) continue;
    // No known date: place it at the start of its year.
    picked.push({ ...t, released: film.date && !film.date.endsWith('-00') ? film.date : `${t.year}-00-00` });
  }
  const top = picked.sort((a, b) => b.released.localeCompare(a.released) || b.votes - a.votes).slice(0, d.limit);
  const metas = await enrich(top.map(t => t.id), 'movie', known, i => ({ name: top[i].name, genres: top[i].genres, releaseInfo: String(top[i].year) }));
  return metas.map((m, i) => ({ ...m, name: top[i].name, releaseInfo: String(top[i].year), imdbRating: String(top[i].rating) }));
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
    : d.source === 'wikipedia' ? await fetchLatestReleases(d, known, exclude)
    : await fetchCinemetaList(d, exclude);
  if (!metas.length) throw new Error('source returned no titles');
  // metas.matched, when the source can tell: how many titles met the rules in all.
  return metas;
}

// Genres offered per type by Stremio's lists, for the manager's form.
async function genreOptions() {
  const m = await getJson(`${CINEMETA}/manifest.json`);
  const genresFor = type => ((m.catalogs.find(c => c.type === type && c.id === 'top') || {}).extra || []).find(e => e.name === 'genre');
  return Object.fromEntries(TYPES.map(t => [t, (genresFor(t) || {}).options || []]));
}

// ---- how a row is laid out as files ----
// The genres offered in Discover's third dropdown on our rows. A fixed list, on
// purpose: Stremio keeps its own copy of the addon's description until the addon
// is reinstalled, so a list that followed each row's contents would go stale.
const ROW_GENRES = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy',
  'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'];
// The first choice in the filter of a "Discover only" row: every title. Stremio leaves a row off
// the Board when its filter must be chosen, and in Discover opens it on the first choice.
const ALL_GENRES = 'All';
// The files Stremio may ask for about one row, relative to catalog/<type>/:
// "<id>.json" with every title, "<id>/genre=All.json" (the same, for a "Discover only" row),
// and with the genre filter one "<id>/genre=<Genre>.json" per genre (the address Stremio builds when a genre is picked).
function rowFiles(id, metas, withGenres) {
  const files = { [`${id}.json`]: metas, [`${id}/genre=${ALL_GENRES}.json`]: metas };
  if (withGenres) for (const g of ROW_GENRES) files[`${id}/genre=${g}.json`] = metas.filter(m => (m.genres || []).includes(g));
  return files;
}

// ---- rating and year in the title line ----
// Stremio shows a title's name under its poster, so the rating and year are put
// in front of it there: "★ 7.6 · 2016 · Train to Busan". Rating first, because
// long lines are cut off on a TV. Only the label in our rows changes; a title's
// own page in Stremio takes its name from Stremio's metadata.
const LABEL = /^(?:★ \d+(?:\.\d)? · )?(?:\d{4} · )?/;
const plainName = name => String(name || '').replace(LABEL, '');   // also undoes a label, so it is never applied twice
function titleLine(meta) {
  const rating = parseFloat(meta.imdbRating);
  const year = (String(meta.releaseInfo || '').match(/\d{4}/) || [])[0];
  return [rating > 0 ? `★ ${rating.toFixed(1)}` : '', year || '', plainName(meta.name)].filter(Boolean).join(' · ');
}

// ---- rating posters ----
// The poster with a title's rating drawn on it is made by the job on GitHub
// (tools/rate-posters.js) and stored under this name. The rating is part of the
// name, so a changed rating is a new file and no device keeps showing the old one.
const POSTER_STYLE = 2;   // raise when the drawing in rate-posters.js changes
function ratedPosterFile(meta) {
  const rating = parseFloat(meta && meta.imdbRating);
  if (!meta || !/^tt\d+$/.test(meta.id || '') || !(rating > 0)) return null;
  return `posters/${meta.id}-${Math.round(rating * 10)}-s${POSTER_STYLE}.jpg`;
}
const isRatedPoster = url => /\/posters\/tt\d+-[\w-]+\.jpg$/.test(url || '');
// The ordinary poster for a title, by IMDb id.
const plainPoster = id => `https://images.metahub.space/poster/medium/${id}/img`;

module.exports = { ROW_GENRES, ALL_GENRES, rowFiles, titleLine, plainName, ratedPosterFile, isRatedPoster, plainPoster, SOURCES, LISTS, LIMITS, FILTERS, normalise, signature, describe, fetchList, genreOptions };
