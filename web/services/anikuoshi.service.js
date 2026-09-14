/*
 * AniKuoshi — web/services/anikuoshi.service.js
 * ------------------------------------------------------------------
 * Server-side service layer that orchestrates the AniKotoAPI extractors
 * into page models for the AniKuoshi PWA. Nothing in here ever touches
 * the client: pages and htmx fragments receive only rendered HTML.
 *
 * Design notes:
 *  - Calls extractor functions in-process (no self-HTTP) → less lag.
 *  - Normalizes messy upstream shapes (search slugs carry "/ep-1").
 *  - Adds page-level LRU caching for expensive multi-fetch compositions.
 *  - Never throws for optional enrichments; degrades gracefully.
 */
import { extractHomeInfo } from "../../src/extractors/homeInfo.extractor.js";
import { extractSpotlight } from "../../src/extractors/spotlight.extractor.js";
import { extractTrending } from "../../src/extractors/trending.extractor.js";
import { extractTopTen } from "../../src/extractors/topten.extractor.js";
import { extractSearchResults, extractSearchSuggestions } from "../../src/extractors/search.extractor.js";
import { extractAnimeInfo } from "../../src/extractors/animeInfo.extractor.js";
import { extractEpisodeList } from "../../src/extractors/episodeList.extractor.js";
import { extractWatchPage } from "../../src/extractors/watchPage.extractor.js";
import { extractServerList, extractStreamInfo, extractMapperServers } from "../../src/extractors/streamInfo.extractor.js";
import { extractSchedule } from "../../src/extractors/schedule.extractor.js";
import { extractFilter } from "../../src/extractors/filter.extractor.js";
import { extractAzList } from "../../src/extractors/azList.extractor.js";
import { extractSeasons } from "../../src/extractors/seasons.extractor.js";
import { extractWatchOrder } from "../../src/extractors/watchOrder.extractor.js";
import { extractRecentlyUpdatedTabs } from "../../src/extractors/recentlyUpdatedTabs.extractor.js";
import { extractNewRelease } from "../../src/extractors/newRelease.extractor.js";
import { extractPopular } from "../../src/extractors/popular.extractor.js";
import { extractUpcomingAnime } from "../../src/extractors/upcomingAnime.extractor.js";
import { extractCompletedAnime } from "../../src/extractors/completedAnime.extractor.js";
import { extractTopAnimeRankings } from "../../src/extractors/topAnimeRankings.extractor.js";
import { getCache, setCache } from "../../src/helper/cache.helper.js";

// ══════════════════════════════════════════════════════════════
// SMALL UTILITIES
// ══════════════════════════════════════════════════════════════

/** Strip trailing "/ep-N" that search/filter results append to slugs. */
export const cleanSlug = (rawSlug) =>
  String(rawSlug || "").split("/ep-")[0].replace(/^\/+|\/+$/g, "");

