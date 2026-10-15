// Our own title index: every movie and series with enough IMDb votes to matter,
// built from IMDb's free public data files (https://datasets.imdbws.com, for
// personal and non-commercial use). Rules can then search the whole catalogue
// instead of the first 1,000 titles of one of Stremio's lists.
//
// Country and original language are not in IMDb's files; those come from
// Wikidata (free, no key) as sets of IMDb ids, fetched per country or language.
//
// Self-contained on purpose (Node built-ins only): like live-source.js, this
// file is published and run by the scheduled job on GitHub as well as on the PC.
// The index itself is never published; only the rows built from it are.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const readline = require('readline');
const { execFile } = require('child_process');

const FILES = {
  ratings: 'https://datasets.imdbws.com/title.ratings.tsv.gz',   // id, rating, votes (about 9 MB)
  basics: 'https://datasets.imdbws.com/title.basics.tsv.gz'      // id, type, title, years, runtime, genres (about 230 MB)
};
const TYPE_OF = { movie: 'movie', tvMovie: 'movie', tvSeries: 'series', tvMiniSeries: 'series' };
const MIN_VOTES = 100;                        // below this a title is too obscure to rank
const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000; // IMDb refreshes its files daily; never fetch more often
const SET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Wikidata ids, each checked against Wikidata's own labels on 13 October 2026.
const COUNTRIES = {
  'South Korea': 'Q884', Japan: 'Q17', India: 'Q668', China: 'Q148', 'Hong Kong': 'Q8646', Thailand: 'Q869',
  'United Kingdom': 'Q145', 'United States': 'Q30', France: 'Q142', Spain: 'Q29', Germany: 'Q183', Italy: 'Q38',
  Denmark: 'Q35', Sweden: 'Q34', Norway: 'Q20', Turkey: 'Q43', Mexico: 'Q96', Brazil: 'Q155', Australia: 'Q408', Canada: 'Q16'
};
const LANGUAGES = {
  Korean: 'Q9176', Japanese: 'Q5287', Hindi: 'Q1568', Tamil: 'Q5885', Malayalam: 'Q36236', Telugu: 'Q8097',
  Chinese: 'Q7850', Cantonese: 'Q9186', Thai: 'Q9217', English: 'Q1860', French: 'Q150', Spanish: 'Q1321',
  German: 'Q188', Italian: 'Q652', Danish: 'Q9035', Swedish: 'Q9027', Norwegian: 'Q9043', Turkish: 'Q256', Portuguese: 'Q5146'
};
// Streaming platforms, by Wikidata id (labels checked 14 October 2026). Wikidata
// records the platform a title was made for or distributed by (original
// broadcaster P449, distributor P750). That is "originals and exclusives", not
// what a service carries today in any one country.
const PLATFORMS = {
  Netflix: ['Q907311'], 'Prime Video': ['Q4740856'], 'Disney+': ['Q54958752'], 'Apple TV+': ['Q62446736'],
  'HBO and HBO Max': ['Q65359104', 'Q23633'], Hulu: ['Q1630304'], 'Paramount+': ['Q27903045'], Peacock: ['Q67765302'],
  JioHotstar: ['Q19758675'], SonyLIV: ['Q17021043'], ZEE5: ['Q51328854']
};
const GENRES = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy',
  'Film-Noir', 'History', 'Horror', 'Music', 'Musical', 'Mystery', 'Reality-TV', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'];

// On the PC the index lives beside the other per-PC files (STREMIO_COLLECTIONS_HOME, set by config.js:
// %USERPROFILE%\.stremio-collections since v1.77.0); on GitHub, in the job's workspace.
const defaultDir = () => process.env.STREMIO_COLLECTIONS_HOME ? path.join(process.env.STREMIO_COLLECTIONS_HOME, 'index')
  : process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'stremio-collections', 'index')
  : path.join(__dirname, '..', '.index-cache');
const indexFile = dir => path.join(dir, 'title-index.json');

function download(url, file) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'stremio-collections (personal use)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return download(res.headers.location, file).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`IMDb data file answered ${res.statusCode}`)); }
      const tmp = file + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(tmp, file); resolve(); });
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Reads a gzipped tab-separated file line by line, calling onRow with the cells of each data row.
async function eachRow(file, onRow) {
  const lines = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let first = true;
  for await (const line of lines) {
    if (first) { first = false; continue; }   // header
    onRow(line.split('\t'));
  }
}

function summaryOf(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'title-index.summary.json'), 'utf8')); } catch (e) { return null; }
}
const isFresh = dir => { const s = summaryOf(dir); return Boolean(s && fs.existsSync(indexFile(dir)) && Date.now() - Date.parse(s.builtAt) < INDEX_MAX_AGE_MS); };

