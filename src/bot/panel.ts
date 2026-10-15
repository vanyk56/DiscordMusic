import {
  Message,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { GuildPlayer } from "./player.js";
import { logger } from "../lib/logger.js";

type SendableChannel = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (options: any) => Promise<Message>;
};

export const PANEL_ID_PREFIX = "music_";

function volumeBar(vol: number): string {
  const filled = Math.round(vol / 20);
  const empty = 10 - filled;
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty));
}

function queueDots(size: number): string {
  if (size === 0) return "Очередь пуста";
  if (size === 1) return "1 трек";
  if (size < 5) return `${size} трека`;
  return `${size} треков`;
}

export function buildPanelEmbed(player: GuildPlayer): EmbedBuilder {
  const track = player.queue.currentTrack;
  const queueSize = player.queue.size();

  if (!track) {
    return new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle("╔══ 🎵 Музыкальный плеер ══╗")
      .setDescription(
        "```\n" +
        "  Нет активных треков\n" +
        "```\n" +
        "Используй `/play` чтобы начать воспроизведение!"
      )
      .setFooter({ text: "SoundCloud • Music Bot" });
  }

  const status = player.paused ? "⏸  ПАУЗА" : "▶  ВОСПРОИЗВЕДЕНИЕ";
  const volBar = volumeBar(player.volume);

  const embed = new EmbedBuilder()
    .setColor(player.paused ? 0xfaa61a : 0xff5500)
    .setAuthor({ name: status })
    .setTitle(track.title.length > 60 ? track.title.slice(0, 57) + "..." : track.title)
    .setURL(track.url)
    .setDescription(
      `\`\`\`\n🔊  ${volBar}  ${player.volume}%\n\`\`\``
    )
    .addFields(
      {
        name: "⏱  Длительность",
        value: `\`${track.duration}\``,
        inline: true,
      },
      {
        name: "📋  В очереди",
        value: `\`${queueDots(queueSize)}\``,
        inline: true,
      },
      {
        name: "🔁  Повтор",
        value: player.queue.loop ? "`Вкл`" : "`Выкл`",
        inline: true,
      },
      {
        name: "👤  Запросил",
        value: `\`${track.requestedBy}\``,
        inline: true,
      },
      {
        name: "📜  История",
        value: `\`${player.history.length} трек(ов)\``,
        inline: true,
      },
    )
    .setFooter({ text: "SoundCloud • Music Bot  •  Управляй кнопками ниже" });

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  return embed;
}

export function buildPanelRows(player: GuildPlayer): ActionRowBuilder<ButtonBuilder>[] {
  const paused = player.paused;
  const hasTrack = !!player.queue.currentTrack;
  const volDown = Math.max(0, player.volume - 10);
  const volUp = Math.min(200, player.volume + 10);

  // Row 1 — основные медиа-кнопки (Unicode-символы как на SWAGA/cara)
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`music_prev_${player.guildId}`)
      .setLabel("⏮")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.history.length === 0),
    new ButtonBuilder()
      .setCustomId(`music_pause_${player.guildId}`)
      .setLabel(paused ? "▶" : "⏸")
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary)
      .setDisabled(!hasTrack),
    new ButtonBuilder()
      .setCustomId(`music_skip_${player.guildId}`)
      .setLabel("⏭")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasTrack),
    new ButtonBuilder()
      .setCustomId(`music_stop_${player.guildId}`)
      .setLabel("⏹")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!hasTrack),
  );

  // Row 2 — громкость и перемешать
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`music_voldown_${player.guildId}`)
      .setLabel(`🔉 ${volDown}%`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.volume <= 0),
    new ButtonBuilder()
      .setCustomId(`music_volup_${player.guildId}`)
      .setLabel(`🔊 ${volUp}%`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.volume >= 200),
    new ButtonBuilder()
      .setCustomId(`music_shuffle_${player.guildId}`)
      .setLabel("🔀")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.queue.size() < 2),
  );

  return [row1, row2];
}

const panelMessages = new Map<string, Message>();

export async function sendPanel(channel: SendableChannel, player: GuildPlayer): Promise<void> {
  await deletePanel(player.guildId);

  try {
    const msg = await channel.send({
      embeds: [buildPanelEmbed(player)],
      components: buildPanelRows(player),
    });
    panelMessages.set(player.guildId, msg);

    player.onPanelUpdate = () => refreshPanel(player);
    player.onPanelDelete = () => deletePanel(player.guildId);
  } catch (err) {
    logger.warn({ err }, "Failed to send music panel");
  }
}

export async function refreshPanel(player: GuildPlayer): Promise<void> {
  const msg = panelMessages.get(player.guildId);
  if (!msg) return;
  try {
    await msg.edit({
      embeds: [buildPanelEmbed(player)],
      components: buildPanelRows(player),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to refresh music panel — removing reference");
    panelMessages.delete(player.guildId);
    player.onPanelUpdate = null;
    player.onPanelDelete = null;
  }
}

export async function deletePanel(guildId: string): Promise<void> {
  const msg = panelMessages.get(guildId);
  panelMessages.delete(guildId);
  if (!msg) return;
  try {
    await msg.delete();
  } catch {
  }
}
