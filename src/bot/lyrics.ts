import { EmbedBuilder, Message, TextChannel, DMChannel, NewsChannel } from "discord.js";
import { GuildPlayer } from "./player.js";
import { logger } from "../lib/logger.js";

type TextSendable = TextChannel | DMChannel | NewsChannel;

export interface LrcLine {
  timeMs: number;
  text: string;
}

export interface LyricsResult {
  trackName: string;
  artistName: string;
  synced: LrcLine[] | null;
  plain: string | null;
}

function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const line of lrc.split("\n")) {
    const match = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (!match) continue;
    const min = parseInt(match[1]!, 10);
    const sec = parseFloat(match[2]!);
    const text = match[3]!.trim();
    if (text) lines.push({ timeMs: Math.floor((min * 60 + sec) * 1000), text });
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

function parseTitle(raw: string): { artist: string; track: string } {
  const sep = raw.indexOf(" - ");
  if (sep !== -1) {
    return { artist: raw.slice(0, sep).trim(), track: raw.slice(sep + 3).trim() };
  }
  return { artist: "", track: raw.trim() };
}

export async function fetchLyrics(title: string): Promise<LyricsResult | null> {
  const { artist, track } = parseTitle(title);

  const queries = artist
    ? [
        `https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`,
        `https://lrclib.net/api/search?q=${encodeURIComponent(title)}`,
      ]
    : [`https://lrclib.net/api/search?q=${encodeURIComponent(title)}`];

  for (const url of queries) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "MusicBot/1.0" } });
      if (!res.ok) continue;
      const data = await res.json() as Array<{
        trackName: string;
        artistName: string;
        syncedLyrics?: string | null;
        plainLyrics?: string | null;
      }>;
      if (!data.length) continue;
      const hit = data[0]!;
      return {
        trackName: hit.trackName,
        artistName: hit.artistName,
        synced: hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null,
        plain: hit.plainLyrics ?? null,
      };
    } catch (err) {
      logger.warn({ err, url }, "lrclib fetch failed");
    }
  }
  return null;
}

const activeSessions = new Map<string, ReturnType<typeof setTimeout>[]>();

export function stopLyricsSession(guildId: string) {
  const timers = activeSessions.get(guildId);
  if (timers) {
    timers.forEach(clearTimeout);
    activeSessions.delete(guildId);
  }
}

function buildLyricsEmbed(
  lyrics: LyricsResult,
  lines: LrcLine[],
  currentIdx: number,
): EmbedBuilder {
  const WINDOW = 4;
  const start = Math.max(0, currentIdx - 1);
  const end = Math.min(lines.length - 1, currentIdx + WINDOW);

  const parts: string[] = [];
  for (let i = start; i <= end; i++) {
    const line = lines[i]!;
    if (i === currentIdx) {
      parts.push(`**» ${line.text} «**`);
    } else {
      parts.push(`  ${line.text}`);
    }
  }

  return new EmbedBuilder()
    .setColor(0xff5500)
    .setAuthor({ name: `🎤 ${lyrics.artistName}` })
    .setTitle(lyrics.trackName)
    .setDescription(parts.join("\n") || "♪")
    .setFooter({ text: "Live Lyrics • lrclib.net" });
}

export async function startLyricsSession(
  channel: TextSendable,
  player: GuildPlayer,
  lyrics: LyricsResult,
): Promise<void> {
  stopLyricsSession(player.guildId);

  const lines = lyrics.synced;
  if (!lines || lines.length === 0) {
    const plain = lyrics.plain ?? "Текст не найден.";
    const chunks = plain.match(/[\s\S]{1,1800}/g) ?? [plain];
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff5500)
          .setAuthor({ name: `🎤 ${lyrics.artistName}` })
          .setTitle(lyrics.trackName)
          .setDescription(chunks[0]!)
          .setFooter({ text: "Lyrics • lrclib.net" }),
      ],
    });
    return;
  }

  let msg: Message | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const scheduleAll = () => {
    const posMs = player.getCurrentPositionMs();

    lines.forEach((line, idx) => {
      const delay = line.timeMs - posMs;
      if (delay < -500) return;

      const t = setTimeout(async () => {
        if (!player.queue.currentTrack) return;
        const embed = buildLyricsEmbed(lyrics, lines, idx);
        try {
          if (!msg) {
            msg = await channel.send({ embeds: [embed] });
          } else {
            await msg.edit({ embeds: [embed] });
          }
        } catch (err) {
          logger.warn({ err }, "Failed to update lyrics message");
        }
      }, Math.max(0, delay));

      timers.push(t);
    });

    activeSessions.set(player.guildId, timers);
  };

  scheduleAll();
}