// Downloads IMDb's files and writes the index. Uses about 1 GB of memory for
// some 20 seconds, which is why ensureIndex() runs it in a process of its own.
async function buildIndex(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  for (const [name, url] of Object.entries(FILES)) await download(url, path.join(dir, `${name}.tsv.gz`));

  const rated = new Map();   // id -> [rating, votes], only titles with enough votes
  await eachRow(path.join(dir, 'ratings.tsv.gz'), ([id, rating, votes]) => {
    if (Number(votes) >= MIN_VOTES) rated.set(id, [Number(rating), Number(votes)]);
  });

  const titles = [];
  await eachRow(path.join(dir, 'basics.tsv.gz'), ([id, kind, title, , adult, start, end, runtime, genres]) => {
    const type = TYPE_OF[kind];
    const r = rated.get(id);
    if (!type || !r || adult === '1' || start === '\\N') return;
    // Compact row: id, type, name, year, end year, runtime in minutes, genres, rating, votes
    titles.push([id, type === 'movie' ? 'm' : 's', title, Number(start), end === '\\N' ? 0 : Number(end),
      runtime === '\\N' ? 0 : Number(runtime), genres === '\\N' ? '' : genres, r[0], r[1]]);
  });

  const summary = {
    builtAt: new Date().toISOString(), minVotes: MIN_VOTES,
    movies: titles.filter(t => t[1] === 'm').length, series: titles.filter(t => t[1] === 's').length,
    seconds: Math.round((Date.now() - started) / 1000)
  };
  fs.writeFileSync(indexFile(dir), JSON.stringify(titles));
  fs.writeFileSync(path.join(dir, 'title-index.summary.json'), JSON.stringify(summary));
  for (const name of Object.keys(FILES)) fs.rmSync(path.join(dir, `${name}.tsv.gz`), { force: true });   // only needed while building
  return summary;
}

// Makes sure an index under a day old exists, building it if not. If a rebuild
// fails and an older index exists, that one is kept and used.
function ensureIndex(dir = defaultDir()) {
  if (isFresh(dir)) return Promise.resolve(summaryOf(dir));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [__filename, 'build', dir], { timeout: 10 * 60 * 1000, maxBuffer: 1e6 }, err => {
      const summary = summaryOf(dir);
      if (summary && fs.existsSync(indexFile(dir))) return resolve({ ...summary, stale: Boolean(err) });
      reject(new Error('could not build the title index: ' + (err ? String(err.message).split('\n')[0] : 'no index written')));
    });
  });
}

function loadIndex(dir = defaultDir()) {
  return JSON.parse(fs.readFileSync(indexFile(dir), 'utf8')).map(([id, t, name, year, endYear, runtime, genres, rating, votes]) =>
    ({ id, type: t === 'm' ? 'movie' : 'series', name, year, endYear, runtime, genres: genres ? genres.split(',') : [], rating, votes }));
}

// The IMDb ids of everything Wikidata lists for a country of origin (P495), an
// original language (P364), or a platform (original broadcaster or distributor). Kept for a week; an older copy is used if Wikidata is down.
async function wikidataSet(kind, name, dir = defaultDir()) {
  const found = { country: COUNTRIES, language: LANGUAGES, platform: PLATFORMS }[kind][name];
  if (!found) throw new Error(`unknown ${kind}: ${name}`);
  const qids = [].concat(found);
  const qid = qids.join('-');
  const file = path.join(dir, `wikidata-${kind}-${qid}.json`);
  const cached = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } })();
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < SET_MAX_AGE_MS) return new Set(cached.ids);
  try {
    const query = kind === 'platform'
      ? `SELECT DISTINCT ?i WHERE { VALUES ?p { ${qids.map(q => 'wd:' + q).join(' ')} } { ?f wdt:P449 ?p } UNION { ?f wdt:P750 ?p } ?f wdt:P345 ?i . }`
      : `SELECT DISTINCT ?i WHERE { ?f wdt:${kind === 'country' ? 'P495' : 'P364'} wd:${qid} ; wdt:P345 ?i . }`;
    const res = await fetch('https://query.wikidata.org/sparql?query=' + encodeURIComponent(query),
      { headers: { 'User-Agent': 'stremio-collections (personal use)', Accept: 'application/sparql-results+json' } });
    if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
    const ids = (await res.json()).results.bindings.map(b => b.i.value).filter(v => /^tt\d+$/.test(v));
    if (!ids.length) throw new Error('Wikidata returned nothing');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), ids }));
    return new Set(ids);
  } catch (e) {
    if (cached) return new Set(cached.ids);
    throw e;
  }
}

