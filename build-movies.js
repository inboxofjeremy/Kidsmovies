import fs from "fs";
import path from "path";

// ===============================
// CONFIG
// ===============================
const TMDB_KEY = process.env.TMDB_API_KEY || "944017b839d3c040bdd2574083e4c1bc";
const DAYS_BACK = 180;
const MAX_PAGES = 20;
const TMDB_CONCURRENCY = 8;
const MIN_VOTE_COUNT = 5;

// ===============================
// DATE HELPERS
// ===============================
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const DATE_FROM = daysAgo(DAYS_BACK);
const DATE_TO = daysAgo(0);

// ===============================
// FETCH HELPERS
// ===============================
async function fetchJSON(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ===============================
// ALLOW +2 DAY WINDOW
// ===============================
function isAllowed(dateStr) {
  if (!dateStr) return false;

  const date = new Date(dateStr).getTime();
  const now = Date.now();

  const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

  // allow past + next 2 days
  return date <= (now + TWO_DAYS);
}

// ===============================
// RELEASE DATE & IMDB ID HELPER
// ===============================
async function fetchMovieDetails(id) {
  const [releaseJson, movieJson] = await Promise.all([
    fetchJSON(`https://api.themoviedb.org/3/movie/${id}/release_dates?api_key=${TMDB_KEY}`),
    fetchJSON(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}&language=en-US`)
  ]);

  const us = releaseJson?.results?.find((r) => r.iso_3166_1 === "US");
  
  let targetDate = null;
  if (us?.release_dates?.length) {
    // 1. Try Digital release (type 4) first
    const digitalDates = us.release_dates
      .filter((d) => d.type === 4 && d.release_date)
      .map((d) => d.release_date.slice(0, 10))
      .sort();

    if (digitalDates.length) {
      targetDate = digitalDates[0];
    } else {
      // 2. Fallback to Theatrical release (type 3) if no digital date exists yet
      const theatricalDates = us.release_dates
        .filter((d) => d.type === 3 && d.release_date)
        .map((d) => d.release_date.slice(0, 10))
        .sort();

      if (theatricalDates.length) {
        targetDate = theatricalDates[0];
      }
    }
  }

  // Fallback to TMDB main release_date if nothing else is found
  if (!targetDate && movieJson?.release_date) {
    targetDate = movieJson.release_date.slice(0, 10);
  }

  return {
    usDate: targetDate,
    imdb_id: movieJson?.imdb_id || null,
  };
}

// ===============================
// CONCURRENCY
// ===============================
async function pMap(list, fn, concurrency = TMDB_CONCURRENCY) {
  const out = new Array(list.length);
  let i = 0;

  const workers = Array(concurrency)
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= list.length) break;
        try {
          out[idx] = await fn(list[idx], idx);
        } catch {
          out[idx] = null;
        }
      }
    });

  await Promise.all(workers);
  return out;
}

// ===============================
// FETCH MOVIES
// ===============================
async function fetchMovies() {
  const all = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `https://api.themoviedb.org/3/discover/movie?` +
      `api_key=${TMDB_KEY}` +
      `&language=en-US` +
      `&with_original_language=en` +
      `&region=US` +
      `&vote_count.gte=${MIN_VOTE_COUNT}` +
      `&sort_by=primary_release_date.desc` +
      `&primary_release_date.gte=${DATE_FROM}` +
      `&primary_release_date.lte=${DATE_TO}` +
      `&without_genres=27` +
      `&page=${page}`;

    const j = await fetchJSON(url);
    if (!j?.results?.length) break;

    all.push(...j.results);
    if (page >= j.total_pages) break;
  }

  const mapped = await pMap(all, async (m) => {
    if (!m?.id) return null;

    const { usDate, imdb_id } = await fetchMovieDetails(m.id);

    // must have a valid release date
    if (!usDate) return null;

    // allow only past + next 2 days
    if (!isAllowed(usDate)) return null;

    // Use IMDb ID if available so stream addons recognize it instantly, fallback to tmdb:id
    const itemId = imdb_id || `tmdb:${m.id}`;

    return {
      id: itemId,
      type: "movie",
      name: m.title || m.original_title || `Movie ${m.id}`,
      description: m.overview || "",
      poster: m.poster_path
        ? `https://image.tmdb.org/t/p/w500${m.poster_path}`
        : null,
      releaseInfo: usDate,
    };
  });

  const seen = new Set();
  const out = [];

  for (const item of mapped) {
    if (!item) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }

  // newest first
  return out.sort((a, b) => {
    return new Date(b.releaseInfo) - new Date(a.releaseInfo);
  });
}

// ===============================
// META BUILDER
// ===============================
async function buildMeta(id) {
  const tmdbId = id.startsWith("tmdb:") ? id.split(":")[1] : null;

  let movie = null;
  if (tmdbId) {
    movie = await fetchJSON(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&language=en-US`
    );
  } else {
    // If id is an IMDb ID (tt...), find TMDB ID first
    const findJson = await fetchJSON(
      `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_KEY}&external_source=imdb_id`
    );
    const tmdbMovieResult = findJson?.movie_results?.[0];
    if (tmdbMovieResult) {
      movie = await fetchJSON(
        `https://api.themoviedb.org/3/movie/${tmdbMovieResult.id}?api_key=${TMDB_KEY}&language=en-US`
      );
    }
  }

  if (!movie) return null;

  const primaryId = movie.imdb_id || `tmdb:${movie.id}`;

  return {
    meta: {
      id: primaryId,
      type: "movie",
      name: movie.title,
      description: movie.overview || "",
      poster: movie.poster_path
        ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
        : null,
      background: movie.backdrop_path
        ? `https://image.tmdb.org/t/p/original${movie.backdrop_path}`
        : null,
      released: movie.release_date
        ? movie.release_date.slice(0, 10)
        : null,
      imdb_id: movie.imdb_id || null,
      imdb: movie.imdb_id || null,
    },
  };
}

// ===============================
// BUILD
// ===============================
async function build() {
  console.log("Fetching movies…");

  const movies = await fetchMovies();

  fs.mkdirSync("./catalog/movie", { recursive: true });
  fs.mkdirSync("./meta/movie", { recursive: true });

  fs.writeFileSync(
    "./catalog/movie/new_releases.json",
    JSON.stringify({ metas: movies }, null, 2)
  );

  for (const m of movies) {
    const meta = await buildMeta(m.id);
    if (!meta) continue;

    const safeFilename = m.id.includes(":") ? m.id.replace(":", "_") : m.id;

    fs.writeFileSync(
      `./meta/movie/${safeFilename}.json`,
      JSON.stringify(meta, null, 2)
    );
  }

  console.log("Done.");
}

build();
