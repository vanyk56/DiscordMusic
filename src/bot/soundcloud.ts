import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { logger } from "../lib/logger.js";

const SC_BASE = "https://api-v2.soundcloud.com";
const SC_HOMEPAGE = "https://soundcloud.com";
const CLIENT_ID_REFRESH_MS = 3_600_000; // refresh every hour

const SC_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://soundcloud.com/",
  "Origin": "https://soundcloud.com",
};

function scFetch(url: string, opts?: RequestInit): Promise<Response> {
  return fetch(url, { ...opts, headers: { ...SC_HEADERS, ...opts?.headers } });
}

let cachedClientId: string | null = null;
let clientIdTimestamp = 0;

export interface SCTrackInfo {
  title: string;
  url: string;
  duration: string;
  durationMs: number;
  thumbnail?: string;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function fetchClientId(): Promise<string> {
  if (cachedClientId && Date.now() - clientIdTimestamp < CLIENT_ID_REFRESH_MS) {
    return cachedClientId;
  }

  logger.info("Fetching SoundCloud client_id...");

  const res = await scFetch(SC_HOMEPAGE);
  if (!res.ok) throw new Error(`Failed to fetch SoundCloud homepage: ${res.status}`);
  const html = await res.text();

  const scriptMatches = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)];
  const scriptUrls = scriptMatches.map((m) => m[1]!);

  for (const scriptUrl of scriptUrls.slice(-5).reverse()) {
    try {
      const scriptRes = await scFetch(scriptUrl);
      if (!scriptRes.ok) continue;
      const js = await scriptRes.text();
      const match = js.match(/client_id:"([a-zA-Z0-9]{20,40})"/);
      if (match) {
        cachedClientId = match[1]!;
        clientIdTimestamp = Date.now();
        logger.info({ clientId: cachedClientId.slice(0, 10) + "..." }, "SoundCloud client_id obtained");
        return cachedClientId;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Could not extract SoundCloud client_id from any script");
}

export async function initializeSoundCloud(): Promise<void> {
  try {
    await fetchClientId();
  } catch (err) {
    logger.warn({ err }, "Failed to initialize SoundCloud client_id");
  }
}

export async function searchTracks(query: string, limit = 10): Promise<SCTrackInfo[]> {
  if (!query || query.trim().length < 2) return [];

  try {
    const clientId = await fetchClientId();
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      client_id: clientId,
    });

    const res = await scFetch(`${SC_BASE}/search/tracks?${params}`);
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);

    const data = (await res.json()) as { collection: any[] };

    return data.collection.map((t: any) => ({
      title: t.title ?? "Unknown",
      url: t.permalink_url ?? "",
      duration: formatDuration(t.duration ?? 0),
      durationMs: t.duration ?? 0,
      thumbnail: t.artwork_url?.replace("-large", "-t500x500") ?? undefined,
    }));
  } catch (err) {
    logger.warn({ err, query }, "SoundCloud search failed");
    return [];
  }
}

export async function resolveTrack(url: string): Promise<SCTrackInfo | null> {
  try {
    const clientId = await fetchClientId();
    const res = await scFetch(
      `${SC_BASE}/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`,
    );
    if (!res.ok) return null;

    const data = (await res.json()) as any;
    if (data.kind !== "track") return null;

    return {
      title: data.title ?? "Unknown",
      url: data.permalink_url ?? url,
      duration: formatDuration(data.duration ?? 0),
      durationMs: data.duration ?? 0,
      thumbnail: data.artwork_url?.replace("-large", "-t500x500") ?? undefined,
    };
  } catch (err) {
    logger.warn({ err, url }, "SoundCloud resolve failed");
    return null;
  }
}

export async function resolvePlaylist(
  url: string,
): Promise<{ title: string; tracks: SCTrackInfo[] } | null> {
  try {
    const clientId = await fetchClientId();
    const res = await scFetch(
      `${SC_BASE}/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`,
    );
    if (!res.ok) return null;

    const data = (await res.json()) as any;
    if (data.kind !== "playlist") return null;

    // Collect tracks that have full info
    const fullTracks: SCTrackInfo[] = [];
    const missingIds: number[] = [];

    for (const t of data.tracks ?? []) {
      if (t.title && t.permalink_url) {
        fullTracks.push({
          title: t.title,
          url: t.permalink_url,
          duration: formatDuration(t.duration ?? 0),
          durationMs: t.duration ?? 0,
          thumbnail: t.artwork_url?.replace("-large", "-t500x500") ?? undefined,
        });
      } else if (t.id) {
        missingIds.push(t.id);
      }
    }

    // Fetch missing tracks in batches of 50
    for (let i = 0; i < missingIds.length; i += 50) {
      const batch = missingIds.slice(i, i + 50);
      const ids = batch.join(",");
      try {
        const batchRes = await scFetch(
          `${SC_BASE}/tracks?ids=${ids}&client_id=${clientId}`,
        );
        if (batchRes.ok) {
          const batchData = (await batchRes.json()) as any[];
          for (const t of batchData) {
            fullTracks.push({
              title: t.title ?? "Unknown",
              url: t.permalink_url ?? "",
              duration: formatDuration(t.duration ?? 0),
              durationMs: t.duration ?? 0,
              thumbnail: t.artwork_url?.replace("-large", "-t500x500") ?? undefined,
            });
          }
        }
      } catch {
        // skip batch on error
      }
    }

    return { title: data.title ?? "Playlist", tracks: fullTracks };
  } catch (err) {
    logger.warn({ err, url }, "SoundCloud playlist resolve failed");
    return null;
  }
}

export async function getStream(
  trackUrl: string,
): Promise<{ stream: Readable }> {
  const clientId = await fetchClientId();

  // Resolve the track to get media transcodings
  const resolveRes = await scFetch(
    `${SC_BASE}/resolve?url=${encodeURIComponent(trackUrl)}&client_id=${clientId}`,
  );
  if (!resolveRes.ok)
    throw new Error(`Failed to resolve track: ${resolveRes.status}`);

  const track = (await resolveRes.json()) as any;
  const transcodings: any[] = track.media?.transcodings ?? [];

  // Prefer progressive (direct MP3 download) over HLS
  const progressive = transcodings.find(
    (t: any) => t.format?.protocol === "progressive",
  );
  const hls = transcodings.find(
    (t: any) => t.format?.protocol === "hls",
  );
  const transcoding = progressive ?? hls;

  if (!transcoding) {
    throw new Error("No suitable transcoding found for track");
  }

  // Get the actual stream URL
  const streamInfoRes = await scFetch(
    `${transcoding.url}?client_id=${clientId}`,
  );
  if (!streamInfoRes.ok)
    throw new Error(`Failed to get stream URL: ${streamInfoRes.status}`);

  const streamInfo = (await streamInfoRes.json()) as { url: string };

  const ffmpeg = spawn("ffmpeg", [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", streamInfo.url,
    "-analyzeduration", "0",
    "-loglevel", "0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1",
  ]);

  ffmpeg.on("error", (err) => {
    logger.error({ err }, "FFmpeg process error");
  });

  ffmpeg.stdout.on("close", () => {
    try {
      ffmpeg.kill("SIGKILL");
    } catch {}
  });

  return { stream: ffmpeg.stdout };
}