/** Extract numeric ep from raw "slug/ep-12" style slugs. */
export const epFromRaw = (rawSlug) => {
  const m = String(rawSlug || "").match(/\/ep-(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
};

/** Normalize a card coming from search/filter/az-list rows. */
const normalizeCard = (item = {}) => ({
  slug: cleanSlug(item.slug || item.href || ""),
  animeId: item.animeId || "",
  title: (item.title || "").trim(),
  japaneseTitle: item.japaneseTitle || "",
  poster: item.poster || "",
  type: item.type || "",
  rating: item.rating || "",
  sub: item.sub ?? "",
  dub: item.dub ?? "",
  total: item.total ?? "",
  genres: Array.isArray(item.genres) ? item.genres.slice(0, 3) : [],
});

/** Wrap an extractor promise so failures become { error } instead of 500s. */
const safe = async (label, fn, cacheKey = null, ttl = 300) => {
  if (cacheKey) {
    const cached = getCache(`ak_${cacheKey}`);
    if (cached) return cached;
  }
  try {
    const value = await fn();
    if (cacheKey && value) setCache(`ak_${cacheKey}`, value, ttl);
    return value;
  } catch (error) {
    console.error(`[AK-SVC] ${label} failed:`, error.message);
    return { error: error.message };
  }
};

// ══════════════════════════════════════════════════════════════
// PAGE MODELS
// ══════════════════════════════════════════════════════════════

/** Spotlight hero for the home page. */
export const getSpotlightModel = () =>
  safe("spotlight", async () => {
    const rows = await extractSpotlight();
    return rows.map(r => ({
      slug: cleanSlug(r.slug),
      title: r.title,
      japaneseTitle: r.japaneseTitle,
      poster: r.poster,
      description: (r.description || "").slice(0, 320),
      rating: r.rating,
      quality: r.quality,
      sub: r.sub, dub: r.dub,
      type: r.type || "",
      date: r.date || "",
    }));
  }, "spotlight", 600);

/** Generic list fetchers used by lazy home rows + browse pages. */
export const listFetchers = {
  trending: (page = 1) => extractTrending(page),
  // NOTE: extractTopTen() ignores args and returns {today, week, month}
  "top-ten": async () => {
    const raw = await extractTopTen();
    return raw?.today || raw?.week || raw?.month || [];
  },
  "most-popular": (page = 1) => extractPopular(page),
  "new-release": (page = 1) => extractNewRelease(page),
  "recently-updated": (page = 1) => extractRecentlyUpdatedTabs(page),
  upcoming: (page = 1) => extractUpcomingAnime(page),
  completed: (page = 1) => extractCompletedAnime(page),
  "top-rankings": (page = 1) => extractTopAnimeRankings(page),
};

/** Normalized, paginable list rows for any of the above keys. */
export const getListModel = async (key, page = 1) => {
  const fetcher = listFetchers[key];
  if (!fetcher) return { data: [], error: "Unknown list" };
  return safe(`list:${key}:${page}`, async () => {
    const raw = await fetcher(page);
    const arr = Array.isArray(raw) ? raw : raw?.data || raw?.results || [];
    return { data: arr.map(normalizeCard), totalPages: 1, currentPage: page };
  }, `list_${key}_${page}`, 300);
};

/** Search with normalization + pagination info. */
export const getSearchModel = async (keyword, page = 1) => {
  if (!keyword) return { data: [], totalPages: 1, currentPage: 1 };
  return safe(`search:${keyword}:${page}`, async () => {
    const raw = await extractSearchResults(keyword, page);
    const data = (raw?.data || []).map(normalizeCard);
    return { data, totalPages: raw?.totalPages || 1, currentPage: raw?.currentPage || page };
  }, `search_${keyword}_${page}`, 300);
};

/** Quick suggestions for the topbar autocomplete. */
export const getSuggestions = async (keyword) => {
  if (!keyword || keyword.length < 2) return [];
  return safe(`suggest:${keyword}`, async () => {
    const raw = await extractSearchSuggestions(keyword);
    return (Array.isArray(raw) ? raw : []).slice(0, 8).map(normalizeCard);
  }, `suggest_${keyword}`, 180);
};

/** Advanced filter browse. NOTE: upstream expects all params (incl. page) in ONE object. */
export const getBrowseModel = async (filters, page = 1) => {
  return safe(`browse:${JSON.stringify(filters)}:${page}`, async () => {
    const raw = await extractFilter({ ...filters, page });
    const data = (raw?.data || []).map(normalizeCard);
    return { data, totalPages: raw?.totalPages || 1, currentPage: raw?.pagination?.currentPage || raw?.currentPage || page };
  }, `browse_${JSON.stringify(filters)}_${page}`, 300);
};

/** A-Z list. */
export const getAzListModel = async (letter, page = 1) => {
  return safe(`az:${letter}:${page}`, async () => {
    const raw = await extractAzList(letter, page);
    const data = (raw?.data || []).map(normalizeCard);
    return { data, totalPages: raw?.totalPages || 1, currentPage: raw?.currentPage || page };
  }, `az_${letter}_${page}`, 600);
};

/** Weekly schedule (day-keyed). */
export const getScheduleModel = async (date) => {
  return safe(`schedule:${date}`, async () => {
    const rows = await extractSchedule(date);
    return (Array.isArray(rows) ? rows : []).map(r => ({
      slug: cleanSlug(r.slug),
      title: r.title,
      time: r.time,
      episode: r.episode_no,
      poster: r.poster || "",
    }));
  }, `schedule_${date}`, 600);
};

/** Full anime detail model (info + episodes + seasons + related + recommendations). */
export const getAnimeModel = async (slug) => {
  return safe(`anime:${slug}`, async () => {
    const [info, epData, seasons, watchOrder, watch] = await Promise.allSettled([
      extractAnimeInfo(slug),
      extractEpisodeList(slug),
      extractSeasons(slug),
      extractWatchOrder(slug),
      extractWatchPage(slug, 1),
    ]);

    if (info.status !== "fulfilled" || info.value?.error) {
      throw new Error(info.value?.error || "Anime not found");
    }

    const episodes = epData.status === "fulfilled" && Array.isArray(epData.value?.episodes)
      ? epData.value.episodes.map(e => ({
          number: parseInt(e.episode_no, 10) || 0,
          id: e.id,
          title: e.title || "",
          serverIds: e.server_ids || "",
          malId: e.mal_id || "",
          timestamp: e.timestamp || "",
          active: !!e.active,
        }))
      : [];

    return {
      info: info.value,
      animeId: info.value.animeId,
      totalEpisodes: episodes.length || parseInt(info.value.episodes, 10) || 0,
      episodes,
      seasons: seasons.status === "fulfilled" && Array.isArray(seasons.value?.seasons)
        ? seasons.value.seasons
        : [],
      related: watchOrder.status === "fulfilled" && Array.isArray(watchOrder.value?.related)
        ? watchOrder.value.related.map(normalizeCard)
        : [],
      recommended: watch.status === "fulfilled" && Array.isArray(watch.value?.recommended)
        ? watch.value.recommended.map(normalizeCard)
        : [],
    };
  }, `anime_${slug}`, 300);
};

/**
 * Full watch-page model for the player: metadata, episodes, servers of the
 * current episode (resolved server-side), the default embed stream and
 * schedule info for the next episode.
 */
export const getWatchModel = async (slug, ep) => {
  return safe(`watch:${slug}:${ep}`, async () => {
    const [watch, epData] = await Promise.allSettled([
      extractWatchPage(slug, ep),
      extractEpisodeList(slug),
    ]);

    if (watch.status !== "fulfilled" || watch.value?.error || !watch.value?.title) {
      throw new Error(watch.value?.error || "Episode not found");
    }
    const w = watch.value;

    const episodes = epData.status === "fulfilled" && Array.isArray(epData.value?.episodes)
      ? epData.value.episodes.map(e => ({
          number: parseInt(e.episode_no, 10) || 0,
          id: e.id,
          title: e.title || "",
          serverIds: e.server_ids || "",
          timestamp: e.timestamp || "",
          malId: e.mal_id || "",
        }))
      : [];

    const current = episodes.find(e => e.number === (parseInt(ep, 10) || 1)) || episodes[0] || null;
    const nextEp = episodes.find(e => e.number === ((parseInt(ep, 10) || 1) + 1)) || null;
    const prevEp = episodes.find(e => e.number === ((parseInt(ep, 10) || 1) - 1)) || null;

    // Resolve servers for the current episode (uses the encrypted token).
    let servers = [];
    if (current?.serverIds) {
      try {
        servers = await extractServerList(current.serverIds) || [];
      } catch (e) {
        console.error("[AK-SVC] server list failed:", e.message);
        servers = [];
      }
    }
    const subServers = servers.filter(s => s.type === "sub");
    const dubServers = servers.filter(s => s.type === "dub");

    // Resolve the default stream (first sub server, fallback first dub).
    const preferred = subServers[0] || dubServers[0] || null;
    let stream = null;
    if (preferred?.link_id) {
      try {
        const raw = await extractStreamInfo(preferred.link_id, slug);
        if (raw?.url) {
          stream = {
            linkId: raw.linkId,
            url: raw.url,
            type: raw.type,
            skipData: raw.skipData,
            serverName: preferred.name,
            serverType: preferred.type,
          };
        }
      } catch (e) {
        console.error("[AK-SVC] default stream resolve failed:", e.message);
      }
    }

    return {
      slug,
      animeId: w.animeId,
      title: w.title,
      japaneseTitle: w.japaneseTitle,
      episodeNumber: parseInt(ep, 10) || w.episodeNumber || 1,
      synopsis: w.synopsis,
      type: w.type,
      status: w.status,
      malScore: w.malScore,
      duration: w.duration,
      episodes: w.episodes,
      genres: w.genres,
      studios: w.studios,
      poster: w.poster,
      backgroundImage: w.backgroundImage,
      nextEpisodeDate: w.nextEpisodeDate,
      nextEpisodeTimestamp: w.nextEpisodeTimestamp,
      servers: { sub: subServers, dub: dubServers },
      stream,
      episodesList: episodes,
      currentEp: current,
      nextEp: nextEp ? { number: nextEp.number, title: nextEp.title } : null,
      prevEp: prevEp ? { number: prevEp.number, title: prevEp.title } : null,
      trending: (w.trending || []).map(normalizeCard),
      recommended: (w.recommended || []).map(normalizeCard),
    };
  }, `watch_${slug}_${ep}`, 180);
};

/** Resolve one stream on demand (htmx server-switch / ep-switch). */
export const resolveStream = async (linkId, slug) => {
  if (!linkId || !/^[A-Za-z0-9+/=._-]{8,512}$/.test(linkId)) {
    return { error: "Invalid link id" };
  }
  try {
    const raw = await extractStreamInfo(linkId, slug || null);
    if (!raw?.url) return { error: "Stream unavailable" };
    return { linkId: raw.linkId, url: raw.url, type: raw.type, skipData: raw.skipData };
  } catch (error) {
    return { error: error.message };
  }
};

/** Bonus: mapper servers (best-effort enrichment). */
export const getMapperServers = async (malId, slug, timestamp) => {
  try {
    return await extractMapperServers(malId, slug, timestamp) || [];
  } catch {
    return [];
  }
};

// ══════════════════════════════════════════════════════════════
// FILTER OPTIONS (static catalog of the anikoto filter facets)
// ══════════════════════════════════════════════════════════════

export const FILTER_OPTIONS = {
  genres: [
    "action", "adventure", "comedy", "drama", "ecchi", "fantasy",
    "horror", "mecha", "music", "mystery", "psychological",
    "romance", "sci-fi", "slice-of-life", "sports", "supernatural", "thriller",
  ],
  statuses: ["airing", "completed", "upcoming"],
  years: ["2026", "2025", "2024", "2023", "2022", "2021", "2020", "2010s", "2000s", "90s"],
  // NOTE: verified-working upstream sort keys ("score"/"name-az" 500 upstream)
  sorts: ["default", "recently-added", "recently-updated", "score-desc",
          "released-date", "most-watched", "trending"],
};

// ══════════════════════════════════════════════════════════════ END
