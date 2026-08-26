import {
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  VoiceConnection,
  createAudioPlayer,
  createAudioResource,
  entersState,
  NoSubscriberBehavior,
} from "@discordjs/voice";

import * as sc from "./soundcloud.js";
import { MusicQueue, Track } from "./queue.js";
import { logger } from "../lib/logger.js";

export { initializeSoundCloud } from "./soundcloud.js";

export async function getSoundCloudPlaylist(url: string): Promise<{ title: string; tracks: { title: string; url: string; duration: string; thumbnail?: string }[] } | null> {
  return sc.resolvePlaylist(url);
}

export async function searchSoundCloudMultiple(query: string, limit = 10): Promise<{ title: string; url: string; duration: string; thumbnail?: string }[]> {
  return sc.searchTracks(query, limit);
}

export async function searchSoundCloud(query: string): Promise<{ title: string; url: string; duration: string; thumbnail?: string } | null> {
  const isUrl = query.startsWith("http://") || query.startsWith("https://");
  if (isUrl) {
    return sc.resolveTrack(query);
  }
  const results = await sc.searchTracks(query, 1);
  return results[0] ?? null;
}

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

const MAX_HISTORY = 20;

export class GuildPlayer {
  public readonly guildId: string;
  public queue: MusicQueue;
  public connection: VoiceConnection | null = null;
  public audioPlayer: AudioPlayer;
  public volume = 100;
  public paused = false;
  public history: Track[] = [];
  public onPanelUpdate: (() => void) | null = null;
  public onPanelDelete: (() => void) | null = null;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  public playbackStartedAt: number | null = null;
  private pausedAt: number | null = null;
  private totalPausedMs = 0;

  constructor(guildId: string) {
    this.guildId = guildId;
    this.queue = new MusicQueue();
    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      if (this.queue.loop && this.queue.currentTrack) {
        this.playTrack(this.queue.currentTrack).catch((err) => {
          logger.error({ err }, "Error replaying track — skipping");
          this.playNext();
        });
        return;
      }
      this.playNext();
    });

    this.audioPlayer.on("error", (err) => {
      logger.error({ err }, "AudioPlayer error — skipping to next track");
      this.playNext();
    });
  }

  private startInactivityTimer() {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      if (!this.queue.currentTrack && this.queue.isEmpty()) {
        logger.info({ guildId: this.guildId }, "Inactivity timeout — leaving voice channel");
        this.stop();
      }
    }, INACTIVITY_TIMEOUT_MS);
    logger.info({ guildId: this.guildId }, "Inactivity timer started (5 min)");
  }

  private clearInactivityTimer() {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  private playNext(): void {
    if (this.queue.currentTrack) {
      this.history.push(this.queue.currentTrack);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    const next = this.queue.dequeue();
    if (next) {
      this.queue.currentTrack = next;
      this.playTrack(next)
        .then(() => { this.onPanelUpdate?.(); })
        .catch((err) => {
          logger.error({ err, title: next.title }, "Error playing next track — skipping");
          this.playNext();
        });
    } else {
      this.queue.currentTrack = null;
      this.onPanelUpdate?.();
      this.startInactivityTimer();
    }
  }

  playPrevious(): void {
    const prev = this.history.pop();
    if (!prev) return;
    if (this.queue.currentTrack) {
      this.queue.enqueueFirst(this.queue.currentTrack);
    }
    this.queue.currentTrack = prev;
    this.playTrack(prev)
      .then(() => { this.onPanelUpdate?.(); })
      .catch((err) => {
        logger.error({ err, title: prev.title }, "Error playing previous track");
        this.playNext();
      });
  }

  shuffleQueue(): void {
    this.queue.shuffle();
    this.onPanelUpdate?.();
  }

  setConnection(connection: VoiceConnection) {
    this.connection = connection;
    connection.subscribe(this.audioPlayer);
  }

  getCurrentPositionMs(): number {
    if (!this.playbackStartedAt) return 0;
    const pausedExtra = this.pausedAt ? Date.now() - this.pausedAt : 0;
    return Date.now() - this.playbackStartedAt - this.totalPausedMs - pausedExtra;
  }

  async playTrack(track: Track): Promise<void> {
    this.clearInactivityTimer();
    logger.info({ url: track.url, title: track.title }, "Streaming track via SoundCloud API");

    const streamData = await sc.getStream(track.url);
    const resource = createAudioResource(streamData.stream, {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });

    resource.volume?.setVolumeLogarithmic(this.volume / 100);
    this.audioPlayer.play(resource);
    this.paused = false;
    this.playbackStartedAt = Date.now();
    this.pausedAt = null;
    this.totalPausedMs = 0;

    await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 15_000);
  }

  async start(): Promise<void> {
    this.clearInactivityTimer();
    const next = this.queue.dequeue();
    if (!next) return;
    this.queue.currentTrack = next;
    await this.playTrack(next);
  }

  pause(): boolean {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      this.audioPlayer.pause();
      this.paused = true;
      this.pausedAt = Date.now();
      this.onPanelUpdate?.();
      return true;
    }
    return false;
  }

  resume(): boolean {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      this.audioPlayer.unpause();
      this.paused = false;
      if (this.pausedAt) {
        this.totalPausedMs += Date.now() - this.pausedAt;
        this.pausedAt = null;
      }
      this.onPanelUpdate?.();
      return true;
    }
    return false;
  }

  skip(): boolean {
    if (
      this.audioPlayer.state.status === AudioPlayerStatus.Playing ||
      this.audioPlayer.state.status === AudioPlayerStatus.Paused
    ) {
      this.audioPlayer.stop(true);
      return true;
    }
    return false;
  }

  stop(): void {
    this.clearInactivityTimer();
    this.queue.clear();
    this.queue.currentTrack = null;
    this.queue.loop = false;
    this.audioPlayer.stop(true);
    this.connection?.destroy();
    this.connection = null;
    const del = this.onPanelDelete;
    this.onPanelUpdate = null;
    this.onPanelDelete = null;
    del?.();
  }

  setVolume(vol: number): boolean {
    if (vol < 0 || vol > 200) return false;
    this.volume = vol;
    const state = this.audioPlayer.state;
    if (
      state.status === AudioPlayerStatus.Playing ||
      state.status === AudioPlayerStatus.Paused
    ) {
      const resource = (state as { resource?: { volume?: { setVolumeLogarithmic: (v: number) => void } } }).resource;
      resource?.volume?.setVolumeLogarithmic(vol / 100);
    }
    this.onPanelUpdate?.();
    return true;
  }
}
