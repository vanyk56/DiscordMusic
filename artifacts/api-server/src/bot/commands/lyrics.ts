import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  TextChannel,
  DMChannel,
  NewsChannel,
} from "discord.js";
import { getPlayer } from "../manager.js";
import { fetchLyrics, startLyricsSession, stopLyricsSession } from "../lyrics.js";

export const data = new SlashCommandBuilder()
  .setName("lyrics")
  .setDescription("Показать текст текущей песни (в реальном времени)");

export async function execute(interaction: ChatInputCommandInteraction) {
  const player = getPlayer(interaction.guildId!);
  if (!player || !player.queue.currentTrack) {
    return interaction.reply({ content: "❌ Сейчас ничего не играет.", ephemeral: true });
  }

  await interaction.deferReply();

  const track = player.queue.currentTrack;
  const lyrics = await fetchLyrics(track.title);

  if (!lyrics) {
    return interaction.editReply(
      `❌ Текст для **${track.title}** не найден.\nПопробуй команду \`/volume\` чтобы убедиться что трек играет, или поищи другой трек.`,
    );
  }

  const hasSynced = lyrics.synced && lyrics.synced.length > 0;

  await interaction.editReply(
    hasSynced
      ? `🎤 Запускаю живые субтитры для **${lyrics.trackName}** — ${lyrics.artistName}`
      : `🎤 Синхронизированный текст недоступен — показываю обычный для **${lyrics.trackName}**`,
  );

  stopLyricsSession(interaction.guildId!);

  const ch = interaction.channel;
  if (!ch || !("send" in ch)) {
    return interaction.editReply("❌ Не могу отправить текст в этот канал.");
  }

  await startLyricsSession(
    ch as TextChannel | DMChannel | NewsChannel,
    player,
    lyrics,
  );

  return;
}
