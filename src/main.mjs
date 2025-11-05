// src/main.mjs
import 'dotenv/config';

// 一時診断（実行後に消してOK）
//const t = process.env.TOKEN || "";
//console.log("TOKEN head:", t.slice(0, 10), "len:", t.length);


import fs from "fs";
import path from "path";
import express from "express";
import { fileURLToPath } from "url";
import {
  Client, GatewayIntentBits, Partials, Events,
  REST, Routes, PermissionFlagsBits
} from "discord.js";
import {
  CHANNEL_NAME_KEYWORDS, ALLOWED_ROLES, OK_REACTIONS,
  CHECK_INTERVAL_MS, REMIND_AFTER_MS
} from "./config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== 環境変数 ======
const TOKEN = process.env.TOKEN;
const PORT = process.env.PORT || 3000;

// ====== ストア ======
const STORE_DIR = path.join(__dirname, "store");
const REMINDER_FILE = path.join(STORE_DIR, "reminders.json");
if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
if (!fs.existsSync(REMINDER_FILE)) fs.writeFileSync(REMINDER_FILE, "[]");

function readReminders() {
  try { return JSON.parse(fs.readFileSync(REMINDER_FILE, "utf8")); }
  catch { return []; }
}
function writeReminders(arr) {
  const tmp = REMINDER_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(arr));
  fs.renameSync(tmp, REMINDER_FILE);
}
function keyOf({ guildId, channelId, messageId, userId }) {
  return `${guildId}:${channelId}:${messageId}:${userId}`;
}

// ====== Web keep-alive（Glitch/Render 用） ======
const app = express();
app.get("/", (_, res) => res.send("OK"));
app.listen(PORT);

// ====== Discord Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ====== コマンド登録 ======
const commands = [
  {
    name: "resolve",
    description: "このチャンネルで自分宛の未処理リマインドを解決扱いにします",
    default_member_permissions: PermissionFlagsBits.SendMessages.toString(),
    dm_permission: false,
  },
];
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const appInfo = await client.application.fetch();
  await rest.put(Routes.applicationCommands(appInfo.id), { body: commands });
}

// ====== リマインド登録/解決 ======
function addReminder({ guildId, channelId, messageId, userId, createdAtMs }) {
  const all = readReminders();
  const id = keyOf({ guildId, channelId, messageId, userId });
  if (all.some(r => r.id === id)) return; // 冪等
  all.push({ id, guildId, channelId, messageId, userId, createdAtMs, dueAtMs: createdAtMs + REMIND_AFTER_MS });
  writeReminders(all);
}
function removeReminders(filter) {
  const all = readReminders();
  const kept = all.filter(r => !(
    (filter.guildId ? r.guildId === filter.guildId : true) &&
    (filter.channelId ? r.channelId === filter.channelId : true) &&
    (filter.messageId ? r.messageId === filter.messageId : true) &&
    (filter.userId ? r.userId === filter.userId : true)
  ));
  writeReminders(kept);
  return all.length - kept.length;
}

async function isResolvedByActivity(channel, originalMessage, userId, sinceMs) {
  // 1) 元メッセージのリアクション
  const msg = originalMessage ?? await channel.messages.fetch(originalMessage.id ?? originalMessage);
  for (const r of msg.reactions.cache.values()) {
    const emoji = r.emoji.name ?? r.emoji.id;
    if (OK_REACTIONS.has(emoji)) return true;
  }
  // 2) メンション以後の本人発言
  const recent = await channel.messages.fetch({ limit: 50 });
  if (recent.some(m => m.author?.id === userId && m.createdTimestamp > sinceMs)) return true;
  return false;
}

async function pollAndRemind() {
  const now = Date.now();
  const all = readReminders();
  const keep = [];

  for (const r of all) {
    try {
      const guild = client.guilds.cache.get(r.guildId) ?? await client.guilds.fetch(r.guildId);
      const channel = guild.channels.cache.get(r.channelId) ?? await guild.channels.fetch(r.channelId);
      if (!channel?.isTextBased?.()) continue;
      const original = await channel.messages.fetch(r.messageId);

      if (now < r.dueAtMs) { keep.push(r); continue; }

      const resolved = await isResolvedByActivity(channel, original, r.userId, r.createdAtMs);
      if (!resolved) {
        const user = await client.users.fetch(r.userId);
        await message.channel.send({
            content: `${user}, こちら対応しましたか？(対応済みの場合ご放念ください)`,
            reply: {
                messageReference: message.id, // ← 元の指摘メッセージを参照
            },
            });
      } else {
        await original.react("✅").catch(() => {});
      }
      // 一回通知で終了（繰り返したい場合は r.dueAtMs += 任意間隔; keep.push(r) へ）
    } catch {
      // 消えたチャンネル/メッセージは破棄
    }
  }
  writeReminders(keep);
}

// ====== メッセージ検知 ======
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    const name = message.channel?.name ?? "";
    if (!CHANNEL_NAME_KEYWORDS.some(k => name.includes(k))) return;
    // 返信だけでメンション無しは除外
    if (message.reference && message.mentions.users.size === 0) return;
    if (message.mentions.users.size === 0) return;

    const guild = message.guild;
    for (const [, user] of message.mentions.users) {
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) continue;
      const hasRole = member.roles.cache.some(r => ALLOWED_ROLES.includes(r.name));
      if (!hasRole) continue;

      await message.react("👀").catch(() => {});
      addReminder({
        guildId: guild.id,
        channelId: message.channel.id,
        messageId: message.id,
        userId: user.id,
        createdAtMs: message.createdTimestamp,
      });
    }
  } catch {}
});

// ====== /resolve ======
client.on(Events.InteractionCreate, async (itx) => {
  if (!itx.isChatInputCommand()) return;
  if (itx.commandName !== "resolve") return;
  try {
    const removed = removeReminders({ guildId: itx.guildId, channelId: itx.channelId, userId: itx.user.id });
    // 直近のメンションに✅（可能なら）
    try {
      const msgs = await itx.channel.messages.fetch({ limit: 50 });
      const lastMentionToMe = msgs.find(m => m.mentions.users.has(itx.user.id));
      if (lastMentionToMe) await lastMentionToMe.react("✅").catch(() => {});
    } catch {}

    await itx.reply({
      ephemeral: true,
      content: removed > 0
        ? `このチャンネルであなた宛の未処理リマインドを ${removed} 件、解決扱いにしました。`
        : "このチャンネルであなた宛の未処理リマインドは見つかりませんでした。",
    });
  } catch {
    await itx.reply({ ephemeral: true, content: "処理中にエラーが発生しました。" });
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`${client.user.tag} logged in`);
  try { await registerCommands(); } catch {}
  pollAndRemind().catch(() => {});
  setInterval(() => pollAndRemind().catch(() => {}), CHECK_INTERVAL_MS);
});

client.login(TOKEN);