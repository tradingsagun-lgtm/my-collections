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
const GENRES = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy',
  'Film-Noir', 'History', 'Horror', 'Music', 'Musical', 'Mystery', 'Reality-TV', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'];

// On the PC the index lives beside the other per-PC files; on GitHub, in the job's workspace.
const defaultDir = () => process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'stremio-collections', 'index')
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

// The IMDb ids of everything Wikidata lists for a country of origin (P495) or
// an original language (P364). Kept for a week; an older copy is used if Wikidata is down.
async function wikidataSet(kind, name, dir = defaultDir()) {
  const qid = (kind === 'country' ? COUNTRIES : LANGUAGES)[name];
  if (!qid) throw new Error(`unknown ${kind}: ${name}`);
  const file = path.join(dir, `wikidata-${kind}-${qid}.json`);
  const cached = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } })();
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < SET_MAX_AGE_MS) return new Set(cached.ids);
  try {
    const query = `SELECT DISTINCT ?i WHERE { ?f wdt:${kind === 'country' ? 'P495' : 'P364'} wd:${qid} ; wdt:P345 ?i . }`;
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

module.exports = { MIN_VOTES, COUNTRIES, LANGUAGES, GENRES, defaultDir, ensureIndex, loadIndex, wikidataSet, summaryOf };

// Run as "node title-index.js build <dir>" by ensureIndex().
if (require.main === module && process.argv[2] === 'build') {
  buildIndex(process.argv[3] || defaultDir()).then(s => console.log(JSON.stringify(s)), e => { console.error(e.message); process.exit(1); });
}