// ---- latest releases by language, from Wikipedia's yearly film lists ----
// Wikipedia keeps a page per language and year ("List of Hindi films of 2026")
// that editors update as films release. It knows about new regional films long
// before Wikidata records their language, which is why this exists.
const WIKIPEDIA_LANGUAGES = ['Hindi', 'Tamil', 'Malayalam', 'Telugu', 'Kannada', 'Bengali', 'Marathi', 'Punjabi'];
const LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WIKI_AGENT = { 'User-Agent': 'stremio-collections (personal catalogue tool; a few requests a day)' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// One request at a time with a pause before each, and a wait-and-retry when asked to slow down.
async function politeJson(url, options = {}) {
  for (let attempt = 1; ; attempt++) {
    await pause(1000);
    const res = await fetch(url, { ...options, headers: { ...WIKI_AGENT, ...(options.headers || {}) } });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) {
      if (attempt >= 6) throw new Error(`${new URL(url).host} would not answer (${res.status})`);
      // Told to slow down: wait as long as asked (up to two minutes), otherwise a little longer each time.
      const asked = Number(res.headers.get('retry-after'));
      await pause(asked > 0 ? Math.min(asked, 120) * 1000 : 15000 * attempt);
    }
  }
}

// The films on one yearly list page that have an IMDb id, with their earliest
// release date where Wikidata has one: [{ id, date }]. Empty if the page does not exist.
async function crawlFilmList(language, year) {
  const page = `List of ${language} films of ${year}`;
  // 1. Every article the list links to, with its Wikidata item (films, but also actors, directors, studios…).
  const items = new Set();
  let more = {};
  for (let i = 0; i < 12; i++) {
    const j = await politeJson('https://en.wikipedia.org/w/api.php?' + new URLSearchParams({
      format: 'json', action: 'query', generator: 'links', titles: page, gplnamespace: '0', gpllimit: '500',
      prop: 'pageprops', ppprop: 'wikibase_item', redirects: '1', ...more
    }));
    for (const p of Object.values((j.query || {}).pages || {})) if (p.pageprops && p.pageprops.wikibase_item) items.add(p.pageprops.wikibase_item);
    if (!j.continue) break;
    more = j.continue;
  }
  // 2. Of those, the ones Wikidata gives an IMDb title id: that keeps the films and drops the people.
  const films = new Map();
  const all = [...items].filter(q => /^Q\d+$/.test(q));
  for (let i = 0; i < all.length; i += 400) {
    const query = `SELECT ?item ?imdb (MIN(?d) AS ?date) WHERE { VALUES ?item { ${all.slice(i, i + 400).map(q => 'wd:' + q).join(' ')} } ?item wdt:P345 ?imdb . OPTIONAL { ?item wdt:P577 ?d } } GROUP BY ?item ?imdb`;
    const j = await politeJson('https://query.wikidata.org/sparql', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      body: 'query=' + encodeURIComponent(query)
    });
    for (const b of j.results.bindings) {
      if (/^tt\d+$/.test(b.imdb.value) && !films.has(b.imdb.value)) films.set(b.imdb.value, b.date ? b.date.value.slice(0, 10) : null);
    }
  }
  return [...films].map(([id, date]) => ({ id, date }));
}

// crawlFilmList, kept for a day; an older copy is used if Wikipedia or Wikidata is unreachable.
async function wikipediaFilms(language, year, dir = defaultDir()) {
  if (!WIKIPEDIA_LANGUAGES.includes(language)) throw new Error(`no Wikipedia film list for: ${language}`);
  const file = path.join(dir, `wikipedia-films-${language}-${year}.json`);
  const cached = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } })();
  // This year's list changes daily; last year's occasionally; older ones hardly at all.
  const age = new Date().getFullYear() - year;
  const maxAge = LIST_MAX_AGE_MS * (age <= 0 ? 1 : age === 1 ? 7 : 30);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < maxAge) return cached.films;
  try {
    const films = await crawlFilmList(language, year);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), films }));
    return films;
  } catch (e) {
    if (cached) return cached.films;
    throw e;
  }
}

// ---- what Stremio's metadata said about a title, kept so it is asked once ----
// Posters, descriptions and release dates, keyed "<type>:<imdb id>". Many titles
// sit in several rows; without this every row would look each one up again.
const metaStoreFile = (dir = defaultDir()) => path.join(dir, 'title-details.json');
function readMetaStore(dir = defaultDir()) {
  try { return JSON.parse(fs.readFileSync(metaStoreFile(dir), 'utf8')); } catch (e) { return {}; }
}
function writeMetaStore(store, dir = defaultDir()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaStoreFile(dir), JSON.stringify(store));
}

module.exports = { readMetaStore, writeMetaStore, MIN_VOTES, COUNTRIES, LANGUAGES, PLATFORMS, GENRES, WIKIPEDIA_LANGUAGES, defaultDir, ensureIndex, loadIndex, wikidataSet, wikipediaFilms, summaryOf };

// Run as "node title-index.js build <dir>" by ensureIndex().
if (require.main === module && process.argv[2] === 'build') {
  buildIndex(process.argv[3] || defaultDir()).then(s => console.log(JSON.stringify(s)), e => { console.error(e.message); process.exit(1); });
}
