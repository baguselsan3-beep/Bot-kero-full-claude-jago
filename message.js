'use strict';
// ── FISCH BOT — message.js ────────────────────────────
// Struktur bersih: semua konstanta & fungsi di top-level,
// handler hanya berisi logic per-pesan.
// ─────────────────────────────────────────────────────

let q = '';
/**
 * ══════════════════════════════════════════
 *   FISCH BOT — message.js
 *   Handler utama pesan WhatsApp + game data
 * ══════════════════════════════════════════
 */

const config  = require('./settings/config');
const fs      = require('fs');
const axios   = require('axios');
const chalk   = require('chalk');
const util    = require('util');
const crypto  = require('crypto');
const fetch   = require('node-fetch');
const moment  = require('moment-timezone');
const path    = require('path');
const os      = require('os');
const { exec, execFile } = require('child_process');
const { default: baileys, getContentType } = require('@itsliaaa/baileys');
const mongoose = require('mongoose');
const { initTelegram, notifyTelegram } = require('./w-shennmine/lib/telegram');
const { smsg, fetchJson, sleep, formatSize, runtime, getBuffer } = require('./w-shennmine/lib/myfunction');
const { fquoted } = require('./w-shennmine/lib/fquoted');

// Media thumbnail (dimuat sekali saat startup)
let _thumbBuffer = null;
function getThumb() {
    if (!_thumbBuffer) {
        const p = require('path').join(__dirname, './w-shennmine/lib/media/sahurhub.jpg');
        _thumbBuffer = require('fs').existsSync(p) ? require('fs').readFileSync(p) : null;
    }
    return _thumbBuffer;
}

// ── Dari config (tidak hardcode lagi) ──────────────
const botAdmins = config.admins || [];

// ── Random background colors untuk status teks (global) ──
const STATUS_BG_COLORS = [
    '#FF69B4', '#FF4500', '#FF6347', '#FF8C00', '#FFD700',
    '#ADFF2F', '#00FA9A', '#00CED1', '#1E90FF', '#9370DB',
    '#FF1493', '#00BFFF', '#32CD32', '#FF7F50', '#DA70D6',
    '#40E0D0', '#F08080', '#90EE90', '#87CEEB', '#DDA0DD',
];
function randomBgColor() {
    return STATUS_BG_COLORS[Math.floor(Math.random() * STATUS_BG_COLORS.length)];
}

// Helper: cek apakah sender adalah admin (support nomor asli, LID, & group chat)
const HARDCODED_ADMINS = (process.env.PERMANENT_ADMINS || '161933470781692,6282132455151,1619334373037381363932,6282245823137')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
// Mapping LID -> nomor HP admin
const LID_TO_PHONE = {
    '161933470781692':        '6282132455151',
    '1619334373037381363932': '6282245823137',
};
function isAdmin(senderNumber, m) {
    function checkNum(n) {
        if (!n) return false;
        const s = String(n).trim().replace(/\u200e|\u200f|\u00a0/g, ''); // strip invisible chars
        const d = s.replace(/\D/g, '');
        if (!d) return false;
        const allAdmins = [...(config.admins || []), ...HARDCODED_ADMINS];
        return allAdmins.some(a => {
            const ad = String(a).trim().replace(/\D/g, '');
            return ad === d || d.endsWith(ad) || ad.endsWith(d);
        });
    }
    if (m) {
        const senderRaw = m.sender || '';
        const senderNum = senderRaw.split('@')[0];
        // FIXED: chatNum dihapus — m.chat adalah JID grup, bukan nomor sender
        // Dulu: checkNum(chatNum) bisa bikin semua orang di grup lolos jadi "admin"
        return checkNum(senderRaw) || checkNum(senderNum);
    }
    return checkNum(senderNumber);
}
const MONGO_SRV = config.mongoSrv;

if (!MONGO_SRV || MONGO_SRV.includes('USER:PASS') || MONGO_SRV.includes('-:-')) {
    console.error('\n❌ mongoSrv belum diisi di settings/config.js!\n');
    process.exit(1);
}

// ===== MONGODB CONNECTION =====
let isMongoConnected = false;
let isMongoConnecting = false;

async function connectMongo(reason = 'startup') {
    if (isMongoConnected || isMongoConnecting) return;
    isMongoConnecting = true;
    try {
        await mongoose.connect(MONGO_SRV, {
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
            maxPoolSize: 10,
            minPoolSize: 1,
        });
        isMongoConnected = true;
        console.log(`✅ Database Fisch connected (${reason})`);
    } catch (err) {
        console.error("❌ Database Fisch connection error:", err.message || err);
        console.error("   Periksa config.mongoSrv di settings/config.js");
    } finally {
        isMongoConnecting = false;
    }
}

connectMongo();

mongoose.connection.on('connected', () => {
    isMongoConnected = true;
    loadConsoleMsgState().catch(() => {});
});
mongoose.connection.on('disconnected', () => {
    isMongoConnected = false;
    console.log('⚠️ MongoDB disconnected. Reconnecting...');
    setTimeout(() => connectMongo('reconnect'), 5000);
});
mongoose.connection.on('error', err => {
    isMongoConnected = false;
    console.error('❌ MongoDB error:', err.message || err);
});

// ===== SCHEMA & MODEL (didefinisikan sekali di luar handler) =====
const rodSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String, default: "rod" },
  luck: { type: Number, default: 0 },
  speed: { type: Number, default: 0 },
  comboFish: { type: Number, default: 1 },
  comboMutations: { type: Number, default: 1 },
  mutationsLuck: { type: Number, default: 0 },
  sellMultiplier: { type: Number, default: 0 },
  price: { type: Number, default: 0 },
  enchant: { type: String, default: null },
  bonusStats: { type: Object, default: {} },
  description: { type: String, default: "" },
  level: { type: Number, default: 1 },
  maxLevel: { type: Number, default: 5 },
  exp: { type: Number, default: 0 },
  expToNextLevel: { type: Number, default: 100 },
  enchantCount: { type: Number, default: 0 }
}, { _id: false });

const playerSchema = new mongoose.Schema({
    id: { type: Number, unique: true },
    username: String,
    money: { type: Number, default: 200 },
    inventory: { type: Array, default: [] },
    level: { type: Number, default: 1 },
    exp: { type: Number, default: 0 },
    expToNextLevel: { type: Number, default: 100 },
    maxLevel: { type: Number, default: 2500 },
    usedFishingRod: { type: String, default: "basicrod" },
    fishingRods: { type: Map, of: rodSchema, default: {} },
    currentIsland: { type: String, default: "mousewood" },
    fishingPending: { type: Array, default: [] },
    fishFound: { type: Array, default: [] },
    mutationFound: { type: Array, default: [] },
    createdAt: { type: Date, default: Date.now },
    friends: { type: Array, default: [] },
    pendingFriends: { type: Array, default: [] },
    travelFound: { type: Array, default: [] },
    fishCaught: { type: Number, default: 0 },
    isVerifiedTelegram: { type: Boolean, default: false },
    whatsappNumber: { type: String, default: null },
    telegramId: { type: String, default: null },
    telegramUUID: { type: String, default: null },
    telegramConnectID: { type: String, default: null },
    telegramUsername:  { type: String, default: null },
    // Gacha & prestige
    gachaTickets:     { type: Number, default: 0 },
    gachaPity:        { type: Number, default: 0 },
    prestigeTokens:   { type: Number, default: 0 },
    prestige:         { type: Number, default: 0 },
    forcedRarity:     { type: String, default: null },
    title:            { type: String, default: null },
    seasonPoints:     { type: Number, default: 0 },
    seasonWins:       { type: Number, default: 0 },
    // Upgrades permanen
    luckUpgrade:      { type: Number, default: 0 },
    speedUpgrade:     { type: Number, default: 0 },
    sellUpgrade:      { type: Number, default: 0 },
    // Daily reward
    lastDaily:        { type: Date, default: null },
    dailyStreak:      { type: Number, default: 0 },
    // Active buffs dari gacha
    activeBoosts:     { type: Object, default: {} },
    islandCooldowns:  { type: Object, default: {} },
    ownedSkins:       { type: Array, default: () => ['default'] },
    equippedSkin:     { type: String, default: 'default' },
    // Achievements
    achievements:     { type: Array, default: [] },
    achievementPoints:{ type: Number, default: 0 },
    totalEarned:      { type: Number, default: 0 },
    rareFishCaught:   { type: Number, default: 0 },
    perfectCatches:   { type: Number, default: 0 },
    biggestFish:      { type: Object, default: null },
});

const Player = mongoose.models.Player || mongoose.model("Player", playerSchema);

const telegramSessionSchema = new mongoose.Schema({
    tempTelegramId: { type: String, required: true },
    tempWhatsAppNumber: { type: String, required: true },
    verificationCode: { type: String, required: true, index: true },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 5 * 60 * 1000) }, // 5 menit
    createdAt: { type: Date, default: Date.now }
});
// Auto-delete expired sessions
telegramSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const TelegramSession = mongoose.models.TelegramSession || mongoose.model("TelegramSession", telegramSessionSchema);

// ── BotConfig Schema — persist event state & feature flags ──
const botConfigSchema = new mongoose.Schema({
    _id: { type: String, default: 'main' }, // single doc
    gachaDisabled:      { type: Boolean, default: false },
    prestigeDisabled:   { type: Boolean, default: false },
    botGlobalOff:       { type: Boolean, default: false },
    bot2Disabled:       { type: Boolean, default: false },
    bot2PairingDisabled:{ type: Boolean, default: false },
    bot3Disabled:       { type: Boolean, default: false },
    bot3PairingDisabled:{ type: Boolean, default: false },
    activeEvent: {
        active:       { type: Boolean, default: false },
        name:         { type: String,  default: '' },
        desc:         { type: String,  default: '' },
        multiplier:   { type: Number,  default: 1 },
        bonusMutation:{ type: Number,  default: 0 },
        endTime:      { type: Date,    default: null },
    },
    globalLuckEvent: {
        active:     { type: Boolean, default: false },
        multiplier: { type: Number,  default: 1 },
        endTime:    { type: Date,    default: null },
        setBy:      { type: String,  default: null },
    },
    rainGoblinEvent: {
        active:  { type: Boolean, default: false },
        endTime: { type: Date,    default: null },
    },
    goldenShopEvent: {
        active:     { type: Boolean, default: false },
        multiplier: { type: Number,  default: 1 },
        endTime:    { type: Date,    default: null },
    },
    // per-bot console log toggle — key = botId (user.id)
    consoleMsgOn:    { type: Map, of: Boolean, default: {} },
    consoleMsgBotOn: { type: Map, of: Boolean, default: {} },
    logGroupJid:     { type: String, default: null },
});
const BotConfig = mongoose.models.BotConfig || mongoose.model('BotConfig', botConfigSchema);

// ── ChatPrefix Schema — persist per-chat prefix ────────
const chatPrefixSchema = new mongoose.Schema({
    _id: { type: String }, // chatJid
    prefix: { type: String, default: '!' },
});
const ChatPrefix = mongoose.models.ChatPrefix || mongoose.model('ChatPrefix', chatPrefixSchema);

// ── Anti-Feature Schema (AntiLink / AntiSwgc / AntiTagAll) ──
// Unified schema per fitur per grup
const antiFeatureSchema = new mongoose.Schema({
    _id:       { type: String }, // `${feature}:${groupJid}` e.g. "antilink:120363@g.us"
    feature:   { type: String }, // 'antilink' | 'antiswgc' | 'antitagall' | 'welcome'
    groupJid:  { type: String },
    enabled:   { type: Boolean, default: false },
    warnLimit: { type: Number,  default: 0 },
    warns:     { type: Object,  default: {} }, // { [senderNumber]: warnCount }
    welcomeMsg: { type: String, default: null }, // hanya dipakai untuk feature: 'welcome'
});
const AntiFeature = mongoose.models.AntiFeature || mongoose.model('AntiFeature', antiFeatureSchema);

// Backward compat — AntiLink lama tetap ada untuk migrasi
const antiLinkSchema = new mongoose.Schema({
    _id: { type: String },
    enabled: { type: Boolean, default: false },
    warnLimit: { type: Number, default: 0 },
    warns: { type: Object, default: {} },
});
const AntiLink = mongoose.models.AntiLink || mongoose.model('AntiLink', antiLinkSchema);

// ── In-memory cache untuk semua fitur ──
// { [groupJid]: boolean }
if (!global.ANTILINK_STATE)   global.ANTILINK_STATE   = {};
if (!global.ANTISWGC_STATE)   global.ANTISWGC_STATE   = {};
if (!global.ANTITAGALL_STATE) global.ANTITAGALL_STATE = {};
if (!global.ANTIGSM_STATE)    global.ANTIGSM_STATE    = {};
if (!global.WELCOME_STATE)    global.WELCOME_STATE    = {};
// { [groupJid]: number }
if (!global.ANTILINK_WARN_LIMIT)   global.ANTILINK_WARN_LIMIT   = {};
if (!global.ANTISWGC_WARN_LIMIT)   global.ANTISWGC_WARN_LIMIT   = {};
if (!global.ANTITAGALL_WARN_LIMIT) global.ANTITAGALL_WARN_LIMIT = {};
if (!global.ANTIGSM_WARN_LIMIT)    global.ANTIGSM_WARN_LIMIT    = {};
// { [groupJid]: { [senderKey]: warnCount } }
if (!global.ANTILINK_WARNS)   global.ANTILINK_WARNS   = {};
if (!global.ANTISWGC_WARNS)   global.ANTISWGC_WARNS   = {};
if (!global.ANTITAGALL_WARNS) global.ANTITAGALL_WARNS = {};
if (!global.ANTIGSM_WARNS)    global.ANTIGSM_WARNS    = {};

// ── Helper: resolve JID dari LID ──────────────────────────
async function resolveSenderJid(client, from, rawSender) {
    if (!rawSender.endsWith('@lid')) return rawSender.includes('@') ? rawSender : `${rawSender}@s.whatsapp.net`;
    try {
        const meta = await client.groupMetadata(from).catch(() => null);
        const lid  = rawSender.split('@')[0];
        const found = meta?.participants?.find(p =>
            p.lid === rawSender || (p.lid || '').split('@')[0] === lid
        );
        if (found?.id?.includes('@s.whatsapp.net')) return found.id;
        if (found?.phoneNumber) return `${String(found.phoneNumber).replace(/\D/g, '')}@s.whatsapp.net`;
    } catch (_) {}
    // fallback: client.findUserId — resolve LID langsung ke WA server,
    // tidak bergantung pada groupMetadata cache yang mungkin belum update
    try {
        const ids = await client.findUserId(rawSender);
        if (ids?.phoneNumber) return ids.phoneNumber;
    } catch (_) {}
    console.error('[resolveSenderJid] ⚠️ Gagal resolve LID, fallback ke raw:', rawSender);
    return rawSender;
}

// ── Helper: proses warn/kick untuk semua fitur ───────────
// forceKick: kalau true, langsung kick tanpa mempedulikan warnLimit

// ── sendAntiLog — kirim log pesan yang dihapus bot ke grup log ──
async function sendAntiLog(client, { feature, from, rawSender, body, m }) {
    const logJid = global.LOG_GROUP_JID;
    if (!logJid) return; // belum diset, skip
    try {
        const EMOJI_MAP = { antilink: '🔗', antiswgc: '📢', antitagall: '📣', antigsm: '📌' };
        const emoji = EMOJI_MAP[feature] || '⚠️';
        const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const groupMeta = await client.groupMetadata(from).catch(() => null);
        const groupName = groupMeta?.subject || from;
        // Resolve LID ke nomor HP
        let senderNum = rawSender?.split('@')[0] || 'unknown';
        if (rawSender?.endsWith('@lid')) {
            try {
                const ids = await client.findUserId(rawSender);
                if (ids?.phoneNumber) senderNum = ids.phoneNumber.split('@')[0];
            } catch (_) {}
        }

        let logText = `${emoji} *[LOG ANTI - ${feature.toUpperCase()}]*\n\n`;
        logText += `📅 Waktu  : ${now}\n`;
        logText += `👤 Sender : ${senderNum}\n`;
        logText += `🏠 Grup   : ${groupName}\n`;
        logText += `📝 Pesan  :\n${body || '(tidak ada teks)'}`;

        await client.sendMessage(logJid, { text: logText });
    } catch(e) {
        console.error('[AntiLog] Gagal kirim log:', e.message);
    }
}

async function handleAntiAction(client, from, rawSender, feature, labelAction, forceKick = false) {
    const STATE_MAP     = { antilink: global.ANTILINK_WARNS,   antiswgc: global.ANTISWGC_WARNS,   antitagall: global.ANTITAGALL_WARNS,   antigsm: global.ANTIGSM_WARNS   };
    const WARNLIM_MAP   = { antilink: global.ANTILINK_WARN_LIMIT, antiswgc: global.ANTISWGC_WARN_LIMIT, antitagall: global.ANTITAGALL_WARN_LIMIT, antigsm: global.ANTIGSM_WARN_LIMIT };
    const EMOJI_MAP     = { antilink: '🔗', antiswgc: '📢', antitagall: '📣', antigsm: '📌' };
    const emoji = EMOJI_MAP[feature] || '⚠️';

    const warnJid  = await resolveSenderJid(client, from, rawSender);
    const warnLimit = WARNLIM_MAP[feature]?.[from] ?? 0;
    const warns    = STATE_MAP[feature];

    // forceKick: abaikan warnLimit, langsung kick
    // Kick DULUAN sebelum kirim pesan warning — minimalkan jeda waktu
    // antara status masuk dan pengirim di-remove dari grup.
    if (forceKick) {
        try {
            const _kickRes = await client.groupParticipantsUpdate(from, [warnJid], 'remove');
            console.log(`[${feature}] Kick result (forceKick) | target: ${warnJid} |`, JSON.stringify(_kickRes));
        } catch (e) {
            console.error(`[${feature}] ❌ Kick gagal (forceKick) | target: ${warnJid} |`, e.message || e);
        }
        try {
            await client.sendMessage(from, {
                text: `${emoji} @${warnJid.split('@')[0]} *${labelAction}!*\nPesan dihapus & kamu telah di-kick dari grup.`,
                mentions: [warnJid]
            });
        } catch (_) {}
        return;
    }

    if (warnLimit === -1 || (warnLimit === 0 && feature === 'antiswgc')) {
        // warnLimit = -1 (antilink/antitagall/antigsm): langsung kick tanpa warn
        // warnLimit = 0  (antiswgc): hapus status + kick langsung
        // Kick DULUAN, baru kirim pesan warning (sama alasan di atas).
        try {
            const _kickRes = await client.groupParticipantsUpdate(from, [warnJid], 'remove');
            console.log(`[${feature}] Kick result | target: ${warnJid} |`, JSON.stringify(_kickRes));
        } catch (e) {
            console.error(`[${feature}] ❌ Kick gagal | target: ${warnJid} |`, e.message || e);
        }
        try {
            await client.sendMessage(from, {
                text: `${emoji} @${warnJid.split('@')[0]} *${labelAction}!*\nPesan dihapus & kamu telah di-kick dari grup.`,
                mentions: [warnJid]
            });
        } catch (_) {}
        try {
            const _kickRes = await client.groupParticipantsUpdate(from, [warnJid], 'remove');
            console.log(`[${feature}] Kick result | target: ${warnJid} |`, JSON.stringify(_kickRes));
        } catch (e) {
            console.error(`[${feature}] ❌ Kick gagal | target: ${warnJid} |`, e.message || e);
        }
    } else if (warnLimit === 0) {
        // warnLimit = 0 (antilink/antitagall/antigsm): hanya hapus pesan, tanpa warn/kick
        // diam saja — pesan sudah dihapus sebelum handleAntiAction dipanggil
    } else {
        if (!warns[from]) warns[from] = {};
        const userKey = warnJid.split('@')[0];
        warns[from][userKey] = (warns[from][userKey] || 0) + 1;
        const currentWarn = warns[from][userKey];
        const sisaWarn    = warnLimit - currentWarn;

        // Persist warns ke DB — gunakan $set dengan dot-notation agar Mongoose
        // benar-benar mendeteksi perubahan pada nested Object field
        try {
            await AntiFeature.findByIdAndUpdate(
                `${feature}:${from}`,
                { $set: { [`warns.${userKey}`]: warns[from][userKey] } },
                { upsert: true }
            );
        } catch (e) {
            console.error(`[${feature}] Gagal simpan warn ke DB:`, e.message);
        }

        if (currentWarn > warnLimit) {
            warns[from][userKey] = 0;
            try {
                await AntiFeature.findByIdAndUpdate(
                    `${feature}:${from}`,
                    { $set: { [`warns.${userKey}`]: 0 } },
                    { upsert: true }
                );
            } catch (_) {}
            try {
                await client.sendMessage(from, {
                    text: `🚫 @${warnJid.split('@')[0]} *Peringatan habis!*\nKamu telah di-kick.\nPesan dihapus.`,
                    mentions: [warnJid]
                });
            } catch (_) {}
            try { await client.groupParticipantsUpdate(from, [warnJid], 'remove'); } catch (_) {}
        } else {
            try {
                await client.sendMessage(from, {
                    text: `⚠️ @${warnJid.split('@')[0]} *Peringatan ${currentWarn}/${warnLimit}!*\n${labelAction}\nPesan dihapus.\n\n_${sisaWarn <= 0 ? 'Peringatan berikutnya = kick!' : `Sisa ${sisaWarn} peringatan sebelum kick.`}_`,
                    mentions: [warnJid]
                });
            } catch (_) {}
        }
    }
}

// ── Helper: simpan warn count ke DB (antilink lama) ──────
async function saveAntiLinkWarns(groupJid) {
    try {
        const warns = global.ANTILINK_WARNS?.[groupJid] || {};
        await AntiFeature.findByIdAndUpdate(`antilink:${groupJid}`, { warns }, { upsert: true });
    } catch (e) {
        console.error('[AntiLink] Gagal simpan warns:', e.message);
    }
}

// ── Helper: toggle anti feature (on/off) + simpan DB ─────
async function setAntiFeature(feature, groupJid, enabled, warnLimit = null) {
    const STATE_MAP   = { antilink: global.ANTILINK_STATE,   antiswgc: global.ANTISWGC_STATE,   antitagall: global.ANTITAGALL_STATE,   antigsm: global.ANTIGSM_STATE, welcome: global.WELCOME_STATE   };
    const WARNLIM_MAP = { antilink: global.ANTILINK_WARN_LIMIT, antiswgc: global.ANTISWGC_WARN_LIMIT, antitagall: global.ANTITAGALL_WARN_LIMIT, antigsm: global.ANTIGSM_WARN_LIMIT, welcome: {} };

    STATE_MAP[feature][groupJid] = enabled;
    if (warnLimit !== null) WARNLIM_MAP[feature][groupJid] = warnLimit;

    const currentLimit = WARNLIM_MAP[feature][groupJid] ?? 0;
    const update = { $set: { feature, groupJid, enabled, warnLimit: currentLimit } };
    // PENTING: jangan hapus warns yang sudah ada — hanya update enabled & warnLimit
    try {
        await AntiFeature.findByIdAndUpdate(
            `${feature}:${groupJid}`,
            update,
            { upsert: true }
        );
    } catch (e) { console.error(`[${feature}] Gagal simpan:`, e.message); }
}

async function setAntiWarnLimit(feature, groupJid, limit) {
    const WARNLIM_MAP = { antilink: global.ANTILINK_WARN_LIMIT, antiswgc: global.ANTISWGC_WARN_LIMIT, antitagall: global.ANTITAGALL_WARN_LIMIT, antigsm: global.ANTIGSM_WARN_LIMIT };

    WARNLIM_MAP[feature][groupJid] = limit;
    // PENTING: Jangan reset warns saat warnLimit diubah — cukup update limit-nya saja
    try {
        await AntiFeature.findByIdAndUpdate(
            `${feature}:${groupJid}`,
            { $set: { warnLimit: limit } },
            { upsert: true }
        );
    } catch (e) { console.error(`[${feature}] Gagal simpan warnLimit:`, e.message); }
}

// ── Welcome message saat ada member baru join grup ───────
async function handleGroupParticipantsUpdate(client, groupJid, participants, action) {
    if (action !== 'add') return; // hanya handle join, bukan leave/promote/demote
    if (!global.WELCOME_STATE?.[groupJid]) return; // fitur off / belum diatur

    try {
        const meta = await client.groupMetadata(groupJid).catch(() => null);
        const groupName  = meta?.subject || 'grup ini';
        const memberCount = meta?.participants?.length ?? '-';

        const customMsg = global.WELCOME_MSG?.[groupJid];

        for (const p of participants) {
            // itsliaaa/baileys bisa kirim participant sebagai string jid ATAU object {id, phoneNumber, jid, ...}
            let jid = typeof p === 'string' ? p : (p?.jid || p?.id || p?.phoneNumber || '');
            if (!jid) continue;

            // FIX: resolve LID -> nomor HP asli pakai findUserId() bawaan library,
            // biar teks & mention konsisten pakai JID yang sama dan tag-nya nyambung.
            try {
                const ids = await client.findUserId(jid);
                if (ids?.phoneNumber) jid = ids.phoneNumber;
            } catch (_) {}

            const rawNum = jid;
            const num = String(rawNum).split('@')[0];
            let text;
            if (customMsg) {
                text = customMsg
                    .replace(/@user/g, `@${num}`)
                    .replace(/@group/g, groupName)
                    .replace(/@count/g, String(memberCount));
            } else {
                text =
                    `👋 *Selamat datang* @${num}!\n\n` +
                    `Semoga betah di *${groupName}* ya 🎉\n` +
                    `Sekarang jumlah member: *${memberCount}*`;
            }
            await client.sendMessage(groupJid, { text, mentions: [jid] });
        }
    } catch (e) {
        console.error('[welcome] Gagal kirim welcome message:', e.message);
    }
}


async function loadAntiFeatureState(attempt = 1) {
    const MAX = 10;
    try {
        if (!isMongoConnected) throw new Error('MongoDB belum connect');

        // Load AntiFeature (baru)
        const docs = await AntiFeature.find({});
        for (const doc of docs) {
            const { feature, groupJid, enabled, warnLimit, warns } = doc;
            if (!groupJid || !feature) continue;
            if (feature === 'antilink') {
                global.ANTILINK_STATE[groupJid]     = enabled;
                global.ANTILINK_WARN_LIMIT[groupJid] = warnLimit ?? 0;
                global.ANTILINK_WARNS[groupJid]     = warns || {};
            } else if (feature === 'antiswgc') {
                global.ANTISWGC_STATE[groupJid]     = enabled;
                global.ANTISWGC_WARN_LIMIT[groupJid] = warnLimit ?? 0;
                global.ANTISWGC_WARNS[groupJid]     = warns || {};
            } else if (feature === 'antitagall') {
                global.ANTITAGALL_STATE[groupJid]     = enabled;
                global.ANTITAGALL_WARN_LIMIT[groupJid] = warnLimit ?? 0;
                global.ANTITAGALL_WARNS[groupJid]     = warns || {};
            } else if (feature === 'antigsm') {
                global.ANTIGSM_STATE[groupJid]     = enabled;
                global.ANTIGSM_WARN_LIMIT[groupJid] = warnLimit ?? 0;
                global.ANTIGSM_WARNS[groupJid]     = warns || {};
            } else if (feature === 'welcome') {
                global.WELCOME_STATE[groupJid] = enabled;
                if (!global.WELCOME_MSG) global.WELCOME_MSG = {};
                if (doc.welcomeMsg) global.WELCOME_MSG[groupJid] = doc.welcomeMsg;
            }
        }

        // Migrasi AntiLink lama → AntiFeature baru
        const oldDocs = await AntiLink.find({});
        for (const doc of oldDocs) {
            const gid = doc._id;
            if (!global.ANTILINK_STATE[gid]) {
                global.ANTILINK_STATE[gid]     = doc.enabled;
                global.ANTILINK_WARN_LIMIT[gid] = doc.warnLimit ?? 0;
                global.ANTILINK_WARNS[gid]     = doc.warns || {};
            }
        }

        console.log(`[AntiFeature] ✅ Loaded ${docs.length} record(s)`);
    } catch (e) {
        if (attempt < MAX) setTimeout(() => loadAntiFeatureState(attempt + 1), 5000);
        else console.error(`[AntiFeature] ❌ Gagal load setelah ${MAX}x: ${e.message}`);
    }
}
// Alias untuk backward compat
function loadAntiLinkState(attempt = 1) { return loadAntiFeatureState(attempt); }
setTimeout(() => loadAntiFeatureState(), 8000);

// ── BotRestrict Schema — bot hanya untuk admin grup ──────
const botRestrictSchema = new mongoose.Schema({
    _id: { type: String }, // groupJid
    adminOnly: { type: Boolean, default: false }, // true = hanya admin grup yang bisa pakai bot
});
const BotRestrict = mongoose.models.BotRestrict || mongoose.model('BotRestrict', botRestrictSchema);

// u2500u2500 BypassBG Schema u2014 grup yang bypass botglobal u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500u2500
const bypassBGSchema = new mongoose.Schema({
    _id: { type: String }, // groupJid
});
const BypassBG = mongoose.models.BypassBG || mongoose.model("BypassBG", bypassBGSchema);

async function loadBypassBG(attempt = 1) {
    const MAX = 10;
    try {
        if (!isMongoConnected) throw new Error("MongoDB belum connect");
        const docs = await BypassBG.find({});
        if (!global.BYPASS_BG_GROUPS) global.BYPASS_BG_GROUPS = new Set();
        for (const doc of docs) global.BYPASS_BG_GROUPS.add(doc._id);
        console.log(`[BypassBG] u✅ Loaded ${docs.length} group(s)`);
    } catch (e) {
        if (attempt < MAX) setTimeout(() => loadBypassBG(attempt + 1), 5000);
        else console.error(`[BypassBG] u❌ Gagal load setelah ${MAX}x: ${e.message}`);
    }
}
setTimeout(() => loadBypassBG(), 10000);

// u2500u2500 AutoSwgc Schema u2014 persist config autoswgc per user u2500u2500u2500u2500
const autoSwgcSchema = new mongoose.Schema({
    _id:          { type: String },
    target:       { type: String },
    intervalMs:   { type: Number },
    contentText:  { type: String, default: "" },
    mediaType:    { type: String, default: null },
    mediaBuffer:  { type: Buffer, default: null },
    chatId:       { type: String },
    botNumber:    { type: String },
});
const AutoSwgc = mongoose.models.AutoSwgc || mongoose.model("AutoSwgc", autoSwgcSchema);

// ── Helper AutoSWGC: pisahkan sesi running Bot1/Bot2 ─────────
// Dulu runKey hanya senderNumber, jadi Bot1 dan Bot2 bentrok di global.JPM_RUNNING.
function getAutoSwgcBotNumber(clientLike) {
    const id = String(clientLike?.user?.id || '').split(':')[0].split('@')[0].trim();
    return id || (clientLike?.isBot3 ? 'bot3' : (clientLike?.isBot2 ? 'bot2' : 'bot1'));
}
function getAutoSwgcRunKey(clientLike, senderNumber) {
    const botNumber = getAutoSwgcBotNumber(clientLike);
    const senderKey = String(senderNumber || '').replace(/\D/g, '') || String(senderNumber || 'unknown');
    return `autoswgc:${botNumber}:${senderKey}`;
}
function normalizeAutoSwgcRunKey(clientLike, savedKey) {
    const key = String(savedKey || '');
    if (key.startsWith('autoswgc:')) return key;
    return getAutoSwgcRunKey(clientLike, key);
}

// ── SwgcSkip Schema — daftar grup yang di-skip saat autoswgc all ──
const swgcSkipSchema = new mongoose.Schema({
    _id: { type: String }, // groupJid
    subject: { type: String, default: '' }, // nama grup (opsional, untuk info)
    addedAt: { type: Date, default: Date.now },
});
const SwgcSkip = mongoose.models.SwgcSkip || mongoose.model('SwgcSkip', swgcSkipSchema);

if (!global.SWGC_SKIP) global.SWGC_SKIP = new Set();

async function loadSwgcSkip(attempt = 1) {
    const MAX = 10;
    try {
        if (!isMongoConnected) throw new Error('MongoDB belum connect');
        const docs = await SwgcSkip.find({});
        if (!global.SWGC_SKIP) global.SWGC_SKIP = new Set();
        for (const doc of docs) global.SWGC_SKIP.add(doc._id);
        console.log(`[SwgcSkip] ✅ Loaded ${docs.length} group(s)`);
    } catch (e) {
        if (attempt < MAX) setTimeout(() => loadSwgcSkip(attempt + 1), 5000);
        else console.error(`[SwgcSkip] ❌ Gagal load setelah ${MAX}x: ${e.message}`);
    }
}
setTimeout(() => loadSwgcSkip(), 11000);

async function loadAutoSwgc(clientRef, attempt = 1) {
    const MAX = 10;
    try {
        if (!isMongoConnected) throw new Error("MongoDB belum connect");
        if (!clientRef) throw new Error("client belum siap");
        const myBotNumber = (clientRef.user?.id || "").split(":")[0].split("@")[0];
        const botLabel = myBotNumber.includes("82245823137") ? "Bot1" : myBotNumber;
        const docs = await AutoSwgc.find({ botNumber: myBotNumber });
        if (!docs.length) return;
        console.log(`[AutoSwgc][${botLabel}] ✅ Loaded ${docs.length} sesi dari DB, menjalankan ulang...`);
        if (!global.JPM_RUNNING) global.JPM_RUNNING = {};
        for (const doc of docs) {
            const runKey = normalizeAutoSwgcRunKey(clientRef, doc._id);
            if (global.JPM_RUNNING[runKey]) continue;

            // Migrasi data lama: _id dulu cuma nomor owner, sekarang dipisah per nomor bot.
            if (runKey !== String(doc._id)) {
                try {
                    await AutoSwgc.findByIdAndUpdate(runKey, {
                        target: doc.target,
                        intervalMs: doc.intervalMs,
                        contentText: doc.contentText || "",
                        mediaType: doc.mediaType || null,
                        mediaBuffer: doc.mediaBuffer || null,
                        chatId: doc.chatId,
                        botNumber: myBotNumber,
                    }, { upsert: true });
                    await AutoSwgc.findByIdAndDelete(doc._id);
                    console.log(`[AutoSwgc][${botLabel}] Migrasi sesi lama ${doc._id} -> ${runKey}`);
                } catch (e) {
                    console.error(`[AutoSwgc][${botLabel}] Gagal migrasi sesi lama:`, e.message);
                }
            }

            const state = {
                total: 0, round: 0, sent: 0, failed: 0,
                intervalMs: doc.intervalMs,
                delayMs: 6000,
                groupMentions: [],
                mediaBuffer: doc.mediaBuffer || null,
                mediaType: doc.mediaType || null,
                contentText: doc.contentText || "",
                cancelled: false,
                sleepTimer: null,
                chatId: doc.chatId,
                target: doc.target,
            };
            global.JPM_RUNNING[runKey] = state;
            ;(async () => {
                function fmtD(ms) {
                    if (ms >= 3600000) return `${ms/3600000}j`;
                    if (ms >= 60000) return `${ms/60000}m`;
                    return `${ms/1000}d`;
                }
                async function getGroupsRestore() {
                    if (state.target !== "all") return [{ id: state.target, subject: "Grup" }];
                    let groups = [];
                    try { const all = await clientRef.groupFetchAllParticipating(); groups = Object.values(all || {}); } catch (_) {}
                    const results = await Promise.allSettled(
                        groups.map(g => {
                            const gid = g.id || g.jid || "";
                            return clientRef.groupMetadata(gid)
                                .then(mt => ({ id: gid, subject: mt.subject || g.name || "Grup" }))
                                .catch(() => ({ id: gid, subject: g.name || "Grup" }));
                        })
                    );
                    return results.filter(r => r.status === "fulfilled" && r.value.id).map(r => r.value);
                }
                state.groupMentions = await getGroupsRestore();
                state.total = state.groupMentions.length;
                while (global.JPM_RUNNING[runKey] && !global.JPM_RUNNING[runKey].cancelled) {
                    state.round++;
                    for (const g of state.groupMentions) {
                        if (state.cancelled || !global.JPM_RUNNING[runKey]) break;
                        try {
                            let content = {};
                            if (state.mediaType === "image") content = { image: state.mediaBuffer, caption: state.contentText || "", groupStatus: true };
                            else if (state.mediaType === "video") content = { video: state.mediaBuffer, caption: state.contentText || "", groupStatus: true };
                            else content = { text: state.contentText || "", groupStatus: true };
                            const msgOpts = state.mediaType ? {} : { backgroundColor: randomBgColor() };
                            await clientRef.sendMessage(g.id, content, msgOpts);
                            state.sent++;
                        } catch (e) { state.failed++; }
                        await new Promise(r => setTimeout(r, state.delayMs || 3000));
                    }
                    if (!global.JPM_RUNNING[runKey] || global.JPM_RUNNING[runKey].cancelled) break;
                    await new Promise(r => {
                        if (!global.JPM_RUNNING[runKey] || global.JPM_RUNNING[runKey].cancelled) return r();
                        const t = setTimeout(r, state.intervalMs);
                        if (global.JPM_RUNNING[runKey]) global.JPM_RUNNING[runKey].sleepTimer = t;
                    });
                }
                delete global.JPM_RUNNING[runKey];
            })();
        }
    } catch (e) {
        if (attempt < MAX) setTimeout(() => loadAutoSwgc(clientRef, attempt + 1), 8000);
        else console.error(`[AutoSwgc][${botLabel}] ❌ Gagal load: ${e.message}`);
    }
}

// Cache in memory { [groupJid]: boolean }
if (!global.BOT_RESTRICT) global.BOT_RESTRICT = {};

async function loadBotRestrict(attempt = 1) {
    const MAX = 10;
    try {
        if (!isMongoConnected) throw new Error('MongoDB belum connect');
        const docs = await BotRestrict.find({});
        for (const doc of docs) {
            global.BOT_RESTRICT[doc._id] = doc.adminOnly;
        }
        console.log(`[BotRestrict] ✅ Loaded ${docs.length} group(s)`);
    } catch (e) {
        if (attempt < MAX) setTimeout(() => loadBotRestrict(attempt + 1), 5000);
        else console.error(`[BotRestrict] ❌ Gagal load setelah ${MAX}x: ${e.message}`);
    }
}
setTimeout(() => loadBotRestrict(), 9000);

// Load all saved prefixes into global.CHAT_PREFIX at startup
async function loadChatPrefixes(attempt = 1) {
    const MAX = 10;
    try {
        if (!isMongoConnected) throw new Error('MongoDB belum connect');
        if (!global.CHAT_PREFIX) global.CHAT_PREFIX = {};
        const docs = await ChatPrefix.find({});
        for (const doc of docs) {
            global.CHAT_PREFIX[doc._id] = doc.prefix;
        }
        console.log(`[ChatPrefix] ✅ Loaded ${docs.length} saved prefix(es)`);
    } catch(e) {
        if (attempt < MAX) {
            setTimeout(() => loadChatPrefixes(attempt + 1), 5000);
        } else {
            console.error(`[ChatPrefix] ❌ Gagal load setelah ${MAX}x: ${e.message}`);
        }
    }
}
setTimeout(() => loadChatPrefixes(), 7000);

// Helper: simpan semua state ke DB (fire-and-forget, tidak perlu await)
async function saveBotConfig() {
    try {
        // Konversi CONSOLE_MSG_STATE & CONSOLE_MSG_BOT_STATE (Map) ke plain object
        // agar tidak tertimpa saat saveBotConfig dipanggil
        const consoleMsgOnObj    = {};
        const consoleMsgBotOnObj = {};
        CONSOLE_MSG_STATE.forEach((v, k)    => { consoleMsgOnObj[k]    = v; });
        CONSOLE_MSG_BOT_STATE.forEach((v, k) => { consoleMsgBotOnObj[k] = v; });

        await BotConfig.findByIdAndUpdate('main', {
            $set: {
                gachaDisabled:    GACHA_DISABLED,
                prestigeDisabled: PRESTIGE_SYSTEM_DISABLED,
                botGlobalOff:     BOT_GLOBAL_OFF,
                bot2Disabled:     global.BOT2_DISABLED,
                bot2PairingDisabled: global.BOT2_PAIRING_DISABLED || false,
                bot3Disabled:     global.BOT3_DISABLED,
                bot3PairingDisabled: global.BOT3_PAIRING_DISABLED || false,
                activeEvent:      ACTIVE_EVENT,
                globalLuckEvent:  GLOBAL_LUCK_EVENT,
                rainGoblinEvent:  RAIN_GOBLIN_EVENT,
                goldenShopEvent:  GOLDEN_SHOP_EVENT,
                consoleMsgOn:     consoleMsgOnObj,
                consoleMsgBotOn:  consoleMsgBotOnObj,
                logGroupJid:      global.LOG_GROUP_JID || null,
            }
        }, { upsert: true });
    } catch(e) {
        console.error('[BotConfig] Gagal simpan:', e.message);
    }
}

// Load state dari DB saat startup, restore timer yang masih aktif
async function loadBotConfig(attempt = 1) {
    const MAX = 10;
    try {
        if (!isMongoConnected) throw new Error('MongoDB belum connect');
        const cfg = await BotConfig.findById('main');
        if (!cfg) return console.log('[BotConfig] Tidak ada config tersimpan, pakai default.');

        const now = Date.now();

        // Restore feature flags
        GACHA_DISABLED          = cfg.gachaDisabled    || false;
        PRESTIGE_SYSTEM_DISABLED = cfg.prestigeDisabled || false;
        BOT_GLOBAL_OFF           = cfg.botGlobalOff     || false;
        global.BOT2_DISABLED     = cfg.bot2Disabled     || false;
        global.BOT2_PAIRING_DISABLED = cfg.bot2PairingDisabled || false;
        global.BOT3_DISABLED     = cfg.bot3Disabled     || false;
        global.BOT3_PAIRING_DISABLED = cfg.bot3PairingDisabled || false;
        global.LOG_GROUP_JID     = cfg.logGroupJid     || null;
        if (global.LOG_GROUP_JID) console.log(`[BotConfig] ✅ Log Group dipulihkan: ${global.LOG_GROUP_JID}`);

        // Restore active event (bonus money)
        if (cfg.activeEvent?.active && cfg.activeEvent.endTime && new Date(cfg.activeEvent.endTime) > now) {
            ACTIVE_EVENT = { ...cfg.activeEvent.toObject?.() || cfg.activeEvent, endTime: new Date(cfg.activeEvent.endTime) };
            const rem = new Date(cfg.activeEvent.endTime) - now;
            setTimeout(() => { ACTIVE_EVENT.active = false; saveBotConfig(); console.log('[EVENT] bonus money berakhir'); }, rem);
            console.log(`[BotConfig] ✅ Active Event dipulihkan: ${ACTIVE_EVENT.name}`);
        }

        // Restore global luck event
        if (cfg.globalLuckEvent?.active && cfg.globalLuckEvent.endTime && new Date(cfg.globalLuckEvent.endTime) > now) {
            GLOBAL_LUCK_EVENT = { ...cfg.globalLuckEvent.toObject?.() || cfg.globalLuckEvent, endTime: new Date(cfg.globalLuckEvent.endTime).getTime() };
            const rem = GLOBAL_LUCK_EVENT.endTime - now;
            setTimeout(() => { GLOBAL_LUCK_EVENT.active = false; saveBotConfig(); }, rem);
            console.log(`[BotConfig] ✅ Luck Event dipulihkan: ×${GLOBAL_LUCK_EVENT.multiplier}`);
        }

        // Restore raining goblin
        if (cfg.rainGoblinEvent?.active && cfg.rainGoblinEvent.endTime && new Date(cfg.rainGoblinEvent.endTime) > now) {
            RAIN_GOBLIN_EVENT = { active: true, endTime: new Date(cfg.rainGoblinEvent.endTime).getTime() };
            mutations["Goblin"] = { multiplier: 999999, chance: 1.0 };
            const rem = RAIN_GOBLIN_EVENT.endTime - now;
            setTimeout(() => { RAIN_GOBLIN_EVENT.active = false; mutations["Goblin"] = { multiplier: 999999, chance: 0 }; saveBotConfig(); console.log('[EVENT] Goblin berakhir'); }, rem);
            console.log(`[BotConfig] ✅ Raining Goblin dipulihkan`);
        }

        // Restore golden shop
        if (cfg.goldenShopEvent?.active && cfg.goldenShopEvent.endTime && new Date(cfg.goldenShopEvent.endTime) > now) {
            GOLDEN_SHOP_EVENT = { active: true, multiplier: cfg.goldenShopEvent.multiplier || 1, endTime: new Date(cfg.goldenShopEvent.endTime).getTime() };
            const rem = GOLDEN_SHOP_EVENT.endTime - now;
            setTimeout(() => { GOLDEN_SHOP_EVENT.active = false; saveBotConfig(); console.log('[EVENT] Golden Shop berakhir'); }, rem);
            console.log(`[BotConfig] ✅ Golden Shop dipulihkan: ×${GOLDEN_SHOP_EVENT.multiplier}`);
        }

        if (GACHA_DISABLED)           console.log('[BotConfig] ⚠️  Gacha: DISABLED');
        if (PRESTIGE_SYSTEM_DISABLED) console.log('[BotConfig] ⚠️  Prestige: DISABLED');

        // Restore consoleMsgOn & consoleMsgBotOn ke in-memory Map
        if (cfg.consoleMsgOn instanceof Map)
            cfg.consoleMsgOn.forEach((v, k) => CONSOLE_MSG_STATE.set(k, v));
        else if (cfg.consoleMsgOn && typeof cfg.consoleMsgOn === 'object')
            Object.entries(cfg.consoleMsgOn).forEach(([k, v]) => CONSOLE_MSG_STATE.set(k, v));

        if (cfg.consoleMsgBotOn instanceof Map)
            cfg.consoleMsgBotOn.forEach((v, k) => CONSOLE_MSG_BOT_STATE.set(k, v));
        else if (cfg.consoleMsgBotOn && typeof cfg.consoleMsgBotOn === 'object')
            Object.entries(cfg.consoleMsgBotOn).forEach(([k, v]) => CONSOLE_MSG_BOT_STATE.set(k, v));

        console.log('[BotConfig] ✅ ConsoleMsgState dipulihkan dari MongoDB');

    } catch(e) {
        if (attempt < MAX) {
            setTimeout(() => loadBotConfig(attempt + 1), 5000);
        } else {
            console.error(`[BotConfig] ❌ Gagal load setelah ${MAX}x: ${e.message}`);
        }
    }
}
setTimeout(() => loadBotConfig(), 6000); // load setelah MongoDB siap

// ── Season History Schema ──────────────────────────
const seasonHistorySchema = new mongoose.Schema({
    seasonNumber: { type: Number, required: true },
    name:         { type: String, default: "" },
    startDate:    { type: Date, required: true },
    endDate:      { type: Date, required: true },
    winner1: { username: String, id: Number, points: Number },
    winner2: { username: String, id: Number, points: Number },
    winner3: { username: String, id: Number, points: Number },
    totalPlayers: { type: Number, default: 0 },
    createdAt:    { type: Date, default: Date.now },
});
const SeasonHistory = mongoose.models.SeasonHistory || mongoose.model("SeasonHistory", seasonHistorySchema);

// ── Custom List Schema ─────────────────────────────────
const customListSchema = new mongoose.Schema({
    group:      { type: String, required: true },
    listName:   { type: String, required: true },
    createdBy:  { type: String, default: '' },   // nomor HP pembuat
    creatorJid: { type: String, default: '' },   // raw JID untuk mention (@s.whatsapp.net / @lid)
    entries:  [{
        name:       { type: String, required: true },
        message:    { type: String, default: '' },
        addedBy:    { type: String, default: '' },   // nomor HP
        addedByJid: { type: String, default: '' },   // raw JID untuk mention
        addedAt:    { type: Date, default: Date.now },
    }],
    createdAt: { type: Date, default: Date.now },
});
customListSchema.index({ group: 1, listName: 1 }, { unique: true });
const CustomList = mongoose.models.CustomList || mongoose.model('CustomList', customListSchema);

// ── Global Season State (di-load dari DB atau default) ─
let currentSeason = {
    number: 1,
    name: "Season 1 — Age of Tides",
    startDate: new Date(),
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 hari default
    active: true,
};

// Load season state on startup — retry sampai MongoDB ready
async function loadSeasonFromDB(attempt = 1) {
    const MAX_ATTEMPT = 10;
    try {
        if (!isMongoConnected) throw new Error('MongoDB belum connect');
        const last = await SeasonHistory.findOne().sort({ seasonNumber: -1 });
        if (last) {
            currentSeason.number = last.seasonNumber + 1;
            currentSeason.name = `Season ${currentSeason.number}`;
            currentSeason.startDate = last.endDate || new Date();
        }
        console.log(`[SEASON] ✅ Season ${currentSeason.number} aktif | Berakhir: ${currentSeason.endDate.toLocaleDateString('id-ID')}`);
    } catch(e) {
        if (attempt < MAX_ATTEMPT) {
            console.log(`[SEASON] ⏳ Menunggu DB... retry ${attempt}/${MAX_ATTEMPT}`);
            setTimeout(() => loadSeasonFromDB(attempt + 1), 5000);
        } else {
            console.error(`[SEASON] ❌ Gagal load season setelah ${MAX_ATTEMPT}x: ${e.message}`);
            console.log(`[SEASON] ⚠️  Menggunakan Season default (Season 1)`);
        }
    }
}
setTimeout(() => loadSeasonFromDB(), 5000);

// ── Auto season reset cron (cek tiap jam) ─────────────
setInterval(async () => {
    try {
        if (!currentSeason.active) return;
        if (Date.now() < currentSeason.endDate.getTime()) return;
        console.log('[SEASON] ⏰ Season berakhir! Memproses reset...');
        await doSeasonReset(null);
    } catch(e) { console.error('[SEASON] auto-reset error:', e.message); }
}, 60 * 60 * 1000); // cek tiap 1 jam

async function doSeasonReset(adminReply) {
    try {
        // Ambil top 3
        const top3 = await Player.find({ seasonPoints: { $gt: 0 } })
            .sort({ seasonPoints: -1 }).limit(3);

        // Simpan ke history
        await SeasonHistory.create({
            seasonNumber: currentSeason.number,
            name: currentSeason.name,
            startDate: currentSeason.startDate,
            endDate: new Date(),
            winner1: top3[0] ? { username: top3[0].username, id: top3[0].id, points: top3[0].seasonPoints } : null,
            winner2: top3[1] ? { username: top3[1].username, id: top3[1].id, points: top3[1].seasonPoints } : null,
            winner3: top3[2] ? { username: top3[2].username, id: top3[2].id, points: top3[2].seasonPoints } : null,
            totalPlayers: await Player.countDocuments({ seasonPoints: { $gt: 0 } }),
        });

        // Beri hadiah ke top 3
        const prizes = [
            { rod: "omegaRod", tokens: 500, money: 10000000000000, title: "🥇 Season Champion" },
            { rod: "cosmicrod", tokens: 200, money: 1000000000000,  title: "🥈 Season Runner-up" },
            { rod: "voidrod",   tokens: 100, money: 100000000000,   title: "🥉 Season Bronze" },
        ];

        let announceText = `🏆 *SEASON ${currentSeason.number} BERAKHIR!*\n\n`;
        announceText += `📅 Durasi: ${currentSeason.startDate.toLocaleDateString('id-ID')} — ${new Date().toLocaleDateString('id-ID')}\n\n`;
        announceText += `🎖️ *PEMENANG:*\n`;

        for (let i = 0; i < Math.min(top3.length, 3); i++) {
            const winner = top3[i];
            const prize  = prizes[i];
            announceText += `${prize.title} *${winner.username}* — ${winner.seasonPoints} pts\n`;

            winner.title = prize.title.replace(/[🥇🥈🥉] /, '');
            winner.money = (winner.money || 0) + prize.money;
            winner.prestigeTokens = (winner.prestigeTokens || 0) + prize.tokens;
            winner.seasonWins = (winner.seasonWins || 0) + 1;
            if (!winner.fishingRods.get(prize.rod)) {
                winner.fishingRods.set(prize.rod, { ...fishingRod[prize.rod] });
                winner.markModified('fishingRods');
            }
            await winner.save();
        }

        announceText += `\n🎁 Hadiah telah dikirim ke pemenang!\n`;
        announceText += `🔄 Season baru dimulai sekarang!`;

        // Reset semua season points
        await Player.updateMany({}, { $set: { seasonPoints: 0 } });

        // Set season baru
        currentSeason = {
            number: currentSeason.number + 1,
            name: `Season ${currentSeason.number + 1}`,
            startDate: new Date(),
            endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            active: true,
        };

        console.log(`[SEASON] ✅ Season ${currentSeason.number} dimulai!`);
        if (adminReply) adminReply(announceText);
        return announceText;
    } catch(e) {
        console.error('[doSeasonReset]', e.message);
        if (adminReply) adminReply('❌ Error saat reset season: ' + e.message);
    }
}

// ===== END OF TOP-LEVEL INIT =====

// Init Telegram bot — dipanggil sekali di level module
// Delay 3s agar mongoose sempat connect dulu
setTimeout(() => {
    try {
        initTelegram(config, Player, TelegramSession);
    } catch (e) {
        console.error('[TELEGRAM] Init error:', e.message);
    }
}, 3000);


// ===== HELPERS & CONSTANTS (top-level) =====



// ===== HELPER FUNCTIONS =====

function mapHas(mapLike, key) {
    if (!mapLike) return false;
    return mapLike instanceof Map ? mapLike.has(key) : Object.prototype.hasOwnProperty.call(mapLike, key);
}

function mapGet(mapLike, key) {
    if (!mapLike) return undefined;
    return mapLike instanceof Map ? mapLike.get(key) : mapLike[key];
}

function mapSet(mapLike, key, value) {
    if (mapLike instanceof Map) mapLike.set(key, value);
    else mapLike[key] = value;
}

async function ensurePlayerDefaults(user) {
    if (!user) return user;
    let changed = false;

    if (!Array.isArray(user.inventory)) { user.inventory = []; changed = true; }
    if (!Array.isArray(user.fishFound)) { user.fishFound = []; changed = true; }
    if (!Array.isArray(user.mutationFound)) { user.mutationFound = []; changed = true; }
    if (!Array.isArray(user.fishingPending)) { user.fishingPending = []; changed = true; }
    if (!Array.isArray(user.travelFound)) { user.travelFound = []; changed = true; }
    if (!Array.isArray(user.friends)) { user.friends = []; changed = true; }
    if (!Array.isArray(user.pendingFriends)) { user.pendingFriends = []; changed = true; }
    if (!user.activeBoosts || typeof user.activeBoosts !== 'object') { user.activeBoosts = {}; changed = true; }
    if (!user.islandCooldowns || typeof user.islandCooldowns !== 'object') { user.islandCooldowns = {}; changed = true; }

    if (!Array.isArray(user.ownedSkins) || user.ownedSkins.length === 0) {
        user.ownedSkins = ['default'];
        changed = true;
    } else if (!user.ownedSkins.includes('default')) {
        user.ownedSkins.push('default');
        changed = true;
    }
    if (!user.equippedSkin) { user.equippedSkin = 'default'; changed = true; }

    if (!user.usedFishingRod) { user.usedFishingRod = 'basicrod'; changed = true; }
    if (!user.fishingRods) { user.fishingRods = new Map(); changed = true; }
    if (!(user.fishingRods instanceof Map)) {
        user.fishingRods = new Map(Object.entries(user.fishingRods || {}));
        changed = true;
    }

    if (!mapHas(user.fishingRods, 'basicrod')) {
        const defaultRod = (typeof fishingRod !== 'undefined' && fishingRod.basicrod)
            ? { ...fishingRod.basicrod }
            : { name: 'Basic Fishing Rod', type: 'rod', luck: 0, speed: 0, comboFish: 1, comboMutations: 1, mutationsLuck: 0, price: 0, level: 1, maxLevel: 5, exp: 0, expToNextLevel: 100 };
        mapSet(user.fishingRods, 'basicrod', defaultRod);
        changed = true;
    }

    if (!mapHas(user.fishingRods, user.usedFishingRod)) {
        user.usedFishingRod = 'basicrod';
        changed = true;
    }

    if (changed) {
        user.markModified('fishingRods');
        user.markModified('inventory');
        user.markModified('islandCooldowns');
        user.markModified('ownedSkins');
        user.markModified('activeBoosts');
        await user.save();
    }
    return user;
}

async function getOrCreateUser(senderNumber, telegramId = null, pushname = null) {
  let query = senderNumber
    ? { whatsappNumber: senderNumber }
    : { telegramId };

  let user = await Player.findOne(query);

  if (!user) {
    // Gunakan pushname WA jika ada, fallback ke Player+counter
    let username = pushname ? pushname.trim().slice(0, 30) : null;
    if (username) {
        // Pastikan username unik
        const taken = await Player.exists({ username });
        if (taken) username = username + '_' + Math.floor(Math.random() * 9000 + 1000);
    } else {
        username = await generateUniqueUsername();
    }

    user = new Player({
      id: await generatePlayerId(),
      username: username,
      money: 200,
      inventory: [],
      level: 1,
      exp: 0,
      expToNextLevel: 100,
      maxLevel: 2500,
      usedFishingRod: "basicrod",
      fishingRods: {
        basicrod: {
          name: "Basic Fishing Rod",
          type: "rod",
          luck: 0.00,
          speed: 0.00,
          comboFish: 1,
          comboMutations: 1,
          mutationsLuck: 0.000,
          price: 0,
          enchant: null,
          bonusStats: {},
          description: "",
          level: 1,
          maxLevel: 5,
          exp: 0,
          expToNextLevel: 100
        }
      },
      currentIsland: "mousewood",
      fishingPending: [],
      fishFound: [],
      mutationFound: [],
      createdAt: Date.now(),
      friends: [],
      pendingFriends: [],
      travelFound: [],
      fishCaught: 0,
      islandCooldowns: {},
      ownedSkins: ['default'],
      equippedSkin: 'default',
      isVerifiedTelegram: !!telegramId,
      whatsappNumber: senderNumber || null,
      telegramId: telegramId || null,
      telegramUUID: null,
      telegramConnectID: null
    });

    try {
      await user.save();
    } catch (err) {
      if (err && err.code === 11000) {
        user = await Player.findOne(query);
      } else {
        throw err;
      }
    }
  } else if (pushname && /^Player\d+$/.test(user.username)) {
    // Auto-update nama jika masih default Player+angka dan pushname tersedia
    let newName = pushname.trim().slice(0, 30);
    const taken = await Player.exists({ username: newName, _id: { $ne: user._id } });
    if (!taken) {
        user.username = newName;
        await user.save();
    }
  }

  return ensurePlayerDefaults(user);
}

async function importFishingJSON() {
    const dbPath = path.join(__dirname, "fishing.json");

    if (!fs.existsSync(dbPath)) {
        return;
    }

    const rawData = fs.readFileSync(dbPath, "utf-8");
    let data;
    try {
        data = JSON.parse(rawData);
    } catch (err) {
        return;
    }

    let addedCount = 0;
    let skippedCount = 0;

    for (const [number, playerData] of Object.entries(data)) {
        const exists = await Player.findOne({ id: playerData.id });
        if (exists) {
            skippedCount++;
            continue;
        }

        const newPlayer = new Player(playerData);
        await newPlayer.save();
        addedCount++;
    }

    return `✅ Import selesai: ${addedCount} player ditambahkan, ${skippedCount} player sudah ada dan dilewati.`
}

async function generateUniqueUsername() {
    let counter = 1;
    let username;
    let exists = true;

    while (exists) {
        username = "Player" + counter;
        exists = await Player.exists({ username });
        counter++;
    }

    return username;
}

async function generatePlayerId() {
    const lastUser = await Player.findOne().sort({ id: -1 }).exec();

    const lastId = (lastUser?.id && !isNaN(lastUser.id) && isFinite(lastUser.id))
        ? parseInt(lastUser.id, 10)
        : 10000000;

    return lastId + 1;
}

async function addRodExp(user, rodKey, amount) {
    const rod = user.fishingRods.get(rodKey);
    if (!rod || rod.level >= rod.maxLevel) return null;

    const safeAmount = (isNaN(amount) || !isFinite(amount)) ? 0 : Math.floor(amount);
    rod.exp = (isNaN(rod.exp) ? 0 : rod.exp) + safeAmount;
    let levelUp = false;
    let statsIncreased = [];

    while (rod.exp >= rod.expToNextLevel && rod.level < rod.maxLevel) {
        rod.exp -= rod.expToNextLevel;
        rod.level++;
        levelUp = true;
        rod.expToNextLevel = 100 * rod.level;

        rod.speed += 0.01;
        statsIncreased.push(`Speed +0.01`);

        if (rod.level % 3 === 0) {
            rod.sellMultiplier = (rod.sellMultiplier || 1) + 0.1;
            statsIncreased.push(`Sell Multiplier +0.1`);
        }

        if (rod.level % 5 === 0) {
            rod.luck += 0.01;
            statsIncreased.push(`Luck +0.01`);
        }

        if (rod.level % 10 === 0) {
            rod.mutationsLuck += 0.0001;
            statsIncreased.push(`Mutations Luck +0.0001`);
        }
    }

    if (levelUp) {
        user.markModified(`fishingRods`);
        await user.save();
        return `🎣 Rod *${rod.name}* naik ke level ${rod.level}!\n✨ Stats meningkat: ${statsIncreased.join(", ")}`;
    }

    return null;
}

function addPlayerExp(user, amount) {
  if (user.level >= user.maxLevel) {
    return `🏆 Kamu sudah mencapai level maksimal (${user.maxLevel})!`;
  }

  const safeAmount = (isNaN(amount) || !isFinite(amount)) ? 0 : Math.floor(amount);
  user.exp = (isNaN(user.exp) ? 0 : user.exp) + safeAmount;
  let levelUpMsg = "";

  while (user.exp >= user.expToNextLevel && user.level < user.maxLevel) {
    user.exp -= user.expToNextLevel;
    user.level++;
    user.expToNextLevel = 300 + (user.level * 50);
    levelUpMsg += `🧍 Kamu naik ke level ${user.level}!\n`;
    if (user.level >= 2500) {
      // Kasih Nolep Rod kalau belum punya
      if (!user.fishingRods) user.fishingRods = new Map();
      const hasNolep = user.fishingRods instanceof Map
        ? user.fishingRods.has('noleprod')
        : user.fishingRods['noleprod'];
      if (!hasNolep) {
        const nolepData = { ...fishingRod['noleprod'] };
        if (user.fishingRods instanceof Map) user.fishingRods.set('noleprod', nolepData);
        else user.fishingRods['noleprod'] = nolepData;
        levelUpMsg += `\n🏆 *SELAMAT! Kamu mencapai Level 2500!*\n🎣 Kamu mendapatkan *Nolep Rod*!\nBukti nyata kamu tidak punya kehidupan. 🗿\n`;
      }
    }
  }

  return levelUpMsg;
}

// ═══════════════ BLACKJACK HELPERS ═══════════════
function bjCreateDeck() {
    const suits = ['♠️', '♥️', '♦️', '♣️'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const deck = [];
    for (const s of suits) for (const r of ranks) deck.push({ rank: r, suit: s });
    // shuffle (Fisher-Yates)
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function bjHandValue(hand) {
    let total = 0, aces = 0;
    for (const c of hand) {
        if (c.rank === 'A') { total += 11; aces++; }
        else if (['J', 'Q', 'K'].includes(c.rank)) total += 10;
        else total += parseInt(c.rank);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
}

function bjRenderHand(hand, hideSecond = false) {
    if (hideSecond) return `${hand[0].rank}${hand[0].suit} 🂠`;
    return hand.map(c => `${c.rank}${c.suit}`).join(' ');
}

function bjIsBlackjack(hand) {
    return hand.length === 2 && bjHandValue(hand) === 21;
}

// ── Reusable blackjack actions (dipakai oleh command teks !hit/!stand/!double DAN reaction handler) ──
async function bjHit(senderNumber, pushname, reply) {
    const game = BLACKJACK_GAMES.get(senderNumber);
    if (!game || game.status !== 'playing') return reply('❌ Kamu tidak sedang main blackjack. Ketik !bj <taruhan> untuk mulai.');

    const user = await getOrCreateUser(senderNumber, null, pushname);
    game.playerHand.push(game.deck.pop());
    const val = bjHandValue(game.playerHand);

    if (val > 21) {
        game.status = 'done';
        BLACKJACK_GAMES.delete(senderNumber);
        return reply(
            `🃏 *BUST!*\n\n` +
            `👤 Tanganmu: ${bjRenderHand(game.playerHand)} (${val})\n\n` +
            `😵 Kamu melebihi 21! Kalah ${formatMoney(game.bet)}.\n💰 Saldo: ${formatMoney(user.money)}`
        );
    }

    return reply(
        `🃏 Kamu ambil kartu.\n\n` +
        `🎰 Dealer: ${bjRenderHand(game.dealerHand, true)}\n` +
        `👤 Tanganmu: ${bjRenderHand(game.playerHand)} (${val})\n\n` +
        `Ketik *!hit* lagi atau *!stand* untuk berhenti.\n` +
        `_(atau react 👊 hit / ⛔ stand di pesan ini)_`
    ).then(sentMsg => { if (sentMsg?.key) game.messageKey = sentMsg.key; return sentMsg; });
}

async function bjStand(senderNumber, pushname, reply) {
    const game = BLACKJACK_GAMES.get(senderNumber);
    if (!game || game.status !== 'playing') return reply('❌ Kamu tidak sedang main blackjack. Ketik !bj <taruhan> untuk mulai.');

    const user = await getOrCreateUser(senderNumber, null, pushname);
    game.status = 'done';

    while (bjHandValue(game.dealerHand) < 17) {
        game.dealerHand.push(game.deck.pop());
    }

    const playerVal = bjHandValue(game.playerHand);
    const dealerVal = bjHandValue(game.dealerHand);
    let resultText, payout;

    if (dealerVal > 21 || playerVal > dealerVal) {
        payout = game.bet * 2;
        resultText = `🎉 Kamu menang ${formatMoney(payout)}!`;
    } else if (playerVal === dealerVal) {
        payout = game.bet;
        resultText = `🤝 Seri! Taruhan dikembalikan.`;
    } else {
        payout = 0;
        resultText = `😵 Kamu kalah ${formatMoney(game.bet)}.`;
    }

    if (payout > 0) { user.money += payout; await user.save(); }
    BLACKJACK_GAMES.delete(senderNumber);

    return reply(
        `🃏 *HASIL BLACKJACK*\n\n` +
        `🎰 Dealer: ${bjRenderHand(game.dealerHand)} (${dealerVal})\n` +
        `👤 Tanganmu: ${bjRenderHand(game.playerHand)} (${playerVal})\n\n` +
        `${resultText}\n💰 Saldo: ${formatMoney(user.money)}`
    );
}

async function bjDouble(senderNumber, pushname, reply) {
    const game = BLACKJACK_GAMES.get(senderNumber);
    if (!game || game.status !== 'playing') return reply('❌ Kamu tidak sedang main blackjack. Ketik !bj <taruhan> untuk mulai.');
    if (game.playerHand.length > 2) return reply('❌ Double down cuma bisa dilakukan di kartu pertama (belum hit).');

    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (user.money < game.bet) return reply(`❌ Saldo tidak cukup untuk double down. Butuh ${formatMoney(game.bet)} lagi.`);

    user.money -= game.bet;
    game.bet *= 2;
    await user.save();

    game.playerHand.push(game.deck.pop());
    const playerVal = bjHandValue(game.playerHand);

    if (playerVal > 21) {
        game.status = 'done';
        BLACKJACK_GAMES.delete(senderNumber);
        return reply(
            `🃏 *DOUBLE DOWN — BUST!*\n\n` +
            `🎰 Dealer: ${bjRenderHand(game.dealerHand, true)}\n` +
            `👤 Tanganmu: ${bjRenderHand(game.playerHand)} (${playerVal})\n\n` +
            `😵 Melebihi 21! Kalah ${formatMoney(game.bet)}.\n💰 Saldo: ${formatMoney(user.money)}`
        );
    }

    game.status = 'done';
    while (bjHandValue(game.dealerHand) < 17) {
        game.dealerHand.push(game.deck.pop());
    }
    const dealerVal = bjHandValue(game.dealerHand);
    let resultText, payout;

    if (dealerVal > 21 || playerVal > dealerVal) {
        payout = game.bet * 2;
        resultText = `🎉 Kamu menang ${formatMoney(payout)}!`;
    } else if (playerVal === dealerVal) {
        payout = game.bet;
        resultText = `🤝 Seri! Taruhan dikembalikan.`;
    } else {
        payout = 0;
        resultText = `😵 Kamu kalah ${formatMoney(game.bet)}.`;
    }

    if (payout > 0) { user.money += payout; await user.save(); }
    BLACKJACK_GAMES.delete(senderNumber);

    return reply(
        `🃏 *DOUBLE DOWN — HASIL*\n\n` +
        `🎰 Dealer: ${bjRenderHand(game.dealerHand)} (${dealerVal})\n` +
        `👤 Tanganmu: ${bjRenderHand(game.playerHand)} (${playerVal})\n\n` +
        `${resultText}\n💰 Saldo: ${formatMoney(user.money)}`
    );
}

// Handler dipanggil dari index.js saat ada reaction ke pesan game blackjack
async function handleBlackjackReaction(client, senderNumber, emoji, reactedKey, pushname) {
    const game = BLACKJACK_GAMES.get(senderNumber);
    if (!game || game.status !== 'playing' || !game.chatId) return;

    // Cuma proses kalau reaction ada di pesan game blackjack yang aktif, bukan pesan lain
    if (!game.messageKey?.id || !reactedKey?.id || reactedKey.id !== game.messageKey.id) return;

    const reply = (teks) => client.sendMessage(game.chatId, { text: String(teks) });

    if (emoji === '👊') return bjHit(senderNumber, pushname, reply);
    if (emoji === '⛔') return bjStand(senderNumber, pushname, reply);
    if (emoji === '2️⃣' || emoji === '2⃣') return bjDouble(senderNumber, pushname, reply);
}

function mutationChance(mutationsObj, maxCount = 1, bonus = 0) {
    // ── Raining Goblin Event: semua pancingan pasti mutasi Goblin ──
    if (RAIN_GOBLIN_EVENT.active && Date.now() < RAIN_GOBLIN_EVENT.endTime) {
        return ["Goblin"];
    }

    const keys = Object.keys(mutationsObj);

    const found = [];
    for (const key of keys) {
        if (found.length >= maxCount) break;
        const m = mutationsObj[key];

        const baseChance = m?.chance || 0;
        const finalChance = Math.max(0, Math.pow(baseChance, 3) + (bonus || 0));

        if (Math.random() < finalChance) {
            found.push(key);
        }
    }

    if (found.length === 0) return ["Normal"];
    return found;
}

function getRandomFish(rod, island = "mousewood", perfectCatch = false, senderNumber = null) {
    const islandData = islands[island];
    if (!islandData) throw new Error(`Pulau "${island}" tidak ditemukan!`);

    const fishList = islandData.listFish;

    // Admin forced rarity (one-shot) — cek dari FORCED_RARITY Map ATAU rod._forcedRarity
    // Mengabaikan pulau — ambil dari SEMUA ikan di game biar bisa dapat ikan manapun
    let forcedChosen = null;
    const forcedRarityVal = rod?._forcedRarity || null;
    let forcedKey = null;
    if (!forcedRarityVal && senderNumber) {
        if (FORCED_RARITY.has(senderNumber)) forcedKey = senderNumber;
        if (!forcedKey) {
            const cleanSender = String(senderNumber).replace(/\D/g, '');
            for (const [k] of FORCED_RARITY) {
                if (String(k).replace(/\D/g, '') === cleanSender) { forcedKey = k; break; }
            }
        }
    }
    const resolvedForcedRar = forcedRarityVal || (forcedKey ? FORCED_RARITY.get(forcedKey) : null);
    if (resolvedForcedRar) {
        if (forcedKey) FORCED_RARITY.delete(forcedKey);
        // Ambil dari SEMUA pulau, bukan hanya pulau saat ini
        const allFishInGame = Object.values(islands).flatMap(isl => isl.listFish || []);
        const forcedList = allFishInGame.filter(f => f.rarity === resolvedForcedRar);
        if (forcedList.length > 0) {
            forcedChosen = forcedList[Math.floor(Math.random() * forcedList.length)];
        } else {
            // Rarity ga ada ikannya — fallback ke rarity tertinggi yang ada
            const rarityOrder = ['special','cataclysmic','apex','limited','extinct','gemstone','fragment','relic','secret','exotic','godly','mythic','legendary','epic','rare','uncommon','common'];
            for (const r of rarityOrder) {
                const fallbackList = allFishInGame.filter(f => f.rarity === r);
                if (fallbackList.length > 0) {
                    forcedChosen = fallbackList[Math.floor(Math.random() * fallbackList.length)];
                    break;
                }
            }
        }
    }

        const enchant = (rod?.enchant && rodEnchants[rod.enchant]?.effect) ? rodEnchants[rod.enchant] : null;

    const baseLuck = rod?.baseLuck ?? 1.0; // base luck player, tidak mempengaruhi rarityBoostMap
    let luckBonus = (rod?.luck || 0); // bonus dari rod — ini yang mempengaruhi rarity weight
    if (enchant?.effect?.luck) luckBonus += (enchant.effect.luck - 1);

    const rarityChance = {
        common: 50, uncommon: 30, rare: 12, epic: 5,
        legendary: 2, mythic: 0.8, godly: 0.4, exotic: 0.3,
        secret: 0.1, relic: 0.05, fragment: 0.03, gemstone: 0.02,
        extinct: 0.01, limited: 0.008, apex: 0.005,
        cataclysmic: 0.003, special: 0.001
    };

    const rarityBoostMap = {
        common: 1 - (luckBonus * 0.5),
        uncommon: 1 - (luckBonus * 0.3),
        rare: 1 + (luckBonus * 0.2),
        epic: 1 + (luckBonus * 0.5),
        legendary: 1 + (luckBonus * 0.8),
        mythic: 1 + (luckBonus * 1.2),
        godly: 1 + (luckBonus * 2.0),
        exotic: 1 + (luckBonus * 2.5),
        secret: 1 + (luckBonus * 3.5),
        relic: 1 + (luckBonus * 4.0),
        fragment: 1 + (luckBonus * 4.5),
        gemstone: 1 + (luckBonus * 5.0),
        extinct: 1 + (luckBonus * 6.0),
        limited: 1 + (luckBonus * 6.5),
        apex: 1 + (luckBonus * 7.0),
        cataclysmic: 1 + (luckBonus * 8.0),
        special: 1 + (luckBonus * 10.0)
    };

    const adjustedFishList = fishList.map(f => {
        const baseChance  = rarityChance[f.rarity] || 1;
        const rarityBoost = rarityBoostMap[f.rarity] || 1;
        return {
            ...f,
            adjChance: Math.max(baseChance * rarityBoost, 0.1)
        };
    });

const totalChance = adjustedFishList.reduce((a, b) => a + b.adjChance, 0);

let chosen;
if (forcedChosen) {
    chosen = adjustedFishList.find(f => f.name === forcedChosen.name) || { ...forcedChosen, adjChance: 1 };
} else {
    const roll = Math.random() * totalChance;
    let acc = 0;
    chosen = adjustedFishList[0];
    for (let fish of adjustedFishList) {
        acc += fish.adjChance;
        if (roll <= acc) {
            chosen = fish;
            break;
        }
    }
}

    const minKg  = (isNaN(chosen.minKg)   || chosen.minKg   == null) ? 0.1  : chosen.minKg;
    const maxKg  = (isNaN(chosen.maxKg)   || chosen.maxKg   == null) ? 1.0  : chosen.maxKg;
    const avgVal = (isNaN(chosen.avgValue) || chosen.avgValue == null) ? 100  : chosen.avgValue;

    let weight = minKg + Math.random() * (maxKg - minKg);

    if (Math.random() < 0.03) {
        const hugeMultiplier = 1.8 + Math.random() * 4.7;
        weight *= hugeMultiplier;
        chosen.name = "🌟 " + chosen.name;
    }

    if (enchant?.effect?.fishSize) weight *= enchant.effect.fishSize;
    weight = parseFloat(weight.toFixed(2));

    let totalPrice = Math.round(avgVal * weight);

    let baseMutationLuck = rod?.mutationsLuck || 0;
    if (enchant?.effect?.mutationChance) baseMutationLuck += enchant.effect.mutationChance;
    if (enchant?.effect?.mutationChanceBonus) baseMutationLuck += enchant.effect.mutationChanceBonus;

    let maxMutations = Math.max(1, rod?.comboMutations || 1);
    let mutationList = mutationChance(mutations, maxMutations, baseMutationLuck);

    if (mutationList.length === 0) {
        mutationList = ["Normal"];
    } else {
        const totalMultiplier = mutationList.reduce(
            (mult, key) => mult * (mutations[key]?.multiplier || 1),
            1
        );
        totalPrice = Math.round(totalPrice * totalMultiplier);
    }

    if (enchant?.effect?.sellValue) totalPrice = Math.round(totalPrice * enchant.effect.sellValue);
    if (enchant?.effect?.sellMultiplier) totalPrice = Math.round(totalPrice * enchant.effect.sellMultiplier);
    
    const rodSellMultiplier = 1 + (rod?.sellMultiplier || 0);
    totalPrice = Math.round(totalPrice * rodSellMultiplier);
    
    let progressSpeedMultiplier = 1;
    if (enchant?.effect?.progressSpeed) progressSpeedMultiplier *= enchant.effect.progressSpeed;
    if (enchant?.effect?.progressSpeedChance) {
        let chanceHigh = enchant.effect.progressSpeedChance[0];
        let lowValue = enchant.effect.progressSpeedChance[1];
        progressSpeedMultiplier *= Math.random() < chanceHigh ? 1.9 : 1 + lowValue;
    }

    if (enchant?.effect?.perPerfectCatch && perfectCatch) {
        progressSpeedMultiplier += enchant.effect.perPerfectCatch;
        if (enchant?.effect?.maxBonus) progressSpeedMultiplier = Math.min(progressSpeedMultiplier, 1 + enchant.effect.maxBonus);
    }
    if (enchant?.effect?.perRegularCatch && !perfectCatch) {
        progressSpeedMultiplier += enchant.effect.perRegularCatch;
        if (enchant?.effect?.maxBonus) progressSpeedMultiplier = Math.max(progressSpeedMultiplier, 1);
    }

    return {
        name: chosen.name,
        rarity: chosen.rarity,
        type: "fish",
        kg: weight,
        pricePerKg: chosen.avgValue,
        price: totalPrice,
        mutations: mutationList,
        isMutated: mutationList.length > 0 && !(mutationList.length === 1 && mutationList[0] === "Normal"),
        progressSpeedMultiplier
    };
}

function generateId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function similarity(a, b) {
    let longer = a.length > b.length ? a : b;
    let shorter = a.length > b.length ? b : a;
    let longerLength = longer.length;
    if (longerLength === 0) return 1.0;
    return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();

    let costs = new Array();
    for (let i = 0; i <= a.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= b.length; j++) {
            if (i === 0) costs[j] = j;
            else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (a.charAt(i - 1) !== b.charAt(j - 1))
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) costs[b.length] = lastValue;
    }
    return costs[b.length];
}

async function findUserByIdOrName(query) {
    let user = null;

    const numId = Number(query);
    if (query !== null && query !== undefined && String(query).trim() !== '' && !isNaN(numId) && isFinite(numId)) {
        user = await Player.findOne({ id: numId });
    }

    if (!user) {
        user = await Player.findOne({ username: query });
    }

    return user;
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function generateConnectID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function formatMoney(number) {
    if (number === null || number === undefined || isNaN(number)) return "0";
    const n = Number(number);
    if (n === 0) return "0";
    const suffixes = ['', 'k', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc', 'Ud', 'Dd', 'Td', 'Qd', 'Qid', 'Sxd', 'Spd', 'Od', 'Nd', 'Vg'];
    let tier = Math.floor(Math.log10(Math.abs(n)) / 3);
    if (tier >= suffixes.length) tier = suffixes.length - 1;
    if (tier < 0) return n.toFixed(2);
    const scale = Math.pow(10, tier * 3);
    return (Math.round(n / scale * 100) / 100) + suffixes[tier];
}

function parseAmount(text) {
    const units = { K:1e3, M:1e6, B:1e9, T:1e12, QA:1e15, QI:1e18, SX:1e21, SP:1e24, OC:1e27, NO:1e30 };
    const m = String(text).toUpperCase().match(/^([\d.,]+)([A-Z]*)$/);
    if (!m) return NaN;
    let num = parseFloat(m[1].replace(/,/g, ''));
    if (units[m[2]]) num *= units[m[2]];
    return Math.floor(num);
}

function doGachaPull(user) {
    const isPity = (user.gachaPity || 0) >= GACHA_PITY_LIMIT;
    const pool = isPity
        ? GACHA_POOL.filter(x => x.rarity === 'ssr')
        : GACHA_POOL;
    const totalW = pool.reduce((a, b) => a + b.weight, 0);
    let roll = Math.random() * totalW, acc = 0;
    let item = pool[0];
    for (const p of pool) { acc += p.weight; if (roll <= acc) { item = p; break; } }
    const isSSR = item.rarity === 'ssr';
    user.gachaPity = isSSR ? 0 : (user.gachaPity || 0) + 1;
    return { item, isSSR, pity: isPity };
}

function addSeasonPoints(user, fish) {
    const extras = SEASON_CONFIG.pointsPerRareFish;
    const pts = extras[fish.rarity] || SEASON_CONFIG.pointsPerFish;
    user.seasonPoints = (user.seasonPoints || 0) + pts;
    if (fish.mutations && fish.mutations.some(m => m !== 'Normal')) {
        user.seasonPoints += SEASON_CONFIG.pointsPerMutation;
    }
    return pts;
}

function getUpgradedStats(user, rod) {
    const luckBonus  = UPGRADES.luck.effect(user.luckUpgrade || 0);
    const speedBonus = UPGRADES.speed.effect(user.speedUpgrade || 0);
    const prestigeBonus = (user.prestige || 0) * 0.05;

    // Cek bait aktif di inventory
    const bait = (user.inventory || []).find(i => i.type === 'bait');
    const baitLuck = bait?.id === 'goldbait' ? 0.3 : bait?.id === 'crystalbait' ? 0.6 : 0;

    return {
        luck: (rod.luck || 0) + luckBonus + prestigeBonus + baitLuck,
        speed: Math.min((rod.speed || 0) + speedBonus, 0.98),
        sellMultiplier: (rod.sellMultiplier || 0),
        activeBait: bait || null,
    };
}

// ===== ISLANDS DATA =====

const islands = {
mousewood: {
  name: "Mousewood",
  image: "https://images.weserv.nl/?url=static.wikitide.net/fischwiki/thumb/c/cb/MoosewoodVillage.png/500px-MoosewoodVillage.png",
  listFish: [
    { name: "Red Snapper", rarity: "common", avgValue: 35, minKg: 0.5, maxKg: 4 },
    { name: "Largemouth Bass", rarity: "common", avgValue: 44, minKg: 1, maxKg: 5.5 },
    { name: "Trout", rarity: "common", avgValue: 52, minKg: 1, maxKg: 7 },
    { name: "Anchovy", rarity: "common", avgValue: 70, minKg: 0.5, maxKg: 5 },
    { name: "Bream", rarity: "common", avgValue: 60, minKg: 0.5, maxKg: 4 },
    { name: "Sockeye Salmon", rarity: "uncommon", avgValue: 210, minKg: 2, maxKg: 15 },
    { name: "Yellowfin Tuna", rarity: "uncommon", avgValue: 180, minKg: 2, maxKg: 8 },
    { name: "Carp", rarity: "uncommon", avgValue: 260, minKg: 1.5, maxKg: 12 },
    { name: "Goldfish", rarity: "uncommon", avgValue: 310, minKg: 0.2, maxKg: 3 },
    { name: "Snook", rarity: "rare", avgValue: 600, minKg: 2, maxKg: 25 },
    { name: "Flounder", rarity: "rare", avgValue: 640, minKg: 1.5, maxKg: 20 },
    { name: "Eel", rarity: "rare", avgValue: 700, minKg: 1, maxKg: 15 },
    { name: "Mudskipper", rarity: "rare", avgValue: 780, minKg: 0.3, maxKg: 3 },
    { name: "Pike", rarity: "epic", avgValue: 2800, minKg: 1.5, maxKg: 25 },
    { name: "Whiptail Catfish", rarity: "epic", avgValue: 3500, minKg: 2, maxKg: 40 },
    { name: "Mossy Turtle", rarity: "epic", avgValue: 4200, minKg: 3, maxKg: 30 },
    { name: "Whisker Bill", rarity: "mythic", avgValue: 9000, minKg: 10, maxKg: 60 },
    { name: "Ironback Carp", rarity: "mythic", avgValue: 11000, minKg: 15, maxKg: 80 },
    { name: "Ancient Gudgeon", rarity: "legendary", avgValue: 50000, minKg: 5, maxKg: 80 },
    { name: "Treble Bass", rarity: "exotic", avgValue: 25000, minKg: 2, maxKg: 200 },
    { name: "Phantom Trout", rarity: "godly", avgValue: 140000, minKg: 10, maxKg: 150 },
    { name: "Spirit Bass", rarity: "secret", avgValue: 400000, minKg: 20, maxKg: 500 },
  ],
},
roslitbay: {
  name: "Roslit Bay",
  image: "https://images.weserv.nl/?url=static.wikitide.net/fischwiki/thumb/3/32/RoslitFar.png/380px-RoslitFar.png",
  listFish: [
  { name: "Minnow", rarity: "common", avgValue: 190, minKg: 0.1, maxKg: 3 },
  { name: "Perch", rarity: "common", avgValue: 210, minKg: 0.2, maxKg: 8 },
  { name: "Chub", rarity: "common", avgValue: 220, minKg: 0.3, maxKg: 6 },
  { name: "Pearl", rarity: "uncommon", avgValue: 380, minKg: 0.1, maxKg: 2 },
  { name: "Butterflyfish", rarity: "uncommon", avgValue: 430, minKg: 0.2, maxKg: 5 },
  { name: "Clownfish", rarity: "uncommon", avgValue: 420, minKg: 0.1, maxKg: 3 },
  { name: "Pumpkinseed", rarity: "uncommon", avgValue: 470, minKg: 0.1, maxKg: 4 },
  { name: "Blue Tang", rarity: "rare", avgValue: 850, minKg: 0.5, maxKg: 15 },
  { name: "Rose Pearl", rarity: "rare", avgValue: 1100, minKg: 0.2, maxKg: 10 },
  { name: "Mimic Octopus", rarity: "rare", avgValue: 1250, minKg: 0.5, maxKg: 8 },
  { name: "Ribbon Eel", rarity: "epic", avgValue: 1900, minKg: 2, maxKg: 30 },
  { name: "Clam", rarity: "epic", avgValue: 2000, minKg: 1, maxKg: 10 },
  { name: "Yellow Boxfish", rarity: "epic", avgValue: 2200, minKg: 0.5, maxKg: 12 },
  { name: "Crown Jellyfish", rarity: "epic", avgValue: 2600, minKg: 1, maxKg: 15 },
  { name: "Squid", rarity: "legendary", avgValue: 5600, minKg: 1, maxKg: 30 },
  { name: "Angelfish", rarity: "legendary", avgValue: 6000, minKg: 0.5, maxKg: 20 },
  { name: "Gilded Pearl", rarity: "legendary", avgValue: 6300, minKg: 0.2, maxKg: 8 },
  { name: "Ruby Eel", rarity: "legendary", avgValue: 6800, minKg: 3, maxKg: 50 },
  { name: "Alligator Gar", rarity: "mythic", avgValue: 14000, minKg: 15, maxKg: 80 },
  { name: "Mauve Pearl", rarity: "mythic", avgValue: 15500, minKg: 0.5, maxKg: 5 },
  { name: "Suckermouth Catfish", rarity: "mythic", avgValue: 17000, minKg: 8, maxKg: 60 },
  { name: "Abyssal Lanternfish", rarity: "mythic", avgValue: 18000, minKg: 0.5, maxKg: 10 },
  { name: "Arapaima", rarity: "godly", avgValue: 30000, minKg: 50, maxKg: 200 },
  { name: "Dumbo Octopus", rarity: "godly", avgValue: 35000, minKg: 2, maxKg: 80 },
  { name: "Deep Pearl", rarity: "godly", avgValue: 38000, minKg: 0.5, maxKg: 15 },
  { name: "Prismatic Ray", rarity: "godly", avgValue: 42000, minKg: 10, maxKg: 120 },
  { name: "Axolotl", rarity: "secret", avgValue: 75000, minKg: 0.2, maxKg: 5 },
  { name: "Aurora Pearl", rarity: "secret", avgValue: 95000, minKg: 0.5, maxKg: 20 },
  { name: "Manta Ray", rarity: "secret", avgValue: 125000, minKg: 80, maxKg: 500 },
  { name: "Golden Sea Pearl", rarity: "secret", avgValue: 155000, minKg: 0.5, maxKg: 25 },
  { name: "Void Eel", rarity: "secret", avgValue: 175000, minKg: 5, maxKg: 200 },
  ]
},
mushgroveswamp: {
  name: "Mushgrove Swamp",
  image: "https://images.weserv.nl/?url=static.wikitide.net/fischwiki/thumb/e/ef/MushgroveFar.png/380px-MushgroveFar.png",
  listFish: [
    { name: "Fungal Cluster", rarity: "common", avgValue: 1300, minKg: 0.2, maxKg: 3 },
    { name: "Swamp Bass", rarity: "common", avgValue: 1600, minKg: 0.5, maxKg: 5 },
    { name: "White Perch", rarity: "uncommon", avgValue: 1850, minKg: 0.3, maxKg: 8 },
    { name: "Grey Carp", rarity: "uncommon", avgValue: 2100, minKg: 0.5, maxKg: 6 },
    { name: "Swamp Sprite", rarity: "uncommon", avgValue: 2000, minKg: 0.1, maxKg: 3 },
    { name: "Bowfin", rarity: "rare", avgValue: 4000, minKg: 1, maxKg: 15 },
    { name: "Swamp Scallop", rarity: "rare", avgValue: 5000, minKg: 0.5, maxKg: 8 },
    { name: "Bog Turtle", rarity: "rare", avgValue: 5600, minKg: 2, maxKg: 20 },
    { name: "Marsh Gar", rarity: "epic", avgValue: 10500, minKg: 3, maxKg: 30 },
    { name: "Diamond Catfish", rarity: "epic", avgValue: 12500, minKg: 2, maxKg: 20 },
    { name: "Toxic Frog", rarity: "epic", avgValue: 14000, minKg: 0.2, maxKg: 3 },
    { name: "Mushgrove Crab", rarity: "legendary", avgValue: 30000, minKg: 2, maxKg: 20 },
    { name: "Swamp Leviathan", rarity: "legendary", avgValue: 38000, minKg: 30, maxKg: 200 },
    { name: "Alligator", rarity: "mythic", avgValue: 65000, minKg: 30, maxKg: 200 },
    { name: "Fungal Serpent", rarity: "mythic", avgValue: 75000, minKg: 15, maxKg: 150 },
    { name: "Handfish", rarity: "godly", avgValue: 145000, minKg: 0.5, maxKg: 8 },
    { name: "Spore Dragon", rarity: "godly", avgValue: 165000, minKg: 50, maxKg: 400 },
    { name: "RocketFuel", rarity: "secret", avgValue: 480000, minKg: 1, maxKg: 10 },
    { name: "Resin", rarity: "secret", avgValue: 550000, minKg: 0.5, maxKg: 8 },
  ],
},
terrapinisland: {
  name: "Terrapin Island",
  image: "https://images.weserv.nl/?url=static.wikitide.net/fischwiki/thumb/3/39/TerrapinFar.png/550px-TerrapinFar.png",
  listFish: [
    { name: "Largemouth Bass", rarity: "common", avgValue: 2900, minKg: 1, maxKg: 15 },
    { name: "Sea Bass", rarity: "uncommon", avgValue: 3500, minKg: 1.5, maxKg: 25 },
    { name: "Shell Crab", rarity: "uncommon", avgValue: 3800, minKg: 0.3, maxKg: 5 },
    { name: "Gudgeon", rarity: "rare", avgValue: 5800, minKg: 0.3, maxKg: 8 },
    { name: "Smallmouth Bass", rarity: "rare", avgValue: 7000, minKg: 0.5, maxKg: 20 },
    { name: "Coral Snapper", rarity: "rare", avgValue: 7800, minKg: 1, maxKg: 30 },
    { name: "Walleye", rarity: "epic", avgValue: 13500, minKg: 1, maxKg: 25 },
    { name: "Gilded Turtle", rarity: "epic", avgValue: 16000, minKg: 5, maxKg: 50 },
    { name: "White Bass", rarity: "legendary", avgValue: 40000, minKg: 1, maxKg: 30 },
    { name: "Island Leviathan", rarity: "legendary", avgValue: 46000, minKg: 50, maxKg: 400 },
    { name: "Redeye Bass", rarity: "mythic", avgValue: 68000, minKg: 0.5, maxKg: 15 },
    { name: "Chinook Salmon", rarity: "mythic", avgValue: 80000, minKg: 10, maxKg: 80 },
    { name: "Apex Hammerhead", rarity: "mythic", avgValue: 88000, minKg: 60, maxKg: 250 },
    { name: "Golden Smallmouth Bass", rarity: "godly", avgValue: 170000, minKg: 2, maxKg: 60 },
    { name: "Sea Turtle", rarity: "godly", avgValue: 240000, minKg: 80, maxKg: 500 },
    { name: "Manatee", rarity: "secret", avgValue: 560000, minKg: 100, maxKg: 800 },
    { name: "Celestial Turtle", rarity: "godly", avgValue: 255000, minKg: 100, maxKg: 600 },
  ],
},
theocean: {
  name: "The Ocean",
  image: "https://images.weserv.nl/?url=static.wikitide.net/fischwiki/thumb/8/89/Ocean.png/550px-Ocean.png",
  listFish: [
    { name: "Tire", rarity: "common", avgValue: 3200, minKg: 5, maxKg: 18 },
    { name: "Seaweed", rarity: "common", avgValue: 3800, minKg: 0.1, maxKg: 5 },
    { name: "Mackerel", rarity: "uncommon", avgValue: 5800, minKg: 1, maxKg: 25 },
    { name: "Mullet", rarity: "uncommon", avgValue: 6200, minKg: 0.5, maxKg: 20 },
    { name: "Gold Sea Bass", rarity: "uncommon", avgValue: 6800, minKg: 1.5, maxKg: 30 },
    { name: "Sardine", rarity: "uncommon", avgValue: 7200, minKg: 0.1, maxKg: 5 },
    { name: "Porgy", rarity: "uncommon", avgValue: 8000, minKg: 0.5, maxKg: 20 },
    { name: "Haddock", rarity: "rare", avgValue: 9200, minKg: 1, maxKg: 25 },
    { name: "Salmon", rarity: "rare", avgValue: 9800, minKg: 3, maxKg: 40 },
    { name: "Gold Yellowfin Tuna", rarity: "rare", avgValue: 11500, minKg: 30, maxKg: 120 },
    { name: "Amberjack", rarity: "rare", avgValue: 12800, minKg: 15, maxKg: 70 },
    { name: "Oarfish", rarity: "rare", avgValue: 13500, minKg: 8, maxKg: 80 },
    { name: "Gold Cod", rarity: "epic", avgValue: 17500, minKg: 3, maxKg: 40 },
    { name: "Gold Fish Barrel", rarity: "epic", avgValue: 20000, minKg: 8, maxKg: 60 },
    { name: "Barracuda", rarity: "epic", avgValue: 22000, minKg: 5, maxKg: 80 },
    { name: "Fangtooth", rarity: "epic", avgValue: 23000, minKg: 0.3, maxKg: 15 },
    { name: "Viperfish", rarity: "epic", avgValue: 23500, minKg: 0.5, maxKg: 20 },
    { name: "Nurse Shark", rarity: "legendary", avgValue: 62000, minKg: 80, maxKg: 200 },
    { name: "Ocean Chimera", rarity: "legendary", avgValue: 70000, minKg: 20, maxKg: 200 },
    { name: "Diamond Swordfish", rarity: "mythic", avgValue: 95000, minKg: 80, maxKg: 400 },
    { name: "Bluefin Tuna", rarity: "mythic", avgValue: 120000, minKg: 100, maxKg: 350 },
    { name: "Stingray", rarity: "mythic", avgValue: 128000, minKg: 15, maxKg: 100 },
    { name: "Halibut", rarity: "mythic", avgValue: 138000, minKg: 80, maxKg: 250 },
    { name: "Abyssal Angler", rarity: "mythic", avgValue: 145000, minKg: 3, maxKg: 80 },
    { name: "Sailfish", rarity: "godly", avgValue: 260000, minKg: 30, maxKg: 300 },
    { name: "Pufferfish", rarity: "godly", avgValue: 280000, minKg: 0.5, maxKg: 20 },
    { name: "Dolphin", rarity: "godly", avgValue: 315000, minKg: 100, maxKg: 500 },
    { name: "Flying Fish", rarity: "godly", avgValue: 345000, minKg: 2, maxKg: 50 },
    { name: "Crown Bass", rarity: "godly", avgValue: 370000, minKg: 3, maxKg: 100 },
    { name: "Moonfish", rarity: "godly", avgValue: 390000, minKg: 150, maxKg: 800 },
    { name: "Titanfish", rarity: "godly", avgValue: 405000, minKg: 100, maxKg: 1000 },
    { name: "Sawfish", rarity: "secret", avgValue: 555000, minKg: 200, maxKg: 800 },
    { name: "Sea Pickle", rarity: "secret", avgValue: 575000, minKg: 0.5, maxKg: 200 },
    { name: "Mythic Fish", rarity: "secret", avgValue: 610000, minKg: 0.5, maxKg: 300 },
    { name: "Mustard", rarity: "secret", avgValue: 700000, minKg: 1, maxKg: 500 },
    { name: "Long Pike", rarity: "secret", avgValue: 740000, minKg: 1.5, maxKg: 600 },
    { name: "Void Shark", rarity: "secret", avgValue: 760000, minKg: 200, maxKg: 2000 },
    { name: "Megalodon", rarity: "extinct", avgValue: 3000000, minKg: 30000, maxKg: 100000 },
    { name: "Primordial Whale", rarity: "extinct", avgValue: 5000000, minKg: 50000, maxKg: 180000 },
  ],
},
atlantis: {
  name: "Atlantis",
  image: "https://static.wikitide.net/fischwiki/thumb/e/ee/Atlantis.png/550px-Atlantis.png",
  listFish: [
    { name: "Voltfin Carp", rarity: "common", avgValue: 600, minKg: 2, maxKg: 30 },
    { name: "Aqua Scribe", rarity: "common", avgValue: 700, minKg: 0.3, maxKg: 12 },
    { name: "Neptune's Nibbler", rarity: "common", avgValue: 500, minKg: 0.2, maxKg: 8 },
    { name: "Atlantean Sardine", rarity: "common", avgValue: 420, minKg: 0.2, maxKg: 5 },
    { name: "Column Crawler", rarity: "common", avgValue: 650, minKg: 0.3, maxKg: 10 },
    { name: "Lightning Minnow", rarity: "uncommon", avgValue: 2500, minKg: 0.2, maxKg: 8 },
    { name: "Poseidon's Perch", rarity: "uncommon", avgValue: 1800, minKg: 0.5, maxKg: 15 },
    { name: "Sunken Silverscale", rarity: "uncommon", avgValue: 1500, minKg: 0.3, maxKg: 10 },
    { name: "Sparkfin Tetra", rarity: "uncommon", avgValue: 2200, minKg: 1, maxKg: 20 },
    { name: "Atlantean Anchovy", rarity: "uncommon", avgValue: 950, minKg: 0.1, maxKg: 5 },
    { name: "Oracle Minnow", rarity: "uncommon", avgValue: 1200, minKg: 0.1, maxKg: 6 },
    { name: "Tentacled Horror", rarity: "rare", avgValue: 20000, minKg: 5, maxKg: 80 },
    { name: "Mosaic Swimmer", rarity: "rare", avgValue: 10000, minKg: 1.5, maxKg: 50 },
    { name: "Static Ray", rarity: "rare", avgValue: 19500, minKg: 10, maxKg: 120 },
    { name: "Shadowfang Snapper", rarity: "rare", avgValue: 13000, minKg: 2, maxKg: 60 },
    { name: "Echo Fisher", rarity: "rare", avgValue: 12500, minKg: 2, maxKg: 55 },
    { name: "Marble Maiden", rarity: "rare", avgValue: 8200, minKg: 1, maxKg: 40 },
    { name: "Titan Tuna", rarity: "epic", avgValue: 30000, minKg: 3, maxKg: 80 },
    { name: "Colossal Carp", rarity: "epic", avgValue: 24000, minKg: 2, maxKg: 60 },
    { name: "Temple Drifter", rarity: "epic", avgValue: 23500, minKg: 2, maxKg: 55 },
    { name: "Crystal Chorus", rarity: "epic", avgValue: 23000, minKg: 1.5, maxKg: 50 },
    { name: "Helios Ray", rarity: "epic", avgValue: 26000, minKg: 2.5, maxKg: 65 },
    { name: "Atlantean Guardian", rarity: "epic", avgValue: 36000, minKg: 4, maxKg: 100 },
    { name: "Oracle's Eye", rarity: "legendary", avgValue: 55000, minKg: 3, maxKg: 80 },
    { name: "Tentacle Eel", rarity: "legendary", avgValue: 62000, minKg: 8, maxKg: 120 },
    { name: "Thunder Bass", rarity: "legendary", avgValue: 62000, minKg: 20, maxKg: 150 },
    { name: "Philosopher's Fish", rarity: "legendary", avgValue: 50000, minKg: 2.5, maxKg: 70 },
    { name: "Giant Manta", rarity: "legendary", avgValue: 58000, minKg: 5, maxKg: 130 },
    { name: "Leviathan Bass", rarity: "legendary", avgValue: 68000, minKg: 8, maxKg: 160 },
    { name: "Storm Eel", rarity: "legendary", avgValue: 78000, minKg: 30, maxKg: 200 },
    { name: "Siren Singer", rarity: "legendary", avgValue: 60000, minKg: 4, maxKg: 120 },
    { name: "Chronos Deep Swimmer", rarity: "legendary", avgValue: 65000, minKg: 4, maxKg: 130 },
    { name: "Abyssal King", rarity: "legendary", avgValue: 72000, minKg: 80, maxKg: 500 },
    { name: "Deep Behemoth", rarity: "legendary", avgValue: 80000, minKg: 80, maxKg: 500 },
    { name: "Deep Emperor", rarity: "legendary", avgValue: 74000, minKg: 60, maxKg: 400 },
    { name: "Deep Crownfish", rarity: "legendary", avgValue: 76000, minKg: 30, maxKg: 350 },
    { name: "Kraken's Herald", rarity: "legendary", avgValue: 85000, minKg: 60, maxKg: 450 },
    { name: "Thunder Serpent", rarity: "legendary", avgValue: 90000, minKg: 50, maxKg: 400 },
    { name: "Starlit Weaver", rarity: "mythic", avgValue: 220000, minKg: 20, maxKg: 300 },
    { name: "Massive Marlin", rarity: "mythic", avgValue: 210000, minKg: 20, maxKg: 280 },
    { name: "Triton's Herald", rarity: "mythic", avgValue: 205000, minKg: 10, maxKg: 200 },
    { name: "Deep One", rarity: "mythic", avgValue: 225000, minKg: 20, maxKg: 350 },
    { name: "Atlantean Alchemist", rarity: "mythic", avgValue: 380000, minKg: 15, maxKg: 250 },
    { name: "Eldritch Horror", rarity: "mythic", avgValue: 290000, minKg: 30, maxKg: 400 },
    { name: "Voidscale Guppy", rarity: "mythic", avgValue: 310000, minKg: 10, maxKg: 200 },
    { name: "Lightning Pike", rarity: "mythic", avgValue: 235000, minKg: 15, maxKg: 150 },
    { name: "Stormcloud Angelfish", rarity: "mythic", avgValue: 260000, minKg: 30, maxKg: 200 },
    { name: "Titanic Sturgeon", rarity: "mythic", avgValue: 340000, minKg: 20, maxKg: 300 },
    { name: "Titanfang Grouper", rarity: "mythic", avgValue: 320000, minKg: 25, maxKg: 350 },
    { name: "Twilight Glowfish", rarity: "mythic", avgValue: 420000, minKg: 10, maxKg: 200 },
    { name: "Mage Marlin", rarity: "mythic", avgValue: 200000, minKg: 60, maxKg: 500 },
    { name: "Abyssal Devourer", rarity: "godly", avgValue: 1200000, minKg: 500, maxKg: 3000 },
    { name: "Void Emperor", rarity: "godly", avgValue: 950000, minKg: 300, maxKg: 2000 },
    { name: "Celestial Koi", rarity: "godly", avgValue: 1100000, minKg: 200, maxKg: 2000 },
    { name: "Zeus' Herald", rarity: "godly", avgValue: 920000, minKg: 80, maxKg: 1500 },
    { name: "King Jellyfish", rarity: "godly", avgValue: 900000, minKg: 150, maxKg: 1200 },
    { name: "Abyssal Goliath", rarity: "godly", avgValue: 1050000, minKg: 300, maxKg: 2000 },
    { name: "The Kraken", rarity: "extinct", avgValue: 5000000, minKg: 10000, maxKg: 100000 },
    { name: "Ancient Kraken", rarity: "special", avgValue: 10000000, minKg: 25000, maxKg: 150000 }
  ],
},
// ── NEW ISLANDS ─────────────────────────────────
volcanicdepths: {
  name: "Volcanic Depths",
  image: "https://images.weserv.nl/?url=static.wikitide.net/fischwiki/thumb/e/ef/MushgroveFar.png/380px-MushgroveFar.png",
  listFish: [
    { name: "Lava Minnow", rarity: "common", avgValue: 2600, minKg: 0.2, maxKg: 8 },
    { name: "Ember Bass", rarity: "common", avgValue: 3500, minKg: 0.5, maxKg: 12 },
    { name: "Scorched Perch", rarity: "uncommon", avgValue: 6000, minKg: 1, maxKg: 20 },
    { name: "Magma Eel", rarity: "uncommon", avgValue: 7500, minKg: 2, maxKg: 35 },
    { name: "Volcanic Carp", rarity: "uncommon", avgValue: 8500, minKg: 1, maxKg: 25 },
    { name: "Flame Snapper", rarity: "rare", avgValue: 12500, minKg: 3, maxKg: 50 },
    { name: "Obsidian Catfish", rarity: "rare", avgValue: 15500, minKg: 5, maxKg: 80 },
    { name: "Ash Pike", rarity: "rare", avgValue: 18000, minKg: 4, maxKg: 70 },
    { name: "Inferno Barracuda", rarity: "epic", avgValue: 33000, minKg: 8, maxKg: 120 },
    { name: "Molten Ray", rarity: "epic", avgValue: 42000, minKg: 12, maxKg: 150 },
    { name: "Magma Shark", rarity: "legendary", avgValue: 100000, minKg: 50, maxKg: 400 },
    { name: "Pyroclastic Bass", rarity: "legendary", avgValue: 125000, minKg: 40, maxKg: 300 },
    { name: "Ember Leviathan", rarity: "mythic", avgValue: 280000, minKg: 100, maxKg: 1000 },
    { name: "Caldera Titan", rarity: "mythic", avgValue: 360000, minKg: 150, maxKg: 1500 },
    { name: "Volcano God", rarity: "godly", avgValue: 980000, minKg: 500, maxKg: 3000 },
    { name: "Phoenix Fish", rarity: "godly", avgValue: 1100000, minKg: 300, maxKg: 2500 },
    { name: "Lava Drake", rarity: "secret", avgValue: 2500000, minKg: 800, maxKg: 8000 },
    { name: "Eternal Flame Carp", rarity: "secret", avgValue: 3200000, minKg: 1000, maxKg: 12000 },
    { name: "Primordial Inferno", rarity: "extinct", avgValue: 10000000, minKg: 50000, maxKg: 200000 },
  ],
},
crystalcaves: {
  name: "Crystal Caves",
  image: "https://images.weserv.nl/?url=static.wikitide.net/fischwiki/thumb/3/39/TerrapinFar.png/550px-TerrapinFar.png",
  listFish: [
    { name: "Glowfin Minnow", rarity: "common", avgValue: 8200, minKg: 0.1, maxKg: 5 },
    { name: "Crystal Chub", rarity: "common", avgValue: 9500, minKg: 0.2, maxKg: 8 },
    { name: "Prism Perch", rarity: "uncommon", avgValue: 19000, minKg: 0.5, maxKg: 15 },
    { name: "Gem Carp", rarity: "uncommon", avgValue: 22000, minKg: 1, maxKg: 20 },
    { name: "Cave Eel", rarity: "uncommon", avgValue: 26000, minKg: 0.5, maxKg: 18 },
    { name: "Diamond Trout", rarity: "rare", avgValue: 43000, minKg: 1.5, maxKg: 40 },
    { name: "Sapphire Bass", rarity: "rare", avgValue: 50000, minKg: 2, maxKg: 55 },
    { name: "Emerald Snapper", rarity: "rare", avgValue: 60000, minKg: 3, maxKg: 70 },
    { name: "Quartz Catfish", rarity: "epic", avgValue: 125000, minKg: 8, maxKg: 120 },
    { name: "Amethyst Ray", rarity: "epic", avgValue: 150000, minKg: 12, maxKg: 150 },
    { name: "Crystal Serpent", rarity: "legendary", avgValue: 350000, minKg: 30, maxKg: 300 },
    { name: "Topaz Leviathan", rarity: "legendary", avgValue: 440000, minKg: 50, maxKg: 500 },
    { name: "Obsidian Dragon", rarity: "mythic", avgValue: 1050000, minKg: 100, maxKg: 1200 },
    { name: "Prismatic Titan", rarity: "mythic", avgValue: 1400000, minKg: 150, maxKg: 1800 },
    { name: "Crystal God", rarity: "godly", avgValue: 3500000, minKg: 500, maxKg: 5000 },
    { name: "Eternal Prism", rarity: "godly", avgValue: 4400000, minKg: 800, maxKg: 8000 },
    { name: "Void Crystal", rarity: "secret", avgValue: 10500000, minKg: 2000, maxKg: 20000 },
    { name: "Absolute Diamond", rarity: "secret", avgValue: 16000000, minKg: 4000, maxKg: 40000 },
    { name: "Genesis Stone", rarity: "extinct", avgValue: 48000000, minKg: 100000, maxKg: 800000 },
  ],
},
};




// ══════════════════════════════════════════════════════════════
//   TRAVEL REQUIREMENTS — syarat unlock tiap pulau
// ══════════════════════════════════════════════════════════════
const travelRequirements = {
    mousewood:       null,                               // starter island - gratis
    roslitbay:       { money: 5_000,       fish: 5   }, // mudah
    mushgroveswamp:  { money: 25_000,      fish: 20  },
    terrapinisland:  { money: 100_000,     fish: 50  },
    theocean:        { money: 1_000_000,   fish: 100 },
    atlantis:        { money: 10_000_000,  fish: 200 },
    volcaniddepths:  { money: 100_000_000, fish: 400 },
    crystalcaves:    { money: 1_000_000_000, fish: 750 },
};

// ===== FISHING ROD CATALOG =====
// Ini adalah daftar semua rod yang tersedia di game
const fishingRod = {
    basicrod: {
        name: "Basic Fishing Rod",
        type: "rod",
        luck: 0.00,
        speed: 0.00,
        comboFish: 1,
        comboMutations: 1,
        mutationsLuck: 0.000,
        sellMultiplier: 0,
        price: 0, // tidak dijual — default rod
        enchant: null,
        bonusStats: {},
        description: "Pancingan standar untuk pemula.",
        level: 1,
        maxLevel: 5,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    ironrod: {
        name: "Iron Rod",
        type: "rod",
        luck: 0.02,
        speed: 0.03,
        comboFish: 1,
        comboMutations: 1,
        mutationsLuck: 0.001,
        sellMultiplier: 0.05,
        price: 25000,
        enchant: null,
        bonusStats: {},
        description: "Pancingan besi yang lebih kuat dari basic rod.",
        level: 1,
        maxLevel: 10,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    goldrod: {
        name: "Gold Rod",
        type: "rod",
        luck: 0.06,
        speed: 0.07,
        comboFish: 1,
        comboMutations: 1,
        mutationsLuck: 0.003,
        sellMultiplier: 0.15,
        price: 250000,
        enchant: null,
        bonusStats: {},
        description: "Pancingan emas dengan luck lebih tinggi.",
        level: 1,
        maxLevel: 15,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    diamondrod: {
        name: "Diamond Rod",
        type: "rod",
        luck: 0.12,
        speed: 0.13,
        comboFish: 2,
        comboMutations: 1,
        mutationsLuck: 0.007,
        sellMultiplier: 0.30,
        price: 2500000,
        enchant: null,
        bonusStats: {},
        description: "Pancingan berlian — combo ikan meningkat.",
        level: 1,
        maxLevel: 20,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    ancientrod: {
        name: "Ancient Rod",
        type: "rod",
        luck: 0.20,
        speed: 0.20,
        comboFish: 2,
        comboMutations: 2,
        mutationsLuck: 0.015,
        sellMultiplier: 0.50,
        price: 25000000,
        enchant: null,
        bonusStats: {},
        description: "Pancingan kuno dari zaman dahulu — mutasi combo meningkat.",
        level: 1,
        maxLevel: 25,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    mythicrod: {
        name: "Mythic Rod",
        type: "rod",
        luck: 0.30,
        speed: 0.28,
        comboFish: 3,
        comboMutations: 2,
        mutationsLuck: 0.025,
        sellMultiplier: 0.75,
        price: 250000000,
        enchant: null,
        bonusStats: {},
        description: "Pancingan mythic — memanggil ikan langka.",
        level: 1,
        maxLevel: 30,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    legendaryrod: {
        name: "Legendary Rod",
        type: "rod",
        luck: 0.42,
        speed: 0.38,
        comboFish: 3,
        comboMutations: 3,
        mutationsLuck: 0.040,
        sellMultiplier: 1.00,
        price: 2500000000,
        enchant: null,
        bonusStats: {},
        description: "Pancingan legenda — combo penuh & sell bonus besar.",
        level: 1,
        maxLevel: 40,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    depthseekerrod: {
        name: "Depthseeker Rod",
        type: "rod",
        luck: 0.55,
        speed: 0.48,
        comboFish: 3,
        comboMutations: 3,
        mutationsLuck: 0.060,
        sellMultiplier: 1.30,
        price: 25000000000,
        enchant: null,
        bonusStats: {},
        description: "Pancingan penjelajah lautan dalam — luck & depth bonus.",
        level: 1,
        maxLevel: 50,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    voidrod: {
        name: "Void Rod",
        type: "rod",
        luck: 0.70,
        speed: 0.60,
        comboFish: 3,
        comboMutations: 4,
        mutationsLuck: 0.085,
        sellMultiplier: 1.75,
        price: 0, // hanya dari token store
        enchant: null,
        bonusStats: {},
        description: "Pancingan void — dari dimensi lain.",
        level: 1,
        maxLevel: 60,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    cosmicrod: {
        name: "Cosmic Rod",
        type: "rod",
        luck: 0.85,
        speed: 0.72,
        comboFish: 3,
        comboMutations: 4,
        mutationsLuck: 0.115,
        sellMultiplier: 2.20,
        price: 0, // hanya dari token store / season reward
        enchant: null,
        bonusStats: {},
        description: "Pancingan kosmik — kekuatan dari bintang-bintang.",
        level: 1,
        maxLevel: 75,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    prestigerod: {
        name: "Prestige Rod",
        type: "rod",
        luck: 0.95,
        speed: 0.80,
        comboFish: 3,
        comboMutations: 5,
        mutationsLuck: 0.150,
        sellMultiplier: 2.70,
        price: 0, // reward prestige
        enchant: null,
        bonusStats: {},
        description: "Pancingan prestige — hadiah bagi yang telah melampaui batas.",
        level: 1,
        maxLevel: 99,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
    },
    omegaRod: {
        name: "Omega Rod",
        type: "rod",
        luck: 1.20,
        speed: 0.90,
        comboFish: 3,
        comboMutations: 5,
        mutationsLuck: 0.200,
        sellMultiplier: 3.50,
        price: 0, // season champion reward
        enchant: null,
        bonusStats: {},
        description: "Pancingan omega — milik sang juara season.",
        level: 1,
        maxLevel: 99,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
        userSetting: "developer",
    },
    eternityrod: {
        name: "Eternity Rod",
        type: "rod",
        luck: 1.50,
        speed: 0.95,
        comboFish: 3,
        comboMutations: 6,
        mutationsLuck: 0.280,
        sellMultiplier: 5.00,
        price: 0, // prestige 5 reward
        enchant: null,
        bonusStats: {},
        description: "Pancingan keabadian — melampaui ruang dan waktu.",
        level: 1,
        maxLevel: 99,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
        userSetting: "developer",
    },
    noleprod: {
        name: "Nolep Rod",
        type: "rod",
        luck: 10.0,
        speed: 0.99,
        comboFish: 3,
        comboMutations: 8,
        mutationsLuck: 0.500,
        sellMultiplier: 30.0,
        price: 0, // reward level 2500
        enchant: null,
        bonusStats: {},
        description: "Hadiah bagi mereka yang tidak punya kehidupan. GG.",
        level: 1,
        maxLevel: 50,
        exp: 0,
        expToNextLevel: 100,
        enchantCount: 0,
        userSetting: "level2500",
    },
};

// ===== ROD ENCHANTS =====

const rodEnchants = {
  swift: {
    name: "Swift",
    rarity: "common",
    effect: { lureSpeed: 1.3, progressSpeed: 1.05 },
    desc: "Mempercepat gerakan umpan dan progres menangkap ikan."
  },
  hasty: {
    name: "Hasty",
    rarity: "common",
    effect: { lureSpeed: 1.55 },
    desc: "Meningkatkan kecepatan umpan sehingga ikan lebih cepat tertarik."
  },
  blessedsong: {
    name: "Blessed Song",
    rarity: "common",
    effect: { progressSpeed: 1.4 },
    desc: "+40% Progress Speed"
  },
  agile: {
    name: "Agile",
    rarity: "common",
    effect: { progressSpeed: 1.1 },
    desc: "Meningkatkan kecepatan progress sedikit agar lebih efisien saat menangkap ikan."
  },
  buoyant: {
    name: "Buoyant",
    rarity: "common",
    effect: { lureSpeed: 1.2 },
    desc: "Meningkatkan kecepatan umpan di air, menarik ikan lebih cepat."
  },
  patient: {
    name: "Patient",
    rarity: "common",
    effect: { luck: 1.05 },
    desc: "Kesabaran menghasilkan hasil tangkapan yang sedikit lebih baik."
  },
  skilled: {
    name: "Skilled",
    rarity: "common",
    effect: { xpMultiplier: 1.25 },
    desc: "Memberikan sedikit tambahan XP setiap tangkapan."
  },
  divine: {
    name: "Divine",
    rarity: "rare",
    effect: { luck: 1.45, lureSpeed: 1.2 },
    desc: "Keberuntungan tinggi dan umpan bergerak lebih cepat."
  },
  clever: {
    name: "Clever",
    rarity: "rare",
    effect: { xpMultiplier: 2.25 },
    desc: "×2.25 XP dari semua hasil tangkapan"
  },
  tempered: {
    name: "Tempered",
    rarity: "rare",
    effect: { progressSpeed: 1.15, lureSpeed: 1.15 },
    desc: "Rod yang stabil dan responsif meningkatkan kecepatan dan kontrol."
  },
  frostbite: {
    name: "Frostbite",
    rarity: "rare",
    effect: { luck: 1.35, lureSpeed: 1.2 },
    desc: "Dingin es laut menenangkan ikan, membuat mereka lebih mudah tertangkap."
  },
  lucky: {
    name: "Lucky",
    rarity: "epic",
    effect: { luck: 1.2, lureSpeed: 1.15 },
    desc: "Menambah keberuntungan dan sedikit kecepatan umpan."
  },
  volcanic: {
    name: "Volcanic",
    rarity: "epic",
    effect: { luck: 1.7, sellMultiplier: 1.6 },
    desc: "Panas dari magma laut meningkatkan nilai ikan yang kamu tangkap."
  },
  coralblessing: {
    name: "Coral Blessing",
    rarity: "epic",
    effect: { xpMultiplier: 2.5, progressSpeed: 1.1 },
    desc: "Berkah terumbu karang memberi pengalaman dan progres lebih cepat."
  },
  deepcurrent: {
    name: "Deep Current",
    rarity: "epic",
    effect: { lureSpeed: 1.35, progressSpeed: 1.25 },
    desc: "Arus laut dalam mempercepat setiap gerakan dan hasil tangkapanmu."
  },
  quality: {
    name: "Quality",
    rarity: "epic",
    effect: { luck: 1.15, lureSpeed: 1.15, progressSpeed: 1.05 },
    desc: "Kombinasi keberuntungan, kecepatan umpan, dan progres menangkap ikan."
  },
  glittered: {
    name: "Glittered",
    rarity: "epic",
    effect: { mutationChance: 0.03 },
    desc: "Meningkatkan peluang mutasi 3%"
  },
  breezed: {
    name: "Breezed",
    rarity: "epic",
    effect: { luck: 1.65, lureSpeed: 1.1, progressSpeed: 1.2, mutationChance: 0.009 },
    desc: "+65% Luck, +10% Lure Speed, +20% Progress Speed, +0.9% Mutation chance"
  },
  mystical: {
    name: "Mystical",
    rarity: "epic",
    effect: { luck: 1.25, lureSpeed: 1.15, progressSpeed: 1.1 },
    desc: "+25% Luck, +15% Lure Speed, +10% Progress Speed "
  },
  harmonic: {
    name: "Harmonic",
    rarity: "epic",
    effect: { lureSpeed: 1.2, xpMultiplier: 1.75 },
    desc: "Keseimbangan sempurna antara kecepatan dan pengalaman."
  },
  dazzling: {
    name: "Dazzling",
    rarity: "epic",
    effect: { luck: 1.4, sellMultiplier: 1.5 },
    desc: "Kilauan rod menarik perhatian ikan berharga tinggi."
  },
  tidal: {
    name: "Tidal",
    rarity: "epic",
    effect: { luck: 1.25, progressSpeed: 1.25 },
    desc: "Mengalir seperti ombak — meningkatkan kecepatan dan keberuntungan."
  },
  enriched: {
    name: "Enriched",
    rarity: "epic",
    effect: { xpMultiplier: 2.0, progressSpeed: 1.05 },
    desc: "Pengalaman yang kaya memberikan XP lebih banyak setiap kali memancing."
  },
  royalcrest: {
    name: "Royal Crest",
    rarity: "legendary",
    effect: { luck: 2.0, sellMultiplier: 2.5 },
    desc: "Simbol para raja laut, meningkatkan nilai dan keberuntungan luar biasa."
  },
  crystalwave: {
    name: "Crystal Wave",
    rarity: "legendary",
    effect: { luck: 1.85, progressSpeed: 1.4, mutationChance: 0.04 },
    desc: "Gelombang kristal memberikan hasil langka dan kecepatan tinggi."
  },
  storming: {
    name: "Storming",
    rarity: "legendary",
    effect: { luck: 1.95, lureSpeed: 1.45, mutationChance: 0.02 },
    desc: "+95% Luck, +45% Lure Speed, +2% Mutation chance"
  },
  seaoverlord: {
    name: "Sea Overlord",
    rarity: "legendary",
    effect: { fishSize: 6, sellMultiplier: 4 },
    desc: "+300% Fish Size, 4× Sell Value"
  },
  infernal: {
    name: "Infernal",
    rarity: "legendary",
    effect: { luck: 1.6, sellMultiplier: 2 },
    desc: "Terbakar oleh api laut dalam, meningkatkan keberuntungan dan nilai jual."
  },
  leviathan: {
    name: "Leviathan",
    rarity: "legendary",
    effect: { fishSize: 3, luck: 1.4 },
    desc: "Diberkahi kekuatan monster laut — ikan yang lebih besar dan lebih berharga."
  },
  tempest: {
    name: "Tempest",
    rarity: "legendary",
    effect: { lureSpeed: 1.5, progressSpeed: 1.3 },
    desc: "Kekuatan badai mempercepat segala hal di lautan."
  },
  phantom: {
    name: "Phantom",
    rarity: "legendary",
    effect: { luck: 1.8, mutationChance: 0.05 },
    desc: "Energi roh laut menambah keberuntungan dan peluang mutasi langka."
  },
  chaotic: {
    name: "Chaotic",
    rarity: "mythic",
    effect: { sellMultiplier: 24 },
    desc: "Meningkatkan nilai jual ikan secara drastis."
  },
  wise: {
    name: "Wise",
    rarity: "mythic",
    effect: { xpMultiplier: 5 },
    desc: "×5 XP dari semua hasil tangkapan"
  },
  mutated: {
    name: "Mutated",
    rarity: "mythic",
    effect: { mutationChance: 0.1 },
    desc: "+10% Mutation chance"
  },
  immortal: {
    name: "Immortal",
    rarity: "mythic",
    effect: { luck: 1.75, progressSpeed: 1.3, sellMultiplier: 16 },
    desc: "+75% Luck, +30% Progress Speed, 16× Sell Value"
  },
  abyssborn: {
    name: "Abyssborn",
    rarity: "mythic",
    effect: { luck: 2.2, mutationChance: 0.12, sellMultiplier: 4 },
    desc: "Kekuatan laut dalam menganugerahkan hasil tangkapan yang sangat berharga."
  },
  astral: {
    name: "Astral",
    rarity: "mythic",
    effect: { luck: 2.5, progressSpeed: 1.4 },
    desc: "Daya kosmik dari bintang-bintang memandu setiap lemparan."
  },
  tyrant: {
    name: "Tyrant",
    rarity: "mythic",
    effect: { fishSize: 4, sellMultiplier: 5 },
    desc: "Rod penguasa samudra — hanya untuk pemancing sejati."
  },
  demonic: {
    name: "Demonic",
    rarity: "mythic",
    effect: { luck: 3.0, mutationChance: 0.2 },
    desc: "Dipenuhi kekuatan jahat laut, meningkatkan keberuntungan ekstrem dan mutasi."
  },
  eternity: {
    name: "Eternity",
    rarity: "mythic",
    effect: { luck: 2.8, progressSpeed: 1.6, sellMultiplier: 6 },
    desc: "Energi abadi dari samudra memberi peningkatan luar biasa pada semua aspek."
  },
   voidtide: {
    name: "Void Tide",
    rarity: "mythic",
    effect: { luck: 3.2, mutationChance: 0.18, sellMultiplier: 5 },
    desc: "Pasang surut dari kekosongan laut memutarbalikkan keberuntunganmu."
  },
  celestia: {
    name: "Celestia",
    rarity: "mythic",
    effect: { luck: 2.8, xpMultiplier: 3.5, progressSpeed: 1.5 },
    desc: "Kekuatan bintang memberi kebijaksanaan dan hasil langka dari setiap lemparan."
  },
  abyssalflare: {
    name: "Abyssal Flare",
    rarity: "godly",
    effect: { luck: 4.5, mutationChance: 0.25, sellMultiplier: 9 },
    desc: "Api dari jurang laut menyalakan setiap tangkapan dengan nilai tinggi."
  },
  reapersnet: {
    name: "Reaper's Net",
    rarity: "godly",
    effect: { luck: 4.0, progressSpeed: 2.0, sellMultiplier: 7 },
    desc: "Jaring sang pencabut laut, memastikan tidak ada ikan berharga yang lolos."
  },
  radiantcore: {
    name: "Radiant Core",
    rarity: "godly",
    effect: { luck: 4.0, sellMultiplier: 8 },
    desc: "Energi terang dari inti laut meningkatkan nilai jual ikan dan keberuntungan besar."
  },
  leviathansgrasp: {
    name: "Leviathan's Grasp",
    rarity: "godly",
    effect: { fishSize: 5, mutationChance: 0.15 },
    desc: "Cengkeraman raksasa laut — setiap tangkapan berpotensi menjadi kolosal dan langka."
  },
  chaosreign: {
    name: "Chaos Reign",
    rarity: "godly",
    effect: { luck: 4.2, sellMultiplier: 10, mutationChance: 0.2 },
    desc: "Kekacauan laut purba memberikan kekuatan tanpa batas pada hasil tangkapanmu."
  },
  timeless: {
    name: "Timeless",
    rarity: "secret",
    effect: { luck: 5.0, progressSpeed: 2.0, xpMultiplier: 3 },
    desc: "Energi waktu sendiri membimbingmu — setiap hasil tangkapan lebih cepat, lebih berharga, dan lebih berpengalaman."
  },
  voidheart: {
    name: "Voidheart",
    rarity: "secret",
    effect: { luck: 6.0, mutationChance: 0.25, sellMultiplier: 12 },
    desc: "Inti kekosongan laut dalam memberikan kekuatan mutasi dan nilai jual ekstrem."
  },
  abysscore: {
    name: "Abyss Core",
    rarity: "secret",
    effect: { luck: 5.0, mutationChance: 0.3, sellMultiplier: 15 },
    desc: "Energi terdalam samudra mengubah setiap hasil menjadi keajaiban langka."
  },
  godslayer: {
    name: "Godslayer",
    rarity: "secret",
    effect: { luck: 7.5, progressSpeed: 2.5, sellMultiplier: 20, mutationChance: 0.35 },
    desc: "Rod legendaris yang menantang dewa laut — kekuatan mutlak untuk para master pemancing."
  },
  omnicore: {
    name: "Omnicore",
    rarity: "secret",
    effect: { luck: 6.5, progressSpeed: 2.2, xpMultiplier: 4 },
    desc: "Inti kekuatan laut universal — setiap aspek memancingmu ditingkatkan drastis."
  },
  paradox: {
    name: "Paradox",
    rarity: "secret",
    effect: { luck: 7.0, mutationChance: 0.4, sellMultiplier: 18 },
    desc: "Rod yang melampaui logika waktu dan ruang, memberikan hasil yang mustahil."
  },
  universe: {
    name: "Universe",
    rarity: "secret",
    effect: { luck: 8.5, mutationChance: 0.45, sellMultiplier: 24 },
    desc: "Rod yang mudah mendapatkan ikan semua secret"
  },
  // ── NEW ENCHANTS ────────────────────────────────
  focused: {
    name: "Focused",
    rarity: "common",
    effect: { progressSpeed: 1.15, xpMultiplier: 1.1 },
    desc: "+15% Progress Speed, +10% XP"
  },
  nimble: {
    name: "Nimble",
    rarity: "common",
    effect: { lureSpeed: 1.25, progressSpeed: 1.1 },
    desc: "+25% Lure Speed, +10% Progress Speed"
  },
  sturdy: {
    name: "Sturdy",
    rarity: "rare",
    effect: { sellMultiplier: 1.4, luck: 1.1 },
    desc: "+40% Sell Value, +10% Luck"
  },
  radiant: {
    name: "Radiant",
    rarity: "rare",
    effect: { luck: 1.5, mutationChance: 0.01 },
    desc: "+50% Luck, +1% Mutation Chance"
  },
  primal: {
    name: "Primal",
    rarity: "epic",
    effect: { luck: 1.8, fishSize: 1.5, sellMultiplier: 1.3 },
    desc: "+80% Luck, +50% Fish Size, +30% Sell"
  },
  venom: {
    name: "Venom",
    rarity: "epic",
    effect: { mutationChance: 0.05, sellMultiplier: 1.8 },
    desc: "+5% Mutation Chance, +80% Sell Value"
  },
  cursed: {
    name: "Cursed",
    rarity: "legendary",
    effect: { luck: 2.2, mutationChance: 0.06, sellMultiplier: 2.2 },
    desc: "+120% Luck, +6% Mutation, +120% Sell — berisiko tinggi, hasil tinggi"
  },
  dragonscale: {
    name: "Dragonscale",
    rarity: "legendary",
    effect: { fishSize: 4, luck: 1.7, progressSpeed: 1.3 },
    desc: "+300% Fish Size, +70% Luck, +30% Progress"
  },
  nebula: {
    name: "Nebula",
    rarity: "mythic",
    effect: { luck: 3.5, xpMultiplier: 4, mutationChance: 0.15 },
    desc: "+250% Luck, 4x XP, +15% Mutation"
  },
  singularity: {
    name: "Singularity",
    rarity: "mythic",
    effect: { sellMultiplier: 30, progressSpeed: 1.5 },
    desc: "30× Sell Value, +50% Progress Speed"
  },
  omega: {
    name: "Omega",
    rarity: "godly",
    effect: { luck: 5.5, sellMultiplier: 12, mutationChance: 0.28, fishSize: 3 },
    desc: "+450% Luck, 12× Sell, +28% Mutation, +200% Size"
  },
  genesis: {
    name: "Genesis",
    rarity: "godly",
    effect: { luck: 5.0, xpMultiplier: 5, progressSpeed: 2.2, sellMultiplier: 8 },
    desc: "Permulaan dari kekuatan tertinggi — semua aspek meningkat drastis"
  },
  apocalypse: {
    name: "Apocalypse",
    rarity: "secret",
    effect: { luck: 9.0, sellMultiplier: 28, mutationChance: 0.5, fishSize: 4 },
    desc: "Kekuatan akhir zaman — tangkapan luar biasa dari kedalaman tergelap"
  },
  etherbound: {
    name: "Etherbound",
    rarity: "secret",
    effect: { luck: 7.5, xpMultiplier: 6, progressSpeed: 2.5, mutationChance: 0.4 },
    desc: "Terikat kekuatan ether — XP dan luck tertinggi yang pernah ada"
  },
};

// ===== GAME CONSTANTS =====

const SEASON_CONFIG = {
    name: "Season 1 — Age of Tides",
    startDate: new Date("2025-01-01"),
    endDate: new Date("2099-12-31"), // Admin set via .setseason
    prizeRod: "omegaRod",
    prizeTokens: 500,
    prizeMoney: 10000000000000,
    topN: 3,
    pointsPerFish: 1,
    pointsPerRareFish: { rare: 5, epic: 15, legendary: 40, mythic: 100, godly: 300, secret: 800, extinct: 2000, special: 5000 },
    pointsPerMutation: 20,
};

// ══════════════════════════════════════════════════════════
//   PRESTIGE SYSTEM
// ══════════════════════════════════════════════════════════
const PRESTIGE_REQUIREMENTS = [
    { level: 1, fish: 500,  money: 10000000000,    reward: "Prestige Rod + 50 tokens + Title 'Veteran'" },
    { level: 2, fish: 1500, money: 1000000000000,  reward: "Luck +20% permanent + 150 tokens" },
    { level: 3, fish: 4000, money: 100000000000000, reward: "Cosmic Rod + 500 tokens + Title 'Legend'" },
    { level: 4, fish: 10000, money: 1e19,           reward: "Double EXP permanent + 1000 tokens" },
    { level: 5, fish: 25000, money: 1e22,           reward: "Eternity Rod + 5000 tokens + Title 'God'" },
];

const PRESTIGE_TITLES = {
    0: "Pemancing Baru",
    1: "Veteran",
    2: "Master Angler",
    3: "Legend",
    4: "Transcendent",
    5: "God of Fishing",
};

// ══════════════════════════════════════════════════════════
//   UPGRADE SHOP (sink uang)
// ══════════════════════════════════════════════════════════
const UPGRADES = {
    luck: {
        name: "🍀 Luck Upgrade",
        desc: "Tingkatkan luck permanen +2% per level",
        maxLevel: 50,
        baseCost: 5000000,
        costMultiplier: 2.5,
        effect: (lv) => lv * 0.02,
        getCost: (lv) => Math.floor(5000000 * Math.pow(2.5, lv)),
    },
    speed: {
        name: "⚡ Speed Upgrade",
        desc: "Kurangi waktu mancing -1% per level",
        maxLevel: 40,
        baseCost: 3000000,
        costMultiplier: 2.3,
        effect: (lv) => lv * 0.01,
        getCost: (lv) => Math.floor(3000000 * Math.pow(2.3, lv)),
    },
};
// Sell multiplier hanya dari EVENT GOLDEN SHOP (admin), bukan dari upgrade player

// ── Golden Shop Event — sell multiplier global dari admin ──
// Aktifkan: !event goldenshop <multiplier> <durasi>
// Contoh: !event goldenshop 2 1h → semua sell ×2 selama 1 jam
let GOLDEN_SHOP_EVENT = {
    active: false,
    multiplier: 1,
    endTime: null,
};

// ══════════════════════════════════════════════════════════
//   DAILY REWARD
// ══════════════════════════════════════════════════════════
const DAILY_REWARDS = [
    { streak: 1,  money: 50000,       tickets: 0, desc: "Hari 1 🎣" },
    { streak: 2,  money: 100000,      tickets: 0, desc: "Hari 2 ✨" },
    { streak: 3,  money: 250000,      tickets: 1, desc: "Hari 3 🎟️ +1 tiket gacha!" },
    { streak: 4,  money: 500000,      tickets: 0, desc: "Hari 4 💰" },
    { streak: 5,  money: 1000000,     tickets: 2, desc: "Hari 5 🎟️🎟️ +2 tiket gacha!" },
    { streak: 6,  money: 2000000,     tickets: 0, desc: "Hari 6 🌟" },
    { streak: 7,  money: 10000000,    tickets: 5, desc: "Hari 7 🔥 BONUS BESAR! +5 tiket!" },
    { streak: 14, money: 100000000,   tickets: 10, desc: "2 Minggu 💎 STREAK BONUS!" },
    { streak: 30, money: 1000000000,  tickets: 20, desc: "1 Bulan 👑 LEGEND STREAK!" },
];

// ══════════════════════════════════════════════════════════
//   GACHA SYSTEM
// ══════════════════════════════════════════════════════════
const GACHA_COST_COINS   = 5000000;   // 5M per pull pakai coins
const GACHA_COST_TICKETS = 1;         // 1 tiket per pull
const GACHA_PITY_LIMIT   = 80;        // pity setelah 80 pull tanpa SSR

const GACHA_POOL = [
    // ─── COMMON (55%) — campuran coins + enchant scroll + item kecil ────
    { type: "enchant_scroll", value: "common",  label: "📜 Enchant Scroll (Common)",  rarity: "common", weight: 22 },
    { type: "tickets",        value: 2,         label: "🎟️ 2 Tiket Gacha",            rarity: "common", weight: 18 },
    { type: "xp_boost",       value: 1.5,       label: "⚡ XP Boost ×1.5 (1 sesi)",   rarity: "common", weight: 15 },

    // ─── RARE (25%) — rod starter + enchant rare + bait buff ─────────────
    { type: "rod",            value: "luckyrod",    label: "🎣 Lucky Rod",            rarity: "rare", weight: 10 },
    { type: "enchant_scroll", value: "rare",        label: "📜 Enchant Scroll (Rare)", rarity: "rare", weight: 8 },
    { type: "tickets",        value: 5,             label: "🎟️ 5 Tiket Gacha",        rarity: "rare", weight: 4 },
    { type: "bait",           value: "goldbait",    label: "🪱 Golden Bait (×2 luck)", rarity: "rare", weight: 3 },

    // ─── EPIC (13%) — rod menengah + enchant epic + token kecil ──────────
    { type: "rod",            value: "precisionrod", label: "🎣 Precision Rod",        rarity: "epic", weight: 5 },
    { type: "enchant_scroll", value: "epic",         label: "📜 Enchant Scroll (Epic)", rarity: "epic", weight: 4 },
    { type: "tokens",         value: 25,             label: "🪙 25 Prestige Tokens",   rarity: "epic", weight: 3 },
    { type: "bait",           value: "crystalbait",  label: "💎 Crystal Bait (×3 luck+sell)", rarity: "epic", weight: 1 },

    // ─── LEGENDARY (6%) — rod mahal + token besar ────────────────────────
    { type: "rod",    value: "midasrod",   label: "🎣 Midas Rod",            rarity: "legendary", weight: 2.5 },
    { type: "tokens", value: 75,           label: "🪙 75 Prestige Tokens",   rarity: "legendary", weight: 2.0 },
    { type: "rod",    value: "avalancherod", label: "🎣 Avalanche Rod",      rarity: "legendary", weight: 1.5 },

    // ─── SSR (1% / pity guaranteed) — rod ultra ─────────────────────────
    { type: "rod",    value: "voidrod",    label: "🌑 Void Rod",             rarity: "ssr", weight: 0.5 },
    { type: "rod",    value: "cosmicrod",  label: "🌌 Cosmic Rod",           rarity: "ssr", weight: 0.3 },
    { type: "tokens", value: 200,          label: "🪙 200 Prestige Tokens",  rarity: "ssr", weight: 0.2 },
];

// ── Enchant scroll effect — diapply saat .view / setelah mancing ──────────
// type "enchant_scroll": user dapat enchant random sesuai rarity scroll
// type "xp_boost": diterapkan ke rod XP gain next mancing (simpan ke user.activeBoosts)
// type "bait": buff luck & sell untuk 1x mancing berikutnya

// ══════════════════════════════════════════════════════════
//   EVENT SYSTEM
// ══════════════════════════════════════════════════════════
let ACTIVE_EVENT = {
    active: false,
    name: "",
    desc: "",
    multiplier: 1,
    bonusMutation: 0,
    endTime: null,
};

// ── Toggle fitur oleh admin ──────────────────────────────
let GACHA_DISABLED = false;           // !gacha off / !gacha on
let PRESTIGE_SYSTEM_DISABLED = false; // !prestige off / !prestige on
let BOT_GLOBAL_OFF = false;           // !botglobal off / !botglobal on
if (!global.BYPASS_BG_GROUPS) global.BYPASS_BG_GROUPS = new Set(); // grup bypass botglobal
if (global.BOT2_DISABLED === undefined) global.BOT2_DISABLED = false; // !sesibot2 off / !sesibot2 on
if (global.BOT2_PAIRING_DISABLED === undefined) global.BOT2_PAIRING_DISABLED = false; // !sesibot2 pairing off / on
// State per-client (bot1/bot2 terpisah) — key = client.user.id
// In-memory cache (sumber kebenaran = MongoDB BotConfig)
const CONSOLE_MSG_STATE = new Map();     // !consolemsg on/off per bot
const CONSOLE_MSG_BOT_STATE = new Map(); // !consolemsgbot on/off per bot

// Helper getter — default: msg ON, bot OFF
const getConsoleMsgOn    = (id) => CONSOLE_MSG_STATE.has(id)     ? CONSOLE_MSG_STATE.get(id)     : true;
const getConsoleMsgBotOn = (id) => CONSOLE_MSG_BOT_STATE.has(id) ? CONSOLE_MSG_BOT_STATE.get(id) : false;

// Load state dari MongoDB ke cache in-memory (dipanggil saat bot start via 'connected' event)
// Catatan: loadBotConfig() juga me-restore state ini via setTimeout(6000).
// loadConsoleMsgState() sebagai fallback cepat saat connected event fire.
async function loadConsoleMsgState() {
    try {
        const cfg = await BotConfig.findById('main');
        if (!cfg) return;

        if (cfg.consoleMsgOn instanceof Map)
            cfg.consoleMsgOn.forEach((v, k) => CONSOLE_MSG_STATE.set(k, v));
        else if (cfg.consoleMsgOn && typeof cfg.consoleMsgOn === 'object')
            Object.entries(cfg.consoleMsgOn).forEach(([k, v]) => CONSOLE_MSG_STATE.set(k, v));

        if (cfg.consoleMsgBotOn instanceof Map)
            cfg.consoleMsgBotOn.forEach((v, k) => CONSOLE_MSG_BOT_STATE.set(k, v));
        else if (cfg.consoleMsgBotOn && typeof cfg.consoleMsgBotOn === 'object')
            Object.entries(cfg.consoleMsgBotOn).forEach(([k, v]) => CONSOLE_MSG_BOT_STATE.set(k, v));

        console.log('[ConsoleMsgState] Loaded from MongoDB ✅');
    } catch (e) {
        console.error('[loadConsoleMsgState]', e.message);
    }
}

// Simpan state ke MongoDB
async function saveConsoleMsgState(botId, msgOn, msgBotOn) {
    try {
        await BotConfig.findByIdAndUpdate('main', {
            $set: {
                [`consoleMsgOn.${botId}`]:    msgOn,
                [`consoleMsgBotOn.${botId}`]: msgBotOn,
            }
        }, { upsert: true });
    } catch (e) {
        console.error('[saveConsoleMsgState] Gagal simpan:', e.message);
    }
}
// Fitur yang dinonaktifkan saat PRESTIGE_SYSTEM_DISABLED:
//   prestige, tokenstore/toko, upgrade, rodupgrade, jackpot, donate, gacha
// Pengecualian: season, event, seasonhistory, daily, stats

let GLOBAL_LUCK_EVENT = {
    active: false,
    multiplier: 1,
    endTime: null,
    setBy: null,
};

// ── Event: Raining Goblin ────────────────────────────────
// Saat aktif, SETIAP ikan yang dipancing pasti dapat mutasi "Goblin"
// dengan multiplier x999999
let RAIN_GOBLIN_EVENT = {
    active: false,
    endTime: null,
};

// ── Admin: force jackpot result per-user ─────────────────
// Map: senderNumber/username → "win" | "lose"
// Key "ALL" untuk override global semua player
const FORCED_JACKPOT_MAP = new Map(); // key: senderNumber | "ALL"

// ══════════════════════════════════════════════════════════
//   PRESTIGE TOKEN SHOP
// ══════════════════════════════════════════════════════════
const TOKEN_SHOP = [
    { id: "tokenshop_voidrod",    name: "🌑 Void Rod",      cost: 300, type: "rod",    value: "voidrod"    },
    { id: "tokenshop_cosmicrod",  name: "🌌 Cosmic Rod",    cost: 800, type: "rod",    value: "cosmicrod"  },
    { id: "tokenshop_tickets10",  name: "🎟️ 10 Tiket Gacha", cost: 50,  type: "tickets", value: 10         },
    { id: "tokenshop_tickets50",  name: "🎟️ 50 Tiket Gacha", cost: 200, type: "tickets", value: 50         },
    { id: "tokenshop_money",      name: "💰 100B Coins",    cost: 100, type: "coins",  value: 100000000000 },
    { id: "tokenshop_bigmoney",   name: "💰 10T Coins",     cost: 500, type: "coins",  value: 10000000000000 },
];

// ══════════════════════════════════════════════════════════
//   HELPER FUNCTIONS BARU
// ══════════════════════════════════════════════════════════
function formatMoney(number) {
    if (number === null || number === undefined || isNaN(number)) return "0";
    const n = Number(number);
    if (n === 0) return "0";
    const suffixes = ['', 'k', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc', 'Ud', 'Dd', 'Td', 'Qd', 'Qid', 'Sxd', 'Spd', 'Od', 'Nd', 'Vg'];
    let tier = Math.floor(Math.log10(Math.abs(n)) / 3);
    if (tier >= suffixes.length) tier = suffixes.length - 1;
    if (tier < 0) return n.toFixed(2);
    const scale = Math.pow(10, tier * 3);
    return (Math.round(n / scale * 100) / 100) + suffixes[tier];
}

function parseAmount(text) {
    const units = { K:1e3, M:1e6, B:1e9, T:1e12, QA:1e15, QI:1e18, SX:1e21, SP:1e24, OC:1e27, NO:1e30 };
    const m = String(text).toUpperCase().match(/^([\d.,]+)([A-Z]*)$/);
    if (!m) return NaN;
    let num = parseFloat(m[1].replace(/,/g, ''));
    if (units[m[2]]) num *= units[m[2]];
    return Math.floor(num);
}

function doGachaPull(user) {
    const isPity = (user.gachaPity || 0) >= GACHA_PITY_LIMIT;
    const pool = isPity
        ? GACHA_POOL.filter(x => x.rarity === 'ssr')
        : GACHA_POOL;
    const totalW = pool.reduce((a, b) => a + b.weight, 0);
    let roll = Math.random() * totalW, acc = 0;
    let item = pool[0];
    for (const p of pool) { acc += p.weight; if (roll <= acc) { item = p; break; } }
    const isSSR = item.rarity === 'ssr';
    user.gachaPity = isSSR ? 0 : (user.gachaPity || 0) + 1;
    return { item, isSSR, pity: isPity };
}

function addSeasonPoints(user, fish) {
    const extras = SEASON_CONFIG.pointsPerRareFish;
    const pts = extras[fish.rarity] || SEASON_CONFIG.pointsPerFish;
    user.seasonPoints = (user.seasonPoints || 0) + pts;
    if (fish.mutations && fish.mutations.some(m => m !== 'Normal')) {
        user.seasonPoints += SEASON_CONFIG.pointsPerMutation;
    }
    return pts;
}

function getUpgradedStats(user, rod) {
    const luckBonus  = UPGRADES.luck.effect(user.luckUpgrade || 0);
    const speedBonus = UPGRADES.speed.effect(user.speedUpgrade || 0);
    const prestigeBonus = (user.prestige || 0) * 0.05;

    // Cek bait aktif di inventory
    const bait = (user.inventory || []).find(i => i.type === 'bait');
    const baitLuck = bait?.id === 'goldbait' ? 0.3 : bait?.id === 'crystalbait' ? 0.6 : 0;

    // Sell multiplier hanya dari rod + GOLDEN SHOP EVENT (tidak ada upgrade sell dari player)
    const goldenShopMult = (GOLDEN_SHOP_EVENT.active && Date.now() < GOLDEN_SHOP_EVENT.endTime)
        ? GOLDEN_SHOP_EVENT.multiplier : 1;

    return {
        luck: (rod.luck || 0) + luckBonus + prestigeBonus + baitLuck,
        speed: Math.min((rod.speed || 0) + speedBonus, 0.98),
        sellMultiplier: (rod.sellMultiplier || 0),
        goldenShopMult,
        activeBait: bait || null,
    };
}


// ╔══════════════════════════════════════════════════════════════╗
// ║              FISCH BOT v2 — ENHANCED SYSTEMS                ║
// ╚══════════════════════════════════════════════════════════════╝

// ══════════════════════════════════════════════════════════════
//   WEATHER SYSTEM — mempengaruhi jenis ikan, luck, speed
// ══════════════════════════════════════════════════════════════
const WEATHERS = {
    sunny: {
        name: "☀️ Cerah",
        desc: "Cuaca cerah, ikan aktif di permukaan.",
        luckMult: 1.0,
        speedMult: 1.0,
        rarityBoost: {},
        exclusive: [],
        color: "yellow",
    },
    cloudy: {
        name: "☁️ Mendung",
        desc: "Langit mendung, ikan mulai turun ke dalam.",
        luckMult: 1.05,
        speedMult: 0.95,
        rarityBoost: { rare: 1.1, epic: 1.05 },
        exclusive: [],
    },
    rainy: {
        name: "🌧️ Hujan",
        desc: "Hujan membuat ikan lapar! Luck meningkat signifikan.",
        luckMult: 1.20,
        speedMult: 0.85,
        rarityBoost: { rare: 1.2, epic: 1.15, legendary: 1.1 },
        exclusive: ["Rainfish", "Stormcaller Eel"],
    },
    stormy: {
        name: "⛈️ Badai",
        desc: "Badai! Ikan langka bermunculan dari kedalaman.",
        luckMult: 1.45,
        speedMult: 0.70,
        rarityBoost: { legendary: 1.3, mythic: 1.2, godly: 1.1 },
        exclusive: ["Thunder Serpent Jr", "Storm Marlin"],
        penalty: "Waktu mancing +40%",
    },
    foggy: {
        name: "🌫️ Berkabut",
        desc: "Kabut tebal — mutasi lebih sering muncul!",
        luckMult: 0.95,
        speedMult: 1.0,
        mutationBonus: 0.05,
        rarityBoost: { mythic: 1.05 },
        exclusive: ["Shadow Carp", "Phantom Eel"],
    },
    windy: {
        name: "💨 Berangin",
        desc: "Angin kencang mengocok perairan, speed naik!",
        luckMult: 0.90,
        speedMult: 1.30,
        rarityBoost: {},
        exclusive: [],
    },
    blizzard: {
        name: "❄️ Blizzard",
        desc: "Badai salju — hanya ikan kutub yang muncul!",
        luckMult: 1.35,
        speedMult: 0.60,
        rarityBoost: { godly: 1.25, secret: 1.15 },
        exclusive: ["Arctic Leviathan", "Glacial Titan"],
        penalty: "Hanya mancing di pulau tertentu",
    },
    moonlight: {
        name: "🌙 Cahaya Bulan",
        desc: "Malam bulan purnama — ikan misterius muncul!",
        luckMult: 1.15,
        speedMult: 1.05,
        rarityBoost: { secret: 1.3, mythic: 1.1 },
        exclusive: ["Moonscale Koi", "Lunar Leviathan"],
        mutationBonus: 0.03,
    },
};

// Cuaca global (berubah tiap 2 jam)
let CURRENT_WEATHER = {
    key: 'sunny',
    ...WEATHERS.sunny,
    expiresAt: Date.now() + 2 * 3600_000,
};

function rotateWeather() {
    const keys = Object.keys(WEATHERS);
    // Weight-based random (badai lebih jarang)
    const weights = { sunny:30, cloudy:25, rainy:20, stormy:5, foggy:10, windy:15, blizzard:3, moonlight:8 };
    const totalW = Object.values(weights).reduce((a,b)=>a+b,0);
    let roll = Math.random() * totalW, acc = 0;
    let chosen = 'sunny';
    for (const [k,w] of Object.entries(weights)) { acc+=w; if(roll<=acc){chosen=k;break;} }
    CURRENT_WEATHER = { key: chosen, ...WEATHERS[chosen], expiresAt: Date.now() + 2*3600_000 };
    console.log(`[WEATHER] 🌦️ Cuaca berganti: ${WEATHERS[chosen].name}`);
}

// Cek dan rotate cuaca tiap menit
setInterval(() => {
    if (Date.now() >= CURRENT_WEATHER.expiresAt) rotateWeather();
}, 60_000);

// ══════════════════════════════════════════════════════════════
//   ACHIEVEMENT SYSTEM
// ══════════════════════════════════════════════════════════════
const ACHIEVEMENTS = {
    // ── FISHING ──
    first_fish:     { id:'first_fish',    name:'🎣 Pemancing Pemula',      desc:'Tangkap ikan pertamamu',                    pts:5,   reward:{money:1000} },
    fish_10:        { id:'fish_10',       name:'🐟 Nelayan Lokal',         desc:'Tangkap 10 ikan',                           pts:10,  reward:{money:5000} },
    fish_50:        { id:'fish_50',       name:'🐠 Nelayan Berpengalaman', desc:'Tangkap 50 ikan',                           pts:20,  reward:{money:25000} },
    fish_100:       { id:'fish_100',      name:'🦈 Nelayan Handal',        desc:'Tangkap 100 ikan',                          pts:35,  reward:{money:100000} },
    fish_500:       { id:'fish_500',      name:'🌊 Master Pancing',        desc:'Tangkap 500 ikan',                          pts:75,  reward:{money:1000000, tickets:5} },
    fish_1000:      { id:'fish_1000',     name:'👑 Legenda Laut',          desc:'Tangkap 1000 ikan',                         pts:150, reward:{money:10000000, tokens:20} },
    fish_5000:      { id:'fish_5000',     name:'🌌 Dewa Pancing',          desc:'Tangkap 5000 ikan',                         pts:500, reward:{money:1000000000, tokens:100} },
    // ── RARITY ──
    first_rare:     { id:'first_rare',    name:'💚 Pertama Rare',          desc:'Tangkap ikan rare pertama',                 pts:15,  reward:{money:5000} },
    first_epic:     { id:'first_epic',    name:'💙 Pertama Epic',          desc:'Tangkap ikan epic pertama',                 pts:25,  reward:{money:20000} },
    first_legendary:{ id:'first_legendary',name:'💛 Pertama Legendary',   desc:'Tangkap ikan legendary pertama',            pts:50,  reward:{money:100000} },
    first_mythic:   { id:'first_mythic',  name:'🟣 Pertama Mythic',       desc:'Tangkap ikan mythic pertama',               pts:100, reward:{money:500000, tickets:2} },
    first_godly:    { id:'first_godly',   name:'🌟 Pertama Godly',        desc:'Tangkap ikan godly pertama',                pts:200, reward:{money:5000000, tickets:5} },
    first_secret:   { id:'first_secret',  name:'⚫ Pertama Secret',       desc:'Tangkap ikan secret pertama',               pts:400, reward:{money:50000000, tokens:15} },
    first_extinct:  { id:'first_extinct', name:'🦕 Pertama Extinct',      desc:'Tangkap ikan yang sudah punah!',            pts:800, reward:{money:500000000, tokens:50} },
    // ── MUTATION ──
    first_mutation: { id:'first_mutation',name:'🧬 Mutasi Pertama',       desc:'Temukan mutasi pertama',                    pts:20,  reward:{money:10000} },
    rare_fish_10:   { id:'rare_fish_10',  name:'💎 Kolektor Langka',      desc:'Tangkap 10 ikan rare+',                     pts:40,  reward:{money:50000} },
    mutation_10:    { id:'mutation_10',   name:'🔬 Ilmuwan Laut',         desc:'Temukan 10 mutasi berbeda',                  pts:80,  reward:{money:200000, tickets:3} },
    // ── WEALTH ──
    money_1m:       { id:'money_1m',      name:'💰 Jutawan',              desc:'Kumpulkan 1 juta uang',                     pts:20,  reward:{tickets:1} },
    money_1b:       { id:'money_1b',      name:'💎 Miliarder',            desc:'Kumpulkan 1 miliar uang',                   pts:75,  reward:{tickets:3} },
    money_1t:       { id:'money_1t',      name:'🏦 Triliuner',            desc:'Kumpulkan 1 triliun uang',                  pts:200, reward:{tokens:10} },
    sell_100m:      { id:'sell_100m',     name:'🤑 Penjual Ulung',        desc:'Total penjualan mencapai 100 juta',         pts:50,  reward:{money:5000000} },
    // ── ROD ──
    rod_level5:     { id:'rod_level5',    name:'🎣 Upgrade Pertama',      desc:'Upgrade rod ke level 5',                    pts:15,  reward:{money:10000} },
    rod_level20:    { id:'rod_level20',   name:'⚡ Rod Master',           desc:'Upgrade rod ke level 20',                   pts:60,  reward:{money:100000} },
    enchant_first:  { id:'enchant_first', name:'✨ Pertama Enchant',      desc:'Pasang enchant pertama kali',               pts:20,  reward:{money:20000} },
    own_3rods:      { id:'own_3rods',     name:'🎣 Kolektor Rod',         desc:'Miliki 3 rod berbeda',                      pts:30,  reward:{money:50000} },
    own_7rods:      { id:'own_7rods',     name:'🗄️ Gudang Rod',          desc:'Miliki 7 rod berbeda',                      pts:100, reward:{tickets:5} },
    // ── EXPLORATION ──
    visit_3islands: { id:'visit_3islands',name:'🏝️ Penjelajah',          desc:'Kunjungi 3 pulau berbeda',                  pts:25,  reward:{money:30000} },
    visit_all:      { id:'visit_all',     name:'🌍 Keliling Dunia',       desc:'Kunjungi semua pulau',                      pts:150, reward:{money:500000, tokens:5} },
    // ── SPECIAL ──
    big_fish:       { id:'big_fish',      name:'🐳 Raksasa Laut',         desc:'Tangkap ikan dengan berat > 1000 kg',       pts:100, reward:{money:1000000} },
    perfect_10:     { id:'perfect_10',    name:'💯 Sempurna',             desc:'Lakukan 10 mancing tanpa hasil common',     pts:75,  reward:{money:500000} },
    storm_fisher:   { id:'storm_fisher',  name:'⛈️ Petir di Badai',      desc:'Mancing saat cuaca badai dan dapat mythic+',pts:200, reward:{money:5000000, tokens:10} },
    night_catcher:  { id:'night_catcher', name:'🌙 Pemburu Malam',        desc:'Mancing saat Moonlight 5 kali',             pts:80,  reward:{money:500000, tickets:2} },
};

async function checkAchievements(user, context = {}) {
    const newAch = [];
    const earned = new Set(user.achievements || []);

    const grant = (id) => {
        if (!earned.has(id) && ACHIEVEMENTS[id]) {
            earned.add(id);
            newAch.push(ACHIEVEMENTS[id]);
        }
    };

    const fish = user.fishCaught || 0;
    const rare = user.rareFishCaught || 0;
    const inv = user.inventory || [];
    const rods = user.fishingRods;
    const rodCount = rods instanceof Map ? rods.size : Object.keys(rods||{}).length;
    const islands_visited = [...new Set((user.travelFound||[]).concat([user.currentIsland||'mousewood']))];

    // Fishing count
    if (fish >= 1)    grant('first_fish');
    if (fish >= 10)   grant('fish_10');
    if (fish >= 50)   grant('fish_50');
    if (fish >= 100)  grant('fish_100');
    if (fish >= 500)  grant('fish_500');
    if (fish >= 1000) grant('fish_1000');
    if (fish >= 5000) grant('fish_5000');

    // Rarity
    if (context.fish) {
        const r = context.fish.rarity;
        if (r === 'rare' || r === 'epic' || r === 'legendary' || r === 'mythic' || r === 'godly' || r === 'secret' || r === 'extinct') grant('first_rare');
        if (r === 'epic' || r === 'legendary' || r === 'mythic' || r === 'godly' || r === 'secret' || r === 'extinct') grant('first_epic');
        if (r === 'legendary' || r === 'mythic' || r === 'godly' || r === 'secret' || r === 'extinct') grant('first_legendary');
        if (r === 'mythic' || r === 'godly' || r === 'secret' || r === 'extinct') grant('first_mythic');
        if (r === 'godly' || r === 'secret' || r === 'extinct') grant('first_godly');
        if (r === 'secret' || r === 'extinct') grant('first_secret');
        if (r === 'extinct') grant('first_extinct');
        if (context.fish.kg > 1000) grant('big_fish');
        if (context.fish.isMutated) grant('first_mutation');
        // Storm fisher
        if (CURRENT_WEATHER.key === 'stormy' && ['mythic','godly','secret','extinct'].includes(r)) grant('storm_fisher');
    }

    // Rare fish count
    if (rare >= 10)   grant('rare_fish_10');

    // Wealth
    const totalEarned = user.totalEarned || 0;
    if ((user.money||0) >= 1e6)    grant('money_1m');
    if ((user.money||0) >= 1e9)    grant('money_1b');
    if ((user.money||0) >= 1e12)   grant('money_1t');
    if (totalEarned >= 1e8)        grant('sell_100m');

    // Rod
    const maxRodLevel = rods instanceof Map
        ? Math.max(...[...rods.values()].map(r=>r.level||1))
        : Math.max(...Object.values(rods||{basicrod:{level:1}}).map(r=>r.level||1));
    if (maxRodLevel >= 5)  grant('rod_level5');
    if (maxRodLevel >= 20) grant('rod_level20');
    if (rodCount >= 3) grant('own_3rods');
    if (rodCount >= 7) grant('own_7rods');
    if (context.enchanted) grant('enchant_first');

    // Exploration
    if (islands_visited.length >= 3) grant('visit_3islands');
    const allIslandKeys = ['mousewood','roslitbay','mushgroveswamp','terrapinisland','theocean','atlantis','volcaniddepths','crystalcaves'];
    if (allIslandKeys.every(k => islands_visited.includes(k))) grant('visit_all');

    // Mutation count
    const mutCount = (user.mutationFound||[]).length;
    if (mutCount >= 10) grant('mutation_10');

    // Night catcher — perlu counter di context
    if (context.moonlight) {
        const mc = (user.achievementPoints || 0);
        // simplified — grant kalau sudah cukup moonlight catcher
    }

    if (newAch.length > 0) {
        user.achievements = [...earned];
        user.markModified('achievements');
        let bonusMoney = 0, bonusTickets = 0, bonusTokens = 0;
        for (const ach of newAch) {
            user.achievementPoints = (user.achievementPoints||0) + ach.pts;
            bonusMoney   += ach.reward?.money   || 0;
            bonusTickets += ach.reward?.tickets || 0;
            bonusTokens  += ach.reward?.tokens  || 0;
        }
        user.money         = (user.money||0)         + bonusMoney;
        user.gachaTickets  = (user.gachaTickets||0)  + bonusTickets;
        user.prestigeTokens= (user.prestigeTokens||0)+ bonusTokens;
    }
    return newAch;
}

// ══════════════════════════════════════════════════════════════
//   FISH CONDITION SYSTEM — ikan dalam kondisi tertentu punya nilai + desc khusus
// ══════════════════════════════════════════════════════════════
const FISH_CONDITIONS = [
    { id: 'perfect',    label: '✨ Perfect',    chance: 0.05, priceBonus: 2.5,   desc: 'Tangkapan sempurna!' },
    { id: 'fresh',      label: '🌊 Segar',      chance: 0.15, priceBonus: 1.5,   desc: 'Ikan masih sangat segar.' },
    { id: 'giant',      label: '🔴 Raksasa',    chance: 0.04, priceBonus: 3.0,   desc: 'Ikan ukuran raksasa langka!' },
    { id: 'diseased',   label: '🦠 Sakit',      chance: 0.08, priceBonus: 0.4,   desc: 'Ikan kurang sehat, nilainya turun.' },
    { id: 'old',        label: '📜 Tua',        chance: 0.06, priceBonus: 1.8,   desc: 'Ikan tua sangat berharga bagi kolektor.' },
    { id: 'shiny',      label: '✨ Bersinar',   chance: 0.03, priceBonus: 4.0,   desc: 'Kilap luar biasa! Langka sekali!' },
    { id: 'normal',     label: '',              chance: 0.59, priceBonus: 1.0,   desc: '' },
];

function rollFishCondition() {
    let roll = Math.random(), acc = 0;
    for (const c of FISH_CONDITIONS) {
        acc += c.chance;
        if (roll <= acc) return c;
    }
    return FISH_CONDITIONS.find(c=>c.id==='normal');
}

// ══════════════════════════════════════════════════════════════
//   ISLAND COOLDOWN — tiap pulau punya cooldown tersendiri
//   Pemain bisa mancing kapan saja, tapi ikan di pulau mahal ada cooldown
// ══════════════════════════════════════════════════════════════
const ISLAND_COOLDOWNS = {
    mousewood:       0,          // tidak ada cooldown (pulau awal)
    roslitbay:       0,
    mushgroveswamp:  0,
    terrapinisland:  30,         // 30 detik cooldown antar sesi
    theocean:        45,
    atlantis:        90,
    volcaniddepths:  120,
    crystalcaves:    180,
};

// ══════════════════════════════════════════════════════════════
//   ROD SKIN SYSTEM — kosmetik, tidak ngaruh ke stats
// ══════════════════════════════════════════════════════════════
const ROD_SKINS = {
    default:    { name: 'Default',       emoji: '🎣', price: 0,       desc: 'Tampilan standar.' },
    golden:     { name: 'Golden',        emoji: '🌟', price: 5000000, desc: 'Rod berlapis emas.' },
    neon:       { name: 'Neon',          emoji: '💚', price: 8000000, desc: 'Bercahaya di kegelapan.' },
    ocean:      { name: 'Ocean',         emoji: '🌊', price: 12000000,desc: 'Motif ombak samudra.' },
    sakura:     { name: 'Sakura',        emoji: '🌸', price: 15000000,desc: 'Motif bunga sakura Jepang.' },
    dragon:     { name: 'Dragon',        emoji: '🐉', price: 50000000,desc: 'Bersisik seperti naga.' },
    cosmic:     { name: 'Cosmic',        emoji: '🌌', price: 0,       desc: 'Hanya bisa didapat dari gacha SSR.', gacha:true },
    void:       { name: 'Void',          emoji: '🌑', price: 0,       desc: 'Hanya dari token store.',  token:100 },
    rainbow:    { name: 'Rainbow',       emoji: '🌈', price: 0,       desc: 'Reward achievement 50 pts.',ach:50 },
};

// ══════════════════════════════════════════════════════════════
//   FISHING STREAK — combo mancing berturut-turut tanpa gagal
// ══════════════════════════════════════════════════════════════
const STREAK_BONUSES = [
    { streak: 3,   bonus: 1.1,  label: '🔥 3 Streak!',  desc: '+10% sell value' },
    { streak: 5,   bonus: 1.2,  label: '🔥🔥 5 Streak!', desc: '+20% sell value' },
    { streak: 10,  bonus: 1.35, label: '⚡ 10 Streak!',  desc: '+35% sell value + luck bonus' },
    { streak: 20,  bonus: 1.5,  label: '💥 20 Streak!',  desc: '+50% sell value' },
    { streak: 50,  bonus: 2.0,  label: '🌋 50 Streak!',  desc: '+100% sell value + mutation bonus' },
    { streak: 100, bonus: 3.0,  label: '🌌 100 Streak!', desc: '×3 sell value + rare fish boost' },
];

function getStreakBonus(streak) {
    let bonus = { mult: 1.0, luckAdd: 0, mutAdd: 0 };
    for (const s of STREAK_BONUSES) {
        if (streak >= s.streak) {
            bonus.mult = s.bonus;
            if (streak >= 10)  bonus.luckAdd = 0.05;
            if (streak >= 50)  bonus.mutAdd  = 0.02;
            if (streak >= 100) bonus.luckAdd = 0.15;
        }
    }
    return bonus;
}

// ══════════════════════════════════════════════════════════════
//   WORLD BOSS EVENT — event khusus boss ikan raksasa
// ══════════════════════════════════════════════════════════════
const WORLD_BOSSES = [
    {
        id: 'kraken_jr',
        name: '🦑 Kraken Jr.',
        hp: 10000,
        maxHp: 10000,
        active: false,
        reward: { money: 50000000, tokens: 30, tickets: 10 },
        desc: 'Anak Kraken yang mengamuk di lautan! Semua pemain bisa serang!',
        dmgPerHit: { min: 50, max: 500 },
        contributors: {},
    },
    {
        id: 'leviathan',
        name: '🌊 Leviathan Purba',
        hp: 50000,
        maxHp: 50000,
        active: false,
        reward: { money: 500000000, tokens: 150, tickets: 50 },
        desc: 'Makhluk purba telah terbangun! Butuh kerja sama semua pemancing!',
        dmgPerHit: { min: 100, max: 1500 },
        contributors: {},
    },
];

let activeWorldBoss = null;
let BOSS_SPAWN_GROUP = null; // group ID untuk announce boss

// Auto-spawn boss tiap 4-8 jam
function scheduleBossSpawn() {
    const minMs = 4 * 60 * 60 * 1000;
    const maxMs = 8 * 60 * 60 * 1000;
    const delay = minMs + Math.random() * (maxMs - minMs);
    setTimeout(async () => {
        if (!activeWorldBoss && BOSS_SPAWN_GROUP) {
            const template = WORLD_BOSSES[Math.floor(Math.random() * WORLD_BOSSES.length)];
            activeWorldBoss = { ...template, hp: template.maxHp, contributors: {} };
            try {
                const { client: _cl } = global._botClient || {};
                if (_cl) await _cl.sendMessage(BOSS_SPAWN_GROUP, {
                    text: `🌊 *WORLD BOSS MUNCUL!*

` +
                          `👹 *${activeWorldBoss.name}*
` +
                          `📝 ${activeWorldBoss.desc}

` +
                          `❤️ HP: *${activeWorldBoss.hp.toLocaleString()}*
` +
                          `🎁 Reward: ${activeWorldBoss.reward.money.toLocaleString()} money + ${activeWorldBoss.reward.tokens} tokens

` +
                          `⚔️ Serang dengan *!boss attack*!`
                });
            } catch(_) {}
        }
        scheduleBossSpawn();
    }, delay);
}
scheduleBossSpawn();

async function attackWorldBoss(user, client, from) {
    if (!activeWorldBoss) return null;
    const dmg = Math.floor(
        activeWorldBoss.dmgPerHit.min +
        Math.random() * (activeWorldBoss.dmgPerHit.max - activeWorldBoss.dmgPerHit.min)
    );
    activeWorldBoss.hp = Math.max(0, activeWorldBoss.hp - dmg);
    activeWorldBoss.contributors[user.id] = (activeWorldBoss.contributors[user.id] || 0) + dmg;

    if (activeWorldBoss.hp <= 0) {
        // Boss kalah — bagi reward
        const totalDmg = Object.values(activeWorldBoss.contributors).reduce((a,b)=>a+b,0);
        const boss = activeWorldBoss;
        activeWorldBoss = null;

        // Umumkan di grup
        let announce = `🎉 *${boss.name} TELAH DIKALAHKAN!*\n\n`;
        announce += `👥 Kontributor teratas:\n`;
        const sorted = Object.entries(boss.contributors).sort((a,b)=>b[1]-a[1]).slice(0,5);
        for (const [uid, d] of sorted) {
            const pct = ((d/totalDmg)*100).toFixed(1);
            announce += `  • Player ${uid}: ${formatMoney(d)} dmg (${pct}%)\n`;
        }
        announce += `\n🎁 Reward dibagi proporsional dari total prize!`;

        try { await client.sendMessage(from, { text: announce }); } catch(_){}

        return { bossKilled: true, dmg, boss };
    }
    return { bossKilled: false, dmg };
}

// ══════════════════════════════════════════════════════════════
//   FISHING MINIGAME — chance dapat bonus dari "perfect timing"
// ══════════════════════════════════════════════════════════════
// Pemain bisa kirim .reel saat mancing untuk dapat "perfect catch bonus"
// Timing random — bot simpan window waktu yang harus ditebak
const REEL_WINDOWS = new Map(); // senderNumber -> { windowStart, windowEnd, rodKey, island, notifSent }
const RESET_CONFIRM = new Map(); // senderNumber -> { targetId, targetUsername, expiry }
const ESCAPE_TIMERS = new Map(); // senderNumber -> timeoutId
const FORCED_RARITY = new Map(); // senderNumber -> rarity string (one-shot)
const COMMAND_COOLDOWNS = new Map(); // senderNumber -> last command timestamp
const SPAM_TRACKER = new Map();     // senderNumber -> { count, windowStart }
const BANNED_USERS = new Map();     // senderNumber -> banExpiry timestamp

const SPAM_WINDOW_MS = 10000;  // window deteksi: 10 detik
const SPAM_WARN_AT   = 4;      // warning setelah 4 cmd dalam window
const SPAM_BAN_AT    = 7;      // ban setelah 7 cmd dalam window
const BAN_DURATION   = 24 * 60 * 60 * 1000; // 24 jam
const RARITY_ESCAPE_TIME = {
    common: 60000, uncommon: 45000, rare: 30000, epic: 20000,
    legendary: 15000, mythic: 10000, godly: 8000, exotic: 7000,
    secret: 6000, relic: 5000, fragment: 5000, gemstone: 4000,
    extinct: 4000, limited: 3000, apex: 3000, cataclysmic: 2000, special: 2000
};

function createReelWindow(senderNumber, rodKey, island, realReadyAt, chatId, clientRef, escapeMs = 30000, origMsg = null, rawJid = null) {
    // Notif dikirim tepat saat readyAt — window reel: 2.5 detik setelah notif
    const windowStart = realReadyAt;
    const windowEnd   = windowStart + 2500; // hanya 2.5 detik window!
    REEL_WINDOWS.set(senderNumber, { windowStart, windowEnd, rodKey, island, notifSent: false });

    // Jadwalkan notif otomatis saat ikan benar-benar gigit
    const delay = realReadyAt - Date.now();
    setTimeout(async () => {
        const w = REEL_WINDOWS.get(senderNumber);
        if (!w || w.notifSent) return;
        w.notifSent = true;
        REEL_WINDOWS.set(senderNumber, w);
        try {
            // Pakai rawJid (bisa @lid atau @s.whatsapp.net) untuk mention yang benar
            const mentionJid = rawJid || (senderNumber.includes('@') ? senderNumber : `${senderNumber}@s.whatsapp.net`);
            await clientRef.sendMessage(chatId, {
                text: `@${mentionJid.split('@')[0]} 🎣 *IKAN MENGGIGIT!*\n\n⚡ Cepat kirim *!reel* sekarang!\n_Window menutup dalam 2.5 detik!_`,
                mentions: [mentionJid]
            }, origMsg ? { quoted: origMsg } : {});
        } catch (err) {
            console.error('[createReelWindow] Gagal kirim notif ikan gigit:', err?.message || err);
        }
    }, Math.max(100, delay));

    // Notif ikan kabur otomatis setelah expiresAt (sesuai rarity)
    const escapeDelay = delay + escapeMs;
    const escapeTimer = setTimeout(async () => {
        ESCAPE_TIMERS.delete(senderNumber);
        try {
            const Player = require('mongoose').model('Player');
            const user = await Player.findOne({
                $or: [
                    { whatsappNumber: senderNumber },
                    { 'fishingPending.sender': senderNumber }
                ]
            });
            if (!user) return;
            const still = (user.fishingPending || []).find(p => p.sender === senderNumber);
            if (!still || !still.expiresAt || Date.now() < Number(still.expiresAt)) return;
            user.fishingPending = user.fishingPending.filter(p => p.sender !== senderNumber);
            await user.save();
            const mentionJid = rawJid || (senderNumber.includes('@') ? senderNumber : `${senderNumber}@s.whatsapp.net`);
            await clientRef.sendMessage(chatId, {
                text: `@${mentionJid.split('@')[0]} 🐟 Ikanmu kabur! Terlalu lama tidak diambil.\nKirim *!mancing* untuk coba lagi.`,
                mentions: [mentionJid]
            });
        } catch (_) {}
    }, Math.max(0, escapeDelay));
    ESCAPE_TIMERS.set(senderNumber, escapeTimer);

    return { windowStart, windowEnd };
}

function checkReelTiming(senderNumber) {
    const w = REEL_WINDOWS.get(senderNumber);
    const now = Date.now();
    // Tidak ada session di memori (bot restart, atau belum mancing)
    if (!w) return 'no_session';
    // Belum waktunya ikan gigit — user kirim !reel terlalu cepat
    if (now < w.windowStart) return 'too_early';
    // Sudah lewat window 2.5 detik setelah ikan gigit
    if (now > w.windowEnd) return 'too_late';
    // Tepat waktu — perfect catch!
    REEL_WINDOWS.delete(senderNumber);
    return 'perfect';
}

// ══════════════════════════════════════════════════════════════
//   FISHING STREAK PER USER (in-memory, reset saat server restart)
// ══════════════════════════════════════════════════════════════
const FISHING_STREAKS = new Map(); // senderNumber -> streak count
const BLACKJACK_GAMES = new Map(); // senderNumber -> { deck, playerHand, dealerHand, bet, status }

const mutations = {
  "Universe": { "multiplier": 24, "chance": 0.00001 },
  "Frozen": { "multiplier": 21, "chance": 0.00001 },
  "Phoenix": { "multiplier": 19, "chance": 0.00001 },
  "Seeker": { "multiplier": 17.8, "chance": 0.00001 },
  "Tryhard": { "multiplier": 17, "chance": 0.0005 },
  "Darkness": { "multiplier": 16.8, "chance": 0.0005 },
  "Mossy": { "multiplier": 16.5, "chance": 0.0005 },
  "Mastered": { "multiplier": 16, "chance": 0.0005 },
  "Glowy": { "multiplier": 15, "chance": 0.0007 },
  "Umbra": { "multiplier": 15, "chance": 0.0007 },
  "Evil": { "multiplier": 15, "chance": 0.0007 },
  "Nocturnal": { "multiplier": 14.2, "chance": 0.0008 },
  "Serene": { "multiplier": 14, "chance": 0.0008 },
  "Diurnal": { "multiplier": 13.5, "chance": 0.0008 },
  "Atomic": { "multiplier": 12, "chance": 0.001 },
  "Chaotic": { "multiplier": 12, "chance": 0.001 },
  "Glacial": { "multiplier": 12, "chance": 0.001 },
  "Oscar": { "multiplier": 12, "chance": 0.001 },
  "Puritas": { "multiplier": 10.7, "chance": 0.0015 },
  "Snowy": { "multiplier": 10, "chance": 0.002 },
  "Blessed": { "multiplier": 10, "chance": 0.002 },
  "Infernal": { "multiplier": 10, "chance": 0.002 },
  "Tentacle Surge": { "multiplier": 10, "chance": 0.002 },
  "Breezed": { "multiplier": 10, "chance": 0.002 },
  "Flora": { "multiplier": 10, "chance": 0.002 },
  "Luminescent": { "multiplier": 9, "chance": 0.0025 },
  "Carrot": { "multiplier": 8, "chance": 0.003 },
  "Nuclear": { "multiplier": 8, "chance": 0.003 },
  "Rainbow Cluster": { "multiplier": 8, "chance": 0.003 },
  "Chilled": { "multiplier": 8, "chance": 0.003 },
  "Prismize": { "multiplier": 8, "chance": 0.003 },
  "Sanguine": { "multiplier": 8, "chance": 0.003 },
  "Toxic": { "multiplier": 8, "chance": 0.003 },
  "Sacratus": { "multiplier": 7.7, "chance": 0.0035 },
  "Nova": { "multiplier": 7.5, "chance": 0.0035 },
  "Shrouded": { "multiplier": 7.5, "chance": 0.0035 },
  "Stardust": { "multiplier": 7.5, "chance": 0.0035 },
  "Levitas": { "multiplier": 7, "chance": 0.004 },
  "Aurora": { "multiplier": 6.5, "chance": 0.0045 },
  "Wrath": { "multiplier": 6.5, "chance": 0.0045 },
  "Astral": { "multiplier": 6, "chance": 0.005 },
  "Gemstone": { "multiplier": 6, "chance": 0.005 },
  "Heavenly": { "multiplier": 6, "chance": 0.005 },
  "Crimson": { "multiplier": 6, "chance": 0.005 },
  "Lost": { "multiplier": 5.5, "chance": 0.006 },
  "Ashen Fortune": { "multiplier": 5, "chance": 0.007 },
  "Bloom": { "multiplier": 5, "chance": 0.007 },
  "Colossal Ink": { "multiplier": 5, "chance": 0.007 },
  "Cursed Touch": { "multiplier": 5, "chance": 0.007 },
  "Emberflame": { "multiplier": 5, "chance": 0.007 },
  "Galactic": { "multiplier": 5, "chance": 0.007 },
  "Lobster": { "multiplier": 5, "chance": 0.007 },
  "Nullified": { "multiplier": 5, "chance": 0.007 },
  "Subspace": { "multiplier": 5, "chance": 0.007 },
  "Quiet": { "multiplier": 5, "chance": 0.007 },
  "Mythical": { "multiplier": 4.5, "chance": 0.008 },
  "Anomalous": { "multiplier": 4.44, "chance": 0.008 },
  "Spirit": { "multiplier": 4.2, "chance": 0.008 },
  "Aureolin": { "multiplier": 4, "chance": 0.009 },
  "Greedy": { "multiplier": 4, "chance": 0.009 },
  "Revitalized": { "multiplier": 4, "chance": 0.009 },
  "Sunken": { "multiplier": 4, "chance": 0.009 },
  "Abyssal": { "multiplier": 3.5, "chance": 0.01 },
  "Aurulent": { "multiplier": 3.5, "chance": 0.01 },
  "Electric Shock": { "multiplier": 3.5, "chance": 0.01 },
  "Vined": { "multiplier": 3.5, "chance": 0.01 },
  "Atlantean": { "multiplier": 3, "chance": 0.012 },
  "Aureate": { "multiplier": 3, "chance": 0.012 },
  "Blighted": { "multiplier": 3, "chance": 0.012 },
  "Brown Wood": { "multiplier": 3, "chance": 0.012 },
  "Celestial": { "multiplier": 3, "chance": 0.012 },
  "Cracked": { "multiplier": 3, "chance": 0.012 },
  "Crystalized": { "multiplier": 3, "chance": 0.012 },
  "Ember": { "multiplier": 3, "chance": 0.012 },
  "Green Leaf": { "multiplier": 3, "chance": 0.012 },
  "Mother Nature": { "multiplier": 3, "chance": 0.012 },
  "Aurelian": { "multiplier": 2.5, "chance": 0.015 },
  "Fossilized": { "multiplier": 2.5, "chance": 0.015 },
  "Lunar": { "multiplier": 2.5, "chance": 0.015 },
  "Scorched": { "multiplier": 2.5, "chance": 0.015 },
  "Solarblaze": { "multiplier": 2.5, "chance": 0.015 },
  "Sleet": { "multiplier": 2.4, "chance": 0.018 },
  "Moon-Kissed": { "multiplier": 2.2, "chance": 0.02 },
  "Aurous": { "multiplier": 2, "chance": 0.025 },
  "Midas": { "multiplier": 2, "chance": 0.025 },
  "Giant": { "multiplier": 2, "chance": 0.03 },
  "Purified": { "multiplier": 2, "chance": 0.03 },
  "Sparkling": { "multiplier": 1.85, "chance": 0.05 },
  "Glossy": { "multiplier": 1.6, "chance": 0.06 },
  "Silver": { "multiplier": 1.6, "chance": 0.06 },
  "Brother": { "multiplier": 1.5, "chance": 0.07 },
  "Big": { "multiplier": 1.5, "chance": 0.08 },
  // ── NEW MUTATIONS ────────────────────────────
  "Transparent": { "multiplier": 1.6, "chance": 0.025 },
  "Metallic": { "multiplier": 1.9, "chance": 0.018 },
  "Bioluminescent": { "multiplier": 2.1, "chance": 0.014 },
  "Ancient": { "multiplier": 2.3, "chance": 0.012 },
  "Radioactive": { "multiplier": 2.5, "chance": 0.009 },
  "Crystalline": { "multiplier": 2.7, "chance": 0.007 },
  "Void-Touched": { "multiplier": 2.9, "chance": 0.006 },
  "Mythweaver": { "multiplier": 3.1, "chance": 0.005 },
  "Starborn": { "multiplier": 3.3, "chance": 0.004 },
  "Primordial": { "multiplier": 3.6, "chance": 0.003 },
  "Dreambreaker": { "multiplier": 3.9, "chance": 0.002 },
  "Sovereign": { "multiplier": 4.2, "chance": 0.001 },
  "Omniscient": { "multiplier": 4.5, "chance": 0.0008 },
  "Transcendent": { "multiplier": 4.8, "chance": 0.00005 },
  "Absolute": { "multiplier": 5.0, "chance": 0.00001 }
};

// Mutasi Goblin — hanya aktif saat event Raining Goblin (diset chance 1.0 saat event on)
mutations["Goblin"] = { multiplier: 999999, chance: 0 }; // chance 0 = tidak muncul normal

// ===== MESSAGE HANDLER =====

// Set untuk track message ID yang sudah diproses (reset saat restart = sengaja)
if (!global.PROCESSED_MSG_IDS) global.PROCESSED_MSG_IDS = new Set();
if (!global.BOT_START_TIME) global.BOT_START_TIME = Date.now();
if (!global.LID_CACHE) global.LID_CACHE = {};

// Load LID map dari auth dir (lid-mapping-*.json) — production guide layer 3
if (!global.LID_MAP) {
    global.LID_MAP = new Map();
    try {
        const _fs = require('fs'), _path = require('path');
        const authDir = _path.join(__dirname, 'sesi_bot');
        if (_fs.existsSync(authDir)) {
            _fs.readdirSync(authDir).filter(f => f.includes('lid-mapping')).forEach(file => {
                try {
                    const data = JSON.parse(_fs.readFileSync(_path.join(authDir, file), 'utf8'));
                    for (const [k, v] of Object.entries(data)) global.LID_MAP.set(k, String(v).replace(/\D/g, ''));
                } catch (_) {}
            });
            if (global.LID_MAP.size > 0) console.log(`[LID] Loaded ${global.LID_MAP.size} mappings from auth dir`);
        }
    } catch (_) {}
}

module.exports = async (client, m, chatUpdate, store) => {
    if (!global._botClient) global._botClient = { client };
    else global._botClient.client = client;

    const msgTs = m?.messageTimestamp ? Number(m.messageTimestamp) * 1000 : 0;
    if (msgTs && msgTs < global.BOT_START_TIME) return;

    // Dedup: skip pesan yang sudah diproses (per-instance)
    const _botInstanceId = (client.user?.id || (client.isBot3 ? '__bot3__' : (client.isBot2 ? '__bot2__' : '__bot1__'))).split(':')[0].split('@')[0];
    if (!global.PROCESSED_MSG_IDS_MAP) global.PROCESSED_MSG_IDS_MAP = {};
    if (!global.PROCESSED_MSG_IDS_MAP[_botInstanceId]) global.PROCESSED_MSG_IDS_MAP[_botInstanceId] = new Set();
    const _dedupSet = global.PROCESSED_MSG_IDS_MAP[_botInstanceId];
    const msgId = m?.key?.id;
    if (msgId) {
        if (_dedupSet.has(msgId)) return;
        _dedupSet.add(msgId);
        if (_dedupSet.size > 5000) {
            const arr = [..._dedupSet];
            global.PROCESSED_MSG_IDS_MAP[_botInstanceId] = new Set(arr.slice(arr.length - 2500));
        }
    }

    // ── Init LID cache dari contacts store (sekali) ────────
    if (!global.LID_CACHE) {
        global.LID_CACHE = {};
        try {
            const contacts = store?.contacts || {};
            for (const [jid, contact] of Object.entries(contacts)) {
                if (jid.endsWith('@lid') && contact.phoneNumber) {
                    const lid = jid.split('@')[0];
                    const num = contact.phoneNumber.replace(/\D/g, '');
                    if (num) global.LID_CACHE[lid] = num;
                }
                // Beberapa versi Baileys simpan di field berbeda
                if (jid.endsWith('@s.whatsapp.net') && contact.lid) {
                    const lid = contact.lid.split('@')[0];
                    const num = jid.split('@')[0];
                    if (lid && num) global.LID_CACHE[lid] = num;
                }
            }
            if (Object.keys(global.LID_CACHE).length > 0) {
                console.log(`[LID] Loaded ${Object.keys(global.LID_CACHE).length} LID mappings from store`);
            }
        } catch (_) {}
    }
    try {
        // ── Skip pesan sistem — tidak perlu diproses ──────────
        const _mtype = m?.mtype || Object.keys(m?.message || {})[0] || '';
        const SKIP_TYPES = [
            'protocolMessage', 'senderKeyDistributionMessage',
            'reactionMessage', 'readReceiptMessage',
            'pollCreationMessage', 'pollUpdateMessage',
            'callLogMesssage', 'callLogMessage',
        ];
        if (SKIP_TYPES.includes(_mtype)) return;

        // ── Parse body dari semua tipe pesan ─────────────────
        const body = (() => {
            try {
                if (m.mtype === 'conversation')               return m.message?.conversation || '';
                if (m.mtype === 'extendedTextMessage')        return m.message?.extendedTextMessage?.text || '';
                if (m.mtype === 'imageMessage')               return m.message?.imageMessage?.caption || '';
                if (m.mtype === 'videoMessage')               return m.message?.videoMessage?.caption || '';
                if (m.mtype === 'documentMessage')            return m.message?.documentMessage?.caption || '';
                if (m.mtype === 'buttonsResponseMessage')     return m.message?.buttonsResponseMessage?.selectedButtonId || '';
                if (m.mtype === 'listResponseMessage')        return m.message?.listResponseMessage?.singleSelectReply?.selectedRowId || '';
                if (m.mtype === 'templateButtonReplyMessage') return m.msg?.selectedId || '';
                if (m.mtype === 'interactiveResponseMessage') {
                    try { return JSON.parse(m.msg?.nativeFlowResponseMessage?.paramsJson || '{}')?.id || ''; } catch { return ''; }
                }
                return m.body || m.text || '';
            } catch { return m.body || m.text || ''; }
        })();

        // ── Routing info (harus DULU sebelum sender) ─────────
        const from    = m.key.remoteJid;
        const isGroup = from.endsWith('@g.us');

        // ── Sender info ───────────────────────────────────────
        // participantPn = sudah resolved @s.whatsapp.net oleh itsliaaa/baileys
        // participant   = bisa @lid di grup LID-mode
        // Prioritaskan participantPn kalau ada agar tidak perlu resolve manual
        const sender = m.key.fromMe
            ? client.decodeJid(client.user.id)
            : (isGroup
                ? (m.key.participantPn || m.key.participant || m.participant || '')
                : from);

        // Fix LID: convert @lid ke nomor asli via cache/store/groupMetadata
        async function resolveSenderNumber(raw, from) {
            if (!raw) return '';

            // Layer 1: Phone JID langsung (@s.whatsapp.net) — JANGAN match @lid,
            // karena LID juga berupa digit diikuti '@', regex lama ketuker.
            if (raw.endsWith('@s.whatsapp.net')) {
                const phoneMatch = raw.match(/^(\d+)@/);
                if (phoneMatch) return phoneMatch[1];
            }

            // Bukan LID
            if (!raw.endsWith('@lid')) return raw.split('@')[0];

            const lid = raw.split('@')[0];

            // Hardcoded admin mapping
            if (LID_TO_PHONE[lid]) return LID_TO_PHONE[lid];

            // Cache
            if (global.LID_CACHE?.[lid]) return global.LID_CACHE[lid];

            // Layer 1b: client.findUserId() — built-in @itsliaaa/baileys resolver,
            // paling reliable buat resolve LID -> phoneNumber (atau sebaliknya).
            try {
                if (typeof client.findUserId === 'function') {
                    const found = await client.findUserId(raw);
                    if (found?.phoneNumber) {
                        const num = String(found.phoneNumber).split('@')[0].replace(/\D/g, '');
                        if (num) { global.LID_CACHE[lid] = num; return num; }
                    }
                }
            } catch (_) {}

            // Layer 2: store.contacts
            try {
                const contact = Object.values(store?.contacts || {}).find(c =>
                    c.id === raw || c.jid === raw
                );
                if (contact?.phoneNumber) {
                    const num = String(contact.phoneNumber).replace(/\D/g, '');
                    if (num) { global.LID_CACHE[lid] = num; return num; }
                }
                // Cari via lid field di contacts
                for (const [jid, c] of Object.entries(store?.contacts || {})) {
                    if (!jid.endsWith('@s.whatsapp.net')) continue;
                    const cLid = (c.lid || '').split('@')[0];
                    if (cLid === lid) {
                        const num = jid.split('@')[0];
                        global.LID_CACHE[lid] = num;
                        return num;
                    }
                }
            } catch (_) {}

            // Layer 2b: group metadata (+ phoneNumber untuk Baileys v6.7.19+)
            try {
                if (from?.endsWith('@g.us')) {
                    const meta = await client.groupMetadata(from).catch(() => null);
                    const found = meta?.participants?.find(p =>
                        p.lid === raw || (p.lid || '').split('@')[0] === lid
                    );
                    if (found?.phoneNumber) {
                        const num = String(found.phoneNumber).replace(/\D/g, '');
                        if (num) { global.LID_CACHE[lid] = num; return num; }
                    }
                    if (found?.id?.includes('@s.whatsapp.net')) {
                        const num = found.id.split('@')[0];
                        global.LID_CACHE[lid] = num;
                        return num;
                    }
                }
            } catch (_) {}

            // Layer 3: LID_MAP dari auth dir (lid-mapping-*.json)
            try {
                if (global.LID_MAP?.has(raw)) {
                    const num = String(global.LID_MAP.get(raw)).replace(/\D/g, '');
                    if (num) { global.LID_CACHE[lid] = num; return num; }
                }
                if (global.LID_MAP?.has(lid)) {
                    const num = String(global.LID_MAP.get(lid)).replace(/\D/g, '');
                    if (num) { global.LID_CACHE[lid] = num; return num; }
                }
            } catch (_) {}

            // Layer 4: DB player
            try {
                const Player = require('mongoose').model('Player');
                const found = await Player.findOne({ whatsappLid: lid }).lean();
                if (found?.whatsappNumber) {
                    const num = found.whatsappNumber.replace(/\D/g, '');
                    if (num) { global.LID_CACHE[lid] = num; return num; }
                }
            } catch (_) {}

            return lid; // Fallback
        }

        const rawSender = isGroup
            ? (m.key.participant || m.participant || sender || '')
            : (m.key.fromMe ? client.decodeJid(client.user.id) : from);

        // Auto-learn LID mapping: kalau ada info nomor asli dari pushName context
        // Simpan mapping LID -> nomor dari contacts store jika tersedia
        if (!global.LID_CACHE) global.LID_CACHE = {};
        try {
            // Baileys menyimpan contact info di store — coba ambil dari sana
            const contactId = rawSender.endsWith('@lid')
                ? rawSender
                : (from.endsWith('@lid') ? from : null);
            if (contactId && client.store?.contacts) {
                const contact = client.store.contacts[contactId];
                if (contact?.notify || contact?.name) {
                    // Ada info contact tapi bukan nomor — skip
                }
            }
            // Cara paling reliable: dari m.key jika ada phoneNumber
            if (rawSender.endsWith('@lid') && m.verifiedBizName === undefined) {
                const lid = rawSender.split('@')[0];
                // Simpan pushname untuk cross-reference nanti
                if (m.pushName && !global.LID_CACHE[lid]) {
                    global.LID_NAME_CACHE = global.LID_NAME_CACHE || {};
                    global.LID_NAME_CACHE[lid] = m.pushName;
                }
            }
        } catch (_) {}

        const senderNumber = await resolveSenderNumber(rawSender, from);

        // Kalau resolve berhasil (LID -> nomor asli), simpan ke cache
        if (rawSender.endsWith('@lid') && senderNumber !== rawSender.split('@')[0]) {
            const lid = rawSender.split('@')[0];
            global.LID_CACHE[lid] = senderNumber;
        }

        // Cek admin — langsung compare semua kemungkinan format sender
        const rawSenderStripped = (rawSender || '').split('@')[0];
        // Owner asli (hardcoded) — TIDAK termasuk adminbot dari config.admins
        const OWNER_LIST = [
            '6282132455151',
            '161933470781692',
            '1619334373037381363932'
        ].map(a => String(a).replace(/[^\d]/g, ''));
        // Admin list = owner + adminbot dari config
        const ADMIN_LIST = [
            ...(config.admins || []),
            ...OWNER_LIST
        ].map(a => String(a).replace(/[^\d]/g, ''));
        const senderClean  = String(senderNumber || '').replace(/[^\d]/g, '');
        const rawClean     = String(rawSenderStripped || '').replace(/[^\d]/g, '');
        const mSenderClean = String((m.sender || '').split('@')[0]).replace(/[^\d]/g, '');

        // ── Group metadata — fetch SEKALI di sini, reuse di seluruh
        // handler pesan ini. Sebelumnya dipanggil 2x terpisah (di sini
        // dan lagi di bawah), masing-masing round-trip ke WA server,
        // yang bikin respons command di grup jauh lebih lambat (~500ms)
        // dibanding di private chat (~5ms).
        const groupMetadata  = isGroup ? await client.groupMetadata(from).catch(() => ({})) : {};

        // Resolve juga via store.contacts kalau rawSender masih @lid
        // Penting untuk isOwner di grup — sender bisa datang sebagai @lid
        let _resolvedSenderClean = senderClean;
        if (rawSender?.endsWith('@lid') && (!senderClean || senderClean === rawClean)) {
            const _lid = rawSender.split('@')[0];
            // Coba store.contacts dulu
            try {
                for (const [cJid, c] of Object.entries(store?.contacts || {})) {
                    if (!cJid.endsWith('@s.whatsapp.net')) continue;
                    if ((c.lid || '').split('@')[0] === _lid) {
                        _resolvedSenderClean = cJid.split('@')[0].replace(/[^\d]/g, '');
                        if (global.LID_CACHE) global.LID_CACHE[_lid] = _resolvedSenderClean;
                        break;
                    }
                }
            } catch (_) {}
            // Fallback: groupMetadata participants (reuse hasil fetch di atas)
            if (_resolvedSenderClean === senderClean) {
                try {
                    const _found = groupMetadata?.participants?.find(p =>
                        p.lid === rawSender || (p.lid || '').split('@')[0] === _lid
                    );
                    if (_found?.id?.endsWith('@s.whatsapp.net')) {
                        _resolvedSenderClean = _found.id.split('@')[0].replace(/[^\d]/g, '');
                        if (global.LID_CACHE) global.LID_CACHE[_lid] = _resolvedSenderClean;
                    } else if (_found?.phoneNumber) {
                        _resolvedSenderClean = String(_found.phoneNumber).replace(/[^\d]/g, '');
                        if (global.LID_CACHE) global.LID_CACHE[_lid] = _resolvedSenderClean;
                    }
                } catch (_) {}
            }
        }

        // isOwner hanya true untuk owner asli (hardcoded), bukan adminbot
        // Cek semua kemungkinan format: resolved number, raw number, m.sender, rawSenderStripped (LID raw)
        const isOwner = OWNER_LIST.some(a =>
            a.length > 0 && (
                a === senderClean ||
                a === _resolvedSenderClean ||
                a === rawClean ||
                a === mSenderClean
            )
        );
        const budy = body;

        // ── Prefix & command parsing ──────────────────────────
        // Per-chat prefix: each group (or private chat) can have its own prefix.
        // Falls back to global.BOT_PREFIX then '!' when no override is set.
        if (!global.CHAT_PREFIX) global.CHAT_PREFIX = {}; // { [chatJid]: prefixChar }
        const _chatPrefixKey = from; // use JID as key (works for groups AND private)
        const _activePrefix  = global.CHAT_PREFIX[_chatPrefixKey] || global.BOT_PREFIX || '!';
        const prefixRegex = new RegExp(`^[${_activePrefix.replace(/[-[\]{}()*+?.,\\^$|#\s]/g,'\\$&')}]`);
        const prefix    = body && prefixRegex.test(body) ? body[0] : _activePrefix;
        const bodyClean = body.replace(/@\d+/g, '').trim();
        const botNumber = await client.decodeJid(client.user.id);
        const isBot     = senderNumber.length > 0 && botNumber.includes(senderNumber);

        const isCmd   = body.startsWith(prefix) || bodyClean.startsWith(prefix);
        const _cmdBody = body.startsWith(prefix) ? body : bodyClean;
        const command = isCmd ? _cmdBody.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase() : '';
        const args    = isCmd ? _cmdBody.slice(prefix.length).trim().split(/\s+/).slice(1) : [];
        const pushname = m.pushName || 'No Name';
        const q    = args.join(' ');
        const text = q;
        const quoted = m.quoted ? m.quoted : m;
        const mime   = (quoted.msg || quoted).mimetype || '';
        const qmsg   = (quoted.msg || quoted);
        const isMedia = /image|video|sticker|audio/.test(mime);

        // ── Group metadata sudah di-fetch sekali di atas (reuse) ──
        const groupName      = isGroup ? (groupMetadata.subject || '') : '';
        // Map participants — itsliaaa/baileys expose p.phoneNumber kalau p.id adalah @lid
        // p.id        = JID utama: @s.whatsapp.net ATAU @lid
        // p.phoneNumber = nomor HP dalam format @s.whatsapp.net (tersedia di LID-mode grup)
        // p.lid       = LID format kalau p.id adalah @s.whatsapp.net
        const participants   = isGroup ? (groupMetadata.participants || []).map(p => ({
            id:    p.phoneNumber || p.id || p.lid || null, // prioritas phoneNumber (sudah resolved)
            jid:   p.phoneNumber || p.id || p.lid || null,
            lid:   p.lid || (p.id?.endsWith('@lid') ? p.id : null),
            admin: p.admin === 'superadmin' ? 'superadmin' : p.admin === 'admin' ? 'admin' : null,
            full:  p
        })) : [];
        const groupOwner    = isGroup ? (participants.find(p => p.admin === 'superadmin')?.jid || '') : '';
        const groupAdmins   = participants
            .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
            .map(p => p.full?.phoneNumber || p.full?.id || p.full?.lid || p.jid);

        const _normJid = j => (j || '').split('@')[0].split(':')[0];
        const _botNumNorm = _normJid(botNumber);
        // Bot sendiri juga bisa punya LID — ambil dari client.user.lid
        const _botLidNorm = _normJid(client.user?.lid || '');

        // Resolve JID admin ke nomor HP
        // Dengan itsliaaa/baileys: mayoritas sudah resolved via p.phoneNumber
        // Fallback tetap ada untuk kasus edge
        const _resolveAdminNum = (jid) => {
            if (!jid) return '';
            if (jid.endsWith('@s.whatsapp.net')) return _normJid(jid);
            if (!jid.endsWith('@lid')) return _normJid(jid);
            const lid = jid.split('@')[0];
            // 1. LID_CACHE
            if (global.LID_CACHE?.[lid]) return global.LID_CACHE[lid];
            // 2. groupMetadata participants — p.phoneNumber dari itsliaaa/baileys
            try {
                const found = groupMetadata?.participants?.find(p =>
                    p.lid === jid || (p.lid || '').split('@')[0] === lid ||
                    (p.id?.endsWith('@lid') && p.id.split('@')[0] === lid)
                );
                if (found?.phoneNumber) {
                    const num = String(found.phoneNumber).replace(/\D/g, '');
                    if (num && global.LID_CACHE) global.LID_CACHE[lid] = num;
                    return num;
                }
                if (found?.id?.endsWith('@s.whatsapp.net')) {
                    const num = found.id.split('@')[0];
                    if (global.LID_CACHE) global.LID_CACHE[lid] = num;
                    return num;
                }
            } catch (_) {}
            // 3. store.contacts
            try {
                for (const [cJid, c] of Object.entries(store?.contacts || {})) {
                    if (!cJid.endsWith('@s.whatsapp.net')) continue;
                    if ((c.lid || '').split('@')[0] === lid) {
                        const num = cJid.split('@')[0];
                        if (global.LID_CACHE) global.LID_CACHE[lid] = num;
                        return num;
                    }
                }
            } catch (_) {}
            return lid;
        };

        // Debug — aktifkan dengan DEBUG_BOT_ADMIN=1
        if (isGroup && process.env.DEBUG_BOT_ADMIN === '1') {
            console.log('[isBotAdmins] botNumber:', botNumber, '| norm:', _botNumNorm, '| botLid:', _botLidNorm);
            console.log('[isBotAdmins] groupAdmins raw:', groupAdmins);
            console.log('[isBotAdmins] resolved:', groupAdmins.map(a => _resolveAdminNum(a)));
        }

        // Cek bot sebagai admin: compare via nomor HP DAN via LID bot
        const isBotAdmins = isGroup ? groupAdmins.some(a => {
            const resolved = _resolveAdminNum(a);
            return resolved === _botNumNorm || (_botLidNorm && _normJid(a) === _botLidNorm);
        }) : false;
        // Cek sender sebagai admin: sama seperti isBotAdmins, resolve LID
        // dulu baru bandingkan nomor HP-nya. m.sender bisa dalam format
        // LID (@lid) sementara groupAdmins isinya campuran nomor HP/LID/JID,
        // jadi exact-match .includes(m.sender) gampang false-negative.
        const _senderNumNorm = _normJid(m.sender);
        const _senderResolved = m.sender?.endsWith('@lid')
            ? (global.LID_CACHE?.[_senderNumNorm] || senderNumber)
            : _senderNumNorm;
        const isAdmins      = isGroup ? groupAdmins.some(a => {
            const resolved = _resolveAdminNum(a);
            return resolved === _senderResolved || resolved === _senderNumNorm || _normJid(a) === _senderNumNorm;
        }) : false;
        const isGroupOwner  = isGroup ? groupOwner === m.sender : false;

        // ── Log incoming message ──────────────────────────────
        const _botId = (client.user?.id || '').split(':')[0].split('@')[0];
        if (m.message && !m.key.fromMe && getConsoleMsgOn(_botId)) {
            const bodyPreview = String(body || m.mtype || '-').slice(0, 80);
            console.log(chalk.bgHex('#4a69bd').bold(' ▢ New Message '));
            console.log(chalk.cyan(`   Tanggal : ${new Date().toLocaleString()}`));
            console.log(chalk.white(`   Pesan   : ${bodyPreview}`));
            console.log(chalk.white(`   Dari    : ${pushname} [${senderNumber}]`));
        }

        // ── Log pesan bot (fromMe) ────────────────────────────
        if (m.message && m.key.fromMe && getConsoleMsgBotOn(_botId)) {
            const bodyPreview = String(body || m.mtype || '-').slice(0, 80);
            console.log(chalk.bgHex('#27ae60').bold(' ▢ Bot Message '));
            console.log(chalk.cyan(`   Tanggal : ${new Date().toLocaleString()}`));
            console.log(chalk.white(`   Pesan   : ${bodyPreview}`));
            console.log(chalk.white(`   Ke      : ${m.chat}`));
        }

        // ── MSG_CACHE — simpan key pesan per sender per grup ──
        // Termasuk pesan fromMe (pesan owner sendiri), biar .purge bisa
        // hapus pesan sendiri juga, bukan cuma pesan member lain.
        if (isGroup && m.message && senderNumber && !client.isBot2) {
            if (!global.MSG_CACHE) global.MSG_CACHE = {};
            if (!global.MSG_CACHE[from]) global.MSG_CACHE[from] = {};
            if (!global.MSG_CACHE[from][senderNumber]) global.MSG_CACHE[from][senderNumber] = [];
            global.MSG_CACHE[from][senderNumber].push({ id: m.key.id, remoteJid: from, participant: m.key.participant, fromMe: !!m.key.fromMe });
            // Batasi cache maks 200 pesan per orang per grup
            if (global.MSG_CACHE[from][senderNumber].length > 200)
                global.MSG_CACHE[from][senderNumber] = global.MSG_CACHE[from][senderNumber].slice(-200);
        }

        // ── Helpers ───────────────────────────────────────────
        const reaction = async (jidss, emoji) => {
            try { await client.sendMessage(jidss, { react: { text: emoji, key: m.key } }); } catch (_) {}
        };

        const reply = async (teks) => {
            try {
                return await client.sendMessage(m.chat, { text: String(teks) }, { quoted: m });
            } catch (e) {
                // fallback tanpa quoted
                try { return await client.sendMessage(m.chat, { text: String(teks) }); } catch (_) {}
            }
        };

        // ── Plugin loader ─────────────────────────────────────
        const pluginsLoader = (dir) => {
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(file => {
                try {
                    const fp = path.join(dir, file);
                    delete require.cache[require.resolve(fp)];
                    return require(fp);
                } catch (e) { console.error(`[Plugin] ${file}:`, e.message); return null; }
            }).filter(Boolean);
        };

        const plugins = pluginsLoader(path.resolve(__dirname, './command'));
        const plug = { client, prefix, command, reply, text, isBot, reaction, pushname, mime, quoted, sleep, fquoted, fetchJson };

        for (const plugin of plugins) {
            if (typeof plugin !== 'function') continue;
            if (!Array.isArray(plugin.command)) continue;
            if (!plugin.command.includes(command)) continue;
            if (plugin.isBot && !isBot) continue;
            if (plugin.private && isGroup) { await reply(config.message.private); continue; }
            await plugin(m, plug);
        }

        // ── AntiSwgc — deteksi group status (SW GC) di grup ─────
        // PRIORITAS TERTINGGI: dicek sebelum antilink agar tidak bisa dikelabui
        if (isGroup && global.ANTISWGC_STATE?.[from]) {
            // Scan generik level-atas — cek SEMUA key tipe pesan (bukan whitelist
            // 8 tipe doang) buat contextInfo.isGroupStatus, supaya tipe pesan baru
            // (buttonsMessage, listMessage, documentWithCaptionMessage, dll) ikut
            // kena. TIDAK masuk ke dalam quotedMessage, biar reply/forward pesan
            // swgc lama nggak false-positive dianggap swgc baru.
            const _hasGroupStatusFlag = (msgObj) => {
                if (!msgObj || typeof msgObj !== 'object') return false;
                if (msgObj.groupStatusMessageV2) return true;
                return Object.keys(msgObj).some((key) => {
                    if (key === 'contextInfo') return false;
                    const val = msgObj[key];
                    return val && typeof val === 'object' && val.contextInfo?.isGroupStatus === true;
                });
            };

            const isGroupStatus =
                m.mtype === 'groupStatusMessageV2' ||
                _hasGroupStatusFlag(m.message) ||
                _hasGroupStatusFlag(m.message?.ephemeralMessage?.message) ||
                _hasGroupStatusFlag(m.message?.viewOnceMessage?.message) ||
                _hasGroupStatusFlag(m.message?.viewOnceMessageV2?.message) ||
                _hasGroupStatusFlag(m.message?.viewOnceMessageV2Extension?.message);

            if (isGroupStatus) {
                // ── Lock per (grup, sender) — cegah spam 2-3 swgc dalam
                // sedetik bikin handleAntiAction/kick/log kepanggil berkali-kali
                // paralel. Cuma trigger pertama yang diproses penuh, sisanya
                // tetep dihapus tapi nggak trigger kick/log/warn ulang.
                if (!global.ANTISWGC_LOCK) global.ANTISWGC_LOCK = {};
                const _lockKey = `${from}:${senderNumber}`;
                const _alreadyLocked = !!global.ANTISWGC_LOCK[_lockKey];
                if (!_alreadyLocked) {
                    global.ANTISWGC_LOCK[_lockKey] = true;
                    setTimeout(() => { delete global.ANTISWGC_LOCK[_lockKey]; }, 5000);
                }

                // ── Resolve participant JID (async, bisa LID → HP) ──────
                // Dipanggil tanpa await dulu — resolve jalan paralel sementara
                // delete pertama sudah dikirim pakai key original.
                const _resolveParticipantJid = async () => {
                    // participantAlt = field itsliaaa/baileys: JID HP yang sudah resolved
                    // dari LID. Ini cara paling reliable — pakai langsung kalau ada.
                    if (m.key.participantAlt?.endsWith('@s.whatsapp.net')) return m.key.participantAlt;

                    const raw = m.key.participant || rawSender || '';
                    if (raw.endsWith('@s.whatsapp.net')) return raw;
                    if (!raw.endsWith('@lid'))
                        return raw.includes('@') ? raw : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
                    const lid = raw.split('@')[0];
                    // 1. LID_CACHE (sync, zero-cost)
                    if (global.LID_CACHE?.[lid]) return `${global.LID_CACHE[lid]}@s.whatsapp.net`;
                    // 2. groupMetadata participants
                    try {
                        const meta = await client.groupMetadata(from).catch(() => null);
                        const found = meta?.participants?.find(p =>
                            p.lid === raw || (p.lid || '').split('@')[0] === lid
                        );
                        if (found?.phoneNumber) {
                            const num = String(found.phoneNumber).replace(/\D/g, '');
                            if (num) { if (global.LID_CACHE) global.LID_CACHE[lid] = num; return `${num}@s.whatsapp.net`; }
                        }
                        if (found?.id?.endsWith('@s.whatsapp.net')) {
                            const num = found.id.split('@')[0];
                            if (global.LID_CACHE) global.LID_CACHE[lid] = num;
                            return found.id;
                        }
                    } catch (_) {}
                    // 3. client.findUserId
                    try {
                        const ids = await client.findUserId(raw);
                        if (ids?.phoneNumber) {
                            const num = String(ids.phoneNumber).replace(/\D/g, '');
                            if (num) { if (global.LID_CACHE) global.LID_CACHE[lid] = num; return `${num}@s.whatsapp.net`; }
                        }
                    } catch (_) {}
                    return raw;
                };

                // ── Log key untuk debug (JANGAN HAPUS sampai delete confirmed work) ──
                console.log('[AntiSwgc] mtype:', m.mtype, '| key:', JSON.stringify(m.key), '| message keys:', Object.keys(m.message || {}));

                // ── KICK DULUAN — prioritas tertinggi ───────────────────
                // Percobaan delete status TERBUKTI selalu gagal (WA tidak
                // mengizinkan revoke groupStatusMessageV2 oleh pihak lain).
                // Supaya jeda waktu antara status masuk & pengirim ke-remove
                // sekecil mungkin (mengurangi kemungkinan status sempat
                // ter-load penuh di device member lain), kick dijalankan
                // SEBELUM mencoba delete, bukan sesudah.
                if (!_alreadyLocked && !isOwner && !isAdmin(senderNumber, m) && !isAdmins) {
                    await handleAntiAction(client, from, rawSender, 'antiswgc', 'Dilarang kirim Group Status di grup ini');
                    sendAntiLog(client, { feature: 'antiswgc', from, rawSender, body, m }).catch(() => {});
                }

                // ── Percobaan delete (best-effort, boleh gagal) ─────────
                // Dijalankan setelah kick — kalaupun semua percobaan ini
                // gagal (seperti biasanya), kick di atas sudah lebih dulu
                // terjadi secepat mungkin.

                // ── Delete: m.key mentah TERNYATA masih pakai LID di
                // field participant (@lid), dan WA server diam-diam
                // menolak revoke untuk participant LID walau response-nya
                // "PENDING" (kelihatan sukses padahal nggak beneran kehapus).
                // Makanya sekarang participantAlt (nomor HP resolved) yang
                // dicoba PERTAMA, baru fallback ke key original mentah.
                let _deleted = false;
                const _participantAlt = m.key.participantAlt || null;

                if (_participantAlt?.endsWith('@s.whatsapp.net')) {
                    try {
                        const _delRes = await client.sendMessage(from, { delete: { ...m.key, participant: _participantAlt } });
                        _deleted = true;
                        console.log(`[AntiSwgc] ✅ Dihapus via participantAlt: ${_participantAlt} | response:`, JSON.stringify(_delRes));
                    } catch (e) {
                        console.error(`[AntiSwgc] ❌ Gagal via participantAlt ${_participantAlt}:`, e.message || e);
                    }
                }

                // ── Fallback 1: key original apa adanya (mungkin masih LID) ──
                if (!_deleted) {
                    try {
                        const _delRes = await client.sendMessage(from, { delete: m.key });
                        _deleted = true;
                        console.log('[AntiSwgc] ✅ Dihapus via key original | response:', JSON.stringify(_delRes));
                    } catch (e) {
                        console.error('[AntiSwgc] ❌ Gagal via key original:', e.message || e);
                    }
                }

                // ── Fallback 2: kalau key original gagal, coba resolve
                // participant LID → nomor HP dan override manual ──────────
                if (!_deleted) {
                    const _resolvedParticipant = await _resolveParticipantJid();
                    const _participantPn = m.key.participantPn || null;
                    const _participantCandidates = [...new Set([
                        _participantPn,
                        _resolvedParticipant,
                        m.key.participant,
                        rawSender.endsWith('@s.whatsapp.net') ? rawSender : null,
                    ].filter(Boolean))];

                    for (const p of _participantCandidates) {
                        if (_deleted) break;
                        try {
                            const _delRes = await client.sendMessage(from, { delete: { ...m.key, remoteJid: from, participant: p, fromMe: false } });
                            _deleted = true;
                            console.log(`[AntiSwgc] ✅ Dihapus | participant: ${p} | response:`, JSON.stringify(_delRes));
                        } catch (e) {
                            console.error(`[AntiSwgc] ❌ Gagal participant ${p}:`, e.message || e);
                            if (!_deleted) await new Promise(r => setTimeout(r, 150));
                        }
                    }
                }
                if (!_deleted) {
                    console.error('[AntiSwgc] ❌ Semua cara gagal. key:', JSON.stringify(m.key));
                }
                return;
            }
        }

        // ── AntiLink — deteksi & hapus pesan berisi link di grup ─
        // Prioritas 2: setelah antiswgc
        if (isGroup && !isOwner && !isAdmin(senderNumber, m) && !isAdmins) {
            const antilinkOn = global.ANTILINK_STATE?.[from] ?? false;
            if (antilinkOn) {
                const LINK_REGEX = /(?:https?:\/\/|www\.)\S+|(?:chat\.whatsapp\.com|t\.me|bit\.ly|tinyurl\.com|discord\.gg)\S*/gi;
                // Whitelist: wa.me (link WA langsung) tidak dianggap link berbahaya
                const LINK_WHITELIST = /^https?:\/\/(wa\.me|api\.whatsapp\.com\/send|whatsapp\.com\/channel)\b/i;
                const links = body?.match(LINK_REGEX) || [];
                const hasBlockedLink = links.some(link => !LINK_WHITELIST.test(link));
                if (hasBlockedLink) {
                    try { await client.sendMessage(from, { delete: m.key }); } catch (_) {}
                    await sendAntiLog(client, { feature: 'antilink', from, rawSender, body, m });
                    await handleAntiAction(client, from, rawSender, 'antilink', 'Dilarang kirim link di grup ini');
                    return;
                }
            }
        }

        // ── AntiTagAll — deteksi @all / @everyone di grup ────────
        // Prioritas 3
        if (isGroup && !isOwner && !isAdmin(senderNumber, m) && !isAdmins) {
            if (global.ANTITAGALL_STATE?.[from]) {
                const isTagAll =
                    m.message?.extendedTextMessage?.contextInfo?.nonJidMentions === 1 ||
                    /^@all\b|^@everyone\b/i.test(body || '');
                if (isTagAll) {
                    try { await client.sendMessage(from, { delete: m.key }); } catch (_) {}
                    await sendAntiLog(client, { feature: 'antitagall', from, rawSender, body, m });
                    await handleAntiAction(client, from, rawSender, 'antitagall', 'Dilarang tag @all di grup ini');
                    return;
                }
            }
        }

        // ── AntiGSM — deteksi groupStatusMentionMessage di grup ──
        // Prioritas 4
        if (isGroup && global.ANTIGSM_STATE?.[from]) {
            if (m.message?.groupStatusMentionMessage) {
                await new Promise(r => setTimeout(r, 500));
                try { await client.sendMessage(from, { delete: m.key }); } catch (_) {}
                if (!isOwner && !isAdmin(senderNumber, m) && !isAdmins) {
                    await sendAntiLog(client, { feature: 'antigsm', from, rawSender, body, m });
                    await handleAntiAction(client, from, rawSender, 'antigsm', 'Dilarang kirim Status Mention di grup ini');
                }
                return;
            }
        }

        // ── Command switch ────────────────────────────────────
        // ── Prefix salah — kasih tau prefix yang bener ────────
        // Hanya trigger kalau body diawali simbol umum yang biasa dipakai
        // sebagai prefix bot (bukan prefix aktif chat ini) + diikuti huruf/angka,
        // dan hanya buat owner/admin biar nggak spam ke member biasa.
        if (!isCmd) {
            const _commonPrefixChars = ['!', '.', '/', '#', ',', '$', '%'];
            const _firstChar = body?.[0];
            const _looksLikeCmdAttempt = _firstChar
                && _commonPrefixChars.includes(_firstChar)
                && _firstChar !== _activePrefix
                && /^[a-zA-Z0-9]/.test(body.slice(1));
            if (_looksLikeCmdAttempt && (isOwner || isAdmins)) {
                return reply(`⚠️ Prefix di chat ini bukan *${_firstChar}*.\n\nPrefix yang aktif: *${_activePrefix}*\nContoh: *${_activePrefix}menu*`);
            }
        }
        if (!isCmd || !command) return;
        if (isGroup && !senderNumber) return; // skip pesan grup tanpa sender
        // Guard: jangan proses kalau body kosong atau hanya spasi
        if (!body?.trim()) return;

        // ── RESETPREFIX — bypass prefix, owner only ───────────────
        // Deteksi langsung dari body mentah, tidak perlu prefix yang benar
        const _resetPrefixMatch = body.trim().match(/^resetprefix(?:\s+(.+))?$/i);
        if (_resetPrefixMatch) {
            if (!isOwner) return reply("⛔ Hanya owner bot yang bisa menggunakan resetprefix.");
            const _targetGroup = _resetPrefixMatch[1]?.trim() || from;
            if (!global.CHAT_PREFIX) global.CHAT_PREFIX = {};
            const _oldPrefix = global.CHAT_PREFIX[_targetGroup] || global.BOT_PREFIX || "!";
            delete global.CHAT_PREFIX[_targetGroup];
            try {
                await ChatPrefix.deleteOne({ _id: _targetGroup });
            } catch(e) {
                console.error("[ResetPrefix] Gagal hapus dari DB:", e.message);
            }
            const _defaultPrefix = global.BOT_PREFIX || "!";
            return reply(
                "✅ *Prefix berhasil direset!*\n\n" +
                `*${_oldPrefix}* → *${_defaultPrefix}* (default)\n\n` +
                `_(Berlaku di: ${_targetGroup === from ? "grup/chat ini" : _targetGroup})_`
            );
        }

        // ── BotRestrict — bot hanya untuk admin grup ──────────
        // Kalau aktif, non-admin grup tidak bisa pakai command apapun
        // Pengecualian: owner bot, admin bot, command !bot itu sendiri
        if (isGroup && global.BOT_RESTRICT?.[from] && command !== 'bot') {
            if (!isOwner && !isAdmin(senderNumber, m) && !isAdmins) {
                return; // diam saja, tidak balas
            }
        }

        // ── Bot2/Bot3: hanya boleh autoswgc, listgroup, antilink ──
        const BOT2_ALLOWED = ['autoswgc','listgroup','listgrup','daftargrup','consolemsg','consolemsgbot','swgcskip'];
        if ((client.isBot2 || client.isBot3) && !BOT2_ALLOWED.includes(command)) return;

        // ── BotGlobal OFF — bot hanya bisa dipakai owner/admin bot ──
        // Pengecualian: owner, admin bot, command !botglobal itu sendiri
        if (BOT_GLOBAL_OFF && command !== 'botglobal' && command !== 'bypassbg') {
            const isBypassedGroup = isGroup && global.BYPASS_BG_GROUPS?.has(from);
            if (!isOwner && !isAdmin(senderNumber, m) && !isBypassedGroup) {
                return;
            }
        }
        const DB_COMMANDS = ['setmoney','setrarity','getid','resetdata','unban','banlist','stat','stats','setweather','weather','giverod','deleterod','hapusrod','addmoney','setlevel','setfishcaught','forceenchant','mancing','view','jual','inventory','inv','me','player','top','travel','buy','shop','equip','enchant','prestige','gacha','daily','upgrade','season','donate','jackpot','rodupgrade','tokenstore','toko','transfer','gift','rename','addfriend','delfriend','resetme','listrod','fishbook','mutationbook','stats','streak','boss','ach','achievement','skin','bigfish','biggestfish','event','setevent','resetseason','setseason','database','refreshall','importdata'];
        if (!isMongoConnected && DB_COMMANDS.includes(command) && !isOwner) {
            return reply('⏳ Database belum siap, coba lagi sebentar...');
        }

        // ── Antispam & cooldown ───────────────────────────────
        const NO_COOLDOWN_CMDS = ['reel', 'view'];

        // Fix #3: Cooldown global untuk SEMUA command (bukan hanya DB commands)
        // Ini proteksi tambahan — sticker, help, dll juga kena cooldown
        if (!isOwner && !NO_COOLDOWN_CMDS.includes(command)) {
            const GLOBAL_COOLDOWN_MS = 2000; // 2 detik untuk semua command
            const lastGlobal = COMMAND_COOLDOWNS.get('global_' + senderNumber) || 0;
            const elapsedGlobal = Date.now() - lastGlobal;
            if (elapsedGlobal < GLOBAL_COOLDOWN_MS) {
                const sisaGlobal = ((GLOBAL_COOLDOWN_MS - elapsedGlobal) / 1000).toFixed(1);
                return reply(`⏳ Pelan-pelan bos! Tunggu *${sisaGlobal}* detik.`);
            }
            COMMAND_COOLDOWNS.set('global_' + senderNumber, Date.now());
        }

        if (DB_COMMANDS.includes(command) && !isOwner) {

            // Cek ban
            const banExpiry = BANNED_USERS.get(senderNumber);
            if (banExpiry) {
                if (Date.now() < banExpiry) {
                    const sisaJam  = Math.ceil((banExpiry - Date.now()) / 3600000);
                    return;
                } else {
                    BANNED_USERS.delete(senderNumber);
                    SPAM_TRACKER.delete(senderNumber);
                }
            }

            // Tracking spam — hanya hitung command yang valid
            if (DB_COMMANDS.includes(command)) {
            const now_spam = Date.now();
            const tracker = SPAM_TRACKER.get(senderNumber) || { count: 0, windowStart: now_spam };
            if (now_spam - tracker.windowStart > SPAM_WINDOW_MS) {
                tracker.count = 0;
                tracker.windowStart = now_spam;
            }
            tracker.count++;
            SPAM_TRACKER.set(senderNumber, tracker);
            } // end spam tracking

            const _spamTracker = SPAM_TRACKER.get(senderNumber) || { count: 0 };
            if (_spamTracker.count >= SPAM_BAN_AT) {
                BANNED_USERS.set(senderNumber, Date.now() + BAN_DURATION);
                SPAM_TRACKER.delete(senderNumber);
                COMMAND_COOLDOWNS.delete(senderNumber);
                return;
            } else if (_spamTracker.count >= SPAM_WARN_AT) {
                const sisa = SPAM_BAN_AT - _spamTracker.count;
                return reply(`⚠️ *Peringatan spam!* Jangan spam command!\n${sisa} pelanggaran lagi = ban 24 jam.`);
            }

            // Cooldown 5 detik (kecuali reel & view)
            if (!NO_COOLDOWN_CMDS.includes(command)) {
                const lastCmd = COMMAND_COOLDOWNS.get(senderNumber) || 0;
                const elapsed = Date.now() - lastCmd;
                if (elapsed < 5000) {
                    const sisa = ((5000 - elapsed) / 1000).toFixed(1);
                    return reply(`⏳ Cooldown! Tunggu *${sisa}* detik lagi.`);
                }
                COMMAND_COOLDOWNS.set(senderNumber, Date.now());
            }
        }

        // ── Groq AI — cooldown & tebak-tebakan map ──
        if (!global.GEMINI_COOLDOWN) global.GEMINI_COOLDOWN = new Map();
        if (!global.TEBAK_STATE) global.TEBAK_STATE = new Map(); // senderNumber -> { soal, jawaban }

        switch (command) {
        case "adminmenu":
        case "adminhelp": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;

    return reply(
`╔══════════════════════════╗
║    🔐  ADMIN COMMANDS     ║
╚══════════════════════════╝

👤 *PLAYER MANAGEMENT*
• setmoney <user> <jml>     — Set uang player
• addmoney <user> <jml>     — Tambah uang player
• setlevel <user> <lvl>     — Set level player
• setfishcaught <user> <n>  — Set jumlah mancing
• setrarity <user> <rarity> — Paksa rarity ikan berikutnya
• getid <user>              — Lihat ID/nomor WA player
• unban <user>              — Unban player
• banlist                   — Lihat daftar user yang di-ban
• rename <user> <nama>      — Ganti username player
• forceenchant <user> <rod> <enchant> — Paksa enchant rod
• giverod <user> <rodkey>           — Kasih rod ke player
• deleterod <user> <rodkey>         — Hapus rod dari player
• removerod <rodkey>                — Hapus rod dari SEMUA player
• hapustoken <user> <jumlah> <alasan> — Hapus prestige token + notif PM ke player

🗄️ *DATABASE*
• resetdata <user/ID>   — Reset progress player (ada konfirmasi)
• reset / resetme — Reset akun sendiri
• refreshall  — Refresh semua data player
• importdata  — Import data player
• database    — Info database

🏆 *SEASON & EVENT*
• setseason <n>     — Set nomor season
• resetseason       — Reset season sekarang
• event             — Cek event yang sedang aktif
• setevent start <nama> <jam> <mult> — Mulai bonus money event
• setevent stop                      — Hentikan bonus money event
• setevent luck <mult> <durasi>      — Global luck event (misal: 2 1h)
• setevent luck off                  — Matiin luck event
• setevent goblin <durasi>           — Raining goblin mutation
• setevent goblin off                — Matiin goblin
• setevent goldenshop <mult> <durasi>— Golden shop sell bonus
• setevent goldenshop off            — Matiin golden shop
• deleteseasonhistory          — Preview daftar history
• deleteseasonhistory <nomor>  — Cabut reward + hapus history season itu
• deleteseasonhistory all      — Cabut reward + hapus SEMUA history

📋 *RARITY LIST (untuk setrarity)*
common, uncommon, rare, epic, legendary,
mythic, godly, exotic, secret, relic,
fragment, gemstone, extinct, limited,
apex, cataclysmic, special

📱 *TELEGRAM*
• linktele <nomor>  — Link WA ke Telegram
• unlinktele <nomor>— Putus koneksi Telegram player
• teleinfo <nomor>  — Cek status Telegram player
• resetalltelegramsesi — Hapus semua sesi Telegram`
    );
}

        case "ownermenu":
        case "ownerhelp": {
    if (!isOwner) return;

    return reply(
`╔══════════════════════════╗
║    👑  OWNER COMMANDS     ║
╚══════════════════════════╝

🔑 *ADMIN MANAGEMENT*
• addadminbot <nomor>   — Tambah admin bot
• hapusadminbot <nomor> — Hapus admin bot
• listadmin             — Lihat daftar admin bot
• cekadmin              — Cek status admin sender
• cekowner              — Cek status owner sender

🗄️ *DATABASE EKSKLUSIF*
• importdata            — Import data player
• resetalltelegramsesi  — Hapus semua sesi Telegram

🏆 *SEASON*
• setseason <n>         — Set nomor season
• resetseason           — Reset season sekarang
• hapushistory          — Hapus history season
• deleteseasonhistory <nomor/all> — Cabut reward & hapus history

⚙️ *BOT SETTINGS*
• prefix <char>         — Ganti prefix grup
• setjackpot <jml>      — Set jackpot prize pool
• scalemoney <mult>     — Scale uang semua player
• database              — Info database

🌍 *EVENT & BOSS*
• spawnboss             — Spawn world boss manual
• setbossgroup <id>     — Set grup untuk boss notif

🔞 *HIBURAN*
• ytta                  — Random yuri image`
    );
}

        case "menu": {
    reply(
`╔══════════════════════════╗
║    🐟  FISCH BOT  ${config.version.padEnd(8)}║
╚══════════════════════════╝

👋 Halo *${pushname}*!

🎣 *FISHING*
• mancing       — Mulai memancing
• view          — Ambil hasil tangkapan
• inventory / inv — Lihat inventory ikan
• jual          — Jual semua ikan
• fishbook      — Koleksi ikan unik
• mutationbook  — Koleksi mutasi ikan
• top           — Leaderboard pemain

💰 *EKONOMI*
• money         — Cek saldo kamu
• transfer <user> <jml> — Kirim uang
• gift <user> <id>     — Kirim ikan

🏝️ *PULAU & ROD*
• travel        — Daftar & pindah pulau
• shop          — Toko fishing rod
• buy <rod>     — Beli rod
• equip <rod>   — Pasang rod aktif
• listrod       — Rod yang kamu miliki
• enchant       — Enchant rod aktif
• listenchant   — Daftar enchantment

👥 *SOSIAL*
• me            — Profil kamu
• player <u>    — Profil pemain lain
• addfriend <u> — Tambah teman
• delfriend <u> — Hapus teman
• f-accept <u>  — Terima request teman
• f-decline <u> — Tolak request teman
• requestfriends — Permintaan masuk
• listfriend    — Daftar teman
• rename <nama> — Ganti username
• reset / resetme — Reset akun (hati-hati!)

👑 *PRESTIGE & SISTEM*
• prestige      — Cek info & syarat prestige
• prestige confirm — Konfirmasi naik prestige
• tokenstore    — Toko prestige token
• stats         — Lihat semua stats
• upgrade       — Upgrade stats permanen
• daily         — Ambil reward harian
• gacha         — Gacha rod & reward
• jackpot       — Gambling uang
• donate        — Donasi untuk season points
• event         — Info event aktif
• season        — Info season & leaderboard
• seasonhistory — Riwayat season

🎨 *TOOLS*
• sticker / s  — Buat stiker dari gambar/video

ℹ️ *INFO*
• prefix       — Cek/ganti prefix grup
• version      — Versi bot
• ping         — Cek respons bot`
    );
}
break;

        case "version": {
    reply(
        `ℹ️ *Fisch Bot*\n` +
        `📦 Versi: *${config.version}*\n` +
        `🔧 Platform: WhatsApp + Telegram\n` +
        `📡 Database: MongoDB\n` +
        `⚡ Engine: Baileys @itsliaa`
    );
    break;
}

        case "ping": {
    const start = Date.now();
    await client.sendMessage(from, { text: "🏓 Pong!" }, { quoted: m });
    const end = Date.now();
    reply(`🏓 *Pong!*\n⚡ Respons: *${end - start}ms*`);
    break;
}

        case "tag": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;
    if (!isGroup) return reply('⚠️ Command ini hanya untuk grup!');

    const tagText = args.join(' ') || '📢 Perhatian!';

    // Resolve JID @s.whatsapp.net dari groupMetadata
    let tagJid = rawSender;
    if (rawSender.endsWith('@lid')) {
        try {
            const meta = await client.groupMetadata(from).catch(() => null);
            const lid = rawSender.split('@')[0];
            const found = meta?.participants?.find(p =>
                p.lid === rawSender || (p.lid || '').split('@')[0] === lid
            );
            if (found?.id?.includes('@s.whatsapp.net')) tagJid = found.id;
            else if (found?.phoneNumber) tagJid = `${String(found.phoneNumber).replace(/\D/g, '')}@s.whatsapp.net`;
        } catch (_) {}
    } else if (!rawSender.includes('@')) {
        tagJid = `${rawSender}@s.whatsapp.net`;
    }

    await client.sendMessage(from, {
        text: `@${tagJid.split('@')[0]} 📢 ${tagText}`,
        mentions: [tagJid]
    }, { quoted: m });
    break;
}

// ════════════════════════════════════════════════════════════
//   STICKER COMMAND
// ════════════════════════════════════════════════════════════
        case "prefix": {
    // Allow: owner, bot admin, or group admin only
    const canChangePrefix = isOwner || isAdmin(senderNumber, m) || isAdmins;
    if (!canChangePrefix) return;

    if (!global.CHAT_PREFIX) global.CHAT_PREFIX = {};
    const currentPrefix = global.CHAT_PREFIX[from] || global.BOT_PREFIX || '!';

    if (!q) return reply(
        `ℹ️ Prefix aktif di sini: *${currentPrefix}*\n\n` +
        `Format: *${currentPrefix}prefix <karakter>*\n` +
        `Contoh: *${currentPrefix}prefix /* atau *${currentPrefix}prefix .* atau *${currentPrefix}prefix !*\n\n` +
        (isGroup ? `Prefix hanya berlaku di grup ini, tidak mempengaruhi grup lain.` : `Prefix hanya berlaku di chat ini.`)
    );
    if (q.trim().length > 3) return reply('⚠️ Prefix maksimal 3 karakter!');
    if (/[a-zA-Z0-9]/.test(q.trim())) return reply('⚠️ Prefix tidak boleh huruf/angka!\nGunakan simbol seperti: ! . # $ & ; @ ~ ^ * - = + %');

    const newPrefix = q.trim();
    global.CHAT_PREFIX[from] = newPrefix;

    // Persist to MongoDB so prefix survives bot restarts
    try {
        await ChatPrefix.findByIdAndUpdate(from, { prefix: newPrefix }, { upsert: true });
    } catch(e) {
        console.error('[ChatPrefix] Gagal simpan prefix:', e.message);
    }

    return reply(
        `✅ Prefix berhasil diganti!\n\n` +
        `*${currentPrefix}* → *${newPrefix}*\n\n` +
        `Sekarang gunakan *${newPrefix}mancing*, *${newPrefix}top*, dll.\n` +
        (isGroup ? `_(Hanya berlaku di grup ini)_` : `_(Hanya berlaku di chat ini)_`)
    );
}

        case "hd": {
    const { downloadContentFromMessage } = require('@itsliaaa/baileys');
    const axios = require('axios');

    const src = m.quoted ? m.quoted : m;
    if (!src || !/image/.test(src.mtype)) return reply('📷 Reply atau kirim gambar dengan caption *!hd*');

    await reply('🔍 Lagi nge-upscale gambar pake AI, sabar ya...');

    try {
        // Download gambar asli
        let stream = await downloadContentFromMessage(src.msg || src, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        // ── Engine 1: Danzy Upscale API (primary) ──
        async function upscaleDanzy(buf) {
            const FormData = require('form-data');

            // Coba beberapa image host sampai berhasil dapat URL publik
            async function uploadToHost(buffer) {
                // Host 1: catbox.moe
                try {
                    const form = new FormData();
                    form.append('reqtype', 'fileupload');
                    form.append('fileToUpload', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
                    const res = await axios.post('https://catbox.moe/user/api.php', form, {
                        headers: { ...form.getHeaders(), 'User-Agent': 'Mozilla/5.0' },
                        timeout: 30000,
                        maxBodyLength: Infinity,
                    });
                    const url = (typeof res.data === 'string' ? res.data : '').trim();
                    if (url.startsWith('https://')) return url;
                } catch (_) {}

                // Host 2: 0x0.st
                try {
                    const form = new FormData();
                    form.append('file', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
                    const res = await axios.post('https://0x0.st', form, {
                        headers: { ...form.getHeaders(), 'User-Agent': 'Mozilla/5.0' },
                        timeout: 30000,
                        maxBodyLength: Infinity,
                    });
                    const url = (typeof res.data === 'string' ? res.data : '').trim();
                    if (url.startsWith('https://')) return url;
                } catch (_) {}

                // Host 3: litterbox.catbox.moe (1h expiry)
                try {
                    const form = new FormData();
                    form.append('reqtype', 'fileupload');
                    form.append('time', '1h');
                    form.append('fileToUpload', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
                    const res = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
                        headers: { ...form.getHeaders(), 'User-Agent': 'Mozilla/5.0' },
                        timeout: 30000,
                        maxBodyLength: Infinity,
                    });
                    const url = (typeof res.data === 'string' ? res.data : '').trim();
                    if (url.startsWith('https://')) return url;
                } catch (_) {}

                throw new Error('Semua image host gagal diupload');
            }

            const dlUrl = await uploadToHost(buf);
            console.log(`[!hd] Upload berhasil: ${dlUrl}`);

            // Panggil Danzy upscale API
            const res = await axios.get(
                `https://api.danzy.web.id/api/tools/upscale?url=${encodeURIComponent(dlUrl)}`,
                { responseType: 'arraybuffer', timeout: 120000, maxContentLength: Infinity }
            );
            if (res.status === 200 && res.data?.byteLength > 5000) return Buffer.from(res.data);
            throw new Error(`Danzy API responded ${res.status}`);
        }

        // ── Engine 2: Lokal pakai sharp (4x Lanczos — always works, no internet) ──
        async function upscaleLocalSharp(buf) {
            let sharp;
            try { sharp = require('sharp'); } catch(_) { throw new Error('sharp not installed'); }
            const meta = await sharp(buf).metadata();
            const w = (meta.width  || 500) * 4;
            const h = (meta.height || 500) * 4;
            // Cap at 8000px to avoid OOM
            const scale = Math.min(1, 8000 / Math.max(w, h));
            const fw = Math.round(w * scale);
            const fh = Math.round(h * scale);
            return await sharp(buf)
                .resize(fw, fh, { kernel: sharp.kernel.lanczos3, fastShrinkOnLoad: false })
                .sharpen({ sigma: 1.2, m1: 1.5, m2: 0.7 })
                .jpeg({ quality: 95, mozjpeg: true })
                .toBuffer();
        }

        // ── Engine 3: Lokal pakai Jimp (fallback kalau sharp tidak ada) ──
        async function upscaleLocalJimp(buf) {
            let Jimp;
            try { Jimp = (await Promise.resolve().then(() => require('jimp'))).default || require('jimp'); }
            catch(_) { throw new Error('jimp not installed'); }
            const img = await Jimp.read(buf);
            img.scale(4, Jimp.RESIZE_BICUBIC);
            return await img.getBufferAsync(Jimp.MIME_JPEG);
        }

        const engines = [
            { name: 'Danzy AI Upscale',         fn: () => upscaleDanzy(buffer) },
            { name: 'Local Sharp (4x Lanczos)', fn: () => upscaleLocalSharp(buffer) },
            { name: 'Local Jimp (4x Bicubic)',  fn: () => upscaleLocalJimp(buffer) },
        ];

        let resultBuffer = null;
        let engineUsed = '';

        for (const engine of engines) {
            try {
                resultBuffer = await engine.fn();
                if (resultBuffer && resultBuffer.byteLength > 5000) {
                    engineUsed = engine.name;
                    break;
                }
            } catch (err) {
                console.log(`[!hd] ${engine.name} gagal: ${err.message}`);
            }
        }

        if (!resultBuffer || resultBuffer.byteLength < 5000) {
            throw new Error('Semua engine gagal. Pastikan koneksi internet aktif atau install sharp (npm i sharp).');
        }

        const sizeKB = Math.round(resultBuffer.byteLength / 1024);
        await client.sendMessage(m.chat, {
            image: resultBuffer,
            caption: `✅ *HD Image* — Upscaled 4x\n🤖 Engine: ${engineUsed}\n📦 Size: ${sizeKB} KB`
        }, { quoted: m });

    } catch (e) {
        reply(`❌ Gagal proses gambar: ${e.message}`);
    }
    break;
}

// ════════════════════════════════════════════════════════════
        case "s":
        case "stiker":
        case "sticker": {
    const { downloadContentFromMessage } = require('@itsliaaa/baileys');
    const { writeExifImg, videoToWebp } = require('./w-shennmine/lib/exif');

    // ✅ FIX: Tolak foto/video sekali lihat (view-once) — mediaKey-nya kosong, tidak bisa diunduh
    const quotedType = m.quoted ? m.quoted.mtype : m.mtype;
    if (/viewOnce/i.test(quotedType)) {
        return m.reply('❌ Foto/video *sekali lihat* tidak bisa dijadikan stiker bos!\nKirim ulang medianya secara biasa (bukan mode sekali lihat).');
    }

    if (/image|video|sticker/.test(quotedType)) {
        let q = m.quoted ? m.quoted : m;
        let msgData = q.msg || q;
        let mime = msgData.mimetype || '';

        m.reply('Sabar bos, lagi diproses... 🛠️');

        let type = q.mtype.replace(/Message$/i, '');

        let buffer;
        try {
            let stream = await downloadContentFromMessage(msgData, type);
            buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
        } catch (e) {
            console.error('[sticker download]', e.message);
            return m.reply('❌ Gagal mengunduh media bos! Jangan gunakan foto sekali lihat atau media yang sudah kadaluarsa.');
        }

        let stickerBuffer;
        try {
            if (/video/g.test(mime)) {
                if (msgData.seconds > 11) return m.reply('Maksimal 10 detik bos!');
                stickerBuffer = await videoToWebp(buffer, {
                    packname: "Rusdi Bot Ngawi 67",
                    author: ""
                });
            } else {
                stickerBuffer = await writeExifImg(buffer, {
                    packname: "Rusdi Bot Ngawi 67",
                    author: ""
                });
            }

            if (typeof stickerBuffer === 'string') {
                stickerBuffer = fs.readFileSync(stickerBuffer);
            }

            await client.sendMessage(m.chat, { sticker: stickerBuffer }, { quoted: m });

        } catch (e) {
            console.error('[sticker]', e.message);
            m.reply('Gagal bikin stiker, mesin ffmpeg atau exif lu bermasalah bos!');
        }

    } else {
        m.reply(`Kirim/Reply gambar atau video dengan caption *${prefix + command}*`);
    }
    break;
}

// ════════════════════════════════════════════════════════════
//   QUOTE — Tulisan di atas foto (via memegen.link) jadi stiker
// ════════════════════════════════════════════════════════════
        case "q":
        case "quote": {
    const { downloadContentFromMessage } = require('@itsliaaa/baileys');
    const { writeExifImg } = require('./w-shennmine/lib/exif');
    const axios = require('axios');
    const FormData = require('form-data');

    const src = m.quoted ? m.quoted : m;
    if (!src || !/image/i.test(src.mtype)) {
        return reply(`📷 Kirim/Reply gambar dengan caption *${prefix + command} <teks>*\nContoh: ${prefix + command} son`);
    }

    const rawTeks = text?.trim();
    if (!rawTeks) {
        return reply(`❌ Teksnya mana bos? Contoh:\n*${prefix + command} son* (teks di bawah)\n*${prefix + command} atas|bawah* (dua-duanya)\n*${prefix + command} |atas* (teks di atas aja)`);
    }

    // Format: "bawah" saja -> teks di bawah
    //         "atas|bawah" -> teks di atas dan bawah
    //         "|atas" -> teks di atas aja (kosongkan sebelum |)
    let teksAtas = '', teksBawah = '';
    if (rawTeks.includes('|')) {
        const parts = rawTeks.split('|');
        teksAtas = parts[0].trim();
        teksBawah = parts.slice(1).join('|').trim();
    } else {
        teksBawah = rawTeks;
    }

    m.reply('Sabar bos, lagi diproses... 🛠️');

    try {
        // 1. Download gambar yang di-quote
        let stream = await downloadContentFromMessage(src.msg || src, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        // 2. Upload ke image host publik (coba beberapa fallback)
        async function uploadToHost(buf) {
            try {
                const form = new FormData();
                form.append('reqtype', 'fileupload');
                form.append('userhash', '');
                form.append('fileToUpload', buf, { filename: 'image.jpg', contentType: 'image/jpeg' });
                const res = await axios.post('https://catbox.moe/user/api.php', form, {
                    headers: {
                        ...form.getHeaders(),
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Accept': '*/*',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Origin': 'https://catbox.moe',
                        'Referer': 'https://catbox.moe/',
                    },
                    timeout: 30000,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                });
                const url = (typeof res.data === 'string' ? res.data : '').trim();
                if (url.startsWith('https://')) return url;
                console.log('[!quote] catbox unexpected response:', res.status, JSON.stringify(res.data).slice(0, 200));
            } catch (e) {
                console.log('[!quote] catbox gagal:', e.response?.status || e.code || e.message);
            }

            try {
                const form = new FormData();
                form.append('file', buf, { filename: 'image.jpg', contentType: 'image/jpeg' });
                const res = await axios.post('https://0x0.st', form, {
                    headers: {
                        ...form.getHeaders(),
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    },
                    timeout: 45000,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                });
                const url = (typeof res.data === 'string' ? res.data : '').trim();
                if (url.startsWith('https://')) return url;
                console.log('[!quote] 0x0.st unexpected response:', res.status, JSON.stringify(res.data).slice(0, 200));
            } catch (e) {
                console.log('[!quote] 0x0.st gagal:', e.response?.status || e.code || e.message);
            }

            try {
                const form = new FormData();
                form.append('reqtype', 'fileupload');
                form.append('time', '1h');
                form.append('fileToUpload', buf, { filename: 'image.jpg', contentType: 'image/jpeg' });
                const res = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
                    headers: {
                        ...form.getHeaders(),
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    },
                    timeout: 45000,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                });
                const url = (typeof res.data === 'string' ? res.data : '').trim();
                if (url.startsWith('https://')) return url;
                console.log('[!quote] litterbox unexpected response:', res.status, JSON.stringify(res.data).slice(0, 200));
            } catch (e) {
                console.log('[!quote] litterbox gagal:', e.response?.status || e.code || e.message);
            }

            try {
                const form = new FormData();
                form.append('image', buf.toString('base64'));
                const res = await axios.post('https://api.imgur.com/3/image', form, {
                    headers: {
                        ...form.getHeaders(),
                        'Authorization': 'Client-ID 546c25a59c58ad7', // public anon client-id (imgur's own demo key)
                        'User-Agent': 'Mozilla/5.0',
                    },
                    timeout: 30000,
                    maxBodyLength: Infinity,
                });
                const url = res.data?.data?.link;
                if (url && url.startsWith('https://')) return url;
                console.log('[!quote] imgur unexpected response:', res.status, JSON.stringify(res.data).slice(0, 200));
            } catch (e) {
                console.log('[!quote] imgur gagal:', e.response?.status || e.code || e.message);
            }

            throw new Error('Semua image host gagal diupload — cek log console untuk detail per-host');
        }

        const bgUrl = await uploadToHost(buffer);
        console.log(`[!quote] Upload berhasil: ${bgUrl}`);

        // 3. Encode teks sesuai aturan memegen.link
        //    spasi -> underscore, escape karakter reserved
        function encodeMemegenText(str) {
            return str
                .replace(/_/g, '__')
                .replace(/-/g, '--')
                .replace(/\?/g, '~q')
                .replace(/&/g, '~a')
                .replace(/%/g, '~p')
                .replace(/#/g, '~h')
                .replace(/\//g, '~s')
                .replace(/\\/g, '~b')
                .replace(/</g, '~l')
                .replace(/>/g, '~g')
                .replace(/"/g, "''")
                .replace(/\n/g, '~n')
                .replace(/ /g, '_');
        }

        const encodedAtas = teksAtas ? encodeMemegenText(teksAtas) : '_';
        const encodedBawah = teksBawah ? encodeMemegenText(teksBawah) : '_';
        const memegenUrl = `https://api.memegen.link/images/custom/${encodedAtas}/${encodedBawah}.png?background=${encodeURIComponent(bgUrl)}`;

        // 4. Download hasil meme dari memegen
        const memeRes = await axios.get(memegenUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const memeBuffer = Buffer.from(memeRes.data);

        // 5. Convert jadi stiker
        let stickerBuffer = await writeExifImg(memeBuffer, {
            packname: "Rusdi Bot Ngawi 67",
            author: ""
        });
        if (typeof stickerBuffer === 'string') {
            stickerBuffer = fs.readFileSync(stickerBuffer);
        }

        await client.sendMessage(m.chat, { sticker: stickerBuffer }, { quoted: m });

    } catch (e) {
        console.error('[quote]', e.message);
        m.reply('❌ Gagal bikin quote sticker bos! Coba lagi atau cek koneksi ke memegen.link.');
    }
    break;
}

// ════════════════════════════════════════════════════════════
//   TOIMG — Stiker ke Gambar
// ════════════════════════════════════════════════════════════
        case "toimg":
        case "toimage":
        case "togif": {
    const { downloadContentFromMessage } = require('@itsliaaa/baileys');

    const targetMsg = m.quoted ? m.quoted : m;
    const targetType = targetMsg.mtype;

    if (!/sticker/i.test(targetType)) {
        return reply(`❌ Reply stiker dulu bos baru ketik *${prefix + command}*`);
    }

    try {
        m.reply('Sabar bos, lagi dikonversi... 🛠️');

        const msgData = targetMsg.msg || targetMsg;
        let stream = await downloadContentFromMessage(msgData, 'sticker');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        if (!buffer || buffer.length === 0) {
            throw new Error('Buffer stiker kosong, gagal download dari WhatsApp');
        }

        const ts = Date.now();
        const tmpIn  = `/tmp/stiker_${ts}.webp`;
        const tmpOut = `/tmp/stiker_${ts}.png`;

        fs.writeFileSync(tmpIn, buffer);

        // Cek animated: baca byte signature webp langsung (cek chunk 'ANIM').
        // ffprobe/ffmpeg decoder gagal total membaca animated webp di server ini,
        // jadi tidak bisa diandalkan untuk deteksi - makanya baca header file langsung.
        const flagAnimated = !!(msgData.isAnimated);
        const hasAnimChunk = buffer.includes(Buffer.from('ANIM'));
        const isAnimated = flagAnimated || hasAnimChunk;

        if (isAnimated) {
            // ffmpeg lokal & node-webpmux sama-sama gagal handle animated webp di server ini.
            // Solusi: kirim file ke ezgif.com (web tool publik, di-scrape lewat HTTP request)
            // buat convert webp animasi -> mp4, lalu download hasilnya.
            const FormData = require('form-data');

            // Step 1: upload file ke ezgif
            const uploadForm = new FormData();
            uploadForm.append('new-image', buffer, { filename: 'sticker.webp', contentType: 'image/webp' });

            const uploadRes = await axios.post('https://ezgif.com/webp-to-mp4', uploadForm, {
                headers: uploadForm.getHeaders(),
                maxRedirects: 5,
                timeout: 60000
            });

            // Cari nama file hasil upload dari HTML response.
            // Coba beberapa pola karena struktur ezgif bisa pakai <input type="hidden">
            // atau <form action="..."> yang menyimpan nama file.
            const html = String(uploadRes.data);
            const fileMatch = html.match(/name=["']file["']\s+(?:id=["'][^"']*["']\s+)?value=["']([^"']+)["']/)
                || html.match(/value=["']([^"']+\.webp)["']/)
                || html.match(/\/webp-to-mp4\/([a-zA-Z0-9._-]+\.webp)/);
            if (!fileMatch) {
                try { fs.writeFileSync('/tmp/ezgif_debug.html', html); } catch(_) {}
                // Ambil potongan di sekitar area <form atau <input biar lebih informatif dari sekadar <head>
                const formIdx = html.search(/<form/i);
                const snippet = formIdx >= 0
                    ? html.slice(formIdx, formIdx + 800).replace(/\s+/g, ' ')
                    : html.slice(0, 800).replace(/\s+/g, ' ');
                throw new Error(`Gagal parse response upload ezgif. Preview: ${snippet}`);
            }
            const ezgifFile = fileMatch[1];

            // Step 2: trigger convert pakai nama file dari step 1
            const convertForm = new FormData();
            convertForm.append('file', ezgifFile);
            convertForm.append('start', '0');
            convertForm.append('end', '0');
            convertForm.append('size', '512x512');
            convertForm.append('bg-color', '#ffffff');
            convertForm.append('loop-count', '1');
            convertForm.append('convert', 'Convert WebP to MP4!');

            const convertRes = await axios.post(`https://ezgif.com/webp-to-mp4/${ezgifFile}`, convertForm, {
                headers: convertForm.getHeaders(),
                maxRedirects: 5,
                timeout: 90000
            });

            // Cari link download mp4 hasil dari HTML response
            const downloadMatch = convertRes.data.match(/href="(\/[^"]+\.mp4)"/) ||
                                   convertRes.data.match(/src="(https:\/\/ezgif\.com\/[^"]+\.mp4)"/);
            if (!downloadMatch) {
                try { fs.writeFileSync('/tmp/ezgif_debug2.html', String(convertRes.data)); } catch(_) {}
                const snippet = String(convertRes.data).slice(0, 500).replace(/\s+/g, ' ');
                throw new Error(`Gagal parse hasil konversi ezgif. Preview: ${snippet}`);
            }
            const downloadUrl = downloadMatch[1].startsWith('http')
                ? downloadMatch[1]
                : `https://ezgif.com${downloadMatch[1]}`;

            // Step 3: download hasil mp4
            const mp4Res = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 60000 });
            const gifBuffer = Buffer.from(mp4Res.data);

            fs.existsSync(tmpIn) && fs.unlinkSync(tmpIn);

            await client.sendMessage(m.chat, {
                video: gifBuffer,
                gifPlayback: true,
                caption: '✅ Stiker GIF berhasil dikonversi!'
            }, { quoted: m });

        } else {
            // Static webp -> PNG lossless via ffmpeg (tidak burik!)
            await new Promise((resolve, reject) => {
                // scale 512x512 pakai lanczos (kualitas terbaik), output PNG lossless
                execFile('ffmpeg', ['-y', '-i', tmpIn, '-vf', 'scale=512:512:flags=lanczos', '-compression_level', '0', tmpOut], (err) => {
                    fs.existsSync(tmpIn) && fs.unlinkSync(tmpIn);
                    if (err) return reject(err);
                    resolve();
                });
            });

            const pngBuffer = fs.readFileSync(tmpOut);
            fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut);

            await client.sendMessage(m.chat, {
                image: pngBuffer,
                mimetype: 'image/png',
                caption: '✅ Stiker berhasil dikonversi ke gambar!'
            }, { quoted: m });
        }

    } catch (e) {
        console.error('[toimg]', e);
        reply(`❌ Gagal konversi stiker bos!\nDetail: ${e.message || e}`);
    }
    break;
}


// ════════════════════════════════════════════════════════════
//   INVENTORY COMMAND
// ════════════════════════════════════════════════════════════
        case "inventory":
        case "inv":
        case "bag": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const inv = Array.isArray(user.inventory) ? user.inventory : [];

    if (inv.length === 0) return reply('🎒 Inventory kamu kosong!\nMancing dulu dengan *!mancing*.');

    const pageSize = 10;
    const page = parseInt(args[0]) || 1;

    const fish     = inv.filter(i => i.type === 'fish');
    const scrolls  = inv.filter(i => i.type === 'enchant_scroll');
    const baits    = inv.filter(i => i.type === 'bait');
    const favFish  = fish.filter(f => f.favorite);

    const RARITY_EMOJI = {
        common:'⬜', uncommon:'🟩', rare:'🟦', epic:'🟪',
        legendary:'🟨', mythic:'🌸', godly:'🌟', exotic:'🍊',
        secret:'🖤', relic:'🏺', fragment:'🔷', gemstone:'💎',
        extinct:'🦕', limited:'🎫', apex:'👑', cataclysmic:'🌋', special:'✨'
    };

    // Group ikan berdasarkan nama+rarity, tapi tetap tampilkan tiap individu
    // Urutkan: favorit dulu, lalu rarity tertinggi
    const rarityOrder = ['common','uncommon','rare','epic','legendary','mythic','godly','exotic','secret','relic','fragment','gemstone','extinct','limited','apex','cataclysmic','special'];
    const sortedFish = [...fish].sort((a, b) => {
        if (a.favorite && !b.favorite) return -1;
        if (!a.favorite && b.favorite) return 1;
        return rarityOrder.indexOf(b.rarity) - rarityOrder.indexOf(a.rarity);
    });

    // Group ikan yg sama (nama+rarity) jadi satu blok
    const grouped = [];
    const seenGroup = new Map();
    for (const f of sortedFish) {
        const key = `${f.name}__${f.rarity}`;
        if (!seenGroup.has(key)) {
            seenGroup.set(key, grouped.length);
            grouped.push({ key, name: f.name, rarity: f.rarity, items: [f] });
        } else {
            grouped[seenGroup.get(key)].items.push(f);
        }
    }

    // Pagination berdasarkan group
    const totalPages = Math.max(1, Math.ceil(grouped.length / pageSize));
    const safePage   = Math.min(Math.max(page, 1), totalPages);
    const pageGroups = grouped.slice((safePage - 1) * pageSize, safePage * pageSize);

    const totalValue = fish.reduce((a, f) => a + Math.floor((f.price||0) * (f.perfectBonus||1)), 0);

    let text = `🎒 *Inventory ${user.username}*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🐟 Ikan: *${fish.length}* | ⭐ Favorit: *${favFish.length}* | 📜 Scroll: *${scrolls.length}* | 🪱 Bait: *${baits.length}*\n`;
    text += `💰 Total nilai: *${formatMoney(totalValue)}*\n\n`;

    if (pageGroups.length > 0) {
        text += `🐠 *Ikan (Hal. ${safePage}/${totalPages}):*\n`;
        for (const grp of pageGroups) {
            const em  = RARITY_EMOJI[grp.rarity] || '⬜';
            const favMark = grp.items.some(f => f.favorite) ? '⭐ ' : '';
            if (grp.items.length === 1) {
                // Tampilan single
                const f = grp.items[0];
                const mut = f.mutations && f.mutations.length > 0 && f.mutations[0] !== 'Normal'
                    ? ` 🧬${f.mutations.join('+')}` : '';
                const cond = f.conditionLabel ? ` [${f.conditionLabel}]` : '';
                const finalPrice = Math.floor((f.price||0) * (f.perfectBonus||1));
                text += `${em} ${favMark}*${f.name}*${mut}${cond}\n`;
                text += `   ⚖️ ${f.kg}kg | 💰 ${formatMoney(finalPrice)} | 🆔 ${f.id}\n`;
            } else {
                // Tampilan grup — nama+rarity sama tapi beda berat
                const allFav = grp.items.every(f => f.favorite);
                const someFav = grp.items.some(f => f.favorite);
                const groupFavMark = allFav ? '⭐ ' : someFav ? '✨ ' : '';
                const totalGrpVal = grp.items.reduce((a, f) => a + Math.floor((f.price||0)*(f.perfectBonus||1)), 0);
                text += `${em} ${groupFavMark}*${grp.name}* ×${grp.items.length} — 💰 ${formatMoney(totalGrpVal)}\n`;
                for (const f of grp.items) {
                    const mut = f.mutations && f.mutations.length > 0 && f.mutations[0] !== 'Normal'
                        ? ` 🧬${f.mutations.join('+')}` : '';
                    const favIcon = f.favorite ? '⭐' : '  ';
                    const finalPrice = Math.floor((f.price||0) * (f.perfectBonus||1));
                    text += `   ${favIcon} ⚖️ ${f.kg}kg | 💰 ${formatMoney(finalPrice)}${mut} | 🆔 ${f.id}\n`;
                }
            }
        }
        if (totalPages > 1) text += `\n📄 Hal. berikutnya: *!inv ${safePage < totalPages ? safePage + 1 : 1}*`;
    }

    if (scrolls.length > 0) {
        text += `\n\n📜 *Enchant Scroll (${scrolls.length}):*\n`;
        const scrollGroup = {};
        for (const s of scrolls) { scrollGroup[s.rarity||'common'] = (scrollGroup[s.rarity||'common']||0)+1; }
        for (const [r, cnt] of Object.entries(scrollGroup)) text += `  ${RARITY_EMOJI[r]||'⬜'} ${r} ×${cnt}\n`;
    }

    if (baits.length > 0) {
        text += `\n\n🪱 *Bait (${baits.length}):*\n`;
        const baitGroup = {};
        for (const b of baits) { const k = b.label||b.id||'bait'; baitGroup[k]=(baitGroup[k]||0)+1; }
        for (const [label, cnt] of Object.entries(baitGroup)) text += `  • ${label} ×${cnt}\n`;
    }

    text += `\n\n💡 *!jual* jual semua | *!fav <id>* tandai favorit`;
    reply(text);
    break;
}


// ════════════════════════════════════════════════════════════
//   FAVORITE FISH — !fav / !unfav / !favlist
// ════════════════════════════════════════════════════════════
        case "fav":
        case "favorite": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    // !fav tanpa arg → lihat list favorit
    if (!args[0]) {
        const favs = (user.inventory || []).filter(i => i.type === 'fish' && i.favorite);
        if (favs.length === 0) return reply(
            `⭐ *Favorit Kosong*\n\nBelum ada ikan favorit.\n` +
            `Gunakan *!fav <id>* untuk menandai ikan favorit dari *!inv*\n` +
            `Ikan favorit tidak akan ikut terjual saat *!jual*`
        );
        const RARITY_EMOJI = {
            common:'⬜', uncommon:'🟩', rare:'🟦', epic:'🟪',
            legendary:'🟨', mythic:'🌸', godly:'🌟', exotic:'🍊',
            secret:'🖤', relic:'🏺', fragment:'🔷', gemstone:'💎',
            extinct:'🦕', limited:'🎫', apex:'👑', cataclysmic:'🌋', special:'✨'
        };
        let txt = `⭐ *Ikan Favorit (${favs.length})*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const f of favs) {
            const em = RARITY_EMOJI[f.rarity] || '⬜';
            const mut = f.mutations && f.mutations[0] !== 'Normal' ? ` 🧬${f.mutations.join('+')}` : '';
            txt += `\n${em} *${f.name}*${mut}\n`;
            txt += `   ⚖️ ${f.kg}kg | 💰 ${formatMoney(Math.floor((f.price||0)*(f.perfectBonus||1)))} | 🆔 ${f.id}\n`;
        }
        txt += `\n_Gunakan *!unfav <id>* untuk melepas favorit_`;
        return reply(txt);
    }

    // !fav <id> → toggle favorit
    const targetId = args[0].trim();
    const fish = (user.inventory || []).find(i => i.type === 'fish' && i.id === targetId);
    if (!fish) return reply(`❌ Ikan dengan ID *${targetId}* tidak ditemukan di inventory.\nCek ID ikan di *!inv*`);

    fish.favorite = true;
    user.markModified('inventory');
    await user.save();

    const RARITY_EMOJI2 = { common:'⬜', uncommon:'🟩', rare:'🟦', epic:'🟪', legendary:'🟨', mythic:'🌸', godly:'🌟', exotic:'🍊', secret:'🖤', extinct:'🦕', special:'✨' };
    reply(
        `⭐ *${fish.name}* ditandai sebagai favorit!\n` +
        `${RARITY_EMOJI2[fish.rarity]||'⬜'} ${fish.rarity} | ⚖️ ${fish.kg}kg\n\n` +
        `Ikan ini tidak akan ikut terjual saat *!jual*.\n` +
        `Gunakan *!unfav ${fish.id}* untuk melepas tandai.`
    );
    break;
}

        case "unfav":
        case "unfavorite": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (!args[0]) return reply(
        `⭐ Format: *!unfav <id>*\nContoh: *!unfav 123456*\n\nLihat daftar favorit: *!fav*`
    );

    const targetId = args[0].trim();
    const fish = (user.inventory || []).find(i => i.type === 'fish' && i.id === targetId);
    if (!fish) return reply(`❌ Ikan dengan ID *${targetId}* tidak ditemukan di inventory.`);
    if (!fish.favorite) return reply(`❌ Ikan *${fish.name}* (ID: ${targetId}) bukan favorit.`);

    fish.favorite = false;
    user.markModified('inventory');
    await user.save();

    reply(`✅ Tandai favorit *${fish.name}* dilepas.\nIkan ini sekarang bisa ikut terjual saat *!jual*.`);
    break;
}

// ===== TELEGRAM LINK COMMANDS =====
        case "linktele": {
    if (!isOwner) return;
    const user = await getOrCreateUser(senderNumber, null, pushname);

    // Cek sudah terhubung?
    if (user.isVerifiedTelegram && user.telegramId) {
        const tgUsername = user.telegramUsername ? `@${user.telegramUsername}` : `ID: ${user.telegramId}`;
        return reply(
            `✅ Akun WA kamu sudah terhubung ke Telegram!\n` +
            `📱 Telegram: *${tgUsername}*\n` +
            `🆔 Connect ID: ${user.telegramConnectID || '-'}\n\n` +
            `Ketik *!unlinktele* jika ingin putuskan koneksi.`
        );
    }

    // Hapus session lama jika ada
    await TelegramSession.deleteMany({ tempWhatsAppNumber: senderNumber });

    // Generate kode 6 digit
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 menit

    await TelegramSession.create({
        tempTelegramId: 'pending-' + senderNumber,
        tempWhatsAppNumber: senderNumber,
        verificationCode: code,
        expiresAt
    });

    reply(
        `🔗 *Hubungkan ke Telegram*\n\n` +
        `Kode verifikasi kamu:\n` +
        `┌─────────────────┐\n` +
        `│   *${code}*   │\n` +
        `└─────────────────┘\n\n` +
        `📋 *Cara menghubungkan:*\n` +
        `1️⃣ Buka bot Telegram kamu\n` +
        `2️⃣ Kirim perintah: \`/confirm ${code}\`\n\n` +
        `⏳ Kode berlaku *5 menit*\n` +
        `⚠️ Jangan bagikan kode ini ke siapapun!`
    );
    break;
}

        case "unlinktele": {
    if (!isOwner) return;
    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!user.isVerifiedTelegram && !user.telegramId) {
        return reply('⚠️ Akun WA kamu belum terhubung ke Telegram.');
    }

    const oldTelegramId = user.telegramId;
    user.isVerifiedTelegram = false;
    user.telegramId = null;
    user.telegramUUID = null;
    user.telegramConnectID = null;
    user.telegramUsername = null;
    await user.save();
    await TelegramSession.deleteMany({ tempWhatsAppNumber: senderNumber });

    reply('✅ Koneksi Telegram berhasil diputus!\nKetik *!linktele* untuk menghubungkan ulang.');
    break;
}

        case "teleinfo": {
    if (!isOwner) return;
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const status = user.isVerifiedTelegram && user.telegramId;

    if (!status) {
        return reply(
            `📱 *Status Telegram*\n\n` +
            `❌ Belum terhubung\n\n` +
            `Ketik *!linktele* untuk menghubungkan!`
        );
    }

    const tgUsername = user.telegramUsername ? `@${user.telegramUsername}` : `(no username)`;
    reply(
        `📱 *Status Telegram*\n\n` +
        `✅ Terhubung\n` +
        `📌 Telegram: *${tgUsername}*\n` +
        `🆔 ID: ${user.telegramId}\\n` +
        `🔑 Connect ID: ${user.telegramConnectID || '-'}\\n` +
        `🔄 UUID: ${user.telegramUUID || '-'}`
    );
    break;
}
// ===== END TELEGRAM LINK COMMANDS =====

        case "resetalltelegramsesi": {
    if (!isOwner) 
        return;

    try {
        const result = await TelegramSession.deleteMany({});
        reply(`✅ Semua sesi Telegram sementara telah dihapus.\nJumlah sesi yang dihapus: ${result.deletedCount}`);
        console.log(`[RESET WA] Semua sesi Telegram sementara dihapus. Jumlah: ${result.deletedCount}`);
    } catch (err) {
        reply("❌ Terjadi kesalahan saat mereset sesi Telegram. Coba lagi nanti.");
    }
    break;
}

        case "importdata": {
    if (!isOwner) {
        return;
    }

    reply("🔄 Sedang mengimpor data dari fishing.json...");

    try {
        const resultMessage = await importFishingJSON();
        reply(resultMessage);
    } catch (err) {
        reply("❌ Terjadi kesalahan saat mengimpor data.");
    }
}
break;


        case "gift": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (!user) return reply("⚠️ Akun kamu tidak ditemukan di database!");

    if (!args[0] || !args[1])
        return reply("❌ Format salah!\nContoh: *!gift <username/ID> <id_ikan>*");

    const targetArg = args[0].trim();
    const fishId = args[1].trim();

    const receiver = await Player.findOne({
        $or: [
            { id: targetArg },
            { username: new RegExp(`^${targetArg}$`, "i") }
        ]
    });

    if (!receiver)
        return reply("❌ Player dengan ID atau username itu tidak ditemukan!");

    if (receiver.id === user.id)
        return reply("❌ Kamu tidak bisa mengirim ikan ke diri sendiri!");

    if (!user.friends?.includes(receiver.id))
        return reply("⚠️ Kamu harus menjadi teman dengan user ini terlebih dahulu untuk mengirim gift.");

    if (!Array.isArray(user.inventory) || user.inventory.length === 0)
        return reply("🎣 Inventory kamu kosong!");

    const fishIndex = user.inventory.findIndex(f => f.id === fishId && f.type === "fish");
    if (fishIndex === -1)
        return reply(`❌ Ikan dengan ID *${fishId}* tidak ditemukan di inventory kamu.`);

    const fish = user.inventory.splice(fishIndex, 1)[0];

    if (!Array.isArray(receiver.inventory)) receiver.inventory = [];
    receiver.inventory.push(fish);

    await user.save();
    await receiver.save();

    reply(`🎁 Kamu mengirim ikan *${fish.name}* (ID: ${fish.id}) ke *${receiver.username}* (ID: ${receiver.id})`);

        if (receiver.whatsappNumber && typeof client?.sendMessage === "function") {
            await client.sendMessage(receiver.whatsappNumber + "@s.whatsapp.net", {
                text: `🎣 Kamu menerima ikan *${fish.name}* (ID: ${fish.id}) dari *${user.username}*!`
            });
        }
}
break;

        case "setmoney": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;

    if (args.length < 2)
        return reply("⚙️ Format: !setmoney <username/ID/all> <jumlah>");

    const targetName = args[0];
    const amountRaw  = args[1];
    const amount = parseAmount(amountRaw);

    if (isNaN(amount) || amount < 0)
        return reply("❌ Jumlah tidak valid! Contoh: 1000, 1M, 5B, 999T");

    // ── !setmoney all <jumlah> ────────────────────────────
    if (targetName.toLowerCase() === 'all') {
        reply(`⏳ Mengatur uang semua player menjadi *${formatMoney(amount)}*...`);
        const result = await Player.updateMany({}, { $set: { money: amount } });
        return reply(`✅ Selesai! *${result.modifiedCount}* player uangnya diatur ke *${formatMoney(amount)}*.`);
    }

    const target = await findUserByIdOrName(targetName);
    if (!target)
        return reply("❌ Player tidak ditemukan!");

    target.money = amount;
    await target.save();
    reply(`✅ Uang ${target.username} telah diatur menjadi *💰 ${formatMoney(amount)}*`);
    break;
}

        case "unban": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;

    if (!args[0])
        return reply("⚙️ Format: !unban <username/ID>");

    const target = await findUserByIdOrName(args[0]);
    if (!target)
        return reply("❌ Player tidak ditemukan!");

    const targetNum = target.whatsappNumber || target.id;
    if (!BANNED_USERS.has(targetNum))
        return reply(`ℹ️ *${target.username}* tidak sedang di-ban.`);

    BANNED_USERS.delete(targetNum);
    SPAM_TRACKER.delete(targetNum);
    COMMAND_COOLDOWNS.delete(targetNum);
    return reply(`✅ *${target.username}* berhasil di-unban!`);
}

        case "banlist": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;

    if (BANNED_USERS.size === 0)
        return reply("✅ Tidak ada user yang sedang di-ban.");

    let text = `🚫 *Daftar User Banned (${BANNED_USERS.size})*\n\n`;
    for (const [num, expiry] of BANNED_USERS.entries()) {
        const sisaJam = Math.ceil((expiry - Date.now()) / 3600000);
        text += `• ${num} — sisa *${sisaJam} jam*\n`;
    }
    text += `\n_Gunakan !unban <username/ID> untuk unban_`;
    return reply(text);
}

        case "getid": {
    const targetArg = args[0];
    if (!targetArg)
        return reply(`📋 ID kamu: *${senderNumber}*`);

    const target = await findUserByIdOrName(targetArg);
    if (!target)
        return reply("❌ Player tidak ditemukan!");

    return reply(`📋 ID *${target.username}*: *${target.whatsappNumber || target.id}*`);
}

        case "setluck": {
    if (!isOwner) return;
    return reply("⚠️ Perintah *!setluck* sudah dihapus.\nGunakan *!setevent luck <mult> <durasi>*\nContoh: *!setevent luck 2 1h*");
}

        case "setrarity": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;

    if (args.length < 2)
        return reply("⚙️ Format: !setrarity <username/ID> <rarity>\nRarity: common, uncommon, rare, epic, legendary, mythic, godly, exotic, secret, relic, fragment, gemstone, extinct, limited, apex, cataclysmic, special");

    const targetName = args[0];
    const rarityInput = args[1].toLowerCase();

    const validRarities = Object.keys(RARITY_ESCAPE_TIME);
    if (!validRarities.includes(rarityInput))
        return reply(`❌ Rarity tidak valid! Pilihan: ${validRarities.join(", ")}`);

    const target = await findUserByIdOrName(targetName);
    if (!target)
        return reply("❌ Player tidak ditemukan!");

    // Simpan forced rarity ke database player
    target.forcedRarity = rarityInput;
    await target.save();
    if (target.whatsappNumber) FORCED_RARITY.set(target.whatsappNumber, rarityInput);
    if (target.id) FORCED_RARITY.set(String(target.id), rarityInput);
    const cleanWA = (target.whatsappNumber || '').replace(/\D/g, '');
    if (cleanWA) FORCED_RARITY.set(cleanWA, rarityInput);

    return reply(`✅ Pancingan berikutnya *${target.username}* dijamin dapat ikan *${rarityInput}*!\n_Akan reset otomatis setelah 1x mancing._`);
}

        case "forceenchant": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;

    if (args.length < 3)
        return reply("⚙️ Format: !forceenchant <username/ID> <rodName> <enchantName>");

    const targetName = args[0];
    const rodName = args[1];
    const enchantName = args.slice(2).join(" ");

    const target = await findUserByIdOrName(targetName);
    if (!target) return reply("❌ Player tidak ditemukan!");

    if (!target.fishingRods)
        return reply("🎣 Player ini belum memiliki fishing rod.");

    const rodKey = rodName.toLowerCase().replace(/\s+/g, "");
    const rod = target.fishingRods.get(rodKey);
    if (!rod)
        return reply(`🎣 Player ini tidak memiliki rod bernama *${rodName}*.`);

    const enchantKey = enchantName.toLowerCase().replace(/\s+/g, "");
    const validEnchant = rodEnchants[enchantKey];
    if (!validEnchant)
        return reply(`⚠️ Enchant *${enchantName}* tidak ditemukan di daftar enchant!`);

    rod.enchant = enchantKey;
    await target.save();

    reply(`✅ Rod *${rod.name || rodName}* milik *${target.username}* berhasil di-enchant dengan *${validEnchant.name || enchantName}*!`);
    break;
}

        case "setlevel": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;

    if (args.length < 2)
        return reply("⚙️ Format: !setlevel <username/ID/all> <level>");

    const level = parseInt(args[1]);
    if (isNaN(level) || level < 0)
        return reply("❌ Level tidak valid!");

    // ── !setlevel all <level> ─────────────────────────────
    if (args[0].toLowerCase() === 'all') {
        reply(`⏳ Mengatur level semua player menjadi *${level}*...`);
        const result = await Player.updateMany({}, { $set: { level } });
        return reply(`✅ Selesai! *${result.modifiedCount}* player levelnya diatur ke *${level}*.`);
    }

    const target = await findUserByIdOrName(args[0]);
    if (!target) return reply("❌ Player tidak ditemukan!");

    if (!target.level) target.level = 0;
    target.level = level;
    await target.save();
    reply(`✅ Level *${target.username}* telah diatur menjadi *Level ${level}*`);
    break;
}

        case "setfishcaught": {
    if (!isOwner && !isAdmin(senderNumber, m)) {
        return;
    }

    if (!args[0] || !args[1]) {
        return reply("⚙️ Format: !setfishcaught <username/ID/all> <jumlah>");
    }

    const amount = parseInt(args[1].replace(/,/g, ""));
    if (isNaN(amount) || amount < 0)
        return reply("❌ Jumlah tidak valid!");

    // ── !setcaught all <jumlah> ───────────────────────────
    if (args[0].toLowerCase() === 'all') {
        reply(`⏳ Mengatur fishCaught semua player menjadi *${formatMoney(amount)}*...`);
        const result = await Player.updateMany({}, { $set: { fishCaught: amount } });
        return reply(`✅ Selesai! *${result.modifiedCount}* player fishCaught-nya diatur ke *${formatMoney(amount)}*.`);
    }

    const query = args[0];
    const filter = isNaN(query)
        ? { username: { $regex: new RegExp(`^${query}$`, "i") } }
        : { id: Number(query) };

    const target = await Player.findOne(filter);
    if (!target)
        return reply("❌ Player tidak ditemukan!");

    target.fishCaught = amount;
    await target.save();
    reply(`✅ Jumlah ikan yang ditangkap oleh *${target.username}* telah diatur menjadi *${formatMoney(amount)} ikan*!`);
    break;
}

        case "allplayerid": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;
    const allP = await Player.find({}).sort({ id: 1 });
    if (!allP.length) return reply("❌ Tidak ada player.");
    const lines = allP.map((p, i) => `${i+1}. *${p.username}* — WA: ${p.whatsappNumber || '-'} | ID: ${p.id} | Lv.${p.level} | 💰${formatMoney(p.money)}`);
    const chunks = [];
    let cur = '';
    for (const l of lines) {
        if ((cur + l).length > 3500) { chunks.push(cur.trim()); cur = ''; }
        cur += l + '\n';
    }
    if (cur) chunks.push(cur.trim());
    for (const chunk of chunks) await reply(`📋 *Daftar Semua Player:*

${chunk}`);
    return;
}

        case "giverod": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;
    if (args.length < 2) return reply(
        `⚙️ *Format: giverod <user/all> <rodkey/all> [level] [maxlevel]*\n\n` +
        `Contoh:\n` +
        `• giverod bjorbun voidrod         → beri voidrod ke bjorbun\n` +
        `• giverod bjorbun all             → beri semua rod ke bjorbun\n` +
        `• giverod all voidrod             → beri voidrod ke semua player\n` +
        `• giverod all all                 → beri semua rod ke semua player\n` +
        `• giverod bjorbun voidrod 50      → beri voidrod level 50\n` +
        `• giverod bjorbun voidrod 50 100  → beri voidrod level 50 maxlevel 100\n` +
        `• giverod all voidrod max         → beri voidrod level max ke semua\n\n` +
        `Rod keys: ${Object.keys(fishingRod).join(', ')}`
    );

    const targetArg = args[0].toLowerCase();
    const rodKey    = args[1].toLowerCase();
    const levelArg  = args[2]?.toLowerCase() || null;  // angka, "max", atau null
    const maxLvArg  = args[3] ? parseInt(args[3]) : null;

    // Helper: set level rod sesuai arg
    function applyLevelToRod(rodDef) {
        const rod = { ...rodDef };
        const maxLevel = maxLvArg || rod.maxLevel || 5;
        rod.maxLevel = maxLevel;
        if (levelArg === 'max') {
            rod.level = maxLevel;
        } else if (levelArg && !isNaN(parseInt(levelArg))) {
            rod.level = Math.min(parseInt(levelArg), maxLevel);
        }
        return rod;
    }

    // ── !giverod all <rodkey|all> [level] ────────────────
    if (targetArg === 'all') {
        if (rodKey !== 'all' && !fishingRod[rodKey])
            return reply(`❌ Rod *${rodKey}* tidak ada!\nRod tersedia: ${Object.keys(fishingRod).join(', ')}`);

        reply(`⏳ Memberi rod ke semua player...`);
        const allPlayers = await Player.find({});
        let playerCount = 0;

        for (const p of allPlayers) {
            const rodsToGive = rodKey === 'all' ? Object.entries(fishingRod) : [[rodKey, fishingRod[rodKey]]];
            let added = false;
            for (const [key, def] of rodsToGive) {
                const has = p.fishingRods instanceof Map ? p.fishingRods.has(key) : p.fishingRods?.[key];
                if (!has) {
                    const rodData = applyLevelToRod(def);
                    if (p.fishingRods instanceof Map) p.fishingRods.set(key, rodData);
                    else p.fishingRods[key] = rodData;
                    added = true;
                } else if (levelArg) {
                    // Update level rod yang sudah ada
                    const existing = p.fishingRods instanceof Map ? p.fishingRods.get(key) : p.fishingRods[key];
                    if (existing) {
                        const maxLevel = maxLvArg || existing.maxLevel || 5;
                        existing.maxLevel = maxLevel;
                        existing.level = levelArg === 'max' ? maxLevel : Math.min(parseInt(levelArg), maxLevel);
                        if (p.fishingRods instanceof Map) p.fishingRods.set(key, existing);
                        else p.fishingRods[key] = existing;
                        added = true;
                    }
                }
            }
            if (added) {
                p.markModified('fishingRods');
                await p.save();
                playerCount++;
            }
        }

        const rodLabel  = rodKey === 'all' ? 'semua rod' : `*${fishingRod[rodKey]?.name || rodKey}*`;
        const lvLabel   = levelArg ? ` (level ${levelArg === 'max' ? 'MAX' : levelArg}${maxLvArg ? `, maxlv ${maxLvArg}` : ''})` : '';
        return reply(`✅ ${rodLabel}${lvLabel} berhasil diberikan/diupdate ke *${playerCount}* player!`);
    }

    // ── !giverod <user> <rodkey|all> [level] ─────────────
    const target = await findUserByIdOrName(targetArg);
    if (!target) return reply("❌ Player tidak ditemukan!");

    if (rodKey === 'all') {
        let added = 0;
        for (const [key, def] of Object.entries(fishingRod)) {
            const has = target.fishingRods instanceof Map ? target.fishingRods.has(key) : target.fishingRods?.[key];
            const rodData = applyLevelToRod(def);
            if (!has) {
                if (target.fishingRods instanceof Map) target.fishingRods.set(key, rodData);
                else target.fishingRods[key] = rodData;
                added++;
            } else if (levelArg) {
                const existing = target.fishingRods instanceof Map ? target.fishingRods.get(key) : target.fishingRods[key];
                if (existing) {
                    const maxLevel = maxLvArg || existing.maxLevel || 5;
                    existing.maxLevel = maxLevel;
                    existing.level = levelArg === 'max' ? maxLevel : Math.min(parseInt(levelArg), maxLevel);
                    if (target.fishingRods instanceof Map) target.fishingRods.set(key, existing);
                    else target.fishingRods[key] = existing;
                    added++;
                }
            }
        }
        target.markModified('fishingRods');
        await target.save();
        const lvLabel = levelArg ? ` level ${levelArg === 'max' ? 'MAX' : levelArg}` : '';
        return reply(`✅ *${added}* rod${lvLabel} diberikan/diupdate ke *${target.username}*!`);
    }

    if (!fishingRod[rodKey]) return reply(`❌ Rod *${rodKey}* tidak ada!\nRod tersedia: ${Object.keys(fishingRod).join(', ')}`);

    const rodData    = applyLevelToRod(fishingRod[rodKey]);
    const alreadyHas = target.fishingRods instanceof Map ? target.fishingRods.has(rodKey) : target.fishingRods?.[rodKey];

    if (alreadyHas && levelArg) {
        // Update level rod yang sudah ada
        const existing = target.fishingRods instanceof Map ? target.fishingRods.get(rodKey) : target.fishingRods[rodKey];
        const maxLevel = maxLvArg || existing.maxLevel || 5;
        existing.maxLevel = maxLevel;
        existing.level = levelArg === 'max' ? maxLevel : Math.min(parseInt(levelArg), maxLevel);
        if (target.fishingRods instanceof Map) target.fishingRods.set(rodKey, existing);
        else target.fishingRods[rodKey] = existing;
        target.markModified('fishingRods');
        await target.save();
        return reply(`✅ Level *${fishingRod[rodKey].name}* milik *${target.username}* diset ke *${existing.level}/${existing.maxLevel}*!`);
    }

    if (alreadyHas) return reply(`ℹ️ *${target.username}* sudah punya *${fishingRod[rodKey].name}*.\n💡 Tambahkan level: *!giverod ${targetArg} ${rodKey} <level/max>*`);

    if (target.fishingRods instanceof Map) target.fishingRods.set(rodKey, rodData);
    else target.fishingRods[rodKey] = rodData;
    target.markModified('fishingRods');
    await target.save();
    const lvLabel = levelArg ? ` (level ${levelArg === 'max' ? 'MAX' : rodData.level}/${rodData.maxLevel})` : '';
    return reply(`✅ *${fishingRod[rodKey].name}*${lvLabel} diberikan ke *${target.username}*!`);
}

        case "deleterod":
        case "hapusrod": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;
    if (args.length < 2) return reply("⚙️ Format: !deleterod <username/ID> <rodkey|all>");
    const target = await findUserByIdOrName(args[0]);
    if (!target) return reply("❌ Player tidak ditemukan!");
    const rodKey = args[1].toLowerCase();

    if (rodKey === 'all') {
        // Hapus semua rod kecuali basicrod
        const defaultRod = { ...fishingRod['basicrod'] };
        if (target.fishingRods instanceof Map) {
            target.fishingRods.clear();
            target.fishingRods.set('basicrod', defaultRod);
        } else {
            target.fishingRods = { basicrod: defaultRod };
        }
        target.usedFishingRod = 'basicrod';
        target.markModified('fishingRods');
        await target.save();
        return reply(`✅ Semua rod *${target.username}* dihapus, kembali ke Basic Rod.`);
    }

    if (rodKey === 'basicrod') return reply("❌ Basic rod tidak bisa dihapus!");
    const hasRod = target.fishingRods instanceof Map ? target.fishingRods.has(rodKey) : target.fishingRods?.[rodKey];
    if (!hasRod) return reply(`ℹ️ *${target.username}* tidak punya rod *${rodKey}*.`);
    if (target.fishingRods instanceof Map) target.fishingRods.delete(rodKey);
    else delete target.fishingRods[rodKey];
    if (target.usedFishingRod === rodKey) {
        target.usedFishingRod = 'basicrod';
        reply(`⚠️ Rod aktif *${target.username}* diganti ke Basic Rod.`);
    }
    target.markModified('fishingRods');
    await target.save();
    return reply(`✅ Rod *${rodKey}* dihapus dari *${target.username}*!`);
}

        case "removerod": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;
    const rodToRemove = args[0];
    if (!rodToRemove) return reply("⚠️ Format: !removerod <rodkey>");
    const rodDef = fishingRod[rodToRemove];
    if (!rodDef) return reply(`❌ Rod *${rodToRemove}* tidak ditemukan.`);
    const allPlayers = await Player.find({});
    let count = 0;
    for (const p of allPlayers) {
        const rods = p.fishingRods instanceof Map ? Object.fromEntries(p.fishingRods) : (p.fishingRods || {});
        if (rods[rodToRemove]) {
            if (p.fishingRods instanceof Map) p.fishingRods.delete(rodToRemove);
            else delete p.fishingRods[rodToRemove];
            if (p.usedFishingRod === rodToRemove) p.usedFishingRod = 'basicrod';
            p.markModified('fishingRods');
            await p.save();
            count++;
        }
    }
    return reply(`✅ Rod *${rodToRemove}* dihapus dari *${count}* player.`);
}

        case "deleteuser": {
    if (!isOwner) return;
    if (!q) return reply("⚠️ Format: !deleteuser <username/ID/nomorWA>");
    const _delNum = Number(q);
    const delTarget = await Player.findOne({ whatsappNumber: q })
        || await Player.findOne({ username: { $regex: `^${q}$`, $options: "i" } })
        || (q && !isNaN(_delNum) && isFinite(_delNum) ? await Player.findOne({ id: _delNum }) : null);
    if (!delTarget) return reply(`❌ Player *${q}* tidak ditemukan.`);
    await Player.deleteOne({ _id: delTarget._id });
    return reply(`🗑️ Akun *${delTarget.username}* (WA: ${delTarget.whatsappNumber}) berhasil dihapus permanen.`);
}

// ════════════════════════════════════════════════════════════
//   HAPUS PRESTIGE TOKEN (Admin) — kirim notif PM ke player
// ════════════════════════════════════════════════════════════
        case "hapustoken": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;

    // Format: !hapustoken <user> <jumlah> <alasan...>
    if (args.length < 3) {
        return reply(
            `⚙️ *Format: !hapustoken <username/ID> <jumlah> <alasan>*\n\n` +
            `Contoh:\n` +
            `• *!hapustoken hann 100 Melanggar aturan transaksi token*\n` +
            `• *!hapustoken 10000001 50 Token dari bug exploit dihapus*\n\n` +
            `Player akan mendapat pesan pribadi berisi alasan pengurangan token.`
        );
    }

    const targetArg = args[0];
    const jumlah = parseInt(args[1]);
    const alasan = args.slice(2).join(' ');

    if (isNaN(jumlah) || jumlah <= 0) return reply('❌ Jumlah token tidak valid!');

    const target = await findUserByIdOrName(targetArg);
    if (!target) return reply('❌ Player tidak ditemukan!');

    const tokenSebelum = target.prestigeTokens || 0;
    const dicabut = Math.min(jumlah, tokenSebelum);
    target.prestigeTokens = Math.max(0, tokenSebelum - jumlah);
    await target.save();

    // Kirim notif PM ke player jika punya nomor WA
    const pmText =
        `🔔 *Notifikasi dari Admin*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🪙 *Prestige Token kamu dikurangi!*\n\n` +
        `❌ Dikurangi : *${dicabut} token*\n` +
        `📦 Sebelum  : *${tokenSebelum} token*\n` +
        `📦 Sekarang : *${target.prestigeTokens} token*\n\n` +
        `📋 *Alasan:*\n${alasan}\n\n` +
        `_Jika ada pertanyaan, hubungi admin._`;

    let pmStatus = '⚠️ Nomor WA tidak terdaftar, notif tidak terkirim.';
    if (target.whatsappNumber) {
        try {
            // Resolve dulu — whatsappNumber bisa berupa LID atau nomor HP
            const rawWa = `${target.whatsappNumber}@lid`;
            let resolved = await resolveSenderNumber(rawWa, from);

            // Kalau masih LID (resolve gagal), coba findUserId dari baileys
            if (resolved === target.whatsappNumber) {
                try {
                    const ids = await client.findUserId(`${target.whatsappNumber}@lid`);
                    if (ids?.phoneNumber) resolved = ids.phoneNumber.split('@')[0];
                } catch (_) {}
            }

            const targetJid = `${resolved}@s.whatsapp.net`;
            await client.sendMessage(targetJid, { text: pmText });
            pmStatus = `✅ Notif PM terkirim ke *${target.username}* (${resolved})`;
        } catch (e) {
            pmStatus = `⚠️ Gagal kirim PM: ${e.message}`;
        }
    }

    return reply(
        `✅ *Token berhasil dikurangi!*\n\n` +
        `👤 Player   : *${target.username}*\n` +
        `❌ Dikurangi: *${dicabut} token*\n` +
        `📦 Sisa     : *${target.prestigeTokens} token*\n` +
        `📋 Alasan   : ${alasan}\n\n` +
        pmStatus
    );
}

// ════════════════════════════════════════════════════════════
//   REMOVE PRESTIGE TOKEN — kurangi token player atau semua
//   !removetoken <username/ID/all> <jumlah/all>
// ════════════════════════════════════════════════════════════
        case "removetoken": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;

    if (args.length < 2) {
        return reply(
            `⚙️ *Format: !removetoken <username/ID/all> <jumlah/all>*\n\n` +
            `Contoh:\n` +
            `• *!removetoken bjorbun 100*   → kurangi 100 token\n` +
            `• *!removetoken bjorbun all*   → hapus semua token player\n` +
            `• *!removetoken all 50*        → kurangi 50 token semua player\n` +
            `• *!removetoken all all*       → hapus semua token semua player`
        );
    }

    const targetArg = args[0].toLowerCase();
    const amountArg = args[1].toLowerCase();

    // ── all players ───────────────────────────────────────
    if (targetArg === 'all') {
        if (amountArg === 'all') {
            reply('⏳ Menghapus semua prestige token semua player...');
            const result = await Player.updateMany({}, { $set: { prestigeTokens: 0 } });
            return reply(`✅ Semua prestige token dihapus dari *${result.modifiedCount}* player!`);
        }
        const removeAmt = parseInt(amountArg);
        if (isNaN(removeAmt) || removeAmt <= 0) return reply('❌ Jumlah tidak valid!');
        reply(`⏳ Mengurangi ${removeAmt} token dari semua player...`);
        const allP = await Player.find({ prestigeTokens: { $gt: 0 } });
        let count = 0;
        for (const p of allP) {
            p.prestigeTokens = Math.max(0, (p.prestigeTokens || 0) - removeAmt);
            await p.save();
            count++;
        }
        return reply(`✅ Selesai! ${removeAmt} token dikurangi dari *${count}* player.`);
    }

    // ── satu player ───────────────────────────────────────
    const target = await findUserByIdOrName(targetArg);
    if (!target) return reply('❌ Player tidak ditemukan!');

    const tokenBefore = target.prestigeTokens || 0;
    if (amountArg === 'all') {
        target.prestigeTokens = 0;
        await target.save();
        return reply(`✅ Semua token *${target.username}* dihapus! (sebelumnya: ${tokenBefore})`);
    }

    const removeAmt = parseInt(amountArg);
    if (isNaN(removeAmt) || removeAmt <= 0) return reply('❌ Jumlah tidak valid!');
    const removed = Math.min(removeAmt, tokenBefore);
    target.prestigeTokens = Math.max(0, tokenBefore - removeAmt);
    await target.save();
    return reply(
        `✅ Token *${target.username}* dikurangi!\n` +
        `❌ Dikurangi: *${removed}*\n` +
        `📦 Sisa: *${target.prestigeTokens}*`
    );
}

// ════════════════════════════════════════════════════════════
//   SET JACKPOT — paksa jackpot menang/kalah per-user atau global
//   !setjackpot <username/ID/all> <win|lose|reset>
// ════════════════════════════════════════════════════════════
        case "setjackpot": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;

    if (!args[0]) {
        // Tampilkan status semua forced jackpot
        const globalMode = FORCED_JACKPOT_MAP.get('ALL');
        let txt = `🎲 *Set Jackpot*\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        txt += `Format: *!setjackpot <username/ID/all> <win|lose|reset>*\n\n`;
        txt += `Global: *${globalMode ? globalMode.toUpperCase() : 'Normal (40%)'}*\n`;
        if (FORCED_JACKPOT_MAP.size > 1 || (FORCED_JACKPOT_MAP.size === 1 && !globalMode)) {
            txt += `\nPer-user:\n`;
            for (const [k, v] of FORCED_JACKPOT_MAP) {
                if (k === 'ALL') continue;
                txt += `  • ${k}: *${v.toUpperCase()}*\n`;
            }
        }
        txt += `\nContoh:\n`;
        txt += `• *!setjackpot bjorbun win*  → bjorbun selalu menang\n`;
        txt += `• *!setjackpot bjorbun lose* → bjorbun selalu kalah\n`;
        txt += `• *!setjackpot bjorbun reset*→ bjorbun kembali normal\n`;
        txt += `• *!setjackpot all win*      → semua player selalu menang\n`;
        txt += `• *!setjackpot all reset*    → reset semua ke normal`;
        return reply(txt);
    }

    if (args.length < 2)
        return reply('⚙️ Format: !setjackpot <username/ID/all> <win|lose|reset>');

    const targetArg = args[0].toLowerCase();
    const mode = args[1].toLowerCase();
    if (!['win','lose','reset','normal'].includes(mode))
        return reply('❌ Mode tidak valid! Gunakan: *win*, *lose*, atau *reset*');

    // ── Global (all) ─────────────────────────────────────
    if (targetArg === 'all') {
        if (mode === 'reset' || mode === 'normal') {
            FORCED_JACKPOT_MAP.clear();
            return reply('🎲 Semua setting jackpot di-reset ke *normal (40% menang)*.');
        }
        FORCED_JACKPOT_MAP.set('ALL', mode);
        return reply(`${mode === 'win' ? '✅' : '❌'} Jackpot semua player dipaksa *${mode.toUpperCase()}*!\nGunakan *!setjackpot all reset* untuk mengembalikan ke normal.`);
    }

    // ── Per-user ──────────────────────────────────────────
    const target = await findUserByIdOrName(targetArg);
    if (!target) return reply('❌ Player tidak ditemukan!');

    // Gunakan whatsappNumber sebagai key utama, fallback ke ID
    const userKey = target.whatsappNumber || String(target.id);

    if (mode === 'reset' || mode === 'normal') {
        FORCED_JACKPOT_MAP.delete(userKey);
        return reply(`🎲 Jackpot *${target.username}* dikembalikan ke *normal (40% menang)*.`);
    }

    FORCED_JACKPOT_MAP.set(userKey, mode);
    return reply(
        `${mode === 'win' ? '✅' : '❌'} Jackpot *${target.username}* dipaksa *${mode.toUpperCase()}*!\n` +
        `Gunakan *!setjackpot ${targetArg} reset* untuk mengembalikan ke normal.`
    );
}

        case "resetdata": {
    if (!isOwner) return;

    // ── Step 2: konfirmasi ─────────────────────────────────
    if (args[0] === 'confirm') {
        const pending = RESET_CONFIRM.get(senderNumber);
        if (!pending) return reply('❌ Tidak ada permintaan reset yang pending.\nGunakan: *.resetdata <username/ID>* terlebih dahulu.');
        if (Date.now() > pending.expiry) {
            RESET_CONFIRM.delete(senderNumber);
            return reply('⏰ Konfirmasi kadaluarsa. Ulangi perintah resetdata.');
        }

        RESET_CONFIRM.delete(senderNumber);

        const target = await findUserByIdOrName(pending.targetQuery);
        if (!target) return reply('❌ Player tidak ditemukan (mungkin sudah dihapus).');

        const defaultRod = {
            name: "Basic Fishing Rod", type: "rod",
            luck: 0.00, speed: 0.00, comboFish: 1, comboMutations: 1,
            mutationsLuck: 0.000, sellMultiplier: 0, price: 0, enchant: null, bonusStats: {},
            description: "", level: 1, maxLevel: 5, exp: 0, expToNextLevel: 100, enchantCount: 0
        };

        try {
            target.money           = 200;
            target.level           = 1;
            target.exp             = 0;
            target.expToNextLevel  = 100;
            target.usedFishingRod  = "basicrod";
            target.fishingRods     = { basicrod: defaultRod };
            target.currentIsland   = "mousewood";
            target.inventory       = [];
            target.fishingPending  = [];
            target.fishFound       = [];
            target.mutationFound   = [];
            target.travelFound     = [];
            target.fishCaught      = 0;
            target.gachaTickets    = 0;
            target.gachaPity       = 0;
            target.prestigeTokens  = 0;
            target.prestige        = 0;
            target.forcedRarity    = null;
            target.title           = null;
            target.seasonPoints    = 0;
            target.seasonWins      = 0;
            target.luckUpgrade     = 0;
            target.speedUpgrade    = 0;
            target.sellUpgrade     = 0;
            target.lastDaily       = null;
            target.dailyStreak     = 0;
            target.activeBoosts    = {};
            target.achievements    = [];
            target.achievementPoints = 0;
            target.totalEarned     = 0;
            target.rareFishCaught  = 0;
            target.perfectCatches  = 0;
            target.biggestFish     = null;
            await target.save();
            reply(`✅ Progress *${target.username}* berhasil direset!\nAkun & username tetap ada.`);
        } catch (err) {
            reply('❌ Terjadi kesalahan: ' + err.message);
        }
        break;
    }

    // ── Step 1: minta target ───────────────────────────────
    if (!args[0]) return reply('⚙️ Format: *.resetdata <username/ID>*\nContoh: .resetdata budi');

    const target = await findUserByIdOrName(args[0]);
    if (!target) return reply('❌ Player tidak ditemukan!');

    // Simpan pending confirm, expire 60 detik
    RESET_CONFIRM.set(senderNumber, {
        targetQuery: args[0],
        targetUsername: target.username,
        expiry: Date.now() + 60_000,
    });

    reply(
        `⚠️ *Konfirmasi Reset Data*\n\n` +
        `Player  : *${target.username}*\n` +
        `ID      : *${target.id}*\n` +
        `Level   : *${target.level}*\n` +
        `Money   : *${formatMoney(target.money)}*\n\n` +
        `Semua progress akan direset ke awal.\nAkun & username *tidak* akan dihapus.\n\n` +
        `✅ Lanjut → ketik *.resetdata confirm*\n` +
        `❌ Batal → abaikan pesan ini _(60 detik)_`
    );
    break;
}

        case "addmoney": {
    if (!isOwner && !isAdmin(senderNumber, m)) {
        return;
    }

    if (!args[0] || !args[1]) {
        return reply("⚠️ Format: !addmoney <username/ID> <jumlah>\nContoh: !addmoney hann 1B");
    }

    const targetQuery = args[0];
    const amountText = args[1].toUpperCase();

    const amount = parseAmount(amountText);
    if (isNaN(amount) || amount <= 0)
        return reply("⚠️ Jumlah tidak valid! Gunakan format seperti `100K`, `5M`, `1.2B`");

    const _amNum = Number(targetQuery);
    const target = await Player.findOne({
        $or: [
            { username: new RegExp(`^${targetQuery}$`, "i") },
            ...(!isNaN(_amNum) && isFinite(_amNum) && String(targetQuery).trim() !== '' ? [{ id: _amNum }] : []),
        ]
    });

    if (!target) return reply("❌ Player tidak ditemukan!");

    target.money = (target.money || 0) + amount;
    await target.save();

    reply(`✅ Berhasil menambahkan ${formatMoney(amount)} ke *${target.username}*.\n💰 Total sekarang: ${formatMoney(target.money)}`);
    break;
}

        case "database": {
    if (!isOwner)
        return;

        const players = await Player.find().lean();
        const tempPath = path.join(__dirname, "player_backup.json");
        fs.writeFileSync(tempPath, JSON.stringify(players, null, 2));

        await client.sendMessage(m.chat, {
            document: fs.readFileSync(tempPath),
            mimetype: "application/json",
            fileName: "player_backup.json"
        }, { quoted: m });

        fs.unlinkSync(tempPath);

    break;
}

        case "createlist":
        case "buatlist": {
    // !createlist <namaList> — Buat list baru
    const listName = args.join(' ').trim();
    if (!listName) return reply('❌ Sebutkan nama list!\n📌 Contoh: !createlist Ngawi');

    // Cek limit: 1 list per orang per grup
    const myList = await CustomList.findOne({ group: from, createdBy: senderNumber });
    if (myList) return reply(`❌ Kamu sudah punya list *${myList.listName}*!\nSetiap orang hanya bisa membuat 1 list.\nHapus dulu dengan *!deletelist ${myList.listName}* jika ingin membuat baru.`);

    const exists = await CustomList.findOne({ group: from, listName: { $regex: new RegExp(`^${listName}$`, 'i') } });
    if (exists) return reply(`❌ Nama list *${listName}* sudah dipakai orang lain!`);

    const creatorJid1 = sender.includes('@') ? sender : `${senderNumber}@s.whatsapp.net`;
    await new CustomList({ group: from, listName, createdBy: senderNumber, creatorJid: creatorJid1, entries: [] }).save();
    reply(`✅ List *${listName}* berhasil dibuat!\n\nOrang lain bisa gabung dengan *!joinlist ${listName}*`);
    break;
}

        case "list": {
    // !list — Lihat list milik sendiri
    const doc = await CustomList.findOne({ group: from, createdBy: senderNumber });
    if (!doc) return reply(
        '❌ Kamu belum punya list!\n\n' +
        '📋 *Cara pakai list:*\n' +
        '• *!addlist <nama>* — Buat list kamu\n' +
        '• *!editlist <nama baru>* — Ganti nama list\n' +
        '• *!dellist <nomor>* — Hapus entry dari list\n' +
        '• *!deletelist* — Hapus seluruh list\n\n' +
        '📌 Contoh: !addlist Ngawi'
    );
    if (doc.entries.length === 0) return reply(`📋 List *${doc.listName}* masih kosong.\nOrang lain bisa gabung dengan *!joinlist ${doc.listName}*`);

    const mentionJids = doc.entries.map(e => e.addedByJid || (e.addedBy ? `${e.addedBy}@s.whatsapp.net` : null)).filter(Boolean);
    const rows = doc.entries.map((e, i) => {
        const jid = e.addedByJid || (e.addedBy ? `${e.addedBy}@s.whatsapp.net` : null);
        const tag = jid ? `@${jid.split('@')[0]}` : e.name;
        return `${i + 1}. *${e.name}* (${tag})${e.message ? ' — ' + e.message : ''}`;
    }).join('\n');
    await client.sendMessage(m.chat, {
        text: `📋 *${doc.listName}*\n━━━━━━━━━━━━━━━━━━━━━━\n${rows}\n━━━━━━━━━━━━━━━━━━━━━━\n📊 Total: ${doc.entries.length} orang`,
        mentions: mentionJids
    }, { quoted: m });
    break;
}

        case "addlist": {
    // !addlist <namaList> — Buat list baru (1 per orang per grup)
    const listName = args.join(' ').trim();
    if (!listName) return reply(
        '❌ Sebutkan nama list!\n' +
        '✅ *!addlist <nama>*\n' +
        '📌 Contoh: !addlist Ngawi'
    );

    // Cek: user sudah punya list?
    const myList = await CustomList.findOne({ group: from, createdBy: senderNumber });
    if (myList) return reply(
        `❌ Kamu sudah punya list *${myList.listName}*!\n` +
        `Setiap orang hanya bisa membuat 1 list.\n\n` +
        `Mau ganti nama? Pakai *!editlist <nama baru>*\n` +
        `Mau hapus? Pakai *!deletelist*`
    );

    // Cek: nama sudah dipakai orang lain?
    const nameExists = await CustomList.findOne({ group: from, listName: { $regex: new RegExp(`^${listName}$`, 'i') } });
    if (nameExists) return reply(`❌ Nama list *${listName}* sudah dipakai orang lain!`);

    const creatorJid2 = sender.includes('@') ? sender : `${senderNumber}@s.whatsapp.net`;
    await new CustomList({ group: from, listName, createdBy: senderNumber, creatorJid: creatorJid2, entries: [] }).save();
    reply(`✅ List *${listName}* berhasil dibuat!\n\nLihat listmu dengan *!list*\nOrang lain bisa gabung dengan *!joinlist ${listName}*`);
    break;
}

        case "joinlist":
        case "gabunglist": {
    // !joinlist <nama list>                   → nama = pushname otomatis
    // !joinlist <nama list> | <nama custom>   → nama custom
    // !joinlist <nama list> | <nama custom> | <pesan>
    const rawJoin = body.slice(body.indexOf(' ') + 1).trim();
    const [lNameJoin, customNameJoin, ...msgPartsJoin] = rawJoin.split('|').map(s => s.trim());
    const eMsgJoin = msgPartsJoin.join('|').trim();

    if (!lNameJoin) return reply(
        '❌ Sebutkan nama list yang mau kamu masuki!\n' +
        '✅ *!joinlist <nama list>* — nama otomatis dari WA\n' +
        '✅ *!joinlist <nama list> | <nama custom>*\n' +
        '✅ *!joinlist <nama list> | <nama custom> | <pesan>*\n' +
        '📌 Contoh: !joinlist Ngawi\n' +
        '📌 Contoh: !joinlist Ngawi | Budi\n' +
        '📌 Contoh: !joinlist Ngawi | Budi | halo semua'
    );

    const docJoin = await CustomList.findOne({ group: from, listName: { $regex: new RegExp(`^${lNameJoin}$`, 'i') } });
    if (!docJoin) return reply(`❌ List *${lNameJoin}* tidak ditemukan!\nCek list yang ada dengan *!alllist*`);

    // Cek: udah ada di list ini?
    const alreadyIn = docJoin.entries.some(e => e.addedBy === senderNumber);
    if (alreadyIn) return reply(`❌ Kamu sudah ada di list *${docJoin.listName}*!\nMau keluar? Pakai *!keluarlist ${docJoin.listName}*`);

    // Nama: custom kalau ada, fallback ke pushname, fallback ke nomor
    const displayName = customNameJoin || pushname || senderNumber;
    const addedByJid = sender.includes('@') ? sender : `${senderNumber}@s.whatsapp.net`;
    docJoin.entries.push({ name: displayName, message: eMsgJoin, addedBy: senderNumber, addedByJid });
    await docJoin.save();

    const pos = docJoin.entries.length;
    reply(`✅ *${displayName}* berhasil masuk ke list *${docJoin.listName}* (no. ${pos})${eMsgJoin ? '\n💬 ' + eMsgJoin : ''}!`);
    break;
}

        case "keluarlist":
        case "leavelist": {
    // !keluarlist <nama list> — Keluar dari list orang lain
    const lNameKeluar = args.join(' ').trim();
    if (!lNameKeluar) return reply(
        '❌ Sebutkan nama list yang mau kamu tinggalkan!\n' +
        '✅ *!keluarlist <nama list>*\n' +
        '📌 Contoh: !keluarlist Ngawi'
    );

    const docKeluar = await CustomList.findOne({ group: from, listName: { $regex: new RegExp(`^${lNameKeluar}$`, 'i') } });
    if (!docKeluar) return reply(`❌ List *${lNameKeluar}* tidak ditemukan!`);

    const idxKeluar = docKeluar.entries.findIndex(e => e.addedBy === senderNumber);
    if (idxKeluar === -1) return reply(`❌ Kamu tidak ada di list *${docKeluar.listName}*!`);

    const removedKeluar = docKeluar.entries[idxKeluar];
    docKeluar.entries.splice(idxKeluar, 1);
    await docKeluar.save();
    reply(`👋 *${removedKeluar.name}* berhasil keluar dari list *${docKeluar.listName}*!`);
    break;
}

        case "dellist": {
    // !dellist <nomor> — Hapus entry dari list milik sendiri
    const numStr = args[0]?.trim();
    if (!numStr) return reply(
        '❌ Sebutkan nomor entry yang ingin dihapus!\n' +
        '✅ *!dellist <nomor>*\n' +
        '📌 Contoh: !dellist 1'
    );

    const num = parseInt(numStr);
    if (isNaN(num) || num < 1) return reply('❌ Nomor urut tidak valid!');

    const doc = await CustomList.findOne({ group: from, createdBy: senderNumber });
    if (!doc) return reply('❌ Kamu belum punya list!\nBuat dulu dengan *!addlist <nama>*');
    if (doc.entries.length === 0) return reply(`📋 List *${doc.listName}* sudah kosong!`);
    if (num > doc.entries.length) return reply(`❌ Nomor ${num} tidak ada. List kamu hanya punya ${doc.entries.length} entry.`);

    const toRemove = doc.entries[num - 1];
    doc.entries.splice(num - 1, 1);
    await doc.save();
    reply(`🗑️ *${toRemove.name}* (no. ${num}) berhasil dihapus dari list *${doc.listName}*!`);
    break;
}

        case "deletelist":
        case "hapuslist": {
    // !deletelist — Hapus seluruh list milik sendiri
    const doc = await CustomList.findOne({ group: from, createdBy: senderNumber });
    if (!doc) return reply('❌ Kamu belum punya list!\nBuat dulu dengan *!addlist <nama>*');
    const totalEntries = doc.entries.length;
    await doc.deleteOne();
    reply(`🗑️ List *${doc.listName}* beserta ${totalEntries} entry berhasil dihapus!`);
    break;
}

        case "alllist":
        case "semualist": {
    // !alllist — Tampilkan semua list yang ada di grup ini
    const allLists = await CustomList.find({ group: from }).lean();
    if (!allLists || allLists.length === 0)
        return reply('📋 Belum ada list di grup ini.\nBuat list dengan *!addlist <nama>*');

    const mentionJidsAll = allLists.map(l => l.creatorJid || (l.createdBy ? `${l.createdBy}@s.whatsapp.net` : null)).filter(Boolean);
    let text = `📋 *Semua List di Grup Ini*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    allLists.forEach((l, i) => {
        const jid = l.creatorJid || (l.createdBy ? `${l.createdBy}@s.whatsapp.net` : null);
        const tag = jid ? `@${jid.split('@')[0]}` : (l.createdBy || 'Unknown');
        text += `${i + 1}. *${l.listName}* — ${l.entries.length} orang\n`;
        text += `   👤 Dibuat oleh: ${tag}\n`;
    });
    text += `━━━━━━━━━━━━━━━━━━━━━━\n📊 Total: ${allLists.length} list`;
    await client.sendMessage(m.chat, { text, mentions: mentionJidsAll }, { quoted: m });
    break;
}

        case "editlistname":
        case "gantinama": {
    // !editlistname <nama lama> | <nama baru>
    const raw = body.slice(body.indexOf(' ') + 1).trim();
    const [oldName, newName] = raw.split('|').map(s => s.trim());
    if (!oldName || !newName) return reply(
        '❌ Format salah!\n' +
        '✅ *!editlistname <nama lama> | <nama baru>*\n' +
        '📌 Contoh: !editlistname Ngawi | Budi'
    );

    const doc = await CustomList.findOne({ group: from, listName: { $regex: new RegExp(`^${oldName}$`, 'i') } });
    if (!doc) return reply(`❌ List *${oldName}* tidak ditemukan!`);
    if (doc.createdBy !== senderNumber && !isOwner && !isAdmin(senderNumber, m))
        return reply(`❌ Kamu tidak bisa mengganti nama list *${doc.listName}* karena bukan kamu yang membuatnya!`);

    const taken = await CustomList.findOne({ group: from, listName: { $regex: new RegExp(`^${newName}$`, 'i') } });
    if (taken) return reply(`❌ Nama *${newName}* sudah dipakai!`);

    doc.listName = newName;
    await doc.save();
    reply(`✏️ Nama list berhasil diubah: *${oldName}* → *${newName}*`);
    break;
}

        case "editlist":
        case "gantilist": {
    // !editlist <nama baru> — Ganti nama list milik sendiri (1 list per orang, gausah sebut nama lama)
    const newName = args.join(' ').trim();
    if (!newName) return reply(
        '❌ Sebutkan nama baru!\n' +
        '✅ *!editlist <nama baru>*\n' +
        '📌 Contoh: !editlist Madiun'
    );

    const doc = await CustomList.findOne({ group: from, createdBy: senderNumber });
    if (!doc) return reply(`❌ Kamu belum punya list!\nBuat dulu dengan *!addlist <nama>*`);

    const taken = await CustomList.findOne({
        group: from,
        listName: { $regex: new RegExp(`^${newName}$`, 'i') },
        createdBy: { $ne: senderNumber }
    });
    if (taken) return reply(`❌ Nama *${newName}* sudah dipakai orang lain!`);

    const oldName = doc.listName;
    doc.listName = newName;
    await doc.save();
    reply(`✏️ Nama list berhasil diubah: *${oldName}* → *${newName}*`);
    break;
}

        case "transfer": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!args[0] || !args[1])
        return reply("⚠️ Format: !transfer <username/id> <jumlah>\nContoh: !transfer hann 1B");

    const targetQuery = args[0];
    const amountText = args[1].toUpperCase();

    const amount = parseAmount(amountText);
    if (isNaN(amount) || amount <= 0)
        return reply("⚠️ Jumlah transfer tidak valid!\nGunakan format seperti 100K, 5M, 1.2B");

    const isNumericId = /^\d+$/.test(targetQuery);
    const target = await Player.findOne(
        isNumericId
            ? { $or: [{ username: new RegExp(`^${targetQuery}$`, "i") }, { id: Number(targetQuery) }] }
            : { username: new RegExp(`^${targetQuery}$`, "i") }
    );

    if (!target)
        return reply("❌ User tujuan tidak ditemukan.");

    if (target.id === user.id)
        return reply("⚠️ Kamu tidak bisa transfer ke diri sendiri!");

    if (!user.friends.includes(target.id))
        return reply("⚠️ Kamu harus menjadi teman dengan user ini terlebih dahulu untuk melakukan transfer.");

    if (user.money < amount)
        return reply("💸 Uang kamu tidak cukup untuk transfer ini.");

    user.money -= amount;
    target.money += amount;

    await user.save();
    await target.save();

    reply(`✅ Berhasil mentransfer ${formatMoney(amount)} ke *${target.username}* (ID: ${target.id})`);

    if (target.whatsappNumber && typeof client?.sendMessage === "function") {
        const receiverJid = `${target.whatsappNumber}@s.whatsapp.net`;
        await client.sendMessage(receiverJid, {
            text: `💰 *${user.username}* baru saja mengirim kamu ${formatMoney(amount)}! 🎁`
        });
    }

    // Notif Telegram ke penerima jika sudah link
    if (target.isVerifiedTelegram && target.telegramId) {
        await notifyTelegram(target.telegramId,
            `💸 *Transfer masuk!*\n` +
            `Dari: *${target.username ? user.username : 'Seseorang'}*\n` +
            `Jumlah: *${formatMoney(amount)}* coins\n` +
            `Saldo baru: *${formatMoney(target.money)}* coins`
        );
    }

    break;
}
        case "money": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    reply(`💰 ${user.username}, Kamu mempunyai ${formatMoney(user.money)} money`);
    break;
}

        case "bj":
        case "blackjack": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const existing = BLACKJACK_GAMES.get(senderNumber);

    if (existing && existing.status === 'playing') {
        return reply(
            `🃏 Kamu masih punya game blackjack yang berjalan!\n\n` +
            `🎰 Dealer: ${bjRenderHand(existing.dealerHand, true)}\n` +
            `👤 Tanganmu: ${bjRenderHand(existing.playerHand)} (${bjHandValue(existing.playerHand)})\n\n` +
            `Ketik *!hit* untuk ambil kartu, *!stand* untuk berhenti, atau *!double* untuk double down.`
        );
    }

    const betInput = args[0];
    if (!betInput) return reply(
        `🃏 *Cara main Blackjack:*\n` +
        `!bj <jumlah taruhan>\n\n` +
        `Contoh: !bj 1000\n` +
        `💰 Saldo kamu: ${formatMoney(user.money)}`
    );

    const bet = betInput.toLowerCase() === 'all' ? user.money : parseInt(betInput.replace(/\D/g, ''));
    if (!bet || isNaN(bet) || bet <= 0) return reply('❌ Jumlah taruhan tidak valid.');
    if (bet > user.money) return reply(`❌ Saldo kamu tidak cukup. Saldo: ${formatMoney(user.money)}`);

    user.money -= bet;
    await user.save();

    const deck = bjCreateDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];

    const game = { deck, playerHand, dealerHand, bet, status: 'playing', chatId: m.chat };
    BLACKJACK_GAMES.set(senderNumber, game);

    const playerBJ = bjIsBlackjack(playerHand);
    const dealerBJ = bjIsBlackjack(dealerHand);

    if (playerBJ || dealerBJ) {
        game.status = 'done';
        let resultText, payout = 0;
        if (playerBJ && dealerBJ) {
            payout = bet;
            resultText = `🤝 Sama-sama Blackjack! Seri, taruhan dikembalikan.`;
        } else if (playerBJ) {
            payout = Math.floor(bet * 2.5);
            resultText = `🎉 *BLACKJACK!* Kamu menang ${formatMoney(payout)}!`;
        } else {
            payout = 0;
            resultText = `😵 Dealer dapat Blackjack! Kamu kalah ${formatMoney(bet)}.`;
        }
        if (payout > 0) { user.money += payout; await user.save(); }
        BLACKJACK_GAMES.delete(senderNumber);
        return reply(
            `🃏 *BLACKJACK*\n\n` +
            `🎰 Dealer: ${bjRenderHand(dealerHand)} (${bjHandValue(dealerHand)})\n` +
            `👤 Tanganmu: ${bjRenderHand(playerHand)} (${bjHandValue(playerHand)})\n\n` +
            `${resultText}\n💰 Saldo: ${formatMoney(user.money)}`
        );
    }

    const sentMsg = await reply(
        `🃏 *BLACKJACK* — Taruhan: ${formatMoney(bet)}\n\n` +
        `🎰 Dealer: ${bjRenderHand(dealerHand, true)}\n` +
        `👤 Tanganmu: ${bjRenderHand(playerHand)} (${bjHandValue(playerHand)})\n\n` +
        `Ketik *!hit* (ambil kartu), *!stand* (berhenti), atau *!double* (double down).\n` +
        `_(atau react 👊 hit / ⛔ stand / 2️⃣ double di pesan ini)_`
    );
    if (sentMsg?.key) game.messageKey = sentMsg.key;
    break;
}

        case "hit": {
    await bjHit(senderNumber, pushname, reply);
    break;
}

        case "stand": {
    await bjStand(senderNumber, pushname, reply);
    break;
}

        case "double": {
    await bjDouble(senderNumber, pushname, reply);
    break;
}

        case "cf":
        case "coinflip": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    const betInput = args[0];
    const guessInput = (args[1] || '').toLowerCase();

    if (!betInput || !guessInput) return reply(
        `🪙 *Cara main Coinflip:*\n` +
        `!cf <jumlah> <h/t>\n\n` +
        `h = heads, t = tails\n` +
        `Contoh: !cf 1000 h\n` +
        `💰 Saldo kamu: ${formatMoney(user.money)}`
    );

    const guessMap = { h: 'heads', head: 'heads', heads: 'heads', t: 'tails', tail: 'tails', tails: 'tails' };
    const guess = guessMap[guessInput];
    if (!guess) return reply('❌ Pilihan harus *h* (heads) atau *t* (tails).');

    const bet = betInput.toLowerCase() === 'all' ? user.money : parseInt(betInput.replace(/\D/g, ''));
    if (!bet || isNaN(bet) || bet <= 0) return reply('❌ Jumlah taruhan tidak valid.');
    if (bet > user.money) return reply(`❌ Saldo kamu tidak cukup. Saldo: ${formatMoney(user.money)}`);

    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    const win = result === guess;

    user.money += win ? bet : -bet;
    await user.save();

    const coinEmoji = result === 'heads' ? '🪙 HEADS' : '🪙 TAILS';
    reply(
        `${coinEmoji}\n\n` +
        `Tebakanmu: *${guess.toUpperCase()}*\n` +
        (win
            ? `🎉 Kamu menang ${formatMoney(bet)}!`
            : `😵 Kamu kalah ${formatMoney(bet)}.`) +
        `\n💰 Saldo: ${formatMoney(user.money)}`
    );
    break;
}

        case "slot":
        case "slots": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    const betInput = args[0];
    if (!betInput) return reply(
        `🎰 *Cara main Slot:*\n` +
        `!slot <jumlah>\n\n` +
        `Contoh: !slot 1000\n\n` +
        `*Payout:*\n` +
        `💎💎💎 = 10x (jackpot)\n` +
        `🔔🔔🔔 = 6x\n` +
        `🍋🍋🍋 = 4x\n` +
        `🍒🍒🍒 = 3x\n` +
        `2 simbol sama = 1x (balik modal)\n\n` +
        `💰 Saldo kamu: ${formatMoney(user.money)}`
    );

    const bet = betInput.toLowerCase() === 'all' ? user.money : parseInt(betInput.replace(/\D/g, ''));
    if (!bet || isNaN(bet) || bet <= 0) return reply('❌ Jumlah taruhan tidak valid.');
    if (bet > user.money) return reply(`❌ Saldo kamu tidak cukup. Saldo: ${formatMoney(user.money)}`);

    // bobot: simbol makin langka makin besar payout-nya, makin kecil kemunculannya
    const reelSymbols = [
        { symbol: '🍒', weight: 40 },
        { symbol: '🍋', weight: 28 },
        { symbol: '🔔', weight: 18 },
        { symbol: '💎', weight: 8 },
        { symbol: '⭐', weight: 6 }, // simbol tanpa payout khusus (dianggap "miss" kalau nggak 3x sama)
    ];
    const totalWeight = reelSymbols.reduce((a, s) => a + s.weight, 0);
    function spinReel() {
        let r = Math.random() * totalWeight;
        for (const s of reelSymbols) {
            if (r < s.weight) return s.symbol;
            r -= s.weight;
        }
        return reelSymbols[0].symbol;
    }

    const reels = [spinReel(), spinReel(), spinReel()];
    const payoutTable = { '💎': 10, '🔔': 6, '🍋': 4, '🍒': 3 };

    let multiplier = 0, resultLabel;
    if (reels[0] === reels[1] && reels[1] === reels[2]) {
        multiplier = payoutTable[reels[0]] || 1.5; // 3x ⭐ dikasih payout kecil 1.5x
        resultLabel = `🎉 *JACKPOT!* 3 simbol sama!`;
    } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
        multiplier = 1;
        resultLabel = `✨ 2 simbol sama, modal balik!`;
    } else {
        multiplier = 0;
        resultLabel = `😵 Tidak ada kombinasi. Kalah.`;
    }

    const payout = Math.floor(bet * multiplier);
    user.money += payout - bet;
    await user.save();

    reply(
        `🎰 *SLOT MACHINE*\n\n` +
        `[ ${reels[0]} | ${reels[1]} | ${reels[2]} ]\n\n` +
        `${resultLabel}\n` +
        (multiplier > 0
            ? `Menang ${formatMoney(payout)} (${multiplier}x)`
            : `Kehilangan ${formatMoney(bet)}`) +
        `\n💰 Saldo: ${formatMoney(user.money)}`
    );
    break;
}

        case "stat":
        case "stats": {
    const user   = await getOrCreateUser(senderNumber, null, pushname);
    const rodKey = user.usedFishingRod;
    const rod    = user.fishingRods?.get(rodKey);
    if (!rod) return reply("❌ Kamu belum punya joran!");

    const enchant  = (rod.enchant && rodEnchants[rod.enchant]?.effect) ? rodEnchants[rod.enchant] : null;
    const upgStats = getUpgradedStats(user, rod);
    const bait     = upgStats.activeBait;
    const streak   = FISHING_STREAKS.get(senderNumber) || 0;
    const streakBon = getStreakBonus(streak);
    const weather  = CURRENT_WEATHER;
    const prestige = (user.prestige || 0) * 0.05;

    // Komponen luck
    const luckRod      = (rod.luck || 0) * 100;
    const luckUpgrade  = UPGRADES.luck.effect(user.luckUpgrade || 0) * 100;
    const luckPrestige = prestige * 100;
    const luckBait     = (bait?.id === 'goldbait' ? 0.3 : bait?.id === 'crystalbait' ? 0.6 : 0) * 100;
    const luckEnchant  = enchant?.effect?.luck ? (enchant.effect.luck - 1) * 100 : 0;
    const luckWeather  = ((weather.luckMult || 1) - 1) * 100;
    const luckStreak   = (streakBon.luckAdd || 0) * 100;
    const luckBase     = 100; // base player
    const luckSubtotal = luckBase + luckRod + luckUpgrade + luckPrestige + luckBait + luckEnchant + luckWeather + luckStreak;
    const luckEvent    = GLOBAL_LUCK_EVENT.active && Date.now() < GLOBAL_LUCK_EVENT.endTime ? GLOBAL_LUCK_EVENT.multiplier : 1;
    const luckFinal    = luckSubtotal * luckEvent;

    // Komponen speed
    const speedRod     = (rod.speed || 0) * 100;
    const speedUpgrade = UPGRADES.speed.effect(user.speedUpgrade || 0) * 100;
    const speedEnchant = enchant?.effect?.lureSpeed ? (enchant.effect.lureSpeed - 1) * 100 : 0;
    const speedFinal   = Math.min(speedRod + speedUpgrade + speedEnchant, 98);



    const sep = '─'.repeat(28);
    let txt = `📊 *Total Stat — ${user.username}*\n${sep}\n\n`;

    txt += `🍀 *LUCK*\n`;
    txt += `   Base player    : *+${luckBase.toFixed(1)}%*\n`;
    if (luckRod)      txt += `   Rod (${rod.name.split(' ')[0]})  : *+${luckRod.toFixed(1)}%*\n`;
    if (luckUpgrade)  txt += `   Upgrade Luck   : *+${luckUpgrade.toFixed(1)}%*\n`;
    if (luckPrestige) txt += `   Prestige ×${user.prestige} : *+${luckPrestige.toFixed(1)}%*\n`;
    if (luckBait)     txt += `   Bait           : *+${luckBait.toFixed(1)}%*\n`;
    if (luckEnchant)  txt += `   Enchant        : *+${luckEnchant.toFixed(1)}%*\n`;
    if (luckWeather)  txt += `   Cuaca (${weather.name})  : *+${luckWeather.toFixed(1)}%*\n`;
    if (luckStreak)   txt += `   Streak ×${streak}    : *+${luckStreak.toFixed(1)}%*\n`;
    txt += `   ──────────────────\n`;
    txt += `   Subtotal       : *${luckSubtotal.toFixed(1)}%*\n`;
    if (luckEvent > 1) txt += `   Event ×${luckEvent}     : *${luckFinal.toFixed(1)}%* 🎉\n`;
    txt += `   🍀 *FINAL: ${luckFinal.toFixed(1)}%*\n\n`;

    txt += `⚡ *SPEED*\n`;
    if (speedRod)     txt += `   Rod             : *+${speedRod.toFixed(1)}%*\n`;
    if (speedUpgrade) txt += `   Upgrade Speed   : *+${speedUpgrade.toFixed(1)}%*\n`;
    if (speedEnchant) txt += `   Enchant         : *+${speedEnchant.toFixed(1)}%*\n`;
    txt += `   ⚡ *FINAL: ${speedFinal.toFixed(1)}%*${speedFinal >= 98 ? ' _(cap)_' : ''}\n\n`;

    txt += `🐟 *LAINNYA*\n`;
    txt += `   Combo Ikan      : *${rod.comboFish || 1}x*\n`;
    txt += `   Combo Mutasi    : *${rod.comboMutations || 1}x*\n`;
    txt += `   Mutation Luck   : *${((rod.mutationsLuck || 0) * 100).toFixed(1)}%*\n`;
    if (bait) txt += `   Bait aktif      : *${bait.label}*\n`;
    if (streak >= 3) txt += `   Streak          : *${streak}x* (sell ×${getStreakBonus(streak).mult.toFixed(2)})\n`;

    reply(txt);
    break;
}

        case "rodstat":
        case "statrod": {
    const user   = await getOrCreateUser(senderNumber, null, pushname);
    const rodKey = user.usedFishingRod;
    const rod    = user.fishingRods?.get(rodKey);

    if (!rod) return reply("❌ Kamu belum punya joran!");

    const enchant    = (rod.enchant && rodEnchants[rod.enchant]?.effect) ? rodEnchants[rod.enchant] : null;
    const upgStats   = getUpgradedStats(user, rod);
    const bait       = upgStats.activeBait;

    // Speed dalam persen (0-100%)
    const speedBase  = ((rod.speed || 0) * 100).toFixed(1);
    const speedTotal = (upgStats.speed * 100).toFixed(1);
    const luckBase   = ((rod.luck || 0) * 100).toFixed(1);
    const luckTotal  = (upgStats.luck * 100).toFixed(1);

    const expBar = () => {
        const maxExp = rod.expToNextLevel > 0 ? rod.expToNextLevel : 1;
        const curExp = Math.max(0, Math.min(rod.exp || 0, maxExp));
        const pct    = curExp / maxExp;
        const filled = Math.min(10, Math.max(0, Math.round(pct * 10)));
        return '█'.repeat(filled) + '░'.repeat(10 - filled);
    };

    let txt = `🎣 *Stat Rod: ${rod.name}*\n`;
    txt += `${'─'.repeat(28)}\n`;
    txt += `⭐ Level  : *${rod.level}* / ${rod.maxLevel}\n`;
    txt += `📊 EXP    : ${formatMoney(rod.exp)} / ${formatMoney(rod.expToNextLevel)}\n`;
    txt += `    [${expBar()}]\n\n`;
    txt += `⚡ Speed  : *${speedTotal}%*`;
    if (speedTotal !== speedBase) txt += ` _(base: ${speedBase}%)_`;
    txt += `\n`;
    txt += `🍀 Luck   : *${luckTotal}%*`;
    if (luckTotal !== luckBase) txt += ` _(base: ${luckBase}%)_`;
    txt += `\n`;
    txt += `🐟 Combo  : *${rod.comboFish || 1}x* ikan per mancing\n`;
    txt += `💰 Sell+  : *+${((upgStats.sellMultiplier || 0) * 100).toFixed(0)}%*\n`;

    if (enchant) {
        txt += `\n✨ *Enchant: ${enchant.name}*\n`;
        txt += `   ${enchant.desc || ''}\n`;
    } else {
        txt += `\n✨ Enchant : _Tidak ada_\n`;
    }

    if (bait) {
        txt += `🪱 Bait   : *${bait.label || bait.id}* (+${bait.id === 'goldbait' ? '30' : '60'}% luck)\n`;
    }

    if (user.prestige > 0) {
        txt += `\n👑 Prestige: *${user.prestige}x* (+${(user.prestige * 5).toFixed(0)}% luck)\n`;
    }

    txt += `\n🔧 Upgrade:\n`;
    txt += `   ⚡ Speed Lv.${user.speedUpgrade || 0} | 🍀 Luck Lv.${user.luckUpgrade || 0}`;

    reply(txt);
    break;
}

        case "listrod": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    const rodsMap = user.fishingRods;
    if (!rodsMap || rodsMap.size === 0) return reply("⚠️ Kamu belum memiliki pancingan apapun.");

    const equippedKey = user.usedFishingRod;
    const rows = [];
    for (const [key, rod] of rodsMap.entries()) {
        const isEquipped = key === equippedKey;
        rows.push({
            id: `equip_${key}`,
            title: `${isEquipped ? "⚡ [EQUIPPED] " : ""}${rod.name || key}`,
            description: `Lv.${rod.level}/${rod.maxLevel} | EXP:${rod.exp}/${rod.expToNextLevel} | 🍀${(rod.mutationsLuck*100).toFixed(2)}% | ⚡${(rod.speed*100).toFixed(1)}%`
        });
    }

    let rodText = `🎣 *Fishing Rods Kamu* (${rodsMap.size} rod)\n`;
    rodText += `⚡ Equipped: *${equippedKey}*\n`;
    rodText += `${'─'.repeat(28)}\n`;
    for (const [key, rod] of rodsMap.entries()) {
        const eq = key === equippedKey;
        rodText += `\n${eq ? '⚡ *[EQUIPPED]*' : '🔹'} *${rod.name || key}*`;
        if (rod.enchant) rodText += ` ✨${rod.enchant}`;
        rodText += `\n`;
        rodText += `  Lv.${rod.level}/${rod.maxLevel} | EXP: ${rod.exp}/${rod.expToNextLevel}\n`;
        rodText += `  🍀 Luck: ${(rod.luck*100).toFixed(1)}% | ⚡ Speed: ${(rod.speed*100).toFixed(1)}%\n`;
        rodText += `  🧬 MutLuck: ${(rod.mutationsLuck*100).toFixed(3)}% | 💸 SellMult: x${(1+(rod.sellMultiplier||0)).toFixed(1)}\n`;
        if (!eq) rodText += `  ↳ Equip: *!equip ${key}*\n`;
    }
    rodText += `${'─'.repeat(28)}`;
    reply(rodText);
}
break;

        case "me": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    const timeSince = (timestamp) => {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);
        const units = [
            { label: "tahun", value: 31536000 },
            { label: "bulan", value: 2592000 },
            { label: "hari", value: 86400 },
            { label: "jam", value: 3600 },
            { label: "menit", value: 60 },
            { label: "detik", value: 1 },
        ];
        for (const u of units) {
            const v = Math.floor(seconds / u.value);
            if (v >= 1) return `${v} ${u.label} lalu`;
        }
        return "baru saja";
    };

    const rod = user.fishingRods.get(user.usedFishingRod);
    const rodProgress = `${rod.exp}/${rod.expToNextLevel}`;
    const playerProgress = `${user.exp}/${user.expToNextLevel}`;

    const msg = 
`🎣 *Profil Pemancing*
────────────────────────
📛 Nama: ${user.username}
🆔 ID: ${user.id}
💰 Uang: ${formatMoney(user.money)}
🌍 Pulau: ${user.currentIsland}

🧍 Player:
  ▫️ Level: ${user.level}/${user.maxLevel}
  ▫️ EXP: ${playerProgress}

🎣 Rod: ${rod.name}
  ▫️ Level: ${rod.level}/${rod.maxLevel}
  ▫️ EXP: ${rodProgress}

📊 Statistik
  🐟 Total Mancing: ${user.fishCaught}
  🧬 Mutasi Ditemukan: ${user.mutationFound.length}
  🐠 Ikan Ditemukan: ${user.fishFound.length}
  🎒 Inventory: ${user.inventory.length} item
  👥 Teman: ${user.friends.length}

🕒 Akun dibuat: ${timeSince(user.createdAt)}
────────────────────────`;

    reply(msg);
}
break;

        case "addfriend": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!args[0]) return reply("⚠️ Gunakan: .addfriend <username atau ID>");

    const query = args.join(" ").toLowerCase();
    let target = null;

    if (/^\d{8}$/.test(query)) {
        const parsedId = parseInt(query);
        if (!isNaN(parsedId)) target = await Player.findOne({ id: parsedId });
    } else {
        target = await Player.findOne({ username: { $regex: query, $options: "i" } });
    }

    if (!target) return reply("❌ Player tidak ditemukan.");
    if (target.id === user.id) return reply("❌ Kamu tidak bisa menambahkan diri sendiri sebagai teman.");

    user.friends = user.friends || [];
    target.friends = target.friends || [];
    target.pendingFriends = target.pendingFriends || [];

    if (user.friends.includes(target.id))
        return reply(`⚠️ ${target.username} sudah menjadi temanmu.`);

    if (target.pendingFriends.includes(user.id))
        return reply(`⚠️ Kamu sudah mengirim permintaan teman ke ${target.username}.`);

    await Player.updateOne(
        { id: target.id },
        { $addToSet: { pendingFriends: user.id } }
    );

    reply(`✅ Permintaan teman ke *${target.username}* berhasil dikirim!`);

    // Notif Telegram ke target
    if (target.isVerifiedTelegram && target.telegramId) {
        await notifyTelegram(target.telegramId,
            `👥 *Permintaan pertemanan baru!*\n` +
            `*${user.username}* ingin berteman denganmu.\n` +
            `Ketik \`/acceptfriend ${user.username}\` untuk menerima.`
        );
    }
    break;
}

        case "f-accept": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!args[0]) return reply("⚠️ Gunakan: .f-accept <username atau ID>");

    const query = args.join(" ").toLowerCase();
    let target = null;

    if (/^\d{8}$/.test(query)) {
        const parsedId = parseInt(query);
        if (!isNaN(parsedId)) target = await Player.findOne({ id: parsedId });
    } else {
        target = await Player.findOne({ username: { $regex: query, $options: "i" } });
    }

    if (!target) return reply("❌ Player tidak ditemukan.");

    if (!user.pendingFriends || !user.pendingFriends.includes(target.id)) {
        return reply("❌ Tidak ada permintaan teman dari player tersebut.");
    }

    await Player.updateOne(
        { id: user.id },
        { $pull: { pendingFriends: target.id } }
    );

    await Player.updateOne(
        { id: user.id },
        { $addToSet: { friends: target.id } }
    );

    await Player.updateOne(
        { id: target.id },
        { $addToSet: { friends: user.id } }
    );

    reply(`✅ Kamu menerima permintaan teman dari *${target.username}*!`);
    break;
}

        case "f-decline": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (!args[0]) return reply("⚠️ Gunakan: .f-decline <username atau ID>");

    const query = args.join(" ").toLowerCase();
    let target = null;

    if (/^\d{8}$/.test(query)) {
        const parsedId = parseInt(query);
        if (!isNaN(parsedId)) target = await Player.findOne({ id: parsedId });
    } else {
        target = await Player.findOne({ username: { $regex: query, $options: "i" } });
    }

    if (!target) return reply("❌ Player tidak ditemukan.");

    if (!user.pendingFriends || !user.pendingFriends.includes(target.id)) {
        return reply("❌ Tidak ada permintaan teman dari player tersebut.");
    }

    await Player.updateOne(
        { id: user.id },
        { $pull: { pendingFriends: target.id } }
    );

    await Player.updateOne(
        { id: target.id },
        { $pull: { friendsRequestSent: user.id } }
    );

    reply(`❌ Kamu menolak permintaan teman dari *${target.username}*.`);
    break;
}

        case "delfriend": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (!args[0]) return reply("⚠️ Gunakan: .delfriend <username atau ID>");

    const query = args.join(" ").toLowerCase();
    let target = null;

    if (/^\d{8}$/.test(query)) {
        const parsedId = parseInt(query);
        if (!isNaN(parsedId)) target = await Player.findOne({ id: parsedId });
    } else {
        target = await Player.findOne({ username: { $regex: query, $options: "i" } });
    }

    if (!target) return reply("❌ Player tidak ditemukan.");
    if (!user.friends || !user.friends.includes(target.id))
        return reply("❌ Player tersebut bukan temanmu.");

    await Player.updateOne(
        { id: user.id },
        { $pull: { friends: target.id } }
    );
    await Player.updateOne(
        { id: target.id },
        { $pull: { friends: user.id } }
    );

    reply(`✅ Teman *${target.username}* berhasil dihapus.`);
    break;
}

        case "player": {
    if (!args[0]) return reply("⚠️ Gunakan: .player <ID atau username>");

    const query = args.join(" ").toLowerCase();
    let foundUsers = [];

    if (/^\d{8}$/.test(query)) {
        const parsedId = parseInt(query);
        if (!isNaN(parsedId)) {
            const found = await Player.findOne({ id: parsedId });
            if (found) foundUsers.push(found);
        }
    } else {
        foundUsers = await Player.find({
            username: { $regex: query, $options: "i" },
        });
    }

    if (foundUsers.length === 0) {
        const allPlayers = await Player.find({}, { username: 1, id: 1, money: 1, fishingRods: 1, fishCaught: 1, mutationFound: 1 });
        const candidates = allPlayers
            .map(u => ({
                user: u,
                score: similarity(u.username.toLowerCase(), query)
            }))
            .sort((a, b) => b.score - a.score);

        if (candidates[0] && candidates[0].score > 0.4) {
            foundUsers.push(candidates[0].user);
        }
    }

    if (foundUsers.length === 0) {
        return reply("❌ Player tidak ditemukan di database.");
    }

    const totalMutations = Object.keys(mutations).length;
    let text = "";

    for (const u of foundUsers) {
        const rodsOwned = (u.fishingRods instanceof Map ? [...u.fishingRods.keys()] : Object.keys(u.fishingRods || {})).join(", ") || "Tidak ada rod";
        const totalFishCaught = u.fishCaught || 0;
        const totalMutationsFound = u.mutationFound?.length || 0;

        text += `🎣 Username: ${u.username}\n` +
                `🆔 ID: ${u.id}\n` +
                `💰 Money: ${formatMoney(u.money || 0)}\n` +
                `🎣 Rod dimiliki: ${rodsOwned}\n` +
                `🐟 Total ikan ditangkap: ${totalFishCaught}\n` +
                `🧬 Mutasi ditemukan: ${totalMutationsFound}/${totalMutations}\n\n`;
    }

    reply(text.trim());
    break;
}

        case "requestfriends":
        case "rfriends": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!user || !user.pendingFriends || user.pendingFriends.length === 0) {
        return reply("⚠️ Kamu tidak memiliki permintaan teman yang tertunda.");
    }

    const pending = await Player.find({ id: { $in: user.pendingFriends } });

    if (pending.length === 0)
        return reply("⚠️ Tidak ditemukan data permintaan teman di database.");

    let text = "📨 Permintaan Teman Tertunda:\n\n";
    for (const p of pending) {
        text += `• ${p.username || "Tanpa Nama"} (ID: ${p.id}) 💰${formatMoney(p.money || 0)}\n`;
    }

    reply(text.trim());
    break;
}

        case "listfriend": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (!user || !user.friends || user.friends.length === 0) {
        return reply("⚠️ Kamu belum memiliki teman. Gunakan *!addfriend <username/ID>* untuk menambah teman!");
    }

    const friends = await Player.find({ id: { $in: user.friends } });

    if (friends.length === 0)
        return reply("⚠️ Tidak ditemukan data teman di database.");

    let friendText = `👥 *Daftar Teman ${user.username}* (${friends.length})\n${'─'.repeat(28)}\n`;
    friends.forEach((f, i) => {
        friendText += `\n${i+1}. 👤 *${f.username || "Tanpa Nama"}* [ID: ${f.id}]\n`;
        friendText += `   💰 ${formatMoney(f.money||0)} | 🌍 ${f.currentIsland||"mousewood"} | Lv.${f.level} | 🐟 ${f.fishCaught||0}x\n`;
        friendText += `   ↳ Lihat: *!player ${f.id}*\n`;
    });
    friendText += `${'─'.repeat(28)}`;
    reply(friendText);
    break;
}

        case "reset":
        case "resetme": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!user) return reply("❌ User tidak ditemukan.");

    await Player.updateMany(
        {},
        {
            $pull: {
                friends: user.id,
                pendingFriends: user.id
            }
        }
    );

    const oldId = user.id;
    const oldWhatsapp = user.whatsappNumber;
    const oldTelegramId = user.telegramId;

    user.set({
        username: await generateUniqueUsername(),
        money: 200,
        inventory: [],
        level: 1,
        exp: 0,
        expToNextLevel: 100,
        maxLevel: 2500,
        usedFishingRod: "basicrod",
        fishingRods: {
            basicrod: {
                name: "Basic Fishing Rod",
                type: "rod",
                luck: 0.00,
                speed: 0.00,
                comboFish: 1,
                comboMutations: 1,
                mutationsLuck: 0.000,
                sellMultiplier: 0.0,
                price: 0,
                enchant: null,
                bonusStats: {},
                description: "",
                level: 1,
                maxLevel: 5,
                exp: 0,
                expToNextLevel: 100,
                enchantCount: 0
            }
        },
        currentIsland: "mousewood",
        fishingPending: [],
        fishFound: [],
        mutationFound: [],
        friends: [],
        pendingFriends: [],
        travelFound: [],
        fishCaught: 0,
        isVerifiedTelegram: false,
        whatsappNumber: oldWhatsapp,
        telegramId: oldTelegramId,
        telegramUUID: null,
        telegramConnectID: null,
        id: oldId
    });

    await user.save();

    reply("✅ Akun kamu telah di-reset sepenuhnya! ID, akun terhubung, dan tanggal pembuatan akun tetap sama. Semua progress sudah direset.");
}
break;
        case "equip": {
  const user = await getOrCreateUser(senderNumber, null, pushname);

  if (!args[0])
    return reply("⚠️ Format: !equip <nama_rod>");

  const rodKey = args.join(" ").toLowerCase().replace(/\s+/g, '');

  if (!user.fishingRods || !user.fishingRods.get(rodKey))
    return reply("❌ Kamu belum memiliki pancingan ini.");

  user.usedFishingRod = rodKey;

  await user.save();

  const rod = user.fishingRods.get(rodKey); 
  reply(`🎣 Pancingan aktif kamu sekarang adalah *${rod.name}*!`);
}
break;

        case "buy": {
    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!args[0])
        return reply("⚠️ Format: !buy <nama_rod>");

    const rodKey = args[0].toLowerCase().replace(/\s+/g, '');
    const rodData = fishingRod[rodKey];

    if (!rodData)
        return reply("❌ Pancingan tidak ditemukan.");

    if (rodData.userSetting === "developer" && !isOwner)
        return reply("⚠️ Rod ini hanya bisa dibeli oleh developer bot!");

    if (rodData.price <= 0)
        return reply("❌ Pancingan ini tidak bisa dibeli.");

    if (!user.fishingRods) user.fishingRods = {};

    if (user.fishingRods[rodKey])
    return reply(`⚠️ Kamu sudah memiliki *${rodData.name}*.`);

    if (user.money < rodData.price)
        return reply(`💵 Kamu butuh ${formatMoney(rodData.price)} money untuk membeli ${rodData.name}.`);
        
        user.money -= rodData.price;
        
        if (!(user.fishingRods instanceof Map)) {
          user.fishingRods = new Map(Object.entries(user.fishingRods || {}));
        }
        
        user.fishingRods.set(rodKey, rodData);
        await user.save();
        
        reply(`✅ Berhasil membeli *${rodData.name}*! 🎣`);
}
break;

        case "shop": {
  const user = await getOrCreateUser(senderNumber, null, pushname);

  const rodsForSale = Object.entries(fishingRod)
    .filter(([_, rod]) => rod.price > 0 && rod.userSetting !== "developer")
    .sort((a, b) => a[1].price - b[1].price);

  if (rodsForSale.length === 0)
    return reply("❌ Tidak ada pancingan yang dijual saat ini.");

  const rows = rodsForSale.map(([key, rod]) => {
    const owned = user.fishingRods?.get(key);
    return {
        id: `buy_${key}`,
        title: `${owned ? "✅ " : ""}${rod.name}`,
        description: `💰 ${formatMoney(rod.price)} | 🍀 ${(rod.mutationsLuck*100).toFixed(2)}% | 🎯 ${(rod.luck*100).toFixed(1)}% | ⚡ ${(rod.speed*100).toFixed(1)}%`
    };
  });

  let shopText = `🛒 *Toko Fishing Rod*\n`;
  shopText += `💰 Saldo kamu: *${formatMoney(user.money)}*\n`;
  shopText += `✅ = sudah dimiliki\n${'─'.repeat(28)}\n`;
  rodsForSale.forEach(([key, rod], i) => {
    const owned = user.fishingRods?.get(key);
    shopText += `\n${owned ? '✅' : `${i+1}.`} *${rod.name}*\n`;
    shopText += `   💰 Harga: ${formatMoney(rod.price)}\n`;
    shopText += `   🍀 Luck: ${(rod.luck*100).toFixed(1)}% | ⚡ Speed: ${(rod.speed*100).toFixed(1)}%\n`;
    shopText += `   🧬 MutLuck: ${(rod.mutationsLuck*100).toFixed(3)}% | 💸 SellMult: x${(1+(rod.sellMultiplier||0)).toFixed(1)}\n`;
    shopText += `   🔺 Max Lv: ${rod.maxLevel} | Combo: ${rod.comboFish}🐟 ${rod.comboMutations}🧬\n`;
    if (!owned) shopText += `   ↳ Beli: *!buy ${key}*\n`;
  });
  shopText += `${'─'.repeat(28)}`;
  reply(shopText);
}
break;

        case "listenchant": {
    const enchantKeys = Object.keys(rodEnchants);
    if (enchantKeys.length === 0)
        return reply("⚠️ Belum ada enchant yang tersedia.");

    const RE = { common:"⚪",rare:"🟢",epic:"🔵",legendary:"🟡",mythic:"🟣",godly:"🌈",secret:"⚫" };
    const RORDER = ["common","rare","epic","legendary","mythic","godly","secret"];

    // Group by rarity
    const grouped = {};
    for (const key of enchantKeys) {
        const ench = rodEnchants[key];
        const r = ench.rarity || "common";
        if (!grouped[r]) grouped[r] = [];
        grouped[r].push({ key, ench });
    }

    let encText = `✨ *Daftar Enchantment* (${enchantKeys.length} total)\n${'─'.repeat(28)}\n`;
    for (const rarity of RORDER) {
        const grp = grouped[rarity];
        if (!grp) continue;
        encText += `\n${RE[rarity] || "❔"} *${rarity.toUpperCase()}*\n`;
        grp.forEach(({ key, ench }) => {
            const effStr = Object.entries(ench.effect || {}).map(([k, v]) => {
                let dv = typeof v === "number"
                    ? (v > 2 ? `${v}×` : v > 1 ? `+${((v-1)*100).toFixed(0)}%` : `${(v*100).toFixed(1)}%`)
                    : v;
                return `${k}:${dv}`;
            }).join(" | ");
            encText += `  • *${ench.name}* — ${ench.desc || ""}\n`;
            encText += `    💠 ${effStr}\n`;
        });
    }
    encText += `${'─'.repeat(28)}\n_Gunakan *!enchant* untuk memasang enchant ke rod aktifmu_`;
    reply(encText);
}
break;
  
        case "rename": {
  const user = await getOrCreateUser(senderNumber, null, pushname);

  if (!args[0])
    return reply(`⚠️ Format: *!rename <nama_baru>*\nContoh: !rename hann`);

  const newName = args.join(" ").trim().toLowerCase();

  if (newName.length < 3 || newName.length > 20)
    return reply("❌ Nama harus antara 3–20 karakter.");

  if (!/^[a-z0-9 ]+$/.test(newName))
    return reply("❌ Nama hanya boleh mengandung huruf kecil, angka, dan spasi.");

  const nameTaken = await Player.exists({ username: newName }); 
  if (nameTaken)
    return reply(`⚠️ Nama *${newName}* sudah dipakai pemain lain.\nSilakan pilih nama lain.`);

  const oldName = user.username || "Player";
  user.username = newName;

  await user.save(); 
  
  reply(`✅ Nama berhasil diganti!\n\n👤 *${oldName}* → *${newName}*`);
}
break;
  
        case "enchant": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const rodKey = user.usedFishingRod;
    const rod = user.fishingRods.get(rodKey);
    if (!rod) return reply("⚠️ Kamu belum memiliki fishing rod aktif!");

    rod.enchantCount = rod.enchantCount || 0;

    // Biaya enchant: berbasis harga rod × 0.5, naik eksponensial tiap re-enchant
    // Rod lebih mahal = biaya enchant lebih besar, tiap ulang makin mahal
    const rodBasePrice = fishingRod[rodKey]?.price || 25000;
    const enchantBase = Math.max(rodBasePrice * 0.5, 50000);
    const cost = Math.floor(enchantBase * Math.pow(2.2, rod.enchantCount));

    if (args[0] === "confirm") {
        if (user.money < cost)
            return reply(`💸 Uang kamu tidak cukup! Butuh ${formatMoney(cost)} money.`);

        // Luck & prestige mempengaruhi peluang rarity enchant lebih tinggi
        // luck: rod luck + upgrade luck (0–1.5+), prestige 0–5
        const upgStats = getUpgradedStats(user, rod);
        const totalLuck = Math.min(upgStats.luck || 0, 3.0); // cap 3x agar tidak rusak
        const prestigeBonus = Math.min((user.prestige || 0) * 2, 10); // max +10% dari prestige

        // Base chance tanpa luck: common 45, rare 25, epic 16, legendary 8, mythic 4, godly 1.5, secret 0.5
        // Luck mengurangi common/rare dan menaikkan epic ke atas
        const luckShift = totalLuck * 5; // 0–15% shift
        const rarityChances = [
            { rarity: "common",    chance: Math.max(45 - luckShift * 1.8, 10) },
            { rarity: "rare",      chance: Math.max(25 - luckShift * 0.8, 10) },
            { rarity: "epic",      chance: 16 + luckShift * 0.8 },
            { rarity: "legendary", chance: 8  + luckShift * 0.6 + prestigeBonus * 0.4 },
            { rarity: "mythic",    chance: 4  + luckShift * 0.3 + prestigeBonus * 0.3 },
            { rarity: "godly",     chance: 1.5 + luckShift * 0.08 + prestigeBonus * 0.2 },
            { rarity: "secret",    chance: 0.5 + luckShift * 0.02 + prestigeBonus * 0.1 },
        ];

        const totalWeight = rarityChances.reduce((s, r) => s + r.chance, 0);
        const roll = Math.random() * totalWeight;
        let selectedRarity;
        let cumulative = 0;
        for (const r of rarityChances) {
            cumulative += r.chance;
            if (roll <= cumulative) { selectedRarity = r.rarity; break; }
        }
        if (!selectedRarity) selectedRarity = "common";

        const possibleEnchants = Object.entries(rodEnchants)
            .filter(([_, e]) => e.rarity === selectedRarity);

        if (possibleEnchants.length === 0)
            return reply("⚠️ Tidak ada enchant dengan rarity itu!");

        const [randomKey, randomEnchant] =
            possibleEnchants[Math.floor(Math.random() * possibleEnchants.length)];

        const oldEnchant = rod.enchant ? rodEnchants[rod.enchant]?.name : null;

        rod.enchant = randomKey;
        rod.enchantCount++;
        user.money -= cost;

        user.markModified(`fishingRods.${rodKey}`);
        await user.save();

        return reply(
            `🔮 *Enchant Berhasil!*\n\n` +
            `🎣 Rod: ${rod.name}\n` +
            (oldEnchant ? `✨ Enchant lama: ${oldEnchant}\n` : ``) +
            `🌈 Enchant baru: *${randomEnchant.name}*\n` +
            `💎 Rarity: ${selectedRarity.toUpperCase()}\n` +
            `📜 Deskripsi: ${randomEnchant.desc}\n\n` +
            `💸 Biaya: ${formatMoney(cost)}\n` +
            `💰 Uang tersisa: ${formatMoney(user.money)}`
        );
    }

    // Preview peluang rarity berdasarkan luck saat ini
    const upgStats = getUpgradedStats(user, rod);
    const totalLuck = Math.min(upgStats.luck || 0, 3.0);
    const prestigeBonus = Math.min((user.prestige || 0) * 2, 10);
    const luckShift = totalLuck * 5;
    const previewChances = [
        { rarity: "common",    chance: Math.max(45 - luckShift * 1.8, 10) },
        { rarity: "rare",      chance: Math.max(25 - luckShift * 0.8, 10) },
        { rarity: "epic",      chance: 16 + luckShift * 0.8 },
        { rarity: "legendary", chance: 8  + luckShift * 0.6 + prestigeBonus * 0.4 },
        { rarity: "mythic",    chance: 4  + luckShift * 0.3 + prestigeBonus * 0.3 },
        { rarity: "godly",     chance: 1.5 + luckShift * 0.08 + prestigeBonus * 0.2 },
        { rarity: "secret",    chance: 0.5 + luckShift * 0.02 + prestigeBonus * 0.1 },
    ];
    const totalW = previewChances.reduce((s, r) => s + r.chance, 0);
    const chanceStr = previewChances.map(r => `  ${r.rarity.padEnd(10)}: ${(r.chance / totalW * 100).toFixed(1)}%`).join('\n');

    const nextCost = Math.floor(enchantBase * Math.pow(2.2, rod.enchantCount + 1));
    const currentEnchant = rod.enchant ? rodEnchants[rod.enchant] : null;
    reply(
        `🔮 *Info Enchant Rod*\n${'─'.repeat(28)}\n\n` +
        `🎣 Rod: *${rod.name}*\n` +
        `✨ Enchant sekarang: *${currentEnchant ? currentEnchant.name : "Tidak ada"}*\n` +
        `🔢 Enchant ke-: *${rod.enchantCount + 1}*\n\n` +
        `💰 Biaya: *${formatMoney(cost)}*\n` +
        `💵 Saldo: *${formatMoney(user.money)}*\n\n` +
        `🍀 Luck kamu (${(totalLuck * 100).toFixed(0)}%) memengaruhi peluang:\n` +
        `${chanceStr}\n\n` +
        `⚠️ Enchant bersifat *acak* — luck & prestige meningkatkan\n` +
        `   peluang rarity tinggi. Enchant lama akan *diganti*!\n` +
        `💡 Re-enchant berikutnya akan semakin mahal: *${formatMoney(nextCost)}*\n\n` +
        `${'─'.repeat(28)}\n` +
        `✅ Lanjut → ketik *!enchant confirm*\n` +
        `❌ Batal → abaikan pesan ini`
    );
}
break;

        case "scalemoney": {
    // Admin command: scale down uang semua player karena penurunan harga ikan
    // !scalemoney preview        → lihat preview tanpa apply
    // !scalemoney apply <factor> → apply scale (mis: 0.3 = ambil 30% dari uang sekarang)
    if (!isOwner && !isAdmin(senderNumber, m)) return;

    const factor = parseFloat(args[1]);

    if (args[0] === 'preview') {
        const players = await Player.find({}, 'username money').lean();
        const sample = players.slice(0, 10);
        let txt = `💰 *Preview scalemoney*\n`;
        txt += `Total player: ${players.length}\n`;
        txt += `Format: !scalemoney apply <faktor>\n`;
        txt += `Contoh: !scalemoney apply 0.25 → semua uang × 0.25\n\n`;
        txt += `Sample 10 player:\n`;
        for (const p of sample) {
            txt += `  ${p.username}: ${formatMoney(p.money)} → ${formatMoney(p.money * 0.25)} (×0.25)\n`;
        }
        return reply(txt);
    }

    if (args[0] === 'apply') {
        if (isNaN(factor) || factor <= 0 || factor >= 1)
            return reply('❌ Faktor harus antara 0 dan 1 (mis: 0.3)');

        reply(`⏳ Mengaplikasikan scale ×${factor} ke semua player...`);
        const players = await Player.find({});
        let count = 0;
        for (const p of players) {
            if ((p.money || 0) > 0) {
                p.money = Math.floor((p.money || 0) * factor);
                await p.save();
                count++;
            }
        }
        return reply(`✅ Selesai! ${count} player disesuaikan.\nUang semua player × ${factor}.`);
    }

    reply(
        `💰 *Scale Money Tool*\n━━━━━━━━━━━━━━━━━━━━\n` +
        `Digunakan setelah penurunan harga ikan agar saldo player\n` +
        `tetap proporsional dengan ekonomi baru.\n\n` +
        `*Perintah:*\n` +
        `  !scalemoney preview          → lihat sample\n` +
        `  !scalemoney apply <faktor>   → apply ke semua\n\n` +
        `*Contoh faktor:*\n` +
        `  0.4 → uang jadi 40% dari semula\n` +
        `  0.25 → uang jadi 25% dari semula\n\n` +
        `⚠️ Tidak bisa di-undo! Pastikan preview dulu.`
    );
    break;
}

        case "refreshall": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;

    reply("🔄 Sedang melakukan refresh semua data player Fisch di MongoDB...");

    const players = await Player.find({});
    let refreshedCount = 0;

    for (const player of players) {
        const oldRods = player.fishingRods || {};
        const newRods = {};

        for (const rodKey in oldRods) {
            if (fishingRod[rodKey]) {
                newRods[rodKey] = {
                    ...fishingRod[rodKey],
                    enchant: oldRods[rodKey].enchant ?? null,
                    exp: oldRods[rodKey].exp ?? 0,
                    enchantCount: oldRods[rodKey].enchantCount ?? 0,
                };
            }
        }

        for (const rodKey in fishingRod) {
            if (!newRods[rodKey]) {
                // Jangan kasih rod khusus (level2500, developer, dll) ke semua player
                const rodDef = fishingRod[rodKey];
                if (rodDef.userSetting && rodDef.userSetting !== 'normal') continue;
                newRods[rodKey] = { ...rodDef };
            }
        }

        await Player.updateOne(
            { id: player.id },
            {
                $set: {
                    username: player.username,
                    money: player.money ?? 200,
                    fishingRods: newRods,
                    usedFishingRod: player.usedFishingRod ?? "basicrod",
                    currentIsland: player.currentIsland ?? "mousewood",
                    inventory: Array.isArray(player.inventory) ? player.inventory : [],
                    level: player.level ?? 1,
                    exp: player.exp ?? 0,
                    expToNextLevel: player.expToNextLevel ?? 100,
                    maxLevel: player.maxLevel ?? 2500,
                    fishingPending: Array.isArray(player.fishingPending) ? player.fishingPending : [],
                    fishFound: Array.isArray(player.fishFound) ? player.fishFound : [],
                    mutationFound: Array.isArray(player.mutationFound) ? player.mutationFound : [],
                    createdAt: player.createdAt || Date.now(),
                    friends: Array.isArray(player.friends) ? player.friends : [],
                    pendingFriends: Array.isArray(player.pendingFriends) ? player.pendingFriends : [],
                    travelFound: Array.isArray(player.travelFound) ? player.travelFound : ["mousewood"],
                    fishCaught: player.fishCaught ?? 0,
                    isVerifiedTelegram: player.isVerifiedTelegram ?? false,
                    whatsappNumber: player.whatsappNumber ?? null,
                    telegramId: player.telegramId ?? null,
                    telegramUUID: player.telegramUUID ?? null,
                    telegramConnectID: player.telegramConnectID ?? null,
                },
            }
        );

        refreshedCount++;
    }

    reply(`✅ Refresh MongoDB selesai!\n🎣 Total player diperbarui: *${refreshedCount}*`);
}
break;
  
        case "mancing":
        case "fish": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const rod = user.fishingRods.get(user.usedFishingRod);
    if (!rod) return reply("❌ Kamu belum punya fishing rod! Beli dulu di *!shop*");

    const now   = Date.now();
    const island = user.currentIsland || "mousewood";
    const islandData = islands[island];
    let pending = user.fishingPending.find(p => p.sender === senderNumber);

    // Cek apakah pending sudah expired (ikan lepas diam-diam)
    if (pending && pending.expiresAt && now >= Number(pending.expiresAt)) {
        // Atomic update — hindari VersionError saat request bersamaan
        await Player.findOneAndUpdate(
            { _id: user._id },
            { $pull: { fishingPending: { sender: senderNumber } } }
        );
        user.fishingPending = user.fishingPending.filter(p => p.sender !== senderNumber);
        pending = null;
    }

    // Sudah ada tangkapan siap
    if (pending && now >= pending.readyAt) {
        return reply(
            `🐟 *Ikan Sudah Menggigit!*\n` +
            `🏝️ Pulau: *${islandData?.name || island}*\n` +
            `🌦️ Cuaca: ${CURRENT_WEATHER.name}\n\n` +
            `Ikanmu siap diambil!\n` +
            `Ketik *!view* untuk mengambil tangkapanmu!\n` +
            `🎯 Atau *!reel* sekarang untuk Perfect Catch Bonus!`
        );
    }

    // Masih mancing
    if (pending) {
        const remaining = ((pending.readyAt - now) / 1000).toFixed(1);
        const streak = FISHING_STREAKS.get(senderNumber) || 0;
        const streakTxt = streak >= 3 ? `\n🔥 Streak: *${streak}x*` : '';
        return reply(
            `🎣 *Sedang Memancing...*\n` +
            `🏝️ Pulau: *${islandData?.name || island}*\n` +
            `🌦️ Cuaca: ${CURRENT_WEATHER.name}\n` +
            `🎣 Rod: *${rod.name}*${streakTxt}\n\n` +
            `⏳ Tunggu *${remaining} detik* lagi.\n` +
            `Ketik *!reel* tepat saat ikan menggigit untuk bonus!`
        );
    }

    // Cek island cooldown
    const cdSec = ISLAND_COOLDOWNS[island] || 0;
    if (cdSec > 0) {
        const lastFish = (user.islandCooldowns || {})[island] || 0;
        const cdLeft   = Math.ceil((lastFish + cdSec * 1000 - now) / 1000);
        if (cdLeft > 0) {
            return reply(
                `⏰ *Cooldown Pulau ${islandData?.name}*\n\n` +
                `Kamu baru saja mancing di sini.\n` +
                `Tunggu *${cdLeft} detik* sebelum mancing lagi.\n\n` +
                `💡 Sementara coba pindah pulau dengan *!travel*`
            );
        }
    }

    // Hitung waktu tunggu dengan cuaca
    const baseWait = 1000 * (5 + Math.random() * 7);
    const enchant  = (rod.enchant && rodEnchants[rod.enchant]?.effect) ? rodEnchants[rod.enchant] : null;
    let waitMultiplier = 1;
    if (enchant?.effect?.lureSpeed)     waitMultiplier /= enchant.effect.lureSpeed;
    if (enchant?.effect?.progressSpeed) waitMultiplier /= enchant.effect.progressSpeed;
    // Cuaca mempengaruhi speed
    waitMultiplier /= (CURRENT_WEATHER.speedMult || 1);

    const waitTime = Math.max(3000, baseWait * (1 - Math.min(rod.speed, 0.95)) * waitMultiplier);

    // Pre-generate rarity untuk tentukan expiresAt
    // Jangan panggil getRandomFish kalau ada forced rarity — nanti ke-consume sebelum !view
    let escapeMs = 30000;
    let upgStatsPreview = getUpgradedStats(user, rod);
    upgStatsPreview.luck = 1.0 + (upgStatsPreview.luck || 0) + ((CURRENT_WEATHER.luckMult || 1) - 1);
    let previewFish = null;
    const previewFishes = []; // untuk multi-combo preview
    const hasForcedRarity = FORCED_RARITY.has(senderNumber) ||
        FORCED_RARITY.has(user.whatsappNumber) ||
        FORCED_RARITY.has(String(user.id));
    if (hasForcedRarity) {
        const forcedR = FORCED_RARITY.get(senderNumber) ||
            FORCED_RARITY.get(user.whatsappNumber) ||
            FORCED_RARITY.get(String(user.id));
        escapeMs = RARITY_ESCAPE_TIME[forcedR] || 30000;
        previewFishes.push({ rarity: forcedR });
    } else {
        const comboCount = Math.min(rod.comboFish || 1, 3);
        for (let pi = 0; pi < comboCount; pi++) {
            const pf = getRandomFish({ ...rod, ...upgStatsPreview, baseLuck: 1.0 }, island);
            previewFishes.push(pf);
        }
        previewFish = previewFishes[0];
        escapeMs = RARITY_ESCAPE_TIME[previewFish.rarity] || 30000;
    }

    // Cari JID @s.whatsapp.net dari groupMetadata untuk mention yang benar
    let mentionableJid = rawSender;
    if (isGroup && rawSender.endsWith('@lid')) {
        try {
            const meta = await client.groupMetadata(from).catch(() => null);
            const lid = rawSender.split('@')[0];
            const found = meta?.participants?.find(p =>
                p.lid === rawSender || (p.lid || '').split('@')[0] === lid
            );
            if (found?.id?.includes('@s.whatsapp.net')) mentionableJid = found.id;
            else if (found?.phoneNumber) mentionableJid = `${String(found.phoneNumber).replace(/\D/g, '')}@s.whatsapp.net`;
        } catch (_) {}
    } else if (!rawSender.includes('@')) {
        mentionableJid = `${rawSender}@s.whatsapp.net`;
    }

    // Setup reel minigame window — waktu asli disembunyikan, kasih hint palsu ±1-2 detik
    const fakeOffset = (Math.random() < 0.5 ? -1 : 1) * (1000 + Math.random() * 1000); // ±1-2 detik
    const fakeWaitTime = Math.max(2000, waitTime + fakeOffset);
    createReelWindow(senderNumber, user.usedFishingRod, island, now + waitTime, m.chat, client, escapeMs, m, mentionableJid);

    user.fishingPending.push({
        sender: senderNumber,
        start: now,
        readyAt: now + waitTime,
        expiresAt: now + waitTime + escapeMs,
        escapeMs,
        rod: user.usedFishingRod,
        island,
        weather: CURRENT_WEATHER.key,
        fishes: previewFishes.filter(pf => pf.name), // simpan preview fish (bila sudah generate penuh)
        comboFish: rod.comboFish,
        messageKey: m.key || null,
        forcedRarity: user.forcedRarity || null
    });

    // Reset forcedRarity di DB setelah disimpan ke pending
    // Atomic update — hindari VersionError saat request bersamaan
    const _newPending = {
        sender: senderNumber,
        start: now,
        readyAt: now + waitTime,
        expiresAt: now + waitTime + escapeMs,
        escapeMs,
        rod: user.usedFishingRod,
        island,
        weather: CURRENT_WEATHER.key,
        fishes: previewFishes.filter(pf => pf.name),
        comboFish: rod.comboFish,
        messageKey: m.key || null,
        forcedRarity: user.forcedRarity || null
    };
    const _fishUpdateOp = { $push: { fishingPending: _newPending } };
    if (user.forcedRarity) {
        _fishUpdateOp.$set = { forcedRarity: null };
        user.forcedRarity = null;
    }
    await Player.findOneAndUpdate({ _id: user._id }, _fishUpdateOp, { new: false });

    // Cuaca & streak info
    const streak = FISHING_STREAKS.get(senderNumber) || 0;
    const streakBonus = getStreakBonus(streak);
    const streakTxt = streak >= 3 ? `\n🔥 Streak: *${streak}x* (Sell ×${streakBonus.mult.toFixed(2)})` : '';
    const weatherTxt = CURRENT_WEATHER.key !== 'sunny' ? `\n*Cuaca: ${CURRENT_WEATHER.name}*\n   ${CURRENT_WEATHER.desc}` : '';
    const enchantInfo = enchant ? ` ✨${enchant.name}` : '';

    const RARITY_EMOJI = {
        common:'⬜', uncommon:'🟩', rare:'🟦', epic:'🟪',
        legendary:'🟨', mythic:'🌸', godly:'🌟', exotic:'🍊',
        secret:'🖤', relic:'🏺', fragment:'🔷', gemstone:'💎',
        extinct:'🦕', limited:'🎫', apex:'👑', cataclysmic:'🌋', special:'✨'
    };
    // Tampilkan rarity hint untuk tiap ikan (sesuai combo count)
    let rarityHint;
    if (previewFishes.length === 1) {
        const r = previewFishes[0].rarity;
        rarityHint = `🎯 Rarity: ${RARITY_EMOJI[r] || '❓'} *${r}*\n`;
    } else {
        const rarLines = previewFishes.map((pf, i) =>
            `   ${i+1}. ${RARITY_EMOJI[pf.rarity] || '❓'} *${pf.rarity}*`
        ).join('\n');
        rarityHint = `🎯 Rarity Preview (${previewFishes.length} ikan):\n${rarLines}\n`;
    }

    const caption =
        `🎣 *Mulai Memancing!*\n${'─'.repeat(28)}\n\n` +
        `🏝️ Pulau: *${islandData?.name || island}*\n` +
        `🎣 Rod: *${rod.name}${enchantInfo}*\n` +
        `🍀 Luck: ${((upgStatsPreview.luck||1)*100).toFixed(1)}%${GLOBAL_LUCK_EVENT.active && Date.now() < GLOBAL_LUCK_EVENT.endTime ? ` (×${GLOBAL_LUCK_EVENT.multiplier} 🍀EVENT!)` : ""} | ⚡ Speed: ${(Math.min((upgStatsPreview.speed||0), 0.98)*100).toFixed(1)}%` +
        weatherTxt + streakTxt + `\n\n` +
        rarityHint +
        `⏳ Ikan menggigit dalam *~${(fakeWaitTime/1000).toFixed(1)} detik*\n` +
        `🔔 Bot akan notif saat ikan gigit — siap *!reel* secepat mungkin!\n` +
        `Atau *!view* untuk ambil hasil.`;

    if (islandData?.image) {
        await client.sendMessage(m.chat, {
            image: { url: islandData.image },
            caption,
            mimetype: "image/jpeg"
        }, { quoted: m });
    } else {
        reply(caption);
    }
}
break;

        case "travel": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (!Array.isArray(user.travelFound)) user.travelFound = [];

    if (!args[0]) {
        const islandKeys = Object.keys(islands);
        const unlockedRows = [];
        const lockedRows = [];

        for (const isle of islandKeys) {
            const unlocked = user.travelFound.includes(isle) || isle === "mousewood";
            const isCurrent = user.currentIsland === isle;
            const displayName = islands[isle]?.name || isle;
            const req = travelRequirements?.[isle];
            const row = {
                id: `travel_${isle}`,
                title: `${isCurrent ? "📍 " : unlocked ? "✅ " : "🔒 "}${displayName}`,
                description: isCurrent
                    ? "Lokasi kamu saat ini"
                    : unlocked
                        ? `Ketik .travel ${isle} untuk pergi`
                        : req ? `Butuh 💰${formatMoney(req.money)} & 🎣${req.fish}x mancing` : "Belum tersedia"
            };
            if (unlocked) unlockedRows.push(row);
            else lockedRows.push(row);
        }

        const sections = [];
        if (unlockedRows.length > 0) sections.push({ title: "✅ Pulau Terbuka", rows: unlockedRows });
        if (lockedRows.length > 0) sections.push({ title: "🔒 Pulau Terkunci", rows: lockedRows });

        let travelText = `🧭 *Travel Menu*\n`;
        travelText += `📍 Saat ini: *${islands[user.currentIsland]?.name || user.currentIsland}*\n`;
        travelText += `${'─'.repeat(28)}\n`;
        if (unlockedRows.length > 0) {
            travelText += `\n✅ *Pulau Terbuka*\n`;
            unlockedRows.forEach(r => {
                const key = r.id.replace('travel_', '');
                const isCur = key === user.currentIsland;
                travelText += `  ${isCur ? '📍' : '•'} *${islands[key]?.name || key}*`;
                if (!isCur) travelText += ` → *!travel ${key}*`;
                travelText += `\n`;
            });
        }
        if (lockedRows.length > 0) {
            travelText += `\n🔒 *Pulau Terkunci*\n`;
            lockedRows.forEach(r => {
                const key = r.id.replace('travel_', '');
                const req = travelRequirements?.[key];
                travelText += `  🔒 *${islands[key]?.name || key}*\n`;
                if (req) travelText += `     💰 ${formatMoney(req.money)} | 🎣 ${req.fish}x mancing\n`;
            });
        }
        travelText += `${'─'.repeat(28)}\n_Gunakan *!travel <nama_pulau>* untuk pindah_`;
        return reply(travelText);
    }

    const target = args[0].toLowerCase().replace(/[_\s]/g, '');
    if (!islands[target]) return reply(`❌ Pulau *${target}* tidak ditemukan!`);

    if (user.currentIsland === target)
        return reply(`⚠️ Kamu sudah berada di *${islands[target].name}*!`);

    if (user.travelFound.includes(target) || target === "mousewood") {
        user.currentIsland = target;
        await Player.updateOne(
            { id: user.id },
            { $set: { currentIsland: target } }
        );

        return reply(
            `🛶 Kamu berlayar ke *${islands[target].name}*!\n\n` +
            (target !== "mousewood" ? `🎣 Sekarang kamu bisa memancing ikan khas pulau ini!` : "")
        );
    }

    const req = travelRequirements[target];
    if (!req)
        return;

    if (user.money < req.money || (user.fishCaught || 0) < req.fish) {
        return reply(
            `🔒 Kamu belum memenuhi syarat untuk menuju *${islands[target].name}*.\n\n` +
            `Syarat yang dibutuhkan:\n` +
            `💰 ${formatMoney(req.money)} money\n` +
            `🎣 Mancing minimal ${req.fish} kali\n\n` +
            `Kamu saat ini:\n💵 ${formatMoney(user.money)} money\n🐟 ${user.fishCaught || 0} kali`
        );
    }

    user.money -= req.money;
    user.travelFound.push(target);
    user.currentIsland = target;

    await Player.updateOne(
        { id: user.id },
        {
            $set: {
                money: user.money,
                currentIsland: user.currentIsland,
                travelFound: user.travelFound
            }
        }
    );

    return reply(
        `🔥 Selamat! Kamu berhasil membuka akses ke pulau baru *${islands[target].name}*! 🎉\n\n` +
        `💸 Uang kamu berkurang ${formatMoney(req.money)} money.\n` +
        `🛶 Selamat datang di *${islands[target].name}*! Kamu bisa mulai memancing di sini.`
    );
}
break;

        case "mutationbook":
        case "mb": {
    const user = await getOrCreateUser(senderNumber, null, pushname); 
    
    if (!user.mutationFound) user.mutationFound = [];

    let text = `🧬 *Mutation Book*\n\n`;
    text += `Daftar mutasi ikan yang sudah kamu temukan:\n\n`;

    const totalMutations = Object.keys(mutations).length;
    let ownedCount = 0;

    for (const [mutationName, mutationData] of Object.entries(mutations)) {
        const owned = user.mutationFound.includes(mutationName);
        const mark = owned ? "✅" : "❌";
        text += `${mark} ${mutationName} — 💥 ×${mutationData.multiplier}\n`;
        if (owned) ownedCount++;
    }

    text += `\n🎯 ${ownedCount}/${totalMutations} mutasi sudah kamu temukan!`;

    await reply(text);
}
break;

        case "fishbook":
        case "fb": {
    const user = await getOrCreateUser(senderNumber, null, pushname); 
    
    if (!user.fishFound) user.fishFound = [];

    let text = `📖 *Fish Book*\n\n`;
    text += `Daftar ikan yang sudah kamu temukan di semua pulau:\n\n`;

    let totalFish = 0;
    let ownedCount = 0;

    for (const [islandName, islandData] of Object.entries(islands)) {
        text += `🏝️ *${islandName.charAt(0).toUpperCase() + islandName.slice(1)}*\n`;

        for (const fish of islandData.listFish) {
            const owned = user.fishFound.includes(fish.name);
            const mark = owned ? "✅" : "❌";
            text += `${mark} ${fish.name} (${fish.rarity})\n`;
            totalFish++;
            if (owned) ownedCount++;
        }

        text += "\n";
    }

    text += `🎯 ${ownedCount}/${totalFish} ikan sudah kamu temukan!`;

    await reply(text);
}
break;

        case "top":
        case "leaderboard": {
  const allPlayers = await Player.find({});
  if (!allPlayers.length) return reply("📊 Belum ada data pemain.");

  const user = await getOrCreateUser(senderNumber, null, pushname);

  const sortedMoney = allPlayers
    .filter(p => p.money != null)
    .sort((a, b) => (b.money || 0) - (a.money || 0));

  const rankMoney =
    sortedMoney.findIndex(p => p.id === user.id) + 1 || allPlayers.length;

  let textTop = `🏆 *Leaderboard Pemancing Terkaya*\n\n`;
  sortedMoney.slice(0, 10).forEach((u, i) => {
    textTop += `${i + 1}. ${u.username} — 💵 ${formatMoney(u.money || 0)}\n`;
  });
  textTop += `\n📍 Posisi kamu (uang): #${rankMoney}/${allPlayers.length}\n\n`;
  
  const sortedFish = allPlayers
    .filter(p => p.fishCaught != null)
    .sort((a, b) => (b.fishCaught || 0) - (a.fishCaught || 0));

  const rankFish =
    sortedFish.findIndex(p => p.id === user.id) + 1 || allPlayers.length;

  textTop += `🎣 *Leaderboard Pemancing Mania*\n\n`;
  sortedFish.slice(0, 10).forEach((u, i) => {
    textTop += `${i + 1}. ${u.username} — 🎣 ${u.fishCaught || 0} kali mancing\n`;
  });
  textTop += `\n📍 Posisi kamu (mancing): #${rankFish}/${allPlayers.length}\n\n`;

  const sortedLevel = allPlayers
    .filter(p => p.level != null)
    .sort((a, b) => (b.level || 0) - (a.level || 0));

  const rankLevel =
    sortedLevel.findIndex(p => p.id === user.id) + 1 || allPlayers.length;

  textTop += `🧠 *Leaderboard Level Tertinggi*\n\n`;
  sortedLevel.slice(0, 10).forEach((u, i) => {
    textTop += `${i + 1}. ${u.username} — 🧍 Level ${u.level || 1}\n`;
  });
  textTop += `\n📍 Posisi kamu (level): #${rankLevel}/${allPlayers.length}`;

  reply(textTop);
}
break;

        case "view": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const rodKey = user.usedFishingRod;
    const rod    = mapGet(user.fishingRods, rodKey) || mapGet(user.fishingRods, 'basicrod');
    if (!rod) return reply('❌ Rod aktif tidak ditemukan. Data akun sudah diperbaiki, coba lagi.');
    let pending  = user.fishingPending.find(p => p.sender === senderNumber);
    const now    = Date.now();

    // Cek expired — ikan lepas
    if (pending && pending.expiresAt && now >= Number(pending.expiresAt)) {
        // Atomic update — hindari VersionError saat request bersamaan
        await Player.findOneAndUpdate(
            { _id: user._id },
            { $pull: { fishingPending: { sender: senderNumber } } }
        );
        return reply("🐟 Ikanmu kabur! Terlalu lama tidak diambil.\nKirim *!mancing* untuk coba lagi.");
    }

    if (!pending) return reply("❌ Kamu belum memancing. Kirim *!mancing* dulu!");

    if (now < pending.readyAt) {
        const remaining = ((pending.readyAt - now) / 1000).toFixed(0);
        return reply(
            `⏳ *Belum Menggigit!*\n\n` +
            `🐟 Ikan masih berenang... tunggu *${remaining} detik* lagi.\n` +
            `🎯 Kirim *!reel* tepat saat ikan menggigit untuk Perfect Catch!`
        );
    }

    // Generate ikan dengan semua sistem baru
    const totalFish  = Math.min(pending.comboFish || rod.comboFish || 1, 3);
    const results    = [];
    const weather    = WEATHERS[pending.weather] || CURRENT_WEATHER;
    const streak     = FISHING_STREAKS.get(senderNumber) || 0;
    const streakBon  = getStreakBonus(streak);
    let rareFishThisSession = 0;

    // Resolve forced rarity SEKALI di luar loop
    let resolvedForcedRarity = null;
    if (pending.forcedRarity) {
        resolvedForcedRarity = pending.forcedRarity;
        pending.forcedRarity = null;
    } else if (FORCED_RARITY.has(senderNumber)) {
        resolvedForcedRarity = FORCED_RARITY.get(senderNumber);
        FORCED_RARITY.delete(senderNumber);
    }

    for (let i = 0; i < totalFish; i++) {
        const upgStats = getUpgradedStats(user, rod);
        upgStats.luck = 1.0 + (upgStats.luck || 0) + ((weather.luckMult || 1) - 1) + (streakBon.luckAdd || 0); // base 1.0
        // Apply global luck event kalau aktif
        if (GLOBAL_LUCK_EVENT.active) {
            if (Date.now() < GLOBAL_LUCK_EVENT.endTime) {
                upgStats.luck = upgStats.luck * GLOBAL_LUCK_EVENT.multiplier;
            } else {
                GLOBAL_LUCK_EVENT.active = false; // expired, matiin otomatis
            }
        }
        const rodEff  = { ...rod, ...upgStats, baseLuck: 1.0, luck: upgStats.luck }; // use upgStats.luck, not rod.luck directly
        // Forced rarity hanya untuk ikan pertama
        if (i === 0 && resolvedForcedRarity) {
            rodEff._forcedRarity = resolvedForcedRarity;
        }
        // Gunakan pre-generated fish dari pending.fishes kalau ada (rarity konsisten dengan !mancing preview)
        let fish;
        if (pending.fishes && pending.fishes[i] && pending.fishes[i].name && !resolvedForcedRarity) {
            fish = { ...pending.fishes[i] };
            // Harga preview dari !mancing sudah dihitung oleh getRandomFish().
            // Jangan kalikan rod/golden multiplier lagi di !view supaya tidak double count.
            fish.price = Math.round(Number(fish.price) || 0);
        } else {
            // Ikan ke-2/3 tidak ikut consume senderNumber forced rarity
            fish = getRandomFish(rodEff, pending.island || "mousewood", false, i === 0 ? null : null);
        }

        // Fish Condition
        const condition = rollFishCondition();
        if (condition.id !== 'normal') {
            fish.condition = condition;
            fish.price = Math.round(fish.price * condition.priceBonus);
            fish.conditionLabel = condition.label;
        }

        // Streak sell bonus
        fish.price = Math.round(fish.price * streakBon.mult);

        // Cuaca rarity boost
        if (weather.rarityBoost?.[fish.rarity]) {
            fish.price = Math.round(fish.price * weather.rarityBoost[fish.rarity]);
        }

        // Perfect catch bonus — simpan di fish untuk dipakai saat !jual
        if (pending.perfectCatch && pending.perfectBonus) {
            fish.perfectBonus = pending.perfectBonus;
        }

        fish.id = generateId();
        results.push(fish);
        user.inventory.push(fish);

        if (!user.fishFound.includes(fish.name)) user.fishFound.push(fish.name);

        // Track biggest fish
        if (!user.biggestFish || fish.kg > user.biggestFish.kg) {
            user.biggestFish = { name: fish.name, kg: fish.kg, price: fish.price, date: new Date() };
        }

        // Track rare fish
        const rareRarities = ['rare','epic','legendary','mythic','godly','secret','extinct'];
        if (rareRarities.includes(fish.rarity)) {
            user.rareFishCaught = (user.rareFishCaught || 0) + 1;
            rareFishThisSession++;
        }

        // Track mutationFound
        if (fish.isMutated) {
            for (const mut of fish.mutations) {
                if (mut !== 'Normal' && !user.mutationFound.includes(mut)) {
                    user.mutationFound.push(mut);
                }
            }
        }
    }

    user.fishingPending = user.fishingPending.filter(p => p.sender !== senderNumber);
    // Cancel timer kabur karena ikan sudah diambil
    if (ESCAPE_TIMERS.has(senderNumber)) {
        clearTimeout(ESCAPE_TIMERS.get(senderNumber));
        ESCAPE_TIMERS.delete(senderNumber);
    }
    user.fishCaught     = (user.fishCaught || 0) + results.length;

    // Update island cooldown
    if (!user.islandCooldowns) user.islandCooldowns = {};
    user.islandCooldowns[pending.island] = now;
    user.markModified('islandCooldowns');

    // Consume bait
    const usedBait = (user.inventory || []).find(i => i.type === 'bait');
    if (usedBait) {
        const bIdx = user.inventory.findIndex(i => i.type === 'bait' && i.itemId === usedBait.itemId);
        if (bIdx > -1) user.inventory.splice(bIdx, 1);
    }

    // Season points
    for (const fish of results) { addSeasonPoints(user, fish); }

    // Event multiplier
    const eventMult   = ACTIVE_EVENT.active ? ACTIVE_EVENT.multiplier : 1;
    const weatherMult = 1; // sudah diapply per ikan
    const perfectMult = (pending.perfectCatch && pending.perfectBonus) ? pending.perfectBonus : 1;
    const totalValue  = results.reduce((a, b) => a + (isNaN(b.price) ? 0 : b.price), 0);
    const totalMoney  = Math.floor((isNaN(totalValue) ? 0 : totalValue) * eventMult * perfectMult);

    // EXP flat per rarity — tidak bergantung harga ikan
    const RARITY_EXP = {
        common: { rod: 10, player: 15 },
        uncommon: { rod: 20, player: 25 },
        rare: { rod: 35, player: 45 },
        epic: { rod: 55, player: 70 },
        legendary: { rod: 80, player: 100 },
        mythic: { rod: 110, player: 140 },
        godly: { rod: 150, player: 190 },
        exotic: { rod: 200, player: 250 },
        secret: { rod: 260, player: 320 },
        relic: { rod: 330, player: 400 },
        fragment: { rod: 400, player: 480 },
        gemstone: { rod: 480, player: 570 },
        extinct: { rod: 560, player: 660 },
        limited: { rod: 640, player: 750 },
        apex: { rod: 730, player: 850 },
        cataclysmic: { rod: 830, player: 960 },
        special: { rod: 950, player: 1100 }
    };
    const expGainRod    = results.reduce((a, f) => a + (RARITY_EXP[f.rarity]?.rod    || 10), 0);
    const expGainPlayer = results.reduce((a, f) => a + (RARITY_EXP[f.rarity]?.player || 15), 0);

    // Update total earned
    user.totalEarned = (user.totalEarned || 0) + totalMoney;

    // Update streak
    const allNonCommon = results.every(f => f.rarity !== 'common');
    if (allNonCommon && results.length > 0) {
        FISHING_STREAKS.set(senderNumber, streak + results.length);
    } else {
        FISHING_STREAKS.set(senderNumber, 0);
    }
    const newStreak = FISHING_STREAKS.get(senderNumber) || 0;

    // Check achievements
    const newAchs = await checkAchievements(user, {
        fish: results[0],
        weather: pending.weather,
        moonlight: pending.weather === 'moonlight'
    });

    const levelUpRodMsg    = await addRodExp(user, rodKey, expGainRod);
    const levelUpPlayerMsg = addPlayerExp(user, expGainPlayer);

    // World boss attack saat view
    let bossMsg = '';
    if (activeWorldBoss) {
        const bossResult = await attackWorldBoss(user, client, from);
        if (bossResult) {
            bossMsg = bossResult.bossKilled
                ? `\n\n⚔️ *${activeWorldBoss?.name || 'Boss'} DIKALAHKAN!* (dmg: ${formatMoney(bossResult.dmg)})`
                : `\n\n⚔️ Seranganmu ke ${activeWorldBoss.name}: *${formatMoney(bossResult.dmg)} dmg* | HP: ${formatMoney(activeWorldBoss.hp)}/${formatMoney(activeWorldBoss.maxHp)}`;
        }
    }

    // Atomic update — hindari VersionError saat request bersamaan
    await Player.findOneAndUpdate(
        { _id: user._id },
        {
            $set: {
                money:             user.money,
                inventory:         user.inventory,
                fishFound:         user.fishFound,
                mutationFound:     user.mutationFound,
                fishCaught:        user.fishCaught,
                totalEarned:       user.totalEarned,
                level:             user.level,
                exp:               user.exp,
                expToNextLevel:    user.expToNextLevel,
                seasonPoints:      user.seasonPoints,
                rareFishCaught:    user.rareFishCaught,
                biggestFish:       user.biggestFish,
                perfectCatches:    user.perfectCatches,
                achievements:      user.achievements,
                achievementPoints: user.achievementPoints,
                islandCooldowns:   user.islandCooldowns,
                fishingRods:       Object.fromEntries(user.fishingRods),
                activeBoosts:      user.activeBoosts,
            },
            $pull: { fishingPending: { sender: senderNumber } },
        },
        { new: false }
    );

    // Format output
    const RARITY_EMOJI = {
        common:'⚪',uncommon:'🟢',rare:'💚',epic:'💙',legendary:'💛',
        mythic:'🟣',godly:'🌟',secret:'⚫',extinct:'🦕',special:'✨',exotic:'🟠'
    };

    const fishListText = results.map(f => {
        const mutText = (f.mutations?.length && f.mutations[0] !== 'Normal')
            ? ` [${f.mutations.join(', ')}]` : '';
        const condText = f.conditionLabel ? ` ${f.conditionLabel}` : '';
        const emoji = RARITY_EMOJI[f.rarity] || '🐟';
        return `${emoji} *${f.name}*${condText} _(${f.rarity})_${mutText}\n` +
               `   ⚖️ ${f.kg}kg × 💰${formatMoney(f.pricePerKg)}/kg = 💵 *${formatMoney(f.price)}*`;
    }).join('\n\n');

    const enchantText   = rod.enchant ? ` ✨ ${rodEnchants[rod.enchant]?.name || rod.enchant}` : '';
    const weatherText   = weather.key !== 'sunny' ? `\n🌦️ Cuaca: ${weather.name}` : '';
    const streakText    = newStreak >= 3 ? `\n🔥 Streak: *${newStreak}x* (Sell ×${getStreakBonus(newStreak).mult.toFixed(2)})` : '';
    const eventText     = ACTIVE_EVENT.active ? `\n🎪 Event Bonus: *×${eventMult}*` : '';
    const perfectText   = (pending.perfectCatch && pending.perfectBonus)
        ? `\n🎯 Perfect Catch Bonus: *×${pending.perfectBonus.toFixed(1)}* 🔥` : '';
    const totalBaseText = (pending.perfectCatch && pending.perfectBonus)
        ? `\n💰 Nilai dasar: *${formatMoney(totalValue)} money*${perfectText}\n💵 Total setelah bonus: *${formatMoney(totalMoney)} money*`
        : `\n\n💰 Total nilai: *${formatMoney(totalMoney)} money*`;
    const achieveText   = newAchs.length > 0
        ? '\n\n🏆 *Achievement Baru!*\n' + newAchs.map(a=>`   ${a.name} (+${a.pts} pts)`).join('\n')
        : '';

    await reply([
        `🎣 *Hasil Pancingan — ${islands[pending.island]?.name || pending.island}!*\n${'─'.repeat(30)}\n\n` +
        fishListText +
        totalBaseText +
        eventText + weatherText + streakText +
        `\n🎣 Menggunakan: *${rod.name}${enchantText}*\n` +
        `🧠 EXP Rod: +${formatMoney(expGainRod)} | 👤 EXP Player: +${formatMoney(expGainPlayer)}` +
        bossMsg + achieveText,
        levelUpRodMsg,
        levelUpPlayerMsg,
    ].filter(Boolean).join('\n\n'));
}
break;

        case "jual":
        case "sell": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const arg0 = args[0]?.toLowerCase();
    
    let fishToSell = user.inventory.filter(item => item.type === "fish");
    if (fishToSell.length === 0) return reply("📦 Tidak ada ikan yang bisa dijual.");

    // Ikan favorit TIDAK ikut jual kecuali pakai !jual fav (jual favorit saja) atau !jual all+fav
    const includeFav = (arg0 === 'fav' || arg0 === 'favorit' || arg0 === 'all+fav');
    if (!includeFav) {
        const favCount = fishToSell.filter(f => f.favorite).length;
        fishToSell = fishToSell.filter(f => !f.favorite);
        if (fishToSell.length === 0) {
            return reply(`⭐ Semua ikan di inventory kamu adalah favorit!\nGunakan *!jual fav* untuk menjual ikan favorit, atau *!unfav <id>* untuk melepas tandai.`);
        }
    } else if (arg0 === 'fav' || arg0 === 'favorit') {
        fishToSell = fishToSell.filter(f => f.favorite);
        if (fishToSell.length === 0) return reply("📦 Tidak ada ikan favorit di inventory.");
    }
    // arg0 === 'all+fav' → semua ikan termasuk favorit, lanjut filter biasa

    // .jual rare+ → jual hanya rare ke atas
    // .jual common → jual hanya common
    // .jual all / kosong → jual semua
    const RARITY_ORDER = ['common','uncommon','rare','epic','legendary','mythic','godly','secret','extinct','special'];
    const _arg0ForFilter = (arg0 === 'fav' || arg0 === 'favorit' || arg0 === 'all+fav') ? null : arg0;
    if (_arg0ForFilter && _arg0ForFilter !== 'all' && _arg0ForFilter !== 'semua') {
        const filterRarity = _arg0ForFilter;
        if (filterRarity.endsWith('+')) {
            const base = filterRarity.slice(0,-1);
            const baseIdx = RARITY_ORDER.indexOf(base);
            if (baseIdx >= 0) fishToSell = fishToSell.filter(f => RARITY_ORDER.indexOf(f.rarity) >= baseIdx);
            else return reply(`❌ Rarity "${base}" tidak dikenal. Gunakan: common, rare, epic, legendary, dll`);
        } else {
            const targetIdx = RARITY_ORDER.indexOf(filterRarity);
            if (targetIdx >= 0) fishToSell = fishToSell.filter(f => f.rarity === filterRarity);
            else if (filterRarity === 'mutated' || filterRarity === 'mutasi') {
                fishToSell = fishToSell.filter(f => f.isMutated);
            } else return reply(`❌ Filter tidak dikenal. Contoh: *!jual common*, *!jual rare+*, *!jual mutasi*`);
        }
    }

    if (fishToSell.length === 0) return reply(`📦 Tidak ada ikan yang cocok untuk dijual dengan filter "*${arg0}*".`);

    // Golden Shop Event multiplier (hanya dari admin event)
    const gsMultJual = (GOLDEN_SHOP_EVENT.active && Date.now() < GOLDEN_SHOP_EVENT.endTime)
        ? GOLDEN_SHOP_EVENT.multiplier : 1;

    // Grouping untuk summary — tiap ikan dikali bonusnya masing-masing
    const byRarity = {};
    for (const f of fishToSell) {
        const fishMoney = Math.floor((f.price || 0) * (f.perfectBonus || 1) * gsMultJual);
        if (!byRarity[f.rarity]) byRarity[f.rarity] = { count:0, total:0 };
        byRarity[f.rarity].count++;
        byRarity[f.rarity].total += fishMoney;
    }

    const totalMoney  = Object.values(byRarity).reduce((a, b) => a + b.total, 0);
    const baseMoney   = fishToSell.reduce((a, b) => a + (b.price || 0), 0);
    const perfectMult = totalMoney > baseMoney ? (totalMoney / baseMoney) : 1;
    const totalWeight = fishToSell.reduce((a, b) => a + (b.kg || 0), 0);
    const jumlah      = fishToSell.length;
    const sellIds     = new Set(fishToSell.map(f => f.id));

    user.money   = (user.money || 0) + totalMoney;
    user.totalEarned = (user.totalEarned || 0) + totalMoney;
    user.inventory   = user.inventory.filter(item => !(item.type === "fish" && sellIds.has(item.id)));

    const RARITY_EMOJI = { common:'⚪',uncommon:'🟢',rare:'💚',epic:'💙',legendary:'💛',mythic:'🟣',godly:'🌟',secret:'⚫',extinct:'🦕',special:'✨' };
    const summaryLines = Object.entries(byRarity)
        .sort((a,b) => RARITY_ORDER.indexOf(b[0]) - RARITY_ORDER.indexOf(a[0]))
        .map(([r,d]) => `  ${RARITY_EMOJI[r]||'🐟'} ${r}: ${d.count} ekor → ${formatMoney(d.total)}`);

    // Check achievements setelah jual
    const newAchs = await checkAchievements(user, {});
    await user.save();

    const achText = newAchs.length > 0
        ? '\n\n🏆 *Achievement Baru!*\n' + newAchs.map(a=>`   ${a.name} (+${a.pts} pts)`).join('\n')
        : '';

    const perfectJualText = perfectMult > 1
        ? `🎯 Perfect Catch Bonus: *×${perfectMult.toFixed(1)}* 🔥\n💵 Nilai dasar: *${formatMoney(baseMoney)}* → Setelah bonus: *${formatMoney(totalMoney)} money*\n`
        : `💵 Pendapatan: *${formatMoney(totalMoney)} money*\n`;
    const gsJualText = gsMultJual > 1 ? `🛒 Golden Shop Event: *×${gsMultJual}* aktif!\n` : '';

    reply(
        `💰 *Hasil Penjualan Ikan*\n${'─'.repeat(28)}\n` +
        summaryLines.join('\n') + '\n' +
        `${'─'.repeat(28)}\n` +
        `🐟 Terjual: *${jumlah} ekor* | ⚖️ *${totalWeight.toFixed(2)} kg*\n` +
        gsJualText +
        perfectJualText +
        `💰 Saldo: *${formatMoney(user.money)}*\n\n` +
        `💡 Filter: *!jual common* | *!jual rare+* | *!jual mutasi* | *!jual fav* (jual favorit) | *!jual all+fav* (jual semua incl. favorit)` +
        achText
    );
}

break;

// ════════════════════════════════════════════════════════════
//   SEASON COMMANDS
// ════════════════════════════════════════════════════════════
        case "season": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const timeLeft = currentSeason.endDate.getTime() - Date.now();
    const daysLeft  = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
    const hoursLeft = Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    // Top 5 season
    const top5 = await Player.find({ seasonPoints: { $gt: 0 } })
        .sort({ seasonPoints: -1 }).limit(5).lean();

    let text = `🏆 *${currentSeason.name}*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `📅 Mulai: ${currentSeason.startDate.toLocaleDateString('id-ID')}\n`;
    text += `⏳ Sisa: *${daysLeft}h ${hoursLeft}j* lagi\n`;
    text += `📅 Berakhir: ${currentSeason.endDate.toLocaleDateString('id-ID')}\n\n`;
    text += `🎁 *Hadiah Pemenang:*\n`;
    text += `🥇 OMEGA ROD + 500 Tokens + 10T coins\n`;
    text += `🥈 Cosmic Rod + 200 Tokens + 1T coins\n`;
    text += `🥉 Void Rod + 100 Tokens + 100B coins\n\n`;
    text += `📊 *Leaderboard Season:*\n`;
    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
    top5.forEach((p, i) => {
        const isMe = p.id === user.id;
        text += `${medals[i]} ${isMe ? '*' : ''}${p.username}${isMe ? '*' : ''} — ${formatMoney(p.seasonPoints)} pts\n`;
    });

    // Cari posisi user sendiri
    const allSorted = await Player.find({ seasonPoints: { $gt: 0 } })
        .sort({ seasonPoints: -1 }).lean();
    const myRank = allSorted.findIndex(p => p.id === user.id) + 1;
    text += `\n📍 Posisimu: *#${myRank || 'unranked'}* | Poin: *${formatMoney(user.seasonPoints || 0)}*\n`;
    text += `\n💡 Poin dari: mancing ikan, mutasi, rarity tinggi`;

    reply(text);
    break;
}

        case "seasonhistory":
        case "seasonlog": {
    const histories = await SeasonHistory.find().sort({ seasonNumber: -1 }).limit(5).lean();
    if (!histories.length) return reply('📜 Belum ada riwayat season.');
    let text = `📜 *Riwayat Season*\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const h of histories) {
        text += `🏆 *${h.name || 'Season ' + h.seasonNumber}*\n`;
        text += `📅 ${new Date(h.startDate).toLocaleDateString('id-ID')} — ${new Date(h.endDate).toLocaleDateString('id-ID')}\n`;
        if (h.winner1) text += `🥇 ${h.winner1.username} (${formatMoney(h.winner1.points)} pts)\n`;
        if (h.winner2) text += `🥈 ${h.winner2.username} (${formatMoney(h.winner2.points)} pts)\n`;
        if (h.winner3) text += `🥉 ${h.winner3.username} (${formatMoney(h.winner3.points)} pts)\n`;
        text += `👥 ${h.totalPlayers} pemain\n\n`;
    }
    reply(text);
    break;
}

        case "resetseason": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;
    reply('⏳ Memproses reset season...');
    await doSeasonReset(reply);
    break;
}

// ════════════════════════════════════════════════════════════
//   DELETE SEASON HISTORY + CABUT REWARD (Admin)
//   Satu command, selesai semua sekaligus.
// ════════════════════════════════════════════════════════════

        case "deleteseasonhistory":
        case "hapushistory": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;

    // Helper: cabut reward pemenang dari 1 history object
    async function revokeSeasonRewards(h) {
        const PRIZES = [
            { winner: h.winner1, rod: 'omegarod',  tokens: 500, money: 10000000000000, title: 'Season Champion' },
            { winner: h.winner2, rod: 'cosmicrod', tokens: 200, money: 1000000000000,  title: 'Season Runner-up' },
            { winner: h.winner3, rod: 'voidrod',   tokens: 100, money: 100000000000,   title: 'Season Bronze' },
        ];
        const log = [];
        for (const p of PRIZES) {
            if (!p.winner) continue;
            const player = await Player.findOne({ id: p.winner.id });
            if (!player) { log.push(`  ⚠️ ${p.winner.username} tidak ditemukan di DB`); continue; }
            player.money = Math.max(0, (player.money || 0) - p.money);
            player.prestigeTokens = Math.max(0, (player.prestigeTokens || 0) - p.tokens);
            player.seasonWins = Math.max(0, (player.seasonWins || 0) - 1);
            if (player.fishingRods instanceof Map && player.fishingRods.has(p.rod)) {
                player.fishingRods.delete(p.rod);
                player.markModified('fishingRods');
                if (player.usedFishingRod === p.rod) player.usedFishingRod = 'basicrod';
            }
            if (player.title && player.title.includes(p.title)) player.title = 'Pemancing Baru';
            await player.save();
            log.push(`  ✅ *${player.username}* — -${formatMoney(p.money)} coins, -${p.tokens} tokens, rod dicabut`);
        }
        return log;
    }

    // Tanpa argumen → preview daftar + panduan
    if (!args[0]) {
        const histories = await SeasonHistory.find().sort({ seasonNumber: -1 }).lean();
        if (!histories.length) return reply('📜 Tidak ada riwayat season di database.');
        let txt = `📜 *Daftar Season History*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        txt += `Total: *${histories.length}* season\n\n`;
        for (const h of histories) {
            txt += `🏆 *Season ${h.seasonNumber}* — ${h.name || '-'}\n`;
            txt += `   📅 ${new Date(h.startDate).toLocaleDateString('id-ID')} — ${new Date(h.endDate).toLocaleDateString('id-ID')}\n`;
            txt += `   👥 ${h.totalPlayers || 0} pemain\n`;
            if (h.winner1) txt += `   🥇 ${h.winner1.username} (${formatMoney(h.winner1.points)} pts)\n`;
            if (h.winner2) txt += `   🥈 ${h.winner2.username}\n`;
            if (h.winner3) txt += `   🥉 ${h.winner3.username}\n`;
            txt += '\n';
        }
        txt += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        txt += `*Format:*\n`;
        txt += `• *!deleteseasonhistory <nomor>* — Hapus history + cabut reward season itu\n`;
        txt += `• *!deleteseasonhistory all* — Hapus SEMUA history + cabut semua reward`;
        return reply(txt);
    }

    // Hapus SEMUA
    if (args[0] === 'all') {
        const histories = await SeasonHistory.find().sort({ seasonNumber: -1 }).lean();
        if (!histories.length) return reply('📜 Tidak ada riwayat season untuk dihapus.');
        reply(`⏳ Mencabut reward + menghapus *${histories.length}* season history...`);
        const allLogs = [];
        for (const h of histories) {
            const logs = await revokeSeasonRewards(h);
            if (logs.length) allLogs.push(`*Season ${h.seasonNumber}:*`, ...logs);
        }
        await SeasonHistory.deleteMany({});
        let txt = `✅ *Selesai! Semua season history dihapus.*\n\n`;
        txt += allLogs.length ? `🎁 *Reward yang dicabut:*\n${allLogs.join('\n')}` : `ℹ️ Tidak ada pemenang yang perlu dicabut.`;
        return reply(txt);
    }

    // Hapus 1 season tertentu
    const seasonNum = parseInt(args[0]);
    if (isNaN(seasonNum) || seasonNum < 1) return reply('❌ Nomor season tidak valid!\nContoh: *!deleteseasonhistory 3*');
    const history = await SeasonHistory.findOne({ seasonNumber: seasonNum }).lean();
    if (!history) return reply(`❌ Season *${seasonNum}* tidak ditemukan di riwayat.`);

    reply(`⏳ Mencabut reward + menghapus Season *${seasonNum}*...`);
    const logs = await revokeSeasonRewards(history);
    await SeasonHistory.deleteOne({ seasonNumber: seasonNum });

    let txt = `✅ *Season ${seasonNum} dihapus dari history!*\n`;
    txt += `📅 ${new Date(history.startDate).toLocaleDateString('id-ID')} — ${new Date(history.endDate).toLocaleDateString('id-ID')}\n\n`;
    txt += logs.length ? `🎁 *Reward yang dicabut:*\n${logs.join('\n')}` : `ℹ️ Tidak ada pemenang yang perlu dicabut.`;
    return reply(txt);
}

        case "setseason": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;
    if (!args[0]) return reply('⚙️ Format: !setseason <hari>\nContoh: !setseason 30');
    const days = parseInt(args[0]);
    if (isNaN(days) || days < 1) return reply('❌ Jumlah hari tidak valid!');
    currentSeason.endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    reply(`✅ Season diset berakhir dalam *${days} hari*.\nTanggal berakhir: *${currentSeason.endDate.toLocaleDateString('id-ID')}*`);
    break;
}

// ════════════════════════════════════════════════════════════
//   PRESTIGE SYSTEM
// ════════════════════════════════════════════════════════════
        case "prestige": {
    // ── Admin: prestige off / prestige on ───────────────────
    if (args[0] === 'off' || args[0] === 'on') {
        if (!isOwner) return;
        PRESTIGE_SYSTEM_DISABLED = (args[0] === 'off');
        saveBotConfig();
        const featureList = '• prestige\n• tokenstore/toko\n• upgrade\n• rodupgrade\n• jackpot\n• donate\n• gacha';
        return reply(PRESTIGE_SYSTEM_DISABLED
            ? `🔒 *Sistem Prestige dinonaktifkan!*\n\nFitur berikut dinonaktifkan:\n${featureList}\n\n_Fitur daily, stats, season, event tidak terpengaruh._`
            : `✅ *Sistem Prestige diaktifkan kembali!*\n\nSemua fitur prestige dapat digunakan kembali:\n${featureList}`
        );
    }

    // ── Cek apakah prestige system dinonaktifkan ─────────────
    if (PRESTIGE_SYSTEM_DISABLED) {
        return;
    }

    const user = await getOrCreateUser(senderNumber, null, pushname);
    const curLevel = user.prestige || 0;
    const nextReq  = PRESTIGE_REQUIREMENTS[curLevel];

    // .prestige confirm
    if (args[0] === 'confirm') {
        if (!nextReq) return reply('❌ Kamu sudah prestige maksimal!');
        if ((user.fishCaught || 0) < nextReq.fish)
            return reply(`❌ Belum cukup! Mancing dulu ${nextReq.fish - (user.fishCaught||0)} kali lagi.`);
        if ((user.money || 0) < nextReq.money)
            return reply(`❌ Uang kurang! Butuh *${formatMoney(nextReq.money - (user.money||0))}* lagi.`);
        user.money -= nextReq.money;
        user.prestige = curLevel + 1;
        user.prestigeTokens = (user.prestigeTokens || 0) + 100;
        user.title = PRESTIGE_TITLES[user.prestige] || `Prestige ${user.prestige}`;
        if (!user.fishingRods.get('prestigerod')) {
            user.fishingRods.set('prestigerod', { ...fishingRod.prestigerod });
            user.markModified('fishingRods');
        }
        if (user.prestige >= 3 && !user.fishingRods.get('cosmicrod')) {
            user.fishingRods.set('cosmicrod', { ...fishingRod.cosmicrod });
            user.markModified('fishingRods');
        }
        if (user.prestige >= 5 && !user.fishingRods.get('eternityrod')) {
            user.fishingRods.set('eternityrod', { ...fishingRod.eternityrod });
            user.markModified('fishingRods');
        }
        await user.save();
        return reply(
            `🎉 *PRESTIGE ${user.prestige} UNLOCKED!*\n\n` +
            `🎖️ Title baru: *${user.title}*\n` +
            `🪙 +100 Prestige Tokens!\n` +
            `🎁 ${nextReq.reward}\n\n` +
            `💡 Gunakan *!tokenstore* untuk belanja tokens.`
        );
    }

    // .prestige info
    if (!nextReq) {
        return reply(
            `👑 *Prestige Level ${curLevel}* — Kamu sudah mencapai level tertinggi!\n\n` +
            `🎖️ Title: *${user.title || PRESTIGE_TITLES[curLevel]}*\n` +
            `🪙 Tokens: *${user.prestigeTokens || 0}*\n\n` +
            `💡 Gunakan *!tokenstore* untuk belanja tokens.`
        );
    }

    let text = `👑 *Sistem Prestige*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🎖️ Level kamu: *Prestige ${curLevel}*\n`;
    text += `🪙 Tokens: *${user.prestigeTokens || 0}*\n\n`;
    text += `⬆️ *Syarat Prestige ${curLevel + 1}:*\n`;
    text += `🐟 Total mancing: *${user.fishCaught || 0}/${nextReq.fish}*\n`;
    text += `💰 Uang: *${formatMoney(user.money || 0)}/${formatMoney(nextReq.money)}*\n\n`;
    text += `🎁 Hadiah: ${nextReq.reward}\n\n`;
    const canPrestige = (user.fishCaught || 0) >= nextReq.fish && (user.money || 0) >= nextReq.money;
    text += canPrestige
        ? `✅ *Kamu SUDAH memenuhi syarat!*\nKetik *!prestige confirm* untuk naik level.`
        : `❌ Belum memenuhi syarat.`;
    reply(text);
    break;
}



// ════════════════════════════════════════════════════════════
//   DAILY REWARD
// ════════════════════════════════════════════════════════════
        case "daily": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const now = new Date();
    const last = user.lastDaily ? new Date(user.lastDaily) : null;

    if (last) {
        const diffH = (now - last) / (1000 * 60 * 60);
        if (diffH < 20) {
            const nextTime = new Date(last.getTime() + 20 * 60 * 60 * 1000);
            const waitH = Math.floor((nextTime - now) / (1000 * 60 * 60));
            const waitM = Math.floor(((nextTime - now) % (1000 * 60 * 60)) / (1000 * 60));
            return reply(`⏳ Daily reward sudah diambil!\nBisa ambil lagi dalam *${waitH}j ${waitM}m*.\n\n🔥 Streak: *${user.dailyStreak || 1}* hari`);
        }
        const diffD = (now - last) / (1000 * 60 * 60 * 24);
        if (diffD > 2) {
            user.dailyStreak = 0;
        }
    }

    user.dailyStreak = (user.dailyStreak || 0) + 1;
    user.lastDaily = now;

    // Cari reward berdasarkan streak
    const streakDay = user.dailyStreak;
    let reward = DAILY_REWARDS[0];
    for (const r of [...DAILY_REWARDS].reverse()) {
        if (streakDay >= r.streak) { reward = r; break; }
    }

    // Bonus event
    const eventMult = ACTIVE_EVENT.active ? ACTIVE_EVENT.multiplier : 1;
    const finalMoney = Math.floor(reward.money * eventMult);

    user.money = (user.money || 0) + finalMoney;
    user.gachaTickets = (user.gachaTickets || 0) + reward.tickets;
    await user.save();

    let text = `🎁 *Daily Reward!*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `${reward.desc}\n\n`;
    text += `💰 +${formatMoney(finalMoney)} coins\n`;
    if (reward.tickets > 0) text += `🎟️ +${reward.tickets} tiket gacha!\n`;
    if (eventMult > 1) text += `🔥 *Event Bonus x${eventMult}* aktif!\n`;
    text += `\n🔥 Streak: *${streakDay} hari*\n`;
    text += `💰 Saldo: *${formatMoney(user.money)}*\n`;
    text += `🎟️ Tiket gacha: *${user.gachaTickets}*`;
    reply(text);
    break;
}

// ════════════════════════════════════════════════════════════
//   UPGRADE STATS
// ════════════════════════════════════════════════════════════
        case "upgrade": {
    if (PRESTIGE_SYSTEM_DISABLED) return;
    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!args[0]) {
        let text = `⬆️ *Upgrade Stats*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `💰 Saldo: *${formatMoney(user.money)}*\n\n`;

        for (const [key, upg] of Object.entries(UPGRADES)) {
            const curLv = user[key + 'Upgrade'] || 0;
            const nextCost = curLv < upg.maxLevel ? formatMoney(upg.getCost(curLv)) : 'MAX';
            text += `${upg.name}\n`;
            text += `  Level: *${curLv}/${upg.maxLevel}* | Efek: +${(upg.effect(curLv)*100).toFixed(0)}%\n`;
            text += `  Biaya naik: *${nextCost}*\n`;
            text += `  Ketik *!upgrade ${key}*\n\n`;
        }
        text += `💡 *Sell Multiplier* hanya bisa ditingkatkan lewat *EVENT GOLDEN SHOP* (admin only).`;
        return reply(text);
    }

    const upKey = args[0].toLowerCase();
    if (!['luck', 'speed'].includes(upKey)) return reply(`❌ Upgrade tidak ada.\nPilih: luck, speed\n\n💡 Sell hanya dari EVENT GOLDEN SHOP.`);
    const upg = UPGRADES[upKey];

    const curLv = user[upKey + 'Upgrade'] || 0;
    if (curLv >= upg.maxLevel) return reply(`✅ *${upg.name}* sudah MAX Level ${upg.maxLevel}!`);

    const cost = upg.getCost(curLv);
    if ((user.money || 0) < cost) return reply(`💸 Uang kurang!\nButuh: *${formatMoney(cost)}*\nPunya: *${formatMoney(user.money)}*`);

    user.money -= cost;
    user[upKey + 'Upgrade'] = curLv + 1;
    await user.save();

    reply(
        `✅ *${upg.name}* naik ke Level *${curLv + 1}*!\n\n` +
        `💸 Biaya: ${formatMoney(cost)}\n` +
        `📊 Efek total: +${(upg.effect(curLv + 1)*100).toFixed(0)}%\n` +
        `💰 Saldo: ${formatMoney(user.money)}`
    );
    break;
}

// ════════════════════════════════════════════════════════════
//   SETUPGRADE — Admin command set level upgrade player
// ════════════════════════════════════════════════════════════
        case "setupgrade": {
    if (!isAdmin(senderNumber, m)) return;

    // Format: !setupgrade <luck/speed/all> <level/max> [@target atau id]
    // Contoh: !setupgrade luck 50
    //         !setupgrade speed max
    //         !setupgrade all 10 @62xxx

    const subType = args[0]?.toLowerCase();
    const levelArg = args[1]?.toLowerCase();

    if (!subType || !levelArg) {
        return reply(
            `⚙️ *Admin: Set Upgrade Level*\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Format: *!setupgrade <tipe> <level> [target]*\n\n` +
            `Tipe: *luck*, *speed*, *all*\n` +
            `Level: angka atau *max*\n` +
            `Target: opsional — mention/ID player (default: diri sendiri)\n\n` +
            `Contoh:\n` +
            `• *!setupgrade luck 50* — set luckUpgrade kamu ke lv50\n` +
            `• *!setupgrade speed max* — set speedUpgrade ke max\n` +
            `• *!setupgrade all max* — set luck & speed ke max\n` +
            `• *!setupgrade luck 25 10000001* — set luck lv25 ke player id 10000001`
        );
    }

    if (!['luck', 'speed', 'all'].includes(subType)) {
        return reply('❌ Tipe tidak valid. Pilih: *luck*, *speed*, *all*');
    }

    // Resolve target — args[2] bisa ID / mention / "all" (semua player)
    const targetArg = args[2]?.toLowerCase();
    const targetAll = (targetArg === 'all');

    // ── !setupgrade <type> <level> all — update semua player ──
    if (targetAll) {
        const typesToSet = subType === 'all' ? ['luck', 'speed'] : [subType];
        const updateFields = {};
        const msgs = [];
        for (const t of typesToSet) {
            const upg = UPGRADES[t];
            let newLevel;
            if (levelArg === 'max') {
                newLevel = upg.maxLevel;
            } else {
                newLevel = parseInt(levelArg);
                if (isNaN(newLevel) || newLevel < 0) return reply('❌ Level tidak valid! Gunakan angka atau *max*.');
                if (newLevel > upg.maxLevel) newLevel = upg.maxLevel;
            }
            updateFields[t + 'Upgrade'] = newLevel;
            msgs.push(`${upg.name}: Lv.*${newLevel}* (+${(upg.effect(newLevel)*100).toFixed(0)}%)`);
        }
        reply('⏳ Mengupdate semua player...');
        const result = await Player.updateMany({}, { $set: updateFields });
        return reply(
            `✅ *Upgrade di-set ke semua player!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👥 Total player: *${result.modifiedCount}*\n\n` +
            msgs.map(msg => `  ${msg}`).join('\n')
        );
    }

    // ── Single player (atau diri sendiri) ────────────────────
    let targetUser = null;
    if (targetArg) {
        const cleanId = args[2].replace(/\D/g, '');
        const parsedCleanId = parseInt(cleanId);
        targetUser = await Player.findOne({
            $or: [
                ...(!isNaN(parsedCleanId) && isFinite(parsedCleanId) && cleanId !== '' ? [{ id: parsedCleanId }] : []),
                { whatsappNumber: { $regex: cleanId } },
            ]
        });
        if (!targetUser) return reply(`❌ Player tidak ditemukan: ${args[2]}`);
    } else {
        targetUser = await getOrCreateUser(senderNumber, null, pushname);
    }

    const typesToSet = subType === 'all' ? ['luck', 'speed'] : [subType];
    const msgs = [];

    for (const t of typesToSet) {
        const upg = UPGRADES[t];
        let newLevel;
        if (levelArg === 'max') {
            newLevel = upg.maxLevel;
        } else {
            newLevel = parseInt(levelArg);
            if (isNaN(newLevel) || newLevel < 0) return reply('❌ Level tidak valid! Gunakan angka atau *max*.');
            if (newLevel > upg.maxLevel) newLevel = upg.maxLevel;
        }
        targetUser[t + 'Upgrade'] = newLevel;
        msgs.push(`${upg.name}: Lv.*${newLevel}* (+${(upg.effect(newLevel)*100).toFixed(0)}%)`);
    }

    await targetUser.save();

    reply(
        `✅ *Upgrade berhasil di-set!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 Player: *${targetUser.username}*\n\n` +
        msgs.map(msg => `  ${msg}`).join('\n')
    );
    break;
}

// ════════════════════════════════════════════════════════════
//   GACHA SYSTEM
// ════════════════════════════════════════════════════════════
        case "gacha": {
    // ── Admin: gacha off / gacha on ──────────────────────────
    if (args[0] === 'off' || args[0] === 'on') {
        if (!isOwner) return;
        GACHA_DISABLED = (args[0] === 'off');
        saveBotConfig();
        return reply(GACHA_DISABLED
            ? '🔒 *Gacha dinonaktifkan!* Pemain tidak dapat menggunakan !gacha.'
            : '✅ *Gacha diaktifkan kembali!* Pemain dapat menggunakan !gacha lagi.'
        );
    }

    // ── Cek apakah gacha dinonaktifkan ───────────────────────
    if (GACHA_DISABLED || PRESTIGE_SYSTEM_DISABLED) {
        return;
    }

    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!args[0]) {
        return reply(
            `🎰 *Gacha Fisch*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🎟️ Tiket kamu: *${user.gachaTickets || 0}*\n` +
            `🔄 Pity: *${user.gachaPity || 0}/${GACHA_PITY_LIMIT}* (SSR guaranteed)\n\n` +
            `*Cara pull:*\n` +
            `• *!gacha pull* — 1x pull pakai tiket\n` +
            `• *!gacha coins* — 1x pull pakai ${formatMoney(GACHA_COST_COINS)} coins\n` +
            `• *!gacha multi* — 10x pull tiket (hemat!)\n` +
            `• *!gacha multicoins* — 10x pull coins (${formatMoney(GACHA_COST_COINS * 9)} — hemat 1 pull!)\n\n` +
            `*Pool Hadiah:*\n` +
            `⚪ Common 55%: Enchant Scroll, Tiket, XP Boost\n` +
            `🟢 Rare 25%: Rod, Enchant Scroll, Bait, Tiket\n` +
            `🔵 Epic 13%: Rod, Enchant Scroll, Token, Bait\n` +
            `🟡 Legendary 6%: Rod (Midas/Avalanche), Token\n` +
            `⭐ SSR 1%: Void Rod / Cosmic Rod / 200 Token\n` +
            `🔄 Pity ${GACHA_PITY_LIMIT}x: SSR guaranteed!`
        );
    }

    const mode = args[0].toLowerCase();
    const pulls = (mode === 'multi' || mode === 'multicoins') ? 10 : 1;

    if (mode === 'coins') {
        if ((user.money || 0) < GACHA_COST_COINS) return reply(`💸 Butuh *${formatMoney(GACHA_COST_COINS)}* coins.`);
        user.money -= GACHA_COST_COINS;
    } else if (mode === 'multicoins') {
        const multiCoinCost = GACHA_COST_COINS * 9; // 10 pull harga 9
        if ((user.money || 0) < multiCoinCost) return reply(`💸 Butuh *${formatMoney(multiCoinCost)}* coins untuk 10x pull. Kamu punya *${formatMoney(user.money || 0)}*.`);
        user.money -= multiCoinCost;
    } else {
        if ((user.gachaTickets || 0) < pulls) return reply(`🎟️ Butuh *${pulls}* tiket. Kamu punya *${user.gachaTickets || 0}*.`);
        user.gachaTickets -= pulls;
    }

    const results = [];
    for (let i = 0; i < pulls; i++) {
        const { item, isSSR, pity } = doGachaPull(user);
        results.push({ item, isSSR, pity });

        // Apply item berdasarkan tipe
        switch (item.type) {
            case 'coins':
                user.money = (user.money || 0) + item.value;
                break;
            case 'tickets':
                user.gachaTickets = (user.gachaTickets || 0) + item.value;
                break;
            case 'tokens':
                user.prestigeTokens = (user.prestigeTokens || 0) + item.value;
                break;
            case 'rod':
                if (fishingRod[item.value] && !user.fishingRods.get(item.value)) {
                    user.fishingRods.set(item.value, { ...fishingRod[item.value] });
                    user.markModified('fishingRods');
                }
                break;
            case 'enchant_scroll': {
                // Simpan scroll ke inventory untuk dipakai nanti
                if (!Array.isArray(user.inventory)) user.inventory = [];
                user.inventory.push({
                    type: 'enchant_scroll',
                    rarity: item.value,
                    id: Math.floor(100000 + Math.random() * 900000).toString(),
                    label: item.label
                });
                break;
            }
            case 'xp_boost': {
                if (!user.activeBoosts) user.activeBoosts = {};
                user.activeBoosts.xpBoost = (user.activeBoosts.xpBoost || 1) * item.value;
                user.markModified('activeBoosts');
                break;
            }
            case 'bait': {
                if (!Array.isArray(user.inventory)) user.inventory = [];
                user.inventory.push({
                    type: 'bait',
                    id: item.value,
                    label: item.label,
                    itemId: Math.floor(100000 + Math.random() * 900000).toString()
                });
                break;
            }
        }
    }
    await user.save();

    const rarEmoji = { common:'⚪', rare:'🟢', epic:'🔵', legendary:'🟡', ssr:'⭐' };
    const rarLabel = { common:'Common', rare:'Rare', epic:'Epic', legendary:'Legendary', ssr:'SSR ✨' };
    let text = `🎰 *Hasil Gacha (${pulls}x pull)*\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    for (const { item, isSSR, pity } of results) {
        text += `${rarEmoji[item.rarity] || '⚪'} [${rarLabel[item.rarity] || item.rarity}] ${item.label}`;
        if (isSSR || pity) text += ` ← PITY!`;
        text += `\n`;
    }
    text += `\n─────────────────────\n`;
    text += `💰 Saldo: *${formatMoney(user.money)}*\n`;
    text += `🎟️ Tiket: *${user.gachaTickets || 0}*\n`;
    text += `🪙 Tokens: *${user.prestigeTokens || 0}*\n`;
    text += `🔄 Pity: *${user.gachaPity || 0}/${GACHA_PITY_LIMIT}* pull`;
    reply(text);
    break;
}

// ════════════════════════════════════════════════════════════
//   PRESTIGE TOKEN SHOP
// ════════════════════════════════════════════════════════════
        case "tokenstore":
        case "toko": {
    if (PRESTIGE_SYSTEM_DISABLED) return;
    const user = await getOrCreateUser(senderNumber, null, pushname);

    if (!args[0]) {
        let text = `🪙 *Prestige Token Store*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        text += `🪙 Tokens kamu: *${user.prestigeTokens || 0}*\n\n`;
        TOKEN_SHOP.forEach((item, i) => {
            text += `${i+1}. ${item.name} — *${item.cost} tokens*\n`;
        });
        text += `\nKetik *!tokenstore beli <nomor>*`;
        return reply(text);
    }

    if (args[0] === 'beli') {
        const idx = parseInt(args[1]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= TOKEN_SHOP.length) return reply('❌ Nomor item tidak valid.');
        const item = TOKEN_SHOP[idx];
        if ((user.prestigeTokens || 0) < item.cost) return reply(`❌ Token kurang! Butuh *${item.cost}*, punya *${user.prestigeTokens || 0}*.`);
        user.prestigeTokens -= item.cost;

        if (item.type === 'rod') {
            if (user.fishingRods.get(item.value)) return reply(`⚠️ Kamu sudah punya *${item.name}*.`);
            user.fishingRods.set(item.value, { ...fishingRod[item.value] });
            user.markModified('fishingRods');
        } else if (item.type === 'tickets') {
            user.gachaTickets = (user.gachaTickets || 0) + item.value;
        } else if (item.type === 'coins') {
            user.money = (user.money || 0) + item.value;
        }
        await user.save();
        reply(`✅ Berhasil beli *${item.name}*!\n🪙 Sisa tokens: *${user.prestigeTokens}*`);
    }
    break;
}

// ════════════════════════════════════════════════════════════
//   WEATHER COMMAND
// ════════════════════════════════════════════════════════════
        case "cuaca":
        case "weather": {
    const w = CURRENT_WEATHER;
    const timeLeft = Math.max(0, w.expiresAt - Date.now());
    const mins = Math.floor(timeLeft / 60000);
    const secs = Math.floor((timeLeft % 60000) / 1000);

    let txt = `🌦️ *Cuaca Saat Ini*\n${'─'.repeat(28)}\n`;
    txt += `${w.name}\n`;
    txt += `📝 ${w.desc}\n\n`;
    txt += `📊 *Efek:*\n`;
    txt += `  🍀 Luck Mult: ×${(w.luckMult||1).toFixed(2)}\n`;
    txt += `  ⚡ Speed Mult: ×${(w.speedMult||1).toFixed(2)}\n`;
    if (w.mutationBonus) txt += `  🧬 Mutation Bonus: +${(w.mutationBonus*100).toFixed(1)}%\n`;
    if (Object.keys(w.rarityBoost||{}).length) {
        txt += `  📈 Rarity Boost: ` + Object.entries(w.rarityBoost).map(([r,v])=>`${r} ×${v}`).join(', ') + `\n`;
    }
    if (w.exclusive?.length) txt += `  🐟 Ikan Eksklusif: ${w.exclusive.join(', ')}\n`;
    txt += `\n⏳ Berganti dalam: *${mins}m ${secs}s*\n`;
    txt += `\n💡 Cuaca berganti otomatis tiap 2 jam`;
    reply(txt);
    break;
}

// ════════════════════════════════════════════════════════════
//   REEL MINIGAME — perfect catch timing
// ════════════════════════════════════════════════════════════
        case "reel": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    let pending = user.fishingPending.find(p => p.sender === senderNumber);
    const now = Date.now();

    // Cek expired — ikan lepas diam-diam
    if (pending && pending.expiresAt && now >= Number(pending.expiresAt)) {
        user.fishingPending = user.fishingPending.filter(p => p.sender !== senderNumber);
        await user.save();
        return reply("🐟 Ikanmu kabur! Terlalu lama tidak diambil.\nKirim *!mancing* untuk coba lagi.");
    }

    if (!pending) return reply("❌ Kamu belum memancing. Kirim *!mancing* dulu!");

    const timing = checkReelTiming(senderNumber);

    if (timing === 'perfect') {
        // Tandai sebagai perfect catch — bonus di .view
        pending.perfectCatch = true;
        pending.perfectBonus = 1.5 + Math.random() * 1.0; // 1.5x - 2.5x bonus
        user.perfectCatches = (user.perfectCatches || 0) + 1;
        user.markModified('fishingPending');

        // Perpanjang expiresAt — kasih waktu 30 detik setelah reel berhasil
        const VIEW_WINDOW_MS = Number(pending.escapeMs) || 30000;
        pending.expiresAt = Date.now() + VIEW_WINDOW_MS;
        user.markModified('fishingPending');

        // Cancel timer kabur yang lama, set timer baru 30 detik
        if (ESCAPE_TIMERS.has(senderNumber)) {
            clearTimeout(ESCAPE_TIMERS.get(senderNumber));
            ESCAPE_TIMERS.delete(senderNumber);
        }
        const newEscapeTimer = setTimeout(async () => {
            ESCAPE_TIMERS.delete(senderNumber);
            try {
                const Player = require('mongoose').model('Player');
                const freshUser = await Player.findOne({ whatsappNumber: senderNumber });
                if (!freshUser) return;
                const still = (freshUser.fishingPending || []).find(p => p.sender === senderNumber);
                if (!still || !still.expiresAt || Date.now() < Number(still.expiresAt)) return;
                freshUser.fishingPending = freshUser.fishingPending.filter(p => p.sender !== senderNumber);
                await freshUser.save();
                await client.sendMessage(m.chat, {
                    text: `🐟 Ikanmu kabur! Terlalu lama tidak di-view.\nKirim *!mancing* untuk coba lagi.`
                });
            } catch (_) {}
        }, VIEW_WINDOW_MS);
        ESCAPE_TIMERS.set(senderNumber, newEscapeTimer);

        await user.save();

        return reply(
            `🎯 *PERFECT CATCH!*\n\n` +
            `Timing-mu sempurna! 🔥\n` +
            `✨ Bonus nilai ikan: *×${pending.perfectBonus.toFixed(1)}*\n\n` +
            `Kirim *!view* untuk ambil hasilnya!`
        );
    } else if (timing === 'too_early') {
        // Belum waktunya — kasih info sisa waktu dari REEL_WINDOWS
        const w = REEL_WINDOWS.get(senderNumber);
        const remaining = w ? Math.max(0, ((w.windowStart - Date.now()) / 1000)).toFixed(1) : ((pending.readyAt - now) / 1000).toFixed(1);
        return reply(
            `⏳ *Terlalu Cepat!*\n\n` +
            `Ikan belum menggigit kencang...\n` +
            `Tunggu notif dari bot (≈${remaining} detik lagi) lalu kirim *!reel*!`
        );
    } else if (timing === 'too_late') {
        // Miss window — bisa tetap view tapi tanpa bonus
        return reply(
            `😅 *Kelewatan!*\n\n` +
            `Kamu terlambat menarik pancingan!\n` +
            `Ikan kabur dari bonus, tapi kamu masih bisa *!view* untuk ambil ikan biasa.`
        );
    } else {
        // no_session — REEL_WINDOWS kosong (bot restart / race condition)
        // Fallback: tentukan status dari fishingPending langsung
        if (now < pending.readyAt) {
            const remaining = ((pending.readyAt - now) / 1000).toFixed(1);
            return reply(`⏳ *Terlalu Cepat!*\n\nIkan belum menggigit...\nTunggu notif dari bot (≈${remaining} detik lagi) lalu kirim *!reel*!`);
        } else if (now < Number(pending.expiresAt)) {
            return reply(`🐟 Ikan sudah menggigit! Kirim *!view* untuk mengambil.\n_(Window !reel sudah lewat — tidak ada Perfect Catch bonus)_`);
        } else {
            return reply(`🐟 Ikanmu kabur! Terlalu lama tidak diambil.\nKirim *!mancing* untuk coba lagi.`);
        }
    }
}

// ════════════════════════════════════════════════════════════
//   ACHIEVEMENT COMMAND
// ════════════════════════════════════════════════════════════
        case "achievement":
        case "ach": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const earned = new Set(user.achievements || []);
    const total  = Object.keys(ACHIEVEMENTS).length;
    const pts    = user.achievementPoints || 0;

    if (args[0] === 'list' || args[0] === 'all') {
        const CATS = {
            '🎣 Memancing':  ['first_fish','fish_10','fish_50','fish_100','fish_500','fish_1000','fish_5000'],
            '💎 Rarity':     ['first_rare','first_epic','first_legendary','first_mythic','first_godly','first_secret','first_extinct'],
            '🧬 Mutasi':     ['first_mutation','rare_fish_10','mutation_10'],
            '💰 Kekayaan':   ['money_1m','money_1b','money_1t','sell_100m'],
            '🎣 Rod':        ['rod_level5','rod_level20','enchant_first','own_3rods','own_7rods'],
            '🏝️ Eksplorasi': ['visit_3islands','visit_all'],
            '⭐ Spesial':    ['big_fish','perfect_10','storm_fisher','night_catcher'],
        };
        let txt = `🏆 *Daftar Achievement*\n${'─'.repeat(28)}\n`;
        txt += `📊 Progress: *${earned.size}/${total}* | Poin: *${pts}*\n\n`;
        for (const [cat, ids] of Object.entries(CATS)) {
            txt += `*${cat}*\n`;
            for (const id of ids) {
                const ach = ACHIEVEMENTS[id];
                if (!ach) continue;
                const done = earned.has(id);
                txt += `  ${done ? '✅' : '⬜'} ${ach.name} _(${ach.pts} pts)_\n`;
            }
            txt += '\n';
        }
        return reply(txt);
    }

    // Default: ringkasan
    const recentEarned = (user.achievements || []).slice(-5).map(id => ACHIEVEMENTS[id]?.name || id);
    let txt = `🏆 *Achievement ${user.username}*\n${'─'.repeat(28)}\n`;
    txt += `📊 Progress: *${earned.size}/${total}* achievement\n`;
    txt += `⭐ Poin: *${pts}*\n\n`;
    if (recentEarned.length) {
        txt += `🕐 *Terbaru:*\n`;
        txt += recentEarned.reverse().map(n=>`  • ${n}`).join('\n') + '\n\n';
    }
    txt += `💡 *!ach list* untuk lihat semua`;
    reply(txt);
    break;
}

// ════════════════════════════════════════════════════════════
//   STREAK COMMAND
// ════════════════════════════════════════════════════════════
        case "streak": {
    const streak = FISHING_STREAKS.get(senderNumber) || 0;
    const bon = getStreakBonus(streak);
    let txt = `🔥 *Fishing Streak*\n${'─'.repeat(28)}\n`;
    txt += `Streak saat ini: *${streak}x*\n`;
    if (streak >= 3) {
        txt += `💰 Sell Bonus: *×${bon.mult.toFixed(2)}*\n`;
        if (bon.luckAdd) txt += `🍀 Luck Bonus: *+${(bon.luckAdd*100).toFixed(0)}%*\n`;
        if (bon.mutAdd)  txt += `🧬 Mutation Bonus: *+${(bon.mutAdd*100).toFixed(0)}%*\n`;
    }
    txt += '\n*Milestone Streak:*\n';
    for (const s of STREAK_BONUSES) {
        const done = streak >= s.streak;
        txt += `  ${done ? '🔥' : '⬜'} *${s.streak}x* — ${s.desc}\n`;
    }
    txt += `\n💡 Streak reset jika hasil tangkapan ada ikan common!`;
    reply(txt);
    break;
}

// ════════════════════════════════════════════════════════════
//   WORLD BOSS COMMAND
// ════════════════════════════════════════════════════════════
        case "spawnboss": {
    if (!isOwner) return;
    const bossId2 = q || 'kraken_jr';
    const bossTemplate2 = WORLD_BOSSES.find(b => b.id === bossId2);
    if (!bossTemplate2) return reply(`❌ Boss tidak ditemukan.\nPilih: ${WORLD_BOSSES.map(b => b.id).join(', ')}`);
    if (activeWorldBoss) return reply(`⚠️ Boss *${activeWorldBoss.name}* masih aktif!`);
    activeWorldBoss = { ...bossTemplate2, hp: bossTemplate2.maxHp, contributors: {} };
    if (isGroup) BOSS_SPAWN_GROUP = from;
    return reply(
        `🌊 *WORLD BOSS MUNCUL!*\n\n` +
        `👹 *${activeWorldBoss.name}*\n${activeWorldBoss.desc}\n\n` +
        `❤️ HP: *${formatMoney(activeWorldBoss.hp)}*\n` +
        `🎁 Reward: ${formatMoney(activeWorldBoss.reward.money)} money + ${activeWorldBoss.reward.tokens} tokens + ${activeWorldBoss.reward.tickets} tiket\n\n` +
        `⚔️ Serang dengan *!boss attack*!`
    );
}

        case "setbossgroup": {
    if (!isOwner) return;
    if (!isGroup) return reply('⚠️ Command ini hanya untuk grup!');
    BOSS_SPAWN_GROUP = from;
    return reply(`✅ Grup ini dijadikan lokasi announce boss otomatis!`);
}

        case "boss": {
    if (!activeWorldBoss) {
        if (isOwner && args[0] === 'spawn') {
            const bossId = args[1] || 'kraken_jr';
            const bossTemplate = WORLD_BOSSES.find(b => b.id === bossId);
            if (!bossTemplate) return reply(`❌ Boss tidak ditemukan. Pilih: ${WORLD_BOSSES.map(b=>b.id).join(', ')}`);
            activeWorldBoss = { ...bossTemplate, hp: bossTemplate.maxHp, contributors: {} };
            if (isGroup) BOSS_SPAWN_GROUP = from;
            return reply(`⚔️ *WORLD BOSS MUNCUL!*\n\n${activeWorldBoss.name}\n${activeWorldBoss.desc}\n\nHP: ${formatMoney(activeWorldBoss.hp)}\n\n⚔️ Kirim *!boss attack* untuk menyerang!`);
        }
        return reply(
            `🌊 *Tidak ada World Boss aktif.*\n\n` +
            `World Boss muncul secara acak atau diaktifkan admin.\n` +
            `Boss yang tersedia:\n` + WORLD_BOSSES.map(b=>`  • ${b.name}: ${b.desc}`).join('\n')
        );
    }

    if (args[0] === 'attack' || args[0] === 'serang') {
        const user = await getOrCreateUser(senderNumber, null, pushname);
        // Cek cooldown attack (1 kali per 30 detik)
        const lastAtk = (user.islandCooldowns || {})['boss_attack'] || 0;
        const atkCd   = 30000;
        if (Date.now() - lastAtk < atkCd) {
            const w8 = Math.ceil((atkCd - (Date.now()-lastAtk))/1000);
            return reply(`⏳ Cooldown serangan: *${w8} detik* lagi.`);
        }
        if (!user.islandCooldowns) user.islandCooldowns = {};
        user.islandCooldowns['boss_attack'] = Date.now();
        user.markModified('islandCooldowns');
        await user.save();

        const result = await attackWorldBoss(user, client, from);
        if (!result) return reply("❌ Boss sudah pergi!");
        if (result.bossKilled) {
            reply(`💥 *BOSS DIKALAHKAN!* Pukulan terakhirmu: *${formatMoney(result.dmg)} dmg*\n🎁 Reward sedang dibagikan!`);
        } else {
            const hpPct = ((activeWorldBoss.hp / activeWorldBoss.maxHp)*100).toFixed(1);
            reply(
                `⚔️ *Menyerang ${activeWorldBoss.name}!*\n\n` +
                `💥 Damage: *${formatMoney(result.dmg)}*\n` +
                `❤️ HP Boss: *${formatMoney(activeWorldBoss.hp)}* / ${formatMoney(activeWorldBoss.maxHp)} (${hpPct}%)`
            );
        }
    } else {
        const hpPct = ((activeWorldBoss.hp / activeWorldBoss.maxHp)*100).toFixed(1);
        const topContrib = Object.entries(activeWorldBoss.contributors)
            .sort((a,b)=>b[1]-a[1]).slice(0,5)
            .map(([id,d],i)=>`  ${i+1}. Player ${id}: ${formatMoney(d)} dmg`).join('\n') || '  Belum ada';
        reply(
            `⚔️ *WORLD BOSS AKTIF!*\n${'─'.repeat(28)}\n` +
            `👹 ${activeWorldBoss.name}\n` +
            `📝 ${activeWorldBoss.desc}\n\n` +
            `❤️ HP: *${formatMoney(activeWorldBoss.hp)}* / ${formatMoney(activeWorldBoss.maxHp)} (${hpPct}%)\n\n` +
            `🏆 *Top Kontributor:*\n${topContrib}\n\n` +
            `⚔️ Serang dengan *!boss attack*\n` +
            `🎁 Reward: ${formatMoney(activeWorldBoss.reward.money)} money + ${activeWorldBoss.reward.tokens} tokens + ${activeWorldBoss.reward.tickets} tiket`
        );
    }
    break;
}

// ════════════════════════════════════════════════════════════
//   SKIN SYSTEM COMMAND
// ════════════════════════════════════════════════════════════
        case "skin": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const ownedSkins = user.ownedSkins || ['default'];
    if (!ownedSkins.includes('default')) ownedSkins.push('default');

    if (!args[0]) {
        let txt = `🎨 *Rod Skin Shop*\n${'─'.repeat(28)}\n`;
        txt += `Skin aktif: *${ROD_SKINS[user.equippedSkin || 'default']?.emoji} ${ROD_SKINS[user.equippedSkin || 'default']?.name}*\n\n`;
        for (const [key, skin] of Object.entries(ROD_SKINS)) {
            const owned = ownedSkins.includes(key);
            const active = (user.equippedSkin || 'default') === key;
            let costTxt = '';
            if (skin.price > 0)  costTxt = `💰 ${formatMoney(skin.price)}`;
            else if (skin.gacha) costTxt = '🎰 Gacha SSR';
            else if (skin.token) costTxt = `🪙 ${skin.token} tokens`;
            else if (skin.ach)   costTxt = `🏆 ${skin.ach} ach pts`;
            else                 costTxt = 'Gratis';
            txt += `${active ? '✅' : owned ? '🔓' : '🔒'} ${skin.emoji} *${skin.name}*\n`;
            txt += `   📝 ${skin.desc} | ${costTxt}\n`;
            if (!owned) txt += `   ↳ Beli: *!skin buy ${key}*\n`;
            else if (!active) txt += `   ↳ Pakai: *!skin equip ${key}*\n`;
        }
        return reply(txt);
    }

    if (args[0] === 'buy') {
        const skinKey = args[1];
        const skin = ROD_SKINS[skinKey];
        if (!skin) return reply(`❌ Skin "${skinKey}" tidak ditemukan!`);
        if (ownedSkins.includes(skinKey)) return reply(`✅ Kamu sudah punya skin *${skin.name}*!`);
        if (!skin.price || skin.price <= 0) return reply(`❌ Skin ini tidak bisa dibeli langsung.\n${skin.gacha?'Dapatkan dari gacha!':skin.token?`Tukar di token store!`:''}`);
        if ((user.money||0) < skin.price) return reply(`💸 Uang tidak cukup! Perlu: ${formatMoney(skin.price)}, Punya: ${formatMoney(user.money)}`);
        user.money -= skin.price;
        user.ownedSkins = [...ownedSkins, skinKey];
        await user.save();
        return reply(`✅ Berhasil beli skin *${skin.emoji} ${skin.name}*!\nKetik *!skin equip ${skinKey}* untuk memakainya.`);
    }

    if (args[0] === 'equip') {
        const skinKey = args[1];
        const skin = ROD_SKINS[skinKey];
        if (!skin) return reply(`❌ Skin "${skinKey}" tidak ditemukan!`);
        if (!ownedSkins.includes(skinKey)) return reply(`❌ Kamu belum punya skin ini. Beli dulu!`);
        user.equippedSkin = skinKey;
        await user.save();
        return reply(`✅ Skin *${skin.emoji} ${skin.name}* sekarang aktif!`);
    }
    reply(`💡 Cara pakai: *!skin* (lihat toko) | *!skin buy <nama>* | *!skin equip <nama>*`);
    break;
}

// ════════════════════════════════════════════════════════════
//   BIGGESTFISH COMMAND
// ════════════════════════════════════════════════════════════
        case "biggestfish":
        case "bigfish": {
    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (!user.biggestFish) return reply("🐟 Kamu belum pernah menangkap ikan! Coba *!mancing* dulu.");
    const bf = user.biggestFish;
    const date = bf.date ? new Date(bf.date).toLocaleDateString('id-ID') : '?';
    reply(
        `🐳 *Ikan Terbesar ${user.username}*\n${'─'.repeat(28)}\n\n` +
        `🐟 Nama: *${bf.name}*\n` +
        `⚖️ Berat: *${bf.kg} kg*\n` +
        `💰 Nilai: *${formatMoney(bf.price)}*\n` +
        `📅 Ditangkap: ${date}\n\n` +
        `💡 Tangkap ikan lebih berat untuk memecahkan rekor!`
    );
    break;
}

// ════════════════════════════════════════════════════════════
//   EVENT SYSTEM (Admin)
// ════════════════════════════════════════════════════════════
        case "setweather":
        case "weather": {
    if (!args[0]) {
        // Info cuaca saat ini (semua orang bisa lihat)
        const w = CURRENT_WEATHER;
        const tl = w.expiresAt ? w.expiresAt - Date.now() : null;
        const h  = tl ? Math.floor(tl / 3600000) : 0;
        const m  = tl ? Math.floor((tl % 3600000) / 60000) : 0;

        let txt = `🌦️ *Cuaca Saat Ini*\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        txt += `${w.name}\n`;
        txt += `📝 ${w.desc}\n\n`;
        txt += `🍀 Luck Mult  : *×${(w.luckMult || 1).toFixed(2)}*\n`;
        txt += `⚡ Speed Mult : *×${(w.speedMult || 1).toFixed(2)}*\n`;
        if (w.mutationBonus) txt += `🧬 Mutation   : *+${(w.mutationBonus*100).toFixed(1)}%*\n`;
        if (Object.keys(w.rarityBoost || {}).length) {
            const boosts = Object.entries(w.rarityBoost).map(([r,v]) => `${r} ×${v}`).join(', ');
            txt += `✨ Rarity Boost: ${boosts}\n`;
        }
        if (tl && tl > 0) txt += `\n⏳ Berganti dalam: *${h}j ${m}m*`;

        return reply(txt);
    }

    if (!isOwner && !isAdmin(senderNumber, m)) return;

    const weatherKey = args[0].toLowerCase();
    if (weatherKey === 'random') {
        const keys = Object.keys(WEATHERS);
        const chosen = keys[Math.floor(Math.random() * keys.length)];
        CURRENT_WEATHER = { key: chosen, ...WEATHERS[chosen], expiresAt: Date.now() + 2 * 3600000 };
        return reply(`🌦️ Cuaca diganti ke *${CURRENT_WEATHER.name}* secara random!\n⏳ Berlaku 2 jam.`);
    }

    if (!WEATHERS[weatherKey]) {
        const list = Object.keys(WEATHERS).join(', ');
        return reply(`❌ Cuaca tidak valid!\nPilihan: ${list}, random`);
    }

    // Parse durasi opsional: !setweather stormy 1h
    let durMs = 2 * 3600000; // default 2 jam
    if (args[1]) {
        const durMatch = args[1].toLowerCase().match(/^([\d.]+)(s|m|h)$/);
        if (durMatch) {
            const v = parseFloat(durMatch[1]);
            durMs = durMatch[2] === 's' ? v*1000 : durMatch[2] === 'm' ? v*60000 : v*3600000;
        }
    }
    const durH = (durMs / 3600000).toFixed(1);

    CURRENT_WEATHER = { key: weatherKey, ...WEATHERS[weatherKey], expiresAt: Date.now() + durMs };
    setTimeout(() => {
        // Kembalikan ke sunny setelah durasi
        CURRENT_WEATHER = { key: 'sunny', ...WEATHERS.sunny, expiresAt: Date.now() + 2*3600000 };
    }, durMs);

    return reply(
        `✅ Cuaca diubah ke *${CURRENT_WEATHER.name}*!\n` +
        `⏳ Durasi: *${durH} jam*\n` +
        `🍀 Luck ×${(CURRENT_WEATHER.luckMult||1).toFixed(2)} | ⚡ Speed ×${(CURRENT_WEATHER.speedMult||1).toFixed(2)}`
    );
}

// ════════════════════════════════════════════════════════════
//   !event — cek status event yang sedang aktif (semua user)
// ════════════════════════════════════════════════════════════
        case "event": {
    const formatTimeLeft = (ms) => {
        if (ms <= 0) return "Habis";
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return h > 0 ? `${h}j ${m}m` : m > 0 ? `${m}m ${s}d` : `${s}d`;
    };

    const _now = Date.now();
    const moneyActive  = ACTIVE_EVENT.active      && _now < new Date(ACTIVE_EVENT.endTime);
    const luckActive   = GLOBAL_LUCK_EVENT.active && _now < GLOBAL_LUCK_EVENT.endTime;
    const goblinActive = RAIN_GOBLIN_EVENT.active && _now < RAIN_GOBLIN_EVENT.endTime;
    const gsActive     = GOLDEN_SHOP_EVENT.active && _now < GOLDEN_SHOP_EVENT.endTime;
    const anyActive    = moneyActive || luckActive || goblinActive || gsActive;

    let txt = `🎪 *Status Event*\n━━━━━━━━━━━━━━━━━━━━━━`;

    if (!anyActive) {
        txt += `\n\n📅 _Tidak ada event aktif saat ini._`;
    } else {
        if (goblinActive) {
            const tl = RAIN_GOBLIN_EVENT.endTime - _now;
            txt += `\n\n🐸 *Raining Goblin* — ⏳ ${formatTimeLeft(tl)}`;
            txt += `\nSetiap pancingan pasti dapat *Goblin ×999.999*! 🎣`;
        }
        if (gsActive) {
            const tl = GOLDEN_SHOP_EVENT.endTime - _now;
            txt += `\n\n🛒 *Golden Shop* — ⏳ ${formatTimeLeft(tl)}`;
            txt += `\n×${GOLDEN_SHOP_EVENT.multiplier} saat menjual ikan 💰`;
        }
        if (luckActive) {
            const tl = GLOBAL_LUCK_EVENT.endTime - _now;
            txt += `\n\n🍀 *×${GLOBAL_LUCK_EVENT.multiplier} Luck Event* — ⏳ ${formatTimeLeft(tl)}`;
            txt += `\nSemua pemain dapat boost luck ×${GLOBAL_LUCK_EVENT.multiplier} 🎣`;
        }
        if (moneyActive) {
            const tl = new Date(ACTIVE_EVENT.endTime) - _now;
            txt += `\n\n💰 *${ACTIVE_EVENT.name}* — ⏳ ${formatTimeLeft(tl)}`;
            if (ACTIVE_EVENT.multiplier > 1) txt += `\n×${ACTIVE_EVENT.multiplier} bonus uang dari mancing 🐟`;
            if (ACTIVE_EVENT.bonusMutation > 0) txt += `\n+${(ACTIVE_EVENT.bonusMutation*100).toFixed(0)}% peluang mutasi 🧬`;
        }
        if (FORCED_JACKPOT_MAP.size > 0) {
            const gm = FORCED_JACKPOT_MAP.get('ALL');
            if (gm) txt += `\n\n🎲 _Jackpot global: ${gm.toUpperCase()}_`;
        }
    }

    return reply(txt);
}

// ════════════════════════════════════════════════════════════
//   !setevent — admin: aktifkan/matikan event (hanya admin)
//   Format:
//     !setevent start <nama> <jam> <mult>  — bonus money event
//     !setevent stop                       — hentikan bonus money event
//     !setevent luck <mult> <durasi>       — global luck event
//     !setevent luck off                   — matiin luck event
//     !setevent goblin <durasi>            — raining goblin mutation
//     !setevent goblin off                 — matiin goblin
//     !setevent goldenshop <mult> <durasi> — golden shop sell bonus
//     !setevent goldenshop off             — matiin golden shop
// ════════════════════════════════════════════════════════════
        case "setevent": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;

    if (!args[0]) {
        return reply(
            `🎪 *Set Event (Admin)*\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `*Bonus Money Event:*\n` +
            `• setevent start <nama> <jam> <mult>\n` +
            `• setevent stop\n\n` +
            `*Global Luck:*\n` +
            `• setevent luck <mult> <durasi>  (misal: 2 1h)\n` +
            `• setevent luck off\n\n` +
            `*Raining Goblin (mutasi):*\n` +
            `• setevent goblin <durasi>  (misal: 30m)\n` +
            `• setevent goblin off\n\n` +
            `*Golden Shop (sell bonus):*\n` +
            `• setevent goldenshop <mult> <durasi>  (misal: 2 1h)\n` +
            `• setevent goldenshop off\n\n` +
            `_Durasi: 30s · 10m · 2h · 1d_`
        );
    }

    const sub = args[0].toLowerCase();

    // ── Helper parse durasi ──────────────────────────────────
    function parseDurasi(str) {
        const m = (str || '').toLowerCase().match(/^([\d.]+)(s|m|h|d)$/);
        if (!m) return null;
        const v = parseFloat(m[1]);
        const ms = m[2] === 's' ? v*1000 : m[2] === 'm' ? v*60000 : m[2] === 'h' ? v*3600000 : v*86400000;
        const label = m[2] === 's' ? `${v} detik` : m[2] === 'm' ? `${v} menit` : m[2] === 'h' ? `${v} jam` : `${v} hari`;
        return { ms, label };
    }

    // ── start / stop (bonus money event) ────────────────────
    if (sub === 'start') {
        const name  = args[1] || 'Bonus Event';
        const hours = parseFloat(args[2]) || 24;
        const mult  = parseFloat(args[3]) || 2;
        ACTIVE_EVENT = {
            active: true, name,
            desc: `Event spesial selama ${hours} jam!`,
            multiplier: mult, bonusMutation: 0.05,
            endTime: new Date(Date.now() + hours * 3600000),
        };
        setTimeout(() => { ACTIVE_EVENT.active = false; saveBotConfig(); console.log('[EVENT] ended'); }, hours * 3600000);
        saveBotConfig();
        return reply(`✅ Event *${name}* dimulai!\n⏳ Durasi: ${hours} jam\n💰 Bonus: ×${mult}`);
    }

    if (sub === 'stop') {
        ACTIVE_EVENT.active = false;
        saveBotConfig();
        return reply('✅ Bonus money event dihentikan.');
    }

    // ── luck ─────────────────────────────────────────────────
    if (sub === 'luck') {
        if (args[1]?.toLowerCase() === 'off') {
            GLOBAL_LUCK_EVENT.active = false;
            saveBotConfig();
            return reply('✅ Global luck event dimatikan.');
        }
        const mult = parseFloat(args[1]);
        if (isNaN(mult) || mult <= 0) return reply('❌ Format: *!setevent luck <mult> <durasi>*\nContoh: !setevent luck 2 30m');
        const dur = parseDurasi(args[2]);
        if (!dur) return reply('❌ Format durasi salah. Contoh: 30s · 10m · 2h · 1d');
        if (dur.ms < 1000 || dur.ms > 24 * 3600000) return reply('❌ Durasi minimal 1 detik, maksimal 24 jam.');
        GLOBAL_LUCK_EVENT.active = true;
        GLOBAL_LUCK_EVENT.multiplier = mult;
        GLOBAL_LUCK_EVENT.endTime = Date.now() + dur.ms;
        GLOBAL_LUCK_EVENT.setBy = pushname;
        setTimeout(() => { GLOBAL_LUCK_EVENT.active = false; saveBotConfig(); }, dur.ms);
        saveBotConfig();
        return reply(
            `🍀 *GLOBAL LUCK EVENT AKTIF!*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✨ Luck semua pemain: *×${mult}*\n` +
            `⏱️ Durasi: *${dur.label}*\n` +
            `👤 Diaktifkan oleh: ${pushname}`
        );
    }

    // ── goblin (raining goblin mutation) ────────────────────
    if (sub === 'goblin') {
        if (args[1]?.toLowerCase() === 'off') {
            RAIN_GOBLIN_EVENT.active = false;
            mutations["Goblin"] = { multiplier: 999999, chance: 0 };
            saveBotConfig();
            return reply('✅ Event Raining Goblin dihentikan. Mutasi kembali normal.');
        }
        const dur = parseDurasi(args[1]);
        if (!dur) return reply('❌ Format durasi salah. Contoh: 30m · 2h · 1d');
        if (dur.ms < 1000) return reply('❌ Durasi minimal 1 detik.');
        if (dur.ms > 7 * 86400000) return reply('❌ Durasi maksimal 7 hari.');
        RAIN_GOBLIN_EVENT.active = true;
        RAIN_GOBLIN_EVENT.endTime = Date.now() + dur.ms;
        mutations["Goblin"] = { multiplier: 999999, chance: 1.0 };
        setTimeout(() => {
            RAIN_GOBLIN_EVENT.active = false;
            mutations["Goblin"] = { multiplier: 999999, chance: 0 };
            saveBotConfig();
            console.log('[EVENT] Raining Goblin berakhir');
        }, dur.ms);
        saveBotConfig();
        return reply(
            `🐸 *EVENT: RAINING GOBLIN!*\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Setiap pancingan *pasti* dapat mutasi 🐸 *Goblin*!\n` +
            `💥 Multiplier: *×999.999*\n` +
            `⏳ Durasi: *${dur.label}*\n\n` +
            `_Ketik !setevent goblin off untuk menghentikan._`
        );
    }

    // ── goldenshop ───────────────────────────────────────────
    if (sub === 'goldenshop') {
        if (args[1]?.toLowerCase() === 'off') {
            GOLDEN_SHOP_EVENT.active = false;
            saveBotConfig();
            return reply('✅ *Golden Shop Event* dihentikan. Sell multiplier kembali normal.');
        }
        const mult = parseFloat(args[1]);
        if (isNaN(mult) || mult <= 0) return reply('❌ Format: *!setevent goldenshop <mult> <durasi>*\nContoh: !setevent goldenshop 2 1h');
        const dur = parseDurasi(args[2]);
        if (!dur) return reply('❌ Format durasi salah. Contoh: 30m · 2h · 1d');
        if (dur.ms < 1000) return reply('❌ Durasi minimal 1 detik.');
        if (dur.ms > 7 * 86400000) return reply('❌ Durasi maksimal 7 hari.');
        GOLDEN_SHOP_EVENT.active = true;
        GOLDEN_SHOP_EVENT.multiplier = mult;
        GOLDEN_SHOP_EVENT.endTime = Date.now() + dur.ms;
        setTimeout(() => {
            GOLDEN_SHOP_EVENT.active = false;
            saveBotConfig();
            console.log('[EVENT] Golden Shop berakhir');
        }, dur.ms);
        saveBotConfig();
        return reply(
            `🛒 *EVENT: GOLDEN SHOP!*\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `Semua penjualan ikan mendapat bonus *×${mult}*!\n` +
            `⏳ Durasi: *${dur.label}*\n\n` +
            `_Ketik !setevent goldenshop off untuk menghentikan._`
        );
    }

    return reply('❌ Sub-command tidak dikenal.\nKetik *!setevent* untuk lihat daftar perintah.');
}

// ════════════════════════════════════════════════════════════
//   BUANG UANG / SINK
// ════════════════════════════════════════════════════════════
        case "jackpot": {
    if (PRESTIGE_SYSTEM_DISABLED) return;
    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (!args[0]) {
        return reply(
            `🎲 *Jackpot Gamble*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
            `Taruhan uangmu! Kemungkinan menang *40%*.\n` +
            `Menang: dapat *2.5x*\n` +
            `Kalah: kehilangan uang yang ditaruh\n\n` +
            `Format: *!jackpot <jumlah>*\nContoh: *!jackpot 1B*`
        );
    }
    const bet = parseAmount(args[0]);
    if (isNaN(bet) || bet <= 0) return reply('❌ Jumlah taruhan tidak valid!');
    if (bet > (user.money || 0)) return reply(`💸 Uang tidak cukup! Punya: *${formatMoney(user.money)}*`);
    const minBet = 1000000;
    if (bet < minBet) return reply(`❌ Taruhan minimum *${formatMoney(minBet)}*.`);

    const _forcedJackpot = FORCED_JACKPOT_MAP.get(senderNumber)
        || FORCED_JACKPOT_MAP.get(String(user.id))
        || FORCED_JACKPOT_MAP.get('ALL')
        || null;
    const win = _forcedJackpot === 'win' ? true
              : _forcedJackpot === 'lose' ? false
              : Math.random() < 0.40;
    if (win) {
        const gain = Math.floor(bet * 2.5);
        user.money = (user.money || 0) - bet + gain;
        await user.save();
        reply(`🎲 *MENANG!* 🎉\n\n💰 Taruhan: ${formatMoney(bet)}\n💵 Dapat: *+${formatMoney(gain)}*\n💰 Saldo: *${formatMoney(user.money)}*`);
    } else {
        user.money = (user.money || 0) - bet;
        await user.save();
        reply(`🎲 *KALAH!*\n\n💰 Taruhan: ${formatMoney(bet)}\n💸 Hilang: *-${formatMoney(bet)}*\n💰 Saldo: *${formatMoney(user.money)}*`);
    }
    break;
}

        case "ytta": {
    if (!isOwner) return;
    try {
        // API langsung return raw image bytes
        const res = await axios.get('https://api.danzy.web.id/api/random/yuri', { responseType: 'arraybuffer' });
        const buf = Buffer.from(res.data);
        await client.sendMessage(m.chat, { image: buf, caption: '🌸' }, { quoted: m });
    } catch (e) {
        console.error(e);
        reply(`❌ Gagal: ${e.message}`);
    }
    break;
}

        case "cekadmin": {
    const status = isAdmin(senderNumber, m);
    reply(
        `🔍 *Cek Status Admin*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 Nomor: *${senderNumber}*\n` +
        `🔑 Status: ${status ? '*✅ ADMIN*' : '*❌ Bukan Admin*'}`
    );
    break;
}

        case "cekowner": {
    reply(
        `🔍 *Cek Status Owner*\n━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 Nomor: *${senderNumber}*\n` +
        `👑 Status: ${isOwner ? '*✅ OWNER*' : '*❌ Bukan Owner*'}`
    );
    break;
}

        case "addadminbot": {
    if (!isOwner) return;
    const target = args[0]?.replace(/[^0-9]/g, '');
    if (!target) return;
    if (!config.admins) config.admins = [];
    if (config.admins.includes(target)) return;
    config.admins.push(target);
    // Simpan ke file config agar persistent
    try {
        const configPath = require('path').join(__dirname, './settings/config.js');
        let configContent = require('fs').readFileSync(configPath, 'utf8');
        // Update array admins di file config
        const newAdminsStr = JSON.stringify(config.admins);
        configContent = configContent.replace(/admins\s*:\s*\[.*?\]/s, `admins: ${newAdminsStr}`);
        require('fs').writeFileSync(configPath, configContent, 'utf8');
        reply(`✅ *${target}* berhasil ditambahkan sebagai admin bot!`);
    } catch (e) {
        console.error(e);
        reply(`⚠️ Admin ditambahkan sementara (gagal simpan ke config): ${e.message}`);
    }
    break;
}

        case "hapusadminbot": {
    if (!isOwner) return;
    const target = args[0]?.replace(/[^0-9]/g, '');
    if (!target) return;
    if (!config.admins) config.admins = [];
    // Cek hardcoded dulu sebelum cek di config.admins
    if (HARDCODED_ADMINS.some(a => String(a).replace(/\D/g, "") === target)) return;
    const idx = config.admins.findIndex(a => String(a).replace(/\D/g, "") === target);
    if (idx === -1) return;
    config.admins.splice(idx, 1);
    try {
        const configPath = require('path').join(__dirname, './settings/config.js');
        let configContent = require('fs').readFileSync(configPath, 'utf8');
        const newAdminsStr = JSON.stringify(config.admins);
        configContent = configContent.replace(/admins\s*:\s*\[.*?\]/s, `admins: ${newAdminsStr}`);
        require('fs').writeFileSync(configPath, configContent, 'utf8');
        reply(`✅ *${target}* berhasil dihapus dari daftar admin bot!`);
    } catch (e) {
        console.error(e);
        reply(`⚠️ Admin dihapus sementara (gagal simpan ke config): ${e.message}`);
    }
    break;
}

        case "listadmin": {
    if (!isOwner) return;
    const configAdmins = config.admins || [];
    let text = `👑 *Daftar Admin Bot*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    if (configAdmins.length === 0) {
        text += `  (belum ada admin yang ditambahkan)`;
    } else {
        configAdmins.forEach((a, i) => { text += `  ${i+1}. ${a}\n`; });
    }
    reply(text.trim());
    break;
}

        case "donate": {
    // Sink uang ke season prize pool atau "dewa laut"
    if (PRESTIGE_SYSTEM_DISABLED) return;
    const user = await getOrCreateUser(senderNumber, null, pushname);
    if (!args[0]) return reply(`💝 *Donasi ke Dewa Laut*\n\nKorbankan uangmu untuk mendapat EXP & Season Points!\nSetiap 1M yang didonasikan = 100 Season Points.\n\nFormat: *!donate <jumlah>*`);
    const amount = parseAmount(args[0]);
    if (isNaN(amount) || amount <= 0) return reply('❌ Jumlah tidak valid!');
    if (amount > (user.money || 0)) return reply('💸 Uang tidak cukup!');
    const pts = Math.floor(amount / 1000000) * 100;
    user.money -= amount;
    user.seasonPoints = (user.seasonPoints || 0) + pts;
    await user.save();
    reply(`💝 Donasi *${formatMoney(amount)}* ke Dewa Laut!\n\n🏆 +${formatMoney(pts)} Season Points\n💰 Saldo: *${formatMoney(user.money)}*`);
    break;
}

        case "rodupgrade": {
    // Fitur ini sudah dihapus — gunakan !upgrade
    return reply(`⚠️ Perintah *!rodupgrade* sudah dihapus.\nGunakan *!upgrade* untuk upgrade stats permanen (Luck, Speed, Sell) yang melekat ke akun kamu, bukan ke rod.`);
}

        case "stats": {
    // Lihat upgrade stats
    const user = await getOrCreateUser(senderNumber, null, pushname);
    const rod  = user.fishingRods.get(user.usedFishingRod);
    const { luck, speed, sellMultiplier, goldenShopMult } = getUpgradedStats(user, rod || {});
    let text = `📊 *Stats ${user.username}*\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `🎖️ Title: *${user.title || 'Pemancing Baru'}*\n`;
    text += `👑 Prestige: *${user.prestige || 0}*\n`;
    text += `🪙 Tokens: *${user.prestigeTokens || 0}*\n`;
    text += `🎟️ Tiket Gacha: *${user.gachaTickets || 0}*\n`;
    text += `🔥 Daily Streak: *${user.dailyStreak || 0}*\n\n`;
    text += `📈 *Upgrade Permanen:*\n`;
    text += `  🍀 Luck: +${((UPGRADES.luck.effect(user.luckUpgrade||0))*100).toFixed(0)}% (Lv.${user.luckUpgrade||0})\n`;
    text += `  ⚡ Speed: +${((UPGRADES.speed.effect(user.speedUpgrade||0))*100).toFixed(0)}% (Lv.${user.speedUpgrade||0})\n\n`;
    text += `🎣 *Total Stats (rod+upgrade):*\n`;
    text += `  🍀 Luck: ${(luck*100).toFixed(1)}%\n`;
    text += `  ⚡ Speed: ${(speed*100).toFixed(1)}%\n`;
    const totalSellMult = (1 + sellMultiplier) * goldenShopMult;
    text += `  💰 Sell: x${totalSellMult.toFixed(2)}`;
    if (goldenShopMult > 1) text += ` *(×${goldenShopMult} Golden Shop Event aktif!)*`;
    text += `\n\n`;
    text += `🏆 *Season:*\n`;
    text += `  🏅 Poin: *${formatMoney(user.seasonPoints || 0)}*\n`;
    text += `  🏆 Season Wins: *${user.seasonWins || 0}*`;
    reply(text);
    break;
}

        case "setloggroup": {
    if (!isOwner) return reply('⛔ Hanya owner bot yang bisa menggunakan command ini.');

    if (q.trim().toLowerCase() === 'off') {
        global.LOG_GROUP_JID = null;
        await saveBotConfig();
        return reply('✅ Grup log dinonaktifkan. Log anti tidak akan dikirim ke mana-mana.');
    }

    // Jika dipakai di dalam grup, langsung set grup ini
    const targetJid = q.trim() || (isGroup ? from : null);
    if (!targetJid) return reply('⚠️ Gunakan command ini di dalam grup log, atau ketik JID grupnya.\nContoh: .setloggroup 120363xxx@g.us');

    global.LOG_GROUP_JID = targetJid;
    await saveBotConfig();
    return reply(
        `✅ *Grup log berhasil diset!*\n\n` +
        `🏠 JID: ${targetJid}\n\n` +
        `Semua pesan yang dihapus bot (antilink, antiswgc, dll) akan dikirim ke grup ini.`
    );
}


        case "kick":
        case "purge":
        case "kickpurge": {
    if (!isOwner && !isAdmins) return reply('❌ Command ini hanya untuk owner bot atau admin grup.');
    if (!isGroup) return reply('❌ Hanya bisa digunakan di dalam grup.');
    if (!isBotAdmins) return reply('❌ Bot harus jadi admin grup dulu.');

    // Ambil target: dari mention atau reply
    const mentionedJids = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    let targetJid = mentionedJids[0] || null;
    if (!targetJid && m.quoted) {
        targetJid = m.quoted.sender || m.quoted.key?.participant || null;
    }
    if (!targetJid) return reply('❌ Tag atau reply pesan orang yang mau di-' + command + '.');

    const targetNum = await resolveSenderNumber(targetJid, from);
    const targetFull = targetNum.includes('@') ? targetNum : targetNum + '@s.whatsapp.net';

    // ── Admin grup (non-owner) tidak boleh kick sesama admin ──
    if (!isOwner && isAdmins) {
        const targetNumNorm = targetNum.replace(/\D/g, '');
        const targetIsAdmin = groupAdmins.some(a => _resolveAdminNum(a) === targetNumNorm);
        if (targetIsAdmin) return reply('❌ Admin tidak bisa kick/purge sesama admin grup.');
    }

    // ── KICK dulu (kickpurge) ─────────────────────────────
    if (command === 'kick' || command === 'kickpurge') {
        try {
            await client.groupParticipantsUpdate(from, [targetFull], 'remove');
            await reply(`✅ @${targetNum} telah dikick dari grup.`, { mentions: [targetFull] });
        } catch (e) {
            await reply(`❌ Gagal kick @${targetNum}: ${e.message}`);
        }
    }

    // ── PURGE setelah kick ────────────────────────────────
    if (command === 'purge' || command === 'kickpurge') {
        const cached = global.MSG_CACHE?.[from]?.[targetNum] || [];
        if (cached.length === 0) {
            await client.sendMessage(from, { text: `⚠️ Tidak ada pesan tercache dari @${targetNum}.`, mentions: [targetFull] }, { quoted: m });
        } else {
            await client.sendMessage(from, { text: `🗑️ Menghapus *${cached.length}* pesan dari @${targetNum}...`, mentions: [targetFull] }, { quoted: m });
            let deleted = 0;
            for (const key of cached) {
                try {
                    // Per dokumentasi @itsliaaa/baileys: sendMessage(jid, { delete: message.key })
                    // key yang di-cache udah persis berbentuk { id, remoteJid, participant, fromMe }
                    await client.sendMessage(from, { delete: key });
                    deleted++;
                    await new Promise(r => setTimeout(r, 300));
                } catch (_) {}
            }
            // Bersihkan cache
            if (global.MSG_CACHE?.[from]) delete global.MSG_CACHE[from][targetNum];
            await reply(`✅ Selesai — *${deleted}/${cached.length}* pesan dihapus.`);
        }
    }

    break;
}

        case "antilink":
        case "antiswgc":
        case "antitagall":
        case "antigsm": {
    if (!isOwner) return;

    const feature = command; // 'antilink' | 'antiswgc' | 'antitagall' | 'antigsm'
    const LABEL   = { antilink: '🔗 Anti Link', antiswgc: '📢 Anti SWGC', antitagall: '📣 Anti Tag All', antigsm: '📌 Anti GSM' };
    const DESC    = {
        antilink:   'Member yang kirim link',
        antiswgc:   'Siapapun yang kirim Group Status (SW GC)',
        antitagall: 'Member yang tag @all / @everyone',
        antigsm:    'Member yang kirim Status Mention ke grup',
    };

    // ── Parse argumen: support remote (JID sebagai arg pertama) ──
    // !antiswgc on               → grup saat ini
    // !antiswgc 1234@g.us on     → remote ke grup lain
    let targetJid = from;
    let subArg    = (args[0] || '').toLowerCase();

    if (args[0]?.endsWith('@g.us')) {
        targetJid = args[0];
        subArg    = (args[1] || '').toLowerCase();
    }

    const STATE_MAP   = { antilink: global.ANTILINK_STATE,   antiswgc: global.ANTISWGC_STATE,   antitagall: global.ANTITAGALL_STATE,   antigsm: global.ANTIGSM_STATE   };
    const WARNLIM_MAP = { antilink: global.ANTILINK_WARN_LIMIT, antiswgc: global.ANTISWGC_WARN_LIMIT, antitagall: global.ANTITAGALL_WARN_LIMIT, antigsm: global.ANTIGSM_WARN_LIMIT };

    if (!['on', 'off'].includes(subArg)) {
        const currentState = STATE_MAP[feature]?.[targetJid] ?? false;
        const currentWarn  = WARNLIM_MAP[feature]?.[targetJid] ?? 0;
        const isRemote     = targetJid !== from;
        let targetGroupName = '';
        if (isRemote) {
            try {
                const meta = await client.groupMetadata(targetJid).catch(() => null);
                targetGroupName = meta?.subject || '';
            } catch (_) {}
        }
        const _remoteInfo = isRemote ? ('🎯 Grup target: *' + (targetGroupName || targetJid) + '*\n`' + targetJid + '`\n') : '';
        return reply(
            `${LABEL[feature]}\n\n` +
            _remoteInfo +
            `Status: *${currentState ? '✅ ON' : '❌ OFF'}*\n` +
            `Mode: *${
                feature === 'antiswgc'
                    ? (currentWarn === 0 ? 'Langsung kick (0)' : `${currentWarn} warn lalu kick`)
                    : (currentWarn === -1 ? 'Langsung kick (-1)' : currentWarn === 0 ? 'Hanya hapus pesan (0)' : `${currentWarn} warn lalu kick`)
            }*\n\n` +
            `*Format:*\n` +
            `• *!${command} on* — aktifkan\n` +
            `• *!${command} off* — matikan\n` +
            `• *!${command} <JID> on/off* — remote ke grup lain\n` +
            `• *!warn${command.replace('anti','')} <angka>* — set warn limit\n` +
            `• *!warn${command.replace('anti','')} <JID> <angka>* — remote warn limit\n` +
            `_${feature === 'antiswgc' ? '0 = langsung kick' : '0 = hanya hapus pesan, -1 = langsung kick'}, 1–10 = jumlah warn sebelum kick_`
        );
    }

    const newState = subArg === 'on';
    await setAntiFeature(feature, targetJid, newState);

    const warnNow  = WARNLIM_MAP[feature]?.[targetJid] ?? 0;
    const isRemote = targetJid !== from;
    let _targetGroupName = '';
    if (isRemote) {
        try { const _meta = await client.groupMetadata(targetJid).catch(() => null); _targetGroupName = _meta?.subject || ''; } catch (_) {}
    }

    const _remoteInfoOn  = isRemote ? ('🎯 Grup: *' + (_targetGroupName || targetJid) + '*\n`' + targetJid + '`\n') : '';
    const _remoteInfoOff = isRemote ? ('\n🎯 Grup: *' + (_targetGroupName || targetJid) + '*\n`' + targetJid + '`') : '';
    reply(
        newState
            ? `✅ *${LABEL[feature]} diaktifkan!*\n\n` +
              _remoteInfoOn +
              `${DESC[feature]} akan ${feature === 'antiswgc' ? (warnNow === 0 ? '*langsung di-kick*' : `mendapat *${warnNow} peringatan* lalu di-kick`) : (warnNow === -1 ? '*langsung di-kick*' : warnNow === 0 ? '*hanya dihapus pesannya*' : `mendapat *${warnNow} peringatan* lalu di-kick`)}.\n` +
              `_(Admin grup & bot admin dikecualikan)_\n\n` +
              `Gunakan *!warn${command.replace('anti','')} <angka>* untuk atur warn limit.`
            : `❌ *${LABEL[feature]} dimatikan!*\n` + _remoteInfoOff
    );
    break;
}

        case "welcome": {
    if (!isOwner) return;

    const subArg = (args[0] || '').toLowerCase();

    // !welcome              → cek status & bantuan
    if (!['on', 'off', 'setmsg', 'test'].includes(subArg)) {
        const currentState = global.WELCOME_STATE?.[from] ?? false;
        const customMsg    = global.WELCOME_MSG?.[from];
        return reply(
            `👋 *Welcome Message*\n\n` +
            `Status: *${currentState ? '✅ ON' : '❌ OFF'}*\n\n` +
            `*Format:*\n` +
            `• *!welcome on* — aktifkan\n` +
            `• *!welcome off* — matikan\n` +
            `• *!welcome setmsg <teks>* — atur pesan custom\n` +
            `  Variabel: *@user* (tag member), *@group* (nama grup), *@count* (jumlah member)\n` +
            `• *!welcome test* — tes pesan welcome (kamu sebagai member baru)\n\n` +
            (customMsg
                ? `*Pesan saat ini:*\n${customMsg}`
                : `_Belum ada pesan custom, pakai default._`)
        );
    }

    if (subArg === 'setmsg') {
        const text = args.slice(1).join(' ');
        if (!text) return reply(`❌ Kirim teksnya juga, contoh:\n*!welcome setmsg Selamat datang @user di @group! Kita sekarang ada @count member 🎉*`);
        if (!global.WELCOME_MSG) global.WELCOME_MSG = {};
        global.WELCOME_MSG[from] = text;
        try {
            await AntiFeature.findByIdAndUpdate(`welcome:${from}`, { $set: { feature: 'welcome', groupJid: from, welcomeMsg: text } }, { upsert: true });
        } catch (e) { console.error('[welcome] Gagal simpan pesan:', e.message); }
        return reply(`✅ Pesan welcome custom disimpan!\n\nCoba tes: *!welcome test*`);
    }

    if (subArg === 'test') {
        await handleGroupParticipantsUpdate(client, from, [m.sender], 'add');
        return;
    }

    const newState = subArg === 'on';
    await setAntiFeature('welcome', from, newState);
    reply(newState
        ? `✅ *Welcome message diaktifkan!*\n\nSetiap ada member baru join, bot akan otomatis menyapa & mention.`
        : `❌ *Welcome message dimatikan!*`
    );
    break;
}

        case "warnlink":
        case "warnswgc":
        case "warntagall":
        case "warngsm": {
    if (!isOwner) return;

    // Map command → feature
    const featureMap = { warnlink: 'antilink', warnswgc: 'antiswgc', warntagall: 'antitagall', warngsm: 'antigsm' };
    const feature    = featureMap[command];
    const LABEL      = { antilink: '🔗 Anti Link', antiswgc: '📢 Anti SWGC', antitagall: '📣 Anti Tag All', antigsm: '📌 Anti GSM' };

    // ── Parse argumen: support remote ──
    // !warnswgc 3            → grup saat ini, warn = 3
    // !warnswgc 1234@g.us 3  → remote ke grup lain, warn = 3
    let targetJid  = from;
    let warnArgRaw = args[0];

    if (args[0]?.endsWith('@g.us')) {
        targetJid  = args[0];
        warnArgRaw = args[1];
    }

    const WARNLIM_MAP = { antilink: global.ANTILINK_WARN_LIMIT, antiswgc: global.ANTISWGC_WARN_LIMIT, antitagall: global.ANTITAGALL_WARN_LIMIT, antigsm: global.ANTIGSM_WARN_LIMIT };
    const isRemote    = targetJid !== from;

    if (!warnArgRaw) {
        const currentWarn = WARNLIM_MAP[feature]?.[targetJid] ?? 0;
        return reply(
            `⚠️ *Warn Limit — ${LABEL[feature]}*\n\n` +
            `${isRemote ? `🎯 Grup: \`${targetJid}\`\n` : ''}` +
            `Saat ini: *${currentWarn === -1 ? 'Langsung kick (-1)' : currentWarn === 0 ? 'Hanya hapus pesan (0)' : `${currentWarn} warn sebelum kick`}*\n\n` +
            `Format: *!${command} <angka>*\n` +
            `• *!${command} -1* — langsung kick (tanpa warn)\n` +
            `• *!${command} 0* — hanya hapus pesan (tanpa kick)\n` +
            `• *!${command} 1* — 1 warn, warn ke-2 kick\n` +
            `• *!${command} 3* — 3 warn, warn ke-4 kick\n\n` +
            `Remote: *!${command} <JID> <angka>*`
        );
    }

    const newLimit = parseInt(warnArgRaw);
    if (isNaN(newLimit) || newLimit < -1 || newLimit > 10)
        return reply('❌ Angka tidak valid! Gunakan -1, 0, atau 1–10.\n_-1 = langsung kick, 0 = hanya hapus pesan, 1–10 = jumlah warn sebelum kick._');

    await setAntiWarnLimit(feature, targetJid, newLimit);

    reply(
        newLimit === -1
            ? `✅ *Warn limit diset ke -1*\n${isRemote ? `\n🎯 Grup: \`${targetJid}\`\n` : ''}Member akan *langsung di-kick* tanpa peringatan.\n_Semua warn counter direset._`
            : newLimit === 0
            ? `✅ *Warn limit diset ke 0*\n${isRemote ? `\n🎯 Grup: \`${targetJid}\`\n` : ''}Pesan akan *dihapus saja* (tidak kick).\n_Semua warn counter direset._`
            : `✅ *Warn limit diset ke ${newLimit}*\n${isRemote ? `\n🎯 Grup: \`${targetJid}\`\n` : ''}Member dapat *${newLimit} peringatan* sebelum di-kick.\n_Semua warn counter direset._`
    );
    break;
}

        // ─────────────────────────────────────────────────────────
        //  AUTO JPM TAG  — kirim STATUS WA + mention grup, repeat tiap X waktu
        //
        //  !autoswgc all <interval>       — status + mention SEMUA grup, repeat
        //  !autoswgc <JID@g.us> <interval>— status + mention 1 grup, repeat
        //  !autoswgc stop                 — hentikan
        //  !autoswgc                      — cek status
        //
        //  Contoh:
        //  !autoswgc all 1m         → status WA mention semua grup, tiap 1 menit
        //  !autoswgc 120363@g.us 2m → status WA mention 1 grup, tiap 2 menit
        //
        // ─────────────────────────────────────────────────────────


        case "autoswgc": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;


    if (!global.JPM_RUNNING) global.JPM_RUNNING = {};
    const botNumber = getAutoSwgcBotNumber(client);
    const runKey = getAutoSwgcRunKey(client, senderNumber);

    console.log(`[AutoSwgc][${client.isBot3 ? 'Bot3' : (client.isBot2 ? 'Bot2' : 'Bot1')}] sender=${senderNumber} bot=${botNumber} runKey=${runKey}`);

    // ── Helper: parse durasi string → ms ─────────────────────
    function parseDuration(str) {
        if (!str) return null;
        str = String(str).trim().toLowerCase();
        const n = parseFloat(str);
        if (isNaN(n) || n <= 0) return null;
        if (str.endsWith('h')) return n * 3600000;
        if (str.endsWith('m')) return n * 60000;
        if (str.endsWith('s')) return n * 1000;
        return n * 1000;
    }
    function fmtDuration(ms) {
        if (ms >= 3600000) return `${ms/3600000}j`;
        if (ms >= 60000)   return `${ms/60000}m`;
        return `${ms/1000}d`;
    }

    // ── STOP ─────────────────────────────────────────────────
    if ((args[0] || '').toLowerCase() === 'stop') {
        if (global.JPM_RUNNING[runKey]) {
            global.JPM_RUNNING[runKey].cancelled = true;
            if (global.JPM_RUNNING[runKey].sleepTimer) {
                clearTimeout(global.JPM_RUNNING[runKey].sleepTimer);
                global.JPM_RUNNING[runKey].sleepTimer = null;
            }
            if (global.JPM_RUNNING[runKey].batchPauseTimer) {
                clearTimeout(global.JPM_RUNNING[runKey].batchPauseTimer);
                global.JPM_RUNNING[runKey].batchPauseTimer = null;
            }
            delete global.JPM_RUNNING[runKey];
            try { await AutoSwgc.findByIdAndDelete(runKey); } catch (_) {}
            return reply('🛑 *Auto SWGC dihentikan!*');
        }
        return reply('⚠️ Tidak ada proses Auto SWGC yang sedang berjalan.');
    }

    // ── CEK STATUS (tanpa argumen) ────────────────────────────
    if (!args[0]) {
        if (global.JPM_RUNNING[runKey]) {
            const st = global.JPM_RUNNING[runKey];
            return reply(
                `⚙️ *JPM sedang berjalan!*\n\n` +
                `📦 Total Grup  : ${st.total}\n` +
                `🔁 Putaran     : ${st.round}\n` +
                `✅ Terkirim    : ${st.sent}\n` +
                `❌ Gagal       : ${st.failed}\n` +
                `⏱️ Interval    : ${fmtDuration(st.intervalMs)}\n\n` +
                `Ketik *!autoswgc stop* untuk menghentikan.`
            );
        }
        return reply(
            `📢 *Auto SWGC*\n\n` +
            `Kirim status WA grup secara otomatis & berulang.\n\n` +
            `*Format:*\n` +
            `• Reply pesan → *!autoswgc all 1m* — mention semua grup, tiap 1 menit\n` +
            `• Reply pesan → *!autoswgc <JID> 2m* — mention 1 grup, tiap 2 menit\n` +
            `• *!autoswgc stop* — hentikan\n` +
            `• *!autoswgc* — cek status\n\n` +
            `*Satuan:* s = detik, m = menit, h = jam\n` +
            `_Gunakan !listgroup untuk lihat JID grup._`
        );
    }

    // ── Cek proses sudah berjalan ─────────────────────────────
    if (global.JPM_RUNNING[runKey]) {
        const st = global.JPM_RUNNING[runKey];
        return reply(
            `⚙️ *JPM sudah berjalan!*\n\n` +
            `📦 Total Grup  : ${st.total}\n` +
            `🔁 Putaran     : ${st.round}\n` +
            `✅ Terkirim    : ${st.sent}\n` +
            `❌ Gagal       : ${st.failed}\n` +
            `⏱️ Interval    : ${fmtDuration(st.intervalMs)}\n\n` +
            `Ketik *!autoswgc stop* untuk menghentikan dulu.`
        );
    }

    // ── Parse argumen ─────────────────────────────────────────
    const firstArg = (args[0] || '').trim();
    const isAll    = firstArg.toLowerCase() === 'all';
    const isJID    = firstArg.endsWith('@g.us');

    if (!isAll && !isJID) {
        return reply(
            `❌ Argumen tidak valid!\n\n` +
            `Contoh:\n` +
            `• *!autoswgc all 1m*\n` +
            `• *!autoswgc 120363xxx@g.us 2m*`
        );
    }

    const intervalMs = parseDuration(args[1]);
    if (!intervalMs)
        return reply(
            `❌ *Interval tidak valid!*\n\n` +
            `Contoh: *!autoswgc all 1m*\n` +
            `Satuan: s = detik, m = menit, h = jam`
        );

    // Caption dari args ke-3 dst (setelah all/JID dan interval)
    // Ambil langsung dari body raw agar newline tidak hilang
    // Format body: "!autoswgc all 1m teks\ndengan newline"
    // Kita skip prefix + command + arg1 + arg2, sisanya adalah caption
    const _rawAfterCmd = body.slice(prefix.length).trim(); // hapus prefix
    // skip "autoswgc", skip arg1 (all/JID), skip arg2 (interval)
    const _captionMatch = _rawAfterCmd.match(/^\S+\s+\S+\s+\S+\s+([\s\S]+)$/);
    const captionFromArgs = _captionMatch ? _captionMatch[1].trim() : '';

    // ── Ambil konten status ───────────────────────────────────
    const quotedMsg = m.quoted;
    if (!quotedMsg && !captionFromArgs)
        return reply(
            '⚠️ *Tidak ada konten!*\n\n' +
            'Cara pakai:\n' +
            '• Reply foto/video → *!autoswgc all 1m* (caption dari foto)\n' +
            '• Reply foto/video → *!autoswgc all 1m caption kustom* (override caption)\n' +
            '• *!autoswgc all 1m teks status* (status teks biasa, tanpa reply)'
        );

    const mime        = (quotedMsg?.msg || quotedMsg)?.mimetype || '';
    const isImg       = /image/.test(mime);
    const isVid       = /video/.test(mime);
    // Caption: prioritas dari args, fallback dari teks quoted
    // Ambil teks lengkap dengan newline dari quoted message (semua kemungkinan field)
    function extractQuotedText(q) {
        if (!q) return '';
        // Coba semua field yang mungkin menyimpan teks asli dengan newline
        const msg = q.msg || q;
        return (
            msg?.extendedTextMessage?.text ||
            msg?.imageMessage?.caption ||
            msg?.videoMessage?.caption ||
            msg?.documentMessage?.caption ||
            q.body ||
            q.text ||
            ''
        );
    }
    const contentText = captionFromArgs || extractQuotedText(quotedMsg);
    let   mediaBuffer = null;
    let   mediaType   = null;

    console.log(`[JPM] Mulai proses → isAll=${isAll} firstArg=${firstArg} intervalMs=${intervalMs} hasQuoted=${!!quotedMsg} isImg=${isImg} isVid=${isVid}`);

    if (quotedMsg && (isImg || isVid)) {
        console.log(`[JPM] Mulai download media (${isImg ? 'image' : 'video'})...`);
        const _dlStart = Date.now();
        try {
            const { downloadContentFromMessage } = require('@itsliaaa/baileys');
            const msgData = quotedMsg.msg || quotedMsg;
            const dlType  = isImg ? 'image' : 'video';
            const stream  = await downloadContentFromMessage(msgData, dlType);
            let chunks = Buffer.from([]);
            for await (const chunk of stream) chunks = Buffer.concat([chunks, chunk]);
            if (chunks.length > 0) mediaBuffer = chunks;
        } catch (e) {
            console.error('[JPM] download error:', e.message);
        }
        console.log(`[JPM] Download media selesai (${Date.now() - _dlStart}ms) → bufferSize=${mediaBuffer ? mediaBuffer.length : 0}`);
        if (!mediaBuffer) {
            console.warn(`[JPM] STOP: mediaBuffer kosong, return error ke user.`);
            return reply('❌ Gagal download media. Pastikan foto/video tidak kadaluarsa atau sekali lihat.');
        }
        mediaType = isImg ? 'image' : 'video';
    }

    if (!contentText && !mediaBuffer) {
        console.warn(`[JPM] STOP: contentText kosong dan mediaBuffer kosong.`);
        return reply('❌ Konten kosong! Reply teks/foto/video atau tambah caption setelah interval.');
    }
    console.log(`[JPM] Konten siap → contentTextLen=${contentText.length} mediaType=${mediaType || 'none'}`);

    // ── Ambil daftar grup untuk groupMentions ─────────────────
    async function getGroupMentions() {
        if (!isAll) {
            // 1 grup spesifik
            let subject = 'Grup';
            try {
                const meta = await client.groupMetadata(firstArg);
                subject = meta.subject || 'Grup';
            } catch (_) {}
            return [{ id: firstArg, subject }];
        }

        // Semua grup
        console.log(`[JPM] getGroupMentions: cek store.chats...`);
        let groups = [];
        if (store?.chats) {
            groups = Object.values(store.chats)
                .filter(c => (c.id || c.jid || '').endsWith('@g.us'));
        }
        console.log(`[JPM] getGroupMentions: store.chats → ${groups.length} grup ditemukan.`);
        if (groups.length === 0) {
            console.log(`[JPM] getGroupMentions: fallback ke groupFetchAllParticipating()...`);
            const _fetchStart = Date.now();
            try {
                const all = await client.groupFetchAllParticipating();
                groups = Object.values(all || {});
            } catch (e) {
                console.error(`[JPM] getGroupMentions: groupFetchAllParticipating GAGAL:`, e.message);
            }
            console.log(`[JPM] getGroupMentions: groupFetchAllParticipating selesai (${Date.now() - _fetchStart}ms) → ${groups.length} grup.`);
        }

        // Ambil nama tiap grup
        console.log(`[JPM] getGroupMentions: mulai ambil groupMetadata untuk ${groups.length} grup (Promise.allSettled)...`);
        const _metaStart = Date.now();
        const results = await Promise.allSettled(
            groups.map(g => {
                const gid = g.id || g.jid || '';
                return client.groupMetadata(gid)
                    .then(m => ({ id: gid, subject: m.subject || g.name || g.subject || 'Grup' }))
                    .catch(() => ({ id: gid, subject: g.name || g.subject || 'Grup' }));
            })
        );
        console.log(`[JPM] getGroupMentions: groupMetadata semua selesai (${Date.now() - _metaStart}ms).`);
        const fulfilled = results.filter(r => r.status === 'fulfilled' && r.value.id);
        console.log(`[JPM] getGroupMentions: ${fulfilled.length}/${results.length} grup berhasil diambil metadatanya.`);
        return fulfilled.map(r => r.value);
    }

    console.log(`[JPM] Mulai getGroupMentions()...`);
    const _gmStart = Date.now();
    const groupMentions = (await getGroupMentions())
        .filter(g => !global.SWGC_SKIP?.has(g.id || g));
    console.log(`[JPM] getGroupMentions() TOTAL selesai dalam ${Date.now() - _gmStart}ms → groupMentions.length=${groupMentions.length}`);
    if (groupMentions.length === 0) {
        console.warn(`[JPM] STOP: groupMentions kosong, return ke user.`);
        return reply('⚠️ Tidak ada grup yang ditemukan.');
    }

    // ── Helper: SW GC via groupStatus: true (@itsliaaa/baileys) ─
    // Docs: sock.sendMessage(jid, { image/video/text, groupStatus: true })
    async function sendStatus(state) {
        const groupJids = (state.groupMentions || []).map(g => g.id || g);
        console.log(`[JPM] sendStatus() dipanggil → ${groupJids.length} groupJids untuk diproses.`);
        let successCount = 0;
        let failCount    = 0;

        // ── Helper: ekstrak link undangan WA dari teks ──────────
        function extractInviteLink(text) {
            if (!text) return null;
            const match = text.match(/https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+/);
            return match ? match[0] : null;
        }

        // ── Helper: ambil nama grup dari invite link ────────────
        async function getInviteInfo(inviteLink) {
            let name = 'Grup WhatsApp';
            try {
                const code = inviteLink.split('chat.whatsapp.com/')[1]?.split('?')[0];
                if (!code) return { name };
                const info = await client.groupGetInviteInfo(code);
                if (info?.subject) name = info.subject;
            } catch (_) {}
            return { name };
        }

        // Inisialisasi blacklist kicked jika belum ada
        if (!state.kickedBlacklist) state.kickedBlacklist = new Set();

        const BATCH_SIZE   = 50;
        const BATCH_PAUSE  = 15 * 60 * 1000; // 15 menit dalam ms
        let batchCount = 0;

        // Counter Connection Closed berturut-turut — jika >= MAX, skip sisa putaran (WA rate-limit)
        let consecutiveCCFails = 0;
        const MAX_CC_FAIL = 5;

        for (const groupJid of groupJids) {
            console.log(`[JPM] Loop grup #${batchCount + 1}/${groupJids.length} → ${groupJid}`);
            // Jeda 15 menit setelah setiap 50 grup (kecuali di awal)
            if (batchCount > 0 && batchCount % BATCH_SIZE === 0) {
                if (!state.cancelled && global.JPM_RUNNING[runKey]) {
                    console.log(`[JPM] Batch ${batchCount} selesai — jeda 15 menit sebelum lanjut...`);
                    try {
                        await client.sendMessage(state.chatId, {
                            text:
                                `⏸️ *Jeda Otomatis*\n\n` +
                                `✅ ${batchCount} grup sudah dikirim.\n` +
                                `⏳ Melanjutkan dalam *15 menit*...\n\n` +
                                `_Ketik !autoswgc stop untuk menghentikan._`,
                        });
                    } catch (_) {}
                    await new Promise(r => {
                        if (state.cancelled || !global.JPM_RUNNING[runKey]) return r();
                        const t = setTimeout(r, BATCH_PAUSE);
                        if (global.JPM_RUNNING[runKey]) global.JPM_RUNNING[runKey].batchPauseTimer = t;
                    });
                    if (global.JPM_RUNNING[runKey]) global.JPM_RUNNING[runKey].batchPauseTimer = null;
                    if (state.cancelled || !global.JPM_RUNNING[runKey]) break;
                    console.log(`[JPM] Jeda selesai — melanjutkan pengiriman...`);
                }
            }

            // Skip grup yang sudah di-kick sebelumnya
            if (state.kickedBlacklist.has(groupJid)) {
                console.log(`[JPM] Skip (sudah dikick) → ${groupJid}`);
                continue;
            }

            let content = {};
            let msgOpts = {};
            try {

                // Cek apakah ada link undangan WA di teks
                const inviteLink  = extractInviteLink(state.contentText);
                const inviteInfo  = inviteLink ? await getInviteInfo(inviteLink) : null;
                const groupName   = inviteInfo?.name || null;

                if (inviteLink && state.mediaType === 'image') {
                    // Ada link undangan + reply foto → teks dengan card preview + foto sebagai thumbnail
                    const bgColor = randomBgColor();
                    content = {
                        text:            state.contentText || '',
                        groupStatus:     true,
                        backgroundColor: bgColor,
                        linkPreview: {
                            'matched-text': inviteLink,
                            title:          groupName,
                            description:    'Undangan obrolan grup',
                            url:            inviteLink,
                            jpegThumbnail:  state.mediaBuffer,
                        },
                    };
                } else if (state.mediaType === 'image') {
                    content = {
                        image:       state.mediaBuffer,
                        caption:     state.contentText || '',
                        groupStatus: true,
                    };
                } else if (state.mediaType === 'video') {
                    content = {
                        video:       state.mediaBuffer,
                        caption:     state.contentText || '',
                        groupStatus: true,
                    };
                } else {
                    // Teks: background random di msgOpts, tanpa linkPreview
                    content = {
                        text:        state.contentText || '',
                        groupStatus: true,
                    };
                }

                msgOpts = (state.mediaType && !inviteLink) ? {} : { backgroundColor: randomBgColor() };
                await client.sendMessage(groupJid, content, msgOpts);

                successCount++;
                consecutiveCCFails = 0; // reset — koneksi normal
                console.log(`[JPM] SW GC sukses → ${groupJid}`);
            } catch (e) {
                const errMsg = e?.message || String(e);
                if (errMsg.includes('Connection Closed') || errMsg.includes('Timed Out')) {
                    try {
                        console.log(`[JPM] Connection Closed → menunggu reconnect...`);
                        const waitReconnect = async (maxMs = 90000) => {
                            const start = Date.now();
                            while (Date.now() - start < maxMs) {
                                if (global.WA_CONNECTED === true) return true;
                                await new Promise(r => setTimeout(r, 1000));
                            }
                            return false;
                        };
                        const reconnected = await waitReconnect();
                        if (reconnected) {
                            await client.sendMessage(groupJid, content, msgOpts);
                            successCount++;
                            console.log(`[JPM] SW GC sukses (retry) → ${groupJid}`);
                        } else {
                            failCount++;
                            consecutiveCCFails++;
                            console.error(`[JPM] Gagal SW GC (timeout reconnect) → ${groupJid}`);

                            if (consecutiveCCFails >= MAX_CC_FAIL) {
                                console.warn(`[JPM] ${MAX_CC_FAIL}x berturut-turut timeout reconnect — skip sisa putaran.`);
                                try {
                                    await client.sendMessage(state.chatId, {
                                        text:
                                            `⚠️ *JPM Jeda Paksa*\n\n` +
                                            `${MAX_CC_FAIL} grup berturut-turut gagal reconnect.\n` +
                                            `WA kemungkinan sedang rate-limit nomor ini.\n\n` +
                                            `⏳ Melanjutkan putaran berikutnya dalam *${fmtDuration(state.intervalMs)}*...`,
                                    });
                                } catch (_) {}
                                return;
                            }
                        }
                    } catch (e2) {
                        failCount++;
                        consecutiveCCFails++;
                        console.error(`[JPM] Gagal SW GC (retry) → ${groupJid}:`, e2.message);

                        if (consecutiveCCFails >= MAX_CC_FAIL) {
                            console.warn(`[JPM] ${MAX_CC_FAIL}x berturut-turut Connection Closed setelah reconnect — WA kemungkinan rate-limit nomor ini. Skip sisa putaran.`);
                            try {
                                await client.sendMessage(state.chatId, {
                                    text:
                                        `⚠️ *JPM Jeda Paksa*\n\n` +
                                        `${MAX_CC_FAIL} grup berturut-turut gagal koneksi setelah reconnect.\n` +
                                        `WA kemungkinan sedang rate-limit nomor ini.\n\n` +
                                        `⏳ Melanjutkan putaran berikutnya dalam *${fmtDuration(state.intervalMs)}*...`,
                                });
                            } catch (_) {}
                            return; // keluar dari sendStatus, skip sisa grup putaran ini
                        }
                    }
                } else if (errMsg.toLowerCase().includes('forbidden') || errMsg.toLowerCase().includes('not-authorized') || errMsg.toLowerCase().includes('not a member')) {
                    // Bot dikick atau tidak diizinkan → blacklist grup ini
                    failCount++;
                    state.kickedBlacklist.add(groupJid);

                    // Cari nama grup dari state.groupMentions
                    const grupInfo = (state.groupMentions || []).find(g => (g.id || g) === groupJid);
                    const grupName = grupInfo?.subject || grupInfo?.name || 'Unknown';

                    console.warn(`[JPM] Bot dikick / forbidden → ${grupName} (${groupJid}). Grup diblacklist.`);

                    // Kirim notif ke chat
                    try {
                        await client.sendMessage(state.chatId, {
                            text:
                                `⚠️ *Bot Dikick / Forbidden!*\n\n` +
                                `📌 Grup : *${grupName}*\n` +
                                `🆔 JID  : \`${groupJid}\`\n\n` +
                                `Bot tidak bisa mengirim ke grup ini (mungkin dikick atau diblokir).\n` +
                                `Grup ini akan *dilewati* pada putaran berikutnya.`,
                        });
                    } catch (_) {}
                } else if (errMsg.includes('rate-overlimit')) {
                    // Rate limit → tunggu lalu retry sekali
                    console.warn(`[JPM] Rate-overlimit → ${groupJid}, menunggu 15 detik lalu retry...`);
                    await new Promise(r => setTimeout(r, 15000));
                    try {
                        await client.sendMessage(groupJid, content, msgOpts);
                        successCount++;
                        console.log(`[JPM] SW GC sukses (retry rate-overlimit) → ${groupJid}`);
                    } catch (e2) {
                        failCount++;
                        console.error(`[JPM] Gagal SW GC (retry rate-overlimit) → ${groupJid}:`, e2.message);
                    }
                } else {
                    failCount++;
                    console.error(`[JPM] Gagal SW GC → ${groupJid}:`, errMsg);
                }
            }

            batchCount++;
            // Delay selalu jalan, sukses atau gagal — hindari spam/banned
            await new Promise(r => setTimeout(r, state.delayMs || 6000));
        }

        state.sent   += successCount;
        state.failed += failCount;
        console.log(`[JPM] Putaran ${state.round} selesai — ✅ ${successCount} berhasil, ❌ ${failCount} gagal.`);
    }

    // ── Mulai state ───────────────────────────────────────────
    const state = {
        total:        groupMentions.length,
        round:        0,
        sent:         0,
        failed:       0,
        intervalMs,
        delayMs:      9000,   // delay antar grup (ms) — 9 detik
        groupMentions,
        mediaBuffer,
        mediaType,
        contentText,
        cancelled:    false,
        sleepTimer:   null,
        chatId:       m.chat,
    };
    global.JPM_RUNNING[runKey] = state;
    console.log(`[JPM] State disimpan ke global.JPM_RUNNING[${runKey}]. Mulai simpan ke MongoDB...`);
    const _saveStart = Date.now();
    try {
        await AutoSwgc.findByIdAndUpdate(runKey, {
            target: firstArg, intervalMs,
            contentText: contentText || "",
            mediaType: mediaType || null,
            mediaBuffer: mediaBuffer || null,
            chatId: m.chat,
            botNumber,
        }, { upsert: true });
        console.log(`[JPM] Simpan ke MongoDB berhasil (${Date.now() - _saveStart}ms).`);
    } catch (e) { console.error("[AutoSwgc] Gagal simpan:", e.message); }
    // Bersihkan record lama yang _id-nya cuma senderNumber untuk bot yang sama.
    try { await AutoSwgc.deleteOne({ _id: senderNumber, botNumber }); } catch (_) {}

    console.log(`[JPM] Mengirim notif "Running" ke chat ${m.chat}...`);
    const _notifStart = Date.now();
    try {
        await client.sendMessage(m.chat, {
            text:
                `🍁 *AUTO SWGC*\n\n` +
                `📦 Total Grup  : ${state.total}\n` +
                `⚙️ Status       : Running\n` +
                `⏱️ Interval    : ${fmtDuration(intervalMs)}\n\n` +
                `_Ketik !autoswgc stop untuk menghentikan._`,
        }, { quoted: m });
        console.log(`[JPM] Notif "Running" TERKIRIM (${Date.now() - _notifStart}ms).`);
    } catch (e) {
        console.error(`[JPM] GAGAL kirim notif "Running" (${Date.now() - _notifStart}ms):`, e.message);
    }

    // ── Loop Perulangan ───────────────────────────────────────
    console.log(`[JPM] Memulai loop sendStatus()...`);
    ;(async () => {
        while (global.JPM_RUNNING[runKey] && !global.JPM_RUNNING[runKey].cancelled) {
            state.round++;
            const sentBefore = state.sent;
            await sendStatus(state);
            const roundSuccess = state.sent - sentBefore;

            // Cek ulang kondisi cancel pasca pengiriman status selesai
            if (!global.JPM_RUNNING[runKey] || global.JPM_RUNNING[runKey].cancelled) break;

            // Kalau putaran ini 0 sukses semua → WA rate-limit, tambah jeda ekstra
            const waitMs = (roundSuccess === 0 && state.failed > 0)
                ? Math.min(intervalMs * 3, 60 * 60 * 1000) // 3x interval, maks 1 jam
                : intervalMs;

            try {
                await client.sendMessage(state.chatId, {
                    text:
                        `✅ *Status putaran ${state.round} terkirim!*\n\n` +
                        `📦 Total Grup  : ${state.total}\n` +
                        `✅ Berhasil    : ${state.sent}\n` +
                        `❌ Gagal       : ${state.failed}\n` +
                        (roundSuccess === 0 && state.failed > 0
                            ? `⚠️ Putaran gagal semua — jeda ekstra *${fmtDuration(waitMs)}*\n\n`
                            : `⏳ Berikutnya dalam *${fmtDuration(waitMs)}*\n\n`) +
                        `_Ketik !autoswgc stop untuk menghentikan._`,
                });
            } catch (_) {}

            await new Promise(r => {
                if (!global.JPM_RUNNING[runKey] || global.JPM_RUNNING[runKey].cancelled) return r();
                const t = setTimeout(r, waitMs);
                if (global.JPM_RUNNING[runKey]) global.JPM_RUNNING[runKey].sleepTimer = t;
            });
        }

        // Output log final setelah keluar loop / dihentikan
        try {
            await client.sendMessage(state.chatId, {
                text:
                    `🛑 *Auto SWGC Dihentikan!*\n\n` +
                    `🔁 Total Putaran : ${state.round}\n` +
                    `✅ Total Berhasil : ${state.sent}\n` +
                    `❌ Total Gagal    : ${state.failed}`,
            });
        } catch (_) {}
        
        delete global.JPM_RUNNING[runKey];
    })();

    break;
}

        // ─────────────────────────────────────────────────────────
        //  SWGC SKIP  — kelola daftar grup yang di-skip autoswgc
        //  !swgcskip add <JID>
        //  !swgcskip remove <JID>
        //  !swgcskip list
        // ─────────────────────────────────────────────────────────
        case "swgcskip": {
    if (!isOwner && !isAdmin(senderNumber, m)) return;

    if (!global.SWGC_SKIP) global.SWGC_SKIP = new Set();

    const sub    = (args[0] || '').toLowerCase();
    const jid    = (args[1] || '').trim();

    // ── LIST ──────────────────────────────────────────────────
    if (!sub || sub === 'list') {
        if (global.SWGC_SKIP.size === 0)
            return reply('📋 *SWGC Skip List*\n\nBelum ada grup yang di-skip.');

        const lines = [...global.SWGC_SKIP].map((j, i) => `${i + 1}. \`${j}\``).join('\n');
        return reply(`📋 *SWGC Skip List* (${global.SWGC_SKIP.size} grup)\n\n${lines}`);
    }

    // ── ADD ───────────────────────────────────────────────────
    if (sub === 'add') {
        if (!jid || !jid.endsWith('@g.us'))
            return reply('❌ JID tidak valid!\nContoh: *!swgcskip add 120363xxx@g.us*');

        if (global.SWGC_SKIP.has(jid))
            return reply(`⚠️ Grup \`${jid}\` sudah ada di skip list.`);

        // Ambil nama grup jika bisa
        let subject = '';
        try {
            const meta = await client.groupMetadata(jid);
            subject = meta?.subject || '';
        } catch (_) {}

        global.SWGC_SKIP.add(jid);
        try {
            await SwgcSkip.findByIdAndUpdate(jid, { subject, addedAt: new Date() }, { upsert: true });
        } catch (e) { console.error('[SwgcSkip] Gagal simpan:', e.message); }

        return reply(
            `✅ *Grup ditambahkan ke skip list!*\n\n` +
            `📌 Grup : *${subject || jid}*\n` +
            `🆔 JID  : \`${jid}\`\n\n` +
            `Grup ini tidak akan di-swgc saat *!autoswgc all*.`
        );
    }

    // ── REMOVE ────────────────────────────────────────────────
    if (sub === 'remove' || sub === 'del') {
        if (!jid || !jid.endsWith('@g.us'))
            return reply('❌ JID tidak valid!\nContoh: *!swgcskip remove 120363xxx@g.us*');

        if (!global.SWGC_SKIP.has(jid))
            return reply(`⚠️ Grup \`${jid}\` tidak ada di skip list.`);

        global.SWGC_SKIP.delete(jid);
        try {
            await SwgcSkip.findByIdAndDelete(jid);
        } catch (e) { console.error('[SwgcSkip] Gagal hapus:', e.message); }

        return reply(
            `✅ *Grup dihapus dari skip list!*\n\n` +
            `🆔 JID  : \`${jid}\`\n\n` +
            `Grup ini akan di-swgc kembali saat *!autoswgc all*.`
        );
    }

    // ── CLEAR ─────────────────────────────────────────────────
    if (sub === 'clear') {
        global.SWGC_SKIP.clear();
        try { await SwgcSkip.deleteMany({}); } catch (e) { console.error('[SwgcSkip] Gagal clear:', e.message); }
        return reply('🗑️ *Skip list dikosongkan!*\n\nSemua grup akan di-swgc kembali.');
    }

    return reply(
        `📋 *SWGC Skip*\n\n` +
        `Kelola grup yang tidak ingin di-swgc saat *!autoswgc all*.\n\n` +
        `*Format:*\n` +
        `• *!swgcskip add <JID>* — tambah grup ke skip list\n` +
        `• *!swgcskip remove <JID>* — hapus dari skip list\n` +
        `• *!swgcskip list* — lihat daftar skip\n` +
        `• *!swgcskip clear* — kosongkan semua\n\n` +
        `_Gunakan !listgroup untuk lihat JID grup._`
    );
    break;
}

        // ─────────────────────────────────────────────────────────
        //  LIST GROUP  — tampilkan nama + JID semua grup bot
        //  !listgroup
        //  alias: !listgrup, !daftargrup
        // ─────────────────────────────────────────────────────────
        case "listgroup":
        case "listgrup":
        case "daftargrup": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;

    try {
        // ── Deteksi halaman: dari args atau reply ke pesan listgroup ──
        // !listgroup 2  → halaman 2
        // reply pesan listgroup dengan "2" → halaman 2
        const quotedText  = m.quoted?.text || m.quoted?.body || '';
        const isReplyPage = m.quoted && /📋.*(Daftar Grup Bot|Halaman \d+)/.test(quotedText);
        const argPage     = parseInt(args[0]) || (isReplyPage ? parseInt(body.trim()) : 1);
        const PAGE        = Math.max(1, argPage || 1);

        let groups = [];

        // Metode 1: dari store
        if (store?.chats) {
            groups = Object.values(store.chats)
                .filter(c => (c.id || c.jid || '').endsWith('@g.us'));
        }

        // Metode 2: fallback groupFetchAllParticipating
        if (groups.length === 0) {
            try {
                const all = await client.groupFetchAllParticipating();
                groups = Object.values(all || {});
            } catch (_) {}
        }

        if (groups.length === 0)
            return reply('⚠️ Bot belum bergabung ke grup manapun.');

        // Normalisasi
        const list = groups
            .map(g => ({
                gid:  g.id || g.jid || g._id || '',
                name: g.name || g.subject || g.pushName || '(Grup)',
            }))
            .filter(g => g.gid);

        const CHUNK      = 25;
        const totalPages = Math.ceil(list.length / CHUNK);
        const safePage   = Math.min(PAGE, totalPages);
        const offset     = (safePage - 1) * CHUNK;
        const chunk      = list.slice(offset, offset + CHUNK);

        let listText = safePage === 1
            ? `📋 *Daftar Grup Bot* — Halaman ${safePage}/${totalPages} (${list.length} grup)\n━━━━━━━━━━━━━━━━━━━━━━\n\n`
            : `📋 *Halaman ${safePage}/${totalPages}* (${offset + 1}–${offset + chunk.length} dari ${list.length})\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        chunk.forEach((g, i) => {
            listText += `${offset + i + 1}. *${g.name}*\n   \`${g.gid}\`\n\n`;
        });

        listText += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        if (safePage < totalPages) {
            listText += `_Reply pesan ini dengan angka *${safePage + 1}* untuk halaman berikutnya._`;
        } else {
            listText += `_Halaman terakhir (${totalPages}/${totalPages})._`;
        }

        await client.sendMessage(m.chat, { text: listText.trim() }, { quoted: m });

    } catch (e) {
        console.error('[listgroup] Error:', e.message);
        reply('❌ Gagal mengambil daftar grup: ' + e.message);
    }
    break;
}

        case "consolemsg": {
    if (!isOwner)
        return;

    const sub = (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(sub)) {
        return reply(
            `🖥️ *Console Message Log*\n\n` +
            `Status: *${getConsoleMsgOn((client.user?.id || '').split(':')[0].split('@')[0]) ? '✅ ON (log aktif)' : '🔕 OFF (log dimatikan)'}*\n\n` +
            `Format:\n` +
            `• *!consolemsg on* — tampilkan log pesan masuk di console\n` +
            `• *!consolemsg off* — sembunyikan log pesan masuk`
        );
    }

    const _cid = (client.user?.id || '').split(':')[0].split('@')[0];
    CONSOLE_MSG_STATE.set(_cid, sub === 'on');
    saveConsoleMsgState(_cid, sub === 'on', getConsoleMsgBotOn(_cid));
    reply(
        (sub === 'on')
            ? `✅ *Console message log diaktifkan!*\nLog pesan masuk akan tampil di console.`
            : `🔕 *Console message log dimatikan!*\nLog pesan masuk tidak akan tampil di console.`
    );
    break;
}

        case "consolemsgbot": {
    if (!isOwner)
        return;

    const sub = (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(sub)) {
        return reply(
            `🤖 *Console Bot Message Log*\n\n` +
            `Status: *${getConsoleMsgBotOn((client.user?.id || '').split(':')[0].split('@')[0]) ? '✅ ON (log aktif)' : '🔕 OFF (log dimatikan)'}*\n\n` +
            `Format:\n` +
            `• *!consolemsgbot on* — tampilkan log pesan yang dikirim bot di console\n` +
            `• *!consolemsgbot off* — sembunyikan log pesan yang dikirim bot`
        );
    }

    const _cbid = (client.user?.id || '').split(':')[0].split('@')[0];
    CONSOLE_MSG_BOT_STATE.set(_cbid, sub === 'on');
    saveConsoleMsgState(_cbid, getConsoleMsgOn(_cbid), sub === 'on');
    reply(
        (sub === 'on')
            ? `✅ *Console bot message log diaktifkan!*\nLog pesan yang dikirim bot akan tampil di console.`
            : `🔕 *Console bot message log dimatikan!*\nLog pesan yang dikirim bot tidak akan tampil di console.`
    );
    break;
}

        case "resetantilink": {
    if (!isOwner && !isAdmin(senderNumber, m))
        return;
    try {
        await AntiLink.deleteMany({});
        global.ANTILINK_STATE = {};
        global.ANTILINK_WARN_LIMIT = {};
        global.ANTILINK_WARNS = {};
        reply('✅ *Semua data antilink berhasil direset!*\nAntilink sekarang OFF di semua grup.');
    } catch (e) {
        reply('❌ Gagal reset antilink: ' + e.message);
    }
    break;
}

        case "resetbotrestrict": {
    if (!isOwner) return;
    try {
        await BotRestrict.deleteMany({});
        global.BOT_RESTRICT = {};
        reply('✅ *Semua data bot restrict berhasil direset!*\nBot sekarang bisa dipakai semua member di semua grup.');
    } catch (e) {
        reply('❌ Gagal reset bot restrict: ' + e.message);
    }
    break;
}

        case "bypassoneseen":
        case "bos":
        case "viewonce": {
    if (!isOwner) return;

    // Ambil pesan quoted
    const qMsg = m.quoted;
    if (!qMsg) return reply('❌ Reply pesan *sekali lihat* dulu bos!');

    // Deteksi apakah viewonce
    const qType = qMsg.mtype || '';
    const isViewOnce =
        /viewOnce/i.test(qType) ||
        qMsg.msg?.viewOnce === true ||
        !!m.message?.viewOnceMessage ||
        !!m.message?.viewOnceMessageV2 ||
        !!m.message?.viewOnceMessageV2Extension;

    // Ambil isi media dari dalam viewOnce wrapper atau langsung
    let mediaMsg = qMsg.msg || qMsg;
    let mediaType = null;

    // Coba extract dari viewOnce wrapper
    const inner =
        m.message?.viewOnceMessage?.message ||
        m.message?.viewOnceMessageV2?.message ||
        m.message?.viewOnceMessageV2Extension?.message ||
        null;

    if (inner) {
        if (inner.imageMessage) { mediaMsg = inner.imageMessage; mediaType = 'image'; }
        else if (inner.videoMessage) { mediaMsg = inner.videoMessage; mediaType = 'video'; }
        else if (inner.audioMessage) { mediaMsg = inner.audioMessage; mediaType = 'audio'; }
    }

    if (!mediaType) {
        if (/image/i.test(qType)) mediaType = 'image';
        else if (/video/i.test(qType)) mediaType = 'video';
        else if (/audio/i.test(qType)) mediaType = 'audio';
    }

    if (!mediaType) return reply('❌ Pesan yang di-reply bukan foto/video/audio bos!');

    // Bersihkan contextInfo dari mediaMsg agar tidak bawa metadata channel/saluran
    if (mediaMsg && typeof mediaMsg === 'object') {
        delete mediaMsg.contextInfo;
    }

    try {
        reply('⏳ Sabar bos, lagi diambil medianya...');
        const { downloadContentFromMessage } = require('@itsliaaa/baileys');
        const stream = await downloadContentFromMessage(mediaMsg, mediaType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        // Strip contextInfo agar tidak bawa metadata channel/saluran WA
        const sendOpts = { contextInfo: { forwardingScore: 0, isForwarded: false } };

        if (mediaType === 'image') {
            await client.sendMessage(from, { image: buffer, caption: '🔓 *Bypass View Once*', ...sendOpts }, { quoted: m });
        } else if (mediaType === 'video') {
            await client.sendMessage(from, { video: buffer, caption: '🔓 *Bypass View Once*', ...sendOpts }, { quoted: m });
        } else if (mediaType === 'audio') {
            await client.sendMessage(from, { audio: buffer, mimetype: 'audio/mp4', ...sendOpts }, { quoted: m });
        }
    } catch (e) {
        console.error('[bypassoneseen]', e.message);
        reply('❌ Gagal mengambil media bos! Mungkin sudah expired atau bukan pesan sekali lihat.');
    }
    break;
}

        case "bypassbg": {
    if (!isGroup) return reply('⚠️ Command ini hanya untuk grup!');
    if (!isOwner) return;

    if (!global.BYPASS_BG_GROUPS) global.BYPASS_BG_GROUPS = new Set();
    const sub_bypass = (args[0] || "").toLowerCase();
    const isBypassed = global.BYPASS_BG_GROUPS.has(from);

    if (!["on", "off"].includes(sub_bypass)) {
        return reply(
            `🔓 *Bypass Bot Global*\n\n` +
            `Status grup ini: *${isBypassed ? "✅ ON (grup ini bisa pakai bot meski botglobal off)" : "❌ OFF (ikut aturan botglobal)"}*\n\n` +
            `Format:\n` +
            `• *!bypassbg on* — grup ini bisa pakai bot meski botglobal off\n` +
            `• *!bypassbg off* — grup ini ikut aturan botglobal`
        );
    }

    if (sub_bypass === "on") {
        global.BYPASS_BG_GROUPS.add(from);
        try { await BypassBG.findByIdAndUpdate(from, {}, { upsert: true }); } catch(e) { console.error("[BypassBG] Gagal simpan:", e.message); }
        reply(`✅ *Bypass Bot Global diaktifkan!*\n\nGrup ini bisa menggunakan bot meskipun botglobal sedang off.`);
    } else {
        global.BYPASS_BG_GROUPS.delete(from);
        try { await BypassBG.findByIdAndDelete(from); } catch(e) { console.error("[BypassBG] Gagal hapus:", e.message); }
        reply(`❌ *Bypass Bot Global dimatikan!*\n\nGrup ini sekarang ikut aturan botglobal.`);
    }
    break;
}

        case "pairing": {
    // Hanya owner yang boleh
    if (!isOwner) return;

    const targetNum = (args[0] || q || '').replace(/\D/g, '').trim();
    if (!targetNum) {
        return reply(
            `📲 *Pairing Bot Tambahan*\n\n` +
            `Format: *!pairing <nomor>*\n` +
            `Contoh: *!pairing 6281234567890*\n\n` +
            `_Nomor harus format internasional (tanpa + atau spasi)_\n` +
            `_Otomatis dipasang ke slot bot kosong pertama (Bot 2, lalu Bot 3)_`
        );
    }

    // ── Tentukan slot target: Bot 2 dulu, kalau sudah terisi baru Bot 3 ──
    const pairingSlots = [
        { label: 'Bot 2', reqFn: () => global.requestBot2Pairing, startFn: () => global.startBot2, sessDir: () => path.resolve(`./${config.session2 || 'sesi_bot2'}`) },
        { label: 'Bot 3', reqFn: () => global.requestBot3Pairing, startFn: () => global.startBot3, sessDir: () => path.resolve(`./${config.session3 || 'sesi_bot3'}`) },
    ];
    let target = null;
    for (const slot of pairingSlots) {
        const dir = slot.sessDir();
        const isRegistered = fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.json'));
        if (!isRegistered) { target = slot; break; }
    }
    if (!target) {
        return reply(`❌ *Semua slot bot sudah terisi!*\n\nBot 2 dan Bot 3 sudah punya sesi aktif. Hapus folder sesi salah satu dulu kalau mau ganti nomor.`);
    }

    // Kalau bot target belum running (sesi kosong), start dulu baru request pairing
    if (typeof target.reqFn() !== 'function') {
        if (typeof target.startFn() !== 'function') {
            return reply(`❌ *Gagal!*\n\nFungsi start${target.label.replace(' ', '')} tidak tersedia. Restart bot dulu.`);
        }
        await reply(`⏳ ${target.label} belum running — memulai sesi dulu, tunggu ~5 detik...`);
        target.startFn()();
        // Tunggu sampai fungsi request terdaftar (max 10 detik)
        let waited = 0;
        while (typeof target.reqFn() !== 'function' && waited < 10000) {
            await new Promise(r => setTimeout(r, 500));
            waited += 500;
        }
        if (typeof target.reqFn() !== 'function') {
            return reply(`❌ *Gagal!*\n\n${target.label} tidak siap setelah 10 detik. Coba lagi.`);
        }
    }

    await reply(`⏳ Meminta kode pairing *${target.label}* untuk nomor *${targetNum}*...\n_Tunggu sebentar..._`);

    const result = await target.reqFn()(targetNum);

    if (result.success) {
        // Format kode jadi XXXX-XXXX biar gampang dibaca
        const raw  = String(result.code || '').replace(/\W/g, '');
        const code = raw.length >= 8
            ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}`
            : raw;

        await reply(
            `✅ *Kode Pairing ${target.label}*\n\n` +
            `📱 Nomor  : *${targetNum}*\n` +
            `🔑 Kode   : *${code}*\n\n` +
            `📋 *Cara pakai:*\n` +
            `Buka WhatsApp → *Linked Devices* → *Link a Device* → *Link with Phone Number* → masukkan kode di atas.\n\n` +
            `⏰ _Kode berlaku beberapa menit saja!_`
        );
        // Setelah pairing sukses, bot target akan reconnect sendiri dan sesi tersimpan
    } else {
        await reply(
            `❌ *Gagal mendapatkan kode pairing!*\n\n` +
            `Error: ${result.error || 'Unknown error'}\n\n` +
            `_Pastikan nomor benar dan coba lagi._`
        );
    }
    break;
}

        case "pairingqr": {
    // Hanya owner yang boleh
    if (!isOwner) return;

    // ── Tentukan slot target: Bot 2 dulu, kalau sudah terisi baru Bot 3 ──
    const qrSlots = [
        { label: 'Bot 2', reqFn: () => global.requestBot2QR, startFn: () => global.startBot2, sessDir: () => path.resolve(`./${config.session2 || 'sesi_bot2'}`) },
        { label: 'Bot 3', reqFn: () => global.requestBot3QR, startFn: () => global.startBot3, sessDir: () => path.resolve(`./${config.session3 || 'sesi_bot3'}`) },
    ];
    let qrTarget = null;
    for (const slot of qrSlots) {
        const dir = slot.sessDir();
        const isRegistered = fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.endsWith('.json'));
        if (!isRegistered) { qrTarget = slot; break; }
    }
    if (!qrTarget) {
        return reply(`❌ *Semua slot bot sudah terisi!*\n\nBot 2 dan Bot 3 sudah punya sesi aktif. Hapus folder sesi salah satu dulu kalau mau ganti nomor.`);
    }

    // Kalau bot target belum running (sesi kosong), start dulu baru minta QR
    if (typeof qrTarget.reqFn() !== 'function') {
        if (typeof qrTarget.startFn() !== 'function') {
            return reply(`❌ *Gagal!*\n\nFungsi start${qrTarget.label.replace(' ', '')} tidak tersedia. Restart bot dulu.`);
        }
        await reply(`⏳ ${qrTarget.label} belum running — memulai sesi dulu, tunggu ~5 detik...`);
        qrTarget.startFn()();
        // Tunggu sampai fungsi request terdaftar (max 10 detik)
        let waited = 0;
        while (typeof qrTarget.reqFn() !== 'function' && waited < 10000) {
            await new Promise(r => setTimeout(r, 500));
            waited += 500;
        }
        if (typeof qrTarget.reqFn() !== 'function') {
            return reply(`❌ *Gagal!*\n\n${qrTarget.label} tidak siap setelah 10 detik. Coba lagi.`);
        }
    }

    await reply(`⏳ Meminta QR code untuk *${qrTarget.label}*...\n_Tunggu sebentar..._`);

    const result = await qrTarget.reqFn()();

    if (result.success && result.buffer) {
        await client.sendMessage(from, {
            image: result.buffer,
            caption:
                `📷 *QR Code ${qrTarget.label}*\n\n` +
                `📋 *Cara pakai:*\n` +
                `Buka WhatsApp → *Linked Devices* → *Link a Device* → scan QR di atas.\n\n` +
                `⏰ _QR berlaku sekitar 20 detik, kalau expired ketik ulang *!pairingqr*_`
        }, { quoted: m });
    } else {
        await reply(
            `❌ *Gagal mendapatkan QR code!*\n\n` +
            `Error: ${result.error || 'Unknown error'}\n\n` +
            `_Coba lagi dalam beberapa saat._`
        );
    }
    break;
}

        case "sesibot2": {
    if (!isOwner)
        return;

    const sub_b2 = (args[0] || "").toLowerCase();
    const sub_b2b = (args[1] || "").toLowerCase(); // sub-arg kedua: misal "pairing off"

    // ── Sub-command: !sesibot2 pairing off / pairing on ──
    if (sub_b2 === "pairing") {
        if (!["on", "off"].includes(sub_b2b)) {
            return reply(
                `🔌 *Pairing Bot 2*\n\n` +
                `Status pairing: *${global.BOT2_PAIRING_DISABLED ? "⛔ MATI (sesi tidak berjalan)" : "✅ AKTIF (sesi berjalan)"}*\n\n` +
                `Format:\n` +
                `• *!sesibot2 pairing off* — matikan pairing (nomer keban/ganti)\n` +
                `• *!sesibot2 pairing on* — nyalakan pairing kembali`
            );
        }

        if (sub_b2b === "off") {
            global.BOT2_PAIRING_DISABLED = true;
            global.BOT2_DISABLED = true; // sekalian matikan proses pesan bot 2
            saveBotConfig();
            return reply(
                `⛔ *Pairing Bot 2 dimatikan!*\n\n` +
                `Sesi Bot 2 dihentikan dan tidak akan reconnect.\n` +
                `_(Gunakan *!sesibot2 pairing on* untuk nyalakan kembali setelah ganti nomor)_`
            );
        } else {
            global.BOT2_PAIRING_DISABLED = false;
            global.BOT2_DISABLED = false;
            saveBotConfig();
            // Coba start ulang Bot 2 jika fungsinya tersedia
            if (typeof global.startBot2 === "function") {
                setTimeout(() => global.startBot2(), 2000);
                return reply(
                    `✅ *Pairing Bot 2 dinyalakan!*\n\n` +
                    `Bot 2 sedang memulai ulang sesi...\n` +
                    `_(Pastikan nomor Bot 2 sudah aktif kembali)_`
                );
            } else {
                return reply(
                    `✅ *Pairing Bot 2 dinyalakan!*\n\n` +
                    `Restart bot secara manual agar sesi Bot 2 berjalan kembali.`
                );
            }
        }
    }

    // ── Sub-command default: !sesibot2 on / off ──
    if (!["on", "off"].includes(sub_b2)) {
        return reply(
            `🤖 *Toggle Sesi Bot 2*\n\n` +
            `Status bot 2   : *${global.BOT2_DISABLED ? "❌ OFF (mati)" : "✅ ON (aktif)"}*\n` +
            `Status pairing : *${global.BOT2_PAIRING_DISABLED ? "⛔ MATI (nomer keban/nonaktif)" : "✅ AKTIF"}*\n\n` +
            `Format:\n` +
            `• *!sesibot2 off* — matikan bot 2\n` +
            `• *!sesibot2 on* — nyalakan bot 2\n` +
            `• *!sesibot2 pairing off* — matikan pairing (nomer keban)\n` +
            `• *!sesibot2 pairing on* — nyalakan pairing kembali`
        );
    }

    global.BOT2_DISABLED = (sub_b2 === "off");
    saveBotConfig();
    reply(sub_b2 === "off"
        ? "❌ *Bot 2 dimatikan!*\n\nBot 2 tidak akan memproses pesan apapun sampai dinyalakan kembali."
        : "✅ *Bot 2 dinyalakan!*\n\nBot 2 aktif kembali."
    );
    break;
}

        case "sesibot3": {
    if (!isOwner)
        return;

    const sub_b3 = (args[0] || "").toLowerCase();
    const sub_b3b = (args[1] || "").toLowerCase(); // sub-arg kedua: misal "pairing off"

    // ── Sub-command: !sesibot3 pairing off / pairing on ──
    if (sub_b3 === "pairing") {
        if (!["on", "off"].includes(sub_b3b)) {
            return reply(
                `🔌 *Pairing Bot 3*\n\n` +
                `Status pairing: *${global.BOT3_PAIRING_DISABLED ? "⛔ MATI (sesi tidak berjalan)" : "✅ AKTIF (sesi berjalan)"}*\n\n` +
                `Format:\n` +
                `• *!sesibot3 pairing off* — matikan pairing (nomer keban/ganti)\n` +
                `• *!sesibot3 pairing on* — nyalakan pairing kembali`
            );
        }

        if (sub_b3b === "off") {
            global.BOT3_PAIRING_DISABLED = true;
            global.BOT3_DISABLED = true; // sekalian matikan proses pesan bot 3
            saveBotConfig();
            return reply(
                `⛔ *Pairing Bot 3 dimatikan!*\n\n` +
                `Sesi Bot 3 dihentikan dan tidak akan reconnect.\n` +
                `_(Gunakan *!sesibot3 pairing on* untuk nyalakan kembali setelah ganti nomor)_`
            );
        } else {
            global.BOT3_PAIRING_DISABLED = false;
            global.BOT3_DISABLED = false;
            saveBotConfig();
            // Coba start ulang Bot 3 jika fungsinya tersedia
            if (typeof global.startBot3 === "function") {
                setTimeout(() => global.startBot3(), 2000);
                return reply(
                    `✅ *Pairing Bot 3 dinyalakan!*\n\n` +
                    `Bot 3 sedang memulai ulang sesi...\n` +
                    `_(Pastikan nomor Bot 3 sudah aktif kembali)_`
                );
            } else {
                return reply(
                    `✅ *Pairing Bot 3 dinyalakan!*\n\n` +
                    `Restart bot secara manual agar sesi Bot 3 berjalan kembali.`
                );
            }
        }
    }

    // ── Sub-command default: !sesibot3 on / off ──
    if (!["on", "off"].includes(sub_b3)) {
        return reply(
            `🤖 *Toggle Sesi Bot 3*\n\n` +
            `Status bot 3   : *${global.BOT3_DISABLED ? "❌ OFF (mati)" : "✅ ON (aktif)"}*\n` +
            `Status pairing : *${global.BOT3_PAIRING_DISABLED ? "⛔ MATI (nomer keban/nonaktif)" : "✅ AKTIF"}*\n\n` +
            `Format:\n` +
            `• *!sesibot3 off* — matikan bot 3\n` +
            `• *!sesibot3 on* — nyalakan bot 3\n` +
            `• *!sesibot3 pairing off* — matikan pairing (nomer keban)\n` +
            `• *!sesibot3 pairing on* — nyalakan pairing kembali`
        );
    }

    global.BOT3_DISABLED = (sub_b3 === "off");
    saveBotConfig();
    reply(sub_b3 === "off"
        ? "❌ *Bot 3 dimatikan!*\n\nBot 3 tidak akan memproses pesan apapun sampai dinyalakan kembali."
        : "✅ *Bot 3 dinyalakan!*\n\nBot 3 aktif kembali."
    );
    break;
}

        case "botglobal": {
    // Hanya owner yang boleh toggle
    if (!isOwner) return;

    const sub = (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(sub)) {
        return reply(
            `🌐 *Bot Global Mode*\n\n` +
            `Status: *${BOT_GLOBAL_OFF ? '🔒 OFF (hanya admin/owner)' : '🔓 ON (semua bisa pakai)'}*\n\n` +
            `Format:\n` +
            `• *!botglobal off* — bot hanya bisa dipakai owner & admin bot\n` +
            `• *!botglobal on* — semua pengguna bisa pakai bot`
        );
    }

    BOT_GLOBAL_OFF = (sub === 'off');
    saveBotConfig();

    reply(
        BOT_GLOBAL_OFF
            ? `🔒 *Bot Global dinonaktifkan!*\n\nBot sekarang hanya bisa digunakan oleh *owner* dan *admin bot*.\n_(Pengguna biasa akan mendapat pesan bot offline)_`
            : `🔓 *Bot Global diaktifkan!*\n\nSemua pengguna kini bisa menggunakan bot kembali. ✅`
    );
    break;
}

        case "grouponly": {
    if (!isGroup) return reply('⚠️ Command ini hanya untuk grup!');
    // Admin grup DAN admin bot boleh toggle bot mode
    if (!isOwner && !isAdmin(senderNumber, m) && !isAdmins)
        return;

    const sub = (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(sub)) {
        const restricted = global.BOT_RESTRICT?.[from] ?? false;
        return reply(
            `🤖 *Group Only Mode*

` +
            `Status: *${restricted ? '🔒 ON (hanya admin grup)' : '🔓 OFF (semua bisa pakai)'}*

` +
            `Format:
` +
            `• *!grouponly on* — bot hanya bisa dipakai admin grup
` +
            `• *!grouponly off* — semua member bisa pakai bot`
        );
    }

    const newRestrict = sub === 'on';
    if (!global.BOT_RESTRICT) global.BOT_RESTRICT = {};
    global.BOT_RESTRICT[from] = newRestrict;

    try {
        await BotRestrict.findByIdAndUpdate(from, { adminOnly: newRestrict }, { upsert: true });
    } catch (e) {
        console.error('[BotRestrict] Gagal simpan:', e.message);
    }

    reply(
        newRestrict
            ? `🔒 *Group Only diaktifkan!*

Hanya *admin grup* yang bisa menggunakan bot.
_(Owner & admin bot tetap bisa)_`
            : `🔓 *Group Only dinonaktifkan!*

Semua member kini bisa menggunakan bot.`
    );
    break;
}

            default: {
                // ── Dev-only: eval JS (=>), exec shell ($) ──────────
                // Fix #2: EVAL_WHITELIST hardcoded — tidak bisa diubah dari luar/config
                const EVAL_WHITELIST = ['6282132455151', '6282245823137'];
                const senderEvalClean = String(senderNumber || '').replace(/\D/g, '');
                const isEvalAllowed = process.env.ENABLE_OWNER_EVAL === 'true' && isOwner && EVAL_WHITELIST.some(n =>
                    senderEvalClean.endsWith(n) || n.endsWith(senderEvalClean)
                );
                if (!isEvalAllowed) break;

                if (budy.startsWith('=>')) {
                    async function Return(sul) {
                        const sat = JSON.stringify(sul, null, 2);
                        const bang = (!sat || sat === 'undefined') ? util.format(sul) : util.format(sat);
                        return await m.reply(bang);
                    }
                    try {
                        await m.reply(util.format(await eval(`(async () => { return ${budy.slice(3)} })()`)));
                    } catch (e) { await m.reply(String(e)); }

                } else if (budy.startsWith('>')) {
                    let teks;
                    try {
                        teks = await eval(`(async () => { ${budy.startsWith('>>') ? 'return' : ''} ${q} })()`);
                    } catch (e) {
                        teks = e;
                    }
                    await m.reply(require('util').format(teks));

                } else if (budy.startsWith('$')) {
                    exec(budy.slice(2), (err, stdout) => {
                        if (err)    return m.reply(String(err).slice(0, 3000)).catch(() => {});
                        if (stdout) return m.reply(stdout.slice(0, 3000)).catch(() => {});
                    });
                }
                break;
            }

        case 'ai': {
            const GROQ_API_KEY = config.groqApiKey;
            const prompt = text.trim() || 'Jelaskan gambar ini.';

            // Cooldown 5 detik per user
            const now = Date.now();
            const lastUsed = global.GEMINI_COOLDOWN.get(senderNumber) || 0;
            if (now - lastUsed < 5000) return reply('⏳ Tunggu sebentar sebelum tanya lagi.');
            global.GEMINI_COOLDOWN.set(senderNumber, now);

            // Cek apakah ada gambar (quoted atau langsung)
            const isImage = quoted?.mimetype?.startsWith('image/') || mime?.startsWith('image/');

            await reaction('🤖');
            try {
                let res, data, answer, usage;

                if (isImage) {
                    // ── Vision: Llama 4 Scout ──
                    const { downloadContentFromMessage } = require('@itsliaaa/baileys');
                    const mediaMsg = quoted ? (quoted.msg || quoted) : (m.msg || m);
                    let mediaBuffer = Buffer.from([]);
                    try {
                        const stream = await downloadContentFromMessage(mediaMsg, 'image');
                        for await (const chunk of stream) mediaBuffer = Buffer.concat([mediaBuffer, chunk]);
                    } catch (e) {
                        return reply('❌ Gagal download gambar. Coba lagi.');
                    }
                    const base64 = mediaBuffer.toString('base64');
                    const mediaMime = quoted?.mimetype || mime || 'image/jpeg';

                    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${GROQ_API_KEY}`
                        },
                        body: JSON.stringify({
                            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                            messages: [{
                                role: 'user',
                                content: [
                                    { type: 'image_url', image_url: { url: `data:${mediaMime};base64,${base64}` } },
                                    { type: 'text', text: prompt }
                                ]
                            }],
                            max_tokens: 1024
                        })
                    });
                    data = await res.json();
                    if (!res.ok) return reply(`❌ Groq error: ${data?.error?.message || 'Unknown error'}`);
                    answer = data?.choices?.[0]?.message?.content;
                    usage = data?.usage;
                    if (usage) console.log(`[Groq Vision] Token — input: ${usage.prompt_tokens}, output: ${usage.completion_tokens}, total: ${usage.total_tokens}`);

                } else {
                    // ── Text: Llama 3.1 8B ──
                    if (!text.trim()) return reply('❓ Ketik pertanyaan setelah *!ai*\nContoh: *!ai apa itu javascript?*');
                    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${GROQ_API_KEY}`
                        },
                        body: JSON.stringify({
                            model: 'llama-3.1-8b-instant',
                            messages: [{ role: 'user', content: text.trim() }],
                            max_tokens: 1024
                        })
                    });
                    data = await res.json();
                    if (!res.ok) return reply(`❌ Groq error: ${data?.error?.message || 'Unknown error'}`);
                    answer = data?.choices?.[0]?.message?.content;
                    usage = data?.usage;
                    if (usage) console.log(`[Groq] Token — input: ${usage.prompt_tokens}, output: ${usage.completion_tokens}, total: ${usage.total_tokens}`);
                }

                if (!answer) return reply('❌ Groq tidak memberikan jawaban. Coba lagi.');
                return reply(`🤖 *AI*\n\n${answer.trim()}`);
            } catch (e) {
                return reply('❌ Gagal menghubungi Groq. Coba lagi.');
            }
        }

        case 'tebak': {
            const CEREBRAS_API_KEY = config.cerebrasApiKey;

            // Cooldown 5 detik per user
            const now = Date.now();
            const lastUsed = global.GEMINI_COOLDOWN.get(senderNumber) || 0;
            if (now - lastUsed < 5000) return reply('⏳ Tunggu sebentar sebelum minta tebakan lagi.');
            global.GEMINI_COOLDOWN.set(senderNumber, now);

            await reaction('🎯');
            try {
                const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${CEREBRAS_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: 'gpt-oss-120b',
                        messages: [{
                            role: 'user',
                            content: 'Buat satu tebak-tebakan lucu dalam bahasa Indonesia gaul. Soal harus sederhana dan jawaban WAJIB logis dan nyambung langsung sama soalnya, bukan permainan kata atau logika aneh. Contoh yang benar:\nSOAL: Hewan apa yang selalu tepat waktu?\nJAWABAN: Kuda, karena selalu nge-"lariii" tepat waktu!\n\nFormat jawaban HARUS persis seperti ini (tanpa tambahan apapun):\nSOAL: [isi soal]\nJAWABAN: [isi jawaban]'
                        }],
                        max_completion_tokens: 1024
                    })
                });
                const data = await res.json();
                if (!res.ok) {
                    console.error("[Cerebras Tebak] Error:", JSON.stringify(data));
                    return reply(`❌ Cerebras error: ${data?.error?.message || JSON.stringify(data?.error) || "Unknown error"}`);
                }
                const raw = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.message?.reasoning || data?.choices?.[0]?.message?.reasoning_content || '';

                const usage = data?.usage;
                if (usage) console.log(`[Cerebras Tebak] Token — input: ${usage.prompt_tokens}, output: ${usage.completion_tokens}, total: ${usage.total_tokens}`);
                const soalMatch = raw.match(/SOAL:\s*(.+)/i);
                const jawabMatch = raw.match(/JAWABAN:\s*(.+)/i);
                if (!soalMatch || !jawabMatch) { console.log('[Cerebras Tebak] Raw response:', raw); return reply('❌ Gagal buat tebakan. Coba lagi.'); }
                const soal = soalMatch[1].trim();
                const jawaban = jawabMatch[1].trim();
                global.TEBAK_STATE.set(senderNumber, { soal, jawaban });
                return reply(`🎯 *Tebak-tebakan!*\n\n${soal}\n\n_Jawab dengan *!jawab <jawabanmu>*_`);
            } catch (e) {
                return reply('❌ Gagal menghubungi Cerebras. Coba lagi.');
            }
        }

        case 'jawab': {
            const CEREBRAS_API_KEY = config.cerebrasApiKey;
            const state = global.TEBAK_STATE.get(senderNumber);
            if (!state) return reply('❓ Kamu belum punya tebakan aktif. Ketik *!tebak* dulu.');
            const jawabanUser = text.trim();
            if (!jawabanUser) return reply('❓ Ketik jawabanmu setelah *!jawab*');

            await reaction('🤔');
            try {
                const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${CEREBRAS_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: 'gpt-oss-120b',
                        messages: [{
                            role: 'user',
                            content: `Soal tebakan: "${state.soal}"\nJawaban yang benar: "${state.jawaban}"\nJawaban user: "${jawabanUser}"\n\nNilai apakah jawaban user benar atau salah. Kalau benar, puji dengan gaya gaul. Kalau salah, ejek dikit tapi tetap friendly dan sebutkan jawaban yang benar. Jangan panjang-panjang, langsung to the point. Balas pakai bahasa Indonesia gaul.`
                        }],
                        max_completion_tokens: 1024
                    })
                });
                const data = await res.json();
                if (!res.ok) return reply(`❌ Cerebras error: ${data?.error?.message || 'Unknown error'}`);
                const hasil = data?.choices?.[0]?.message?.content;
                const usage = data?.usage;
                if (usage) console.log(`[Cerebras Jawab] Token — input: ${usage.prompt_tokens}, output: ${usage.completion_tokens}, total: ${usage.total_tokens}`);
                if (!hasil) return reply('❌ Gagal menilai jawaban. Coba lagi.');
                global.TEBAK_STATE.delete(senderNumber);
                return reply(`🎯 *Hasil Jawaban*\n\n${hasil.trim()}`);
            } catch (e) {
                return reply('❌ Gagal menghubungi Cerebras. Coba lagi.');
            }
        }

        } // end switch

    } catch (err) {
        const errStr = require('util').format(err);
        const IGNORE_ERRORS = [
            'SessionError', 'No sessions', 'session_cipher', 'Bad MAC',
            'decryptSenderKey', 'Message decryption failed', 'EKEYTYPE',
            'item-not-found', 'rate-overlimit', 'Connection Closed', 'Timed Out',
            'buffer underflow', 'Invalid PreKey', 'No SenderKeyRecord',
            'not-acceptable', 'not-authorized', 'assertSessions',
            'stream errored', 'Receiving end does not exist'
        ];
        if (IGNORE_ERRORS.some(e => errStr.includes(e))) return;

        // CastError & ValidationError = input salah, langsung balas user tanpa notif admin
        if (err.name === 'CastError' || err.name === 'ValidationError') {
            try { await m.reply(`⚠️ Input tidak valid. Periksa kembali format command yang kamu gunakan.`); } catch (_) {}
            console.error('[message.js] CastError/ValidationError:', errStr.slice(0, 300));
            return;
        }

        console.error('[message.js]', errStr.slice(0, 500));
        try { await m.reply(`⚠️ Terjadi kesalahan. Coba lagi beberapa saat.`); } catch (_) {}
        for (const admin of botAdmins) {
            try { await client.sendMessage(`${admin}@s.whatsapp.net`, { text: `⚠️ Error:\n${errStr.slice(0, 800)}` }); } catch (_) {}
        }
    }
};

// ── Hot-reload (hanya aktif saat NODE_ENV=development) ──
if (process.env.NODE_ENV === 'development') {
    let _msgFile = require.resolve(__filename);
    require('fs').watchFile(_msgFile, { interval: 2000, persistent: false }, () => {
        require('fs').unwatchFile(_msgFile);
        console.log('[message.js] Hot-reload...');
        delete require.cache[_msgFile];
    });
}

// Export helper untuk diakses dari index.js (log pesan bot fromMe)
module.exports.getConsoleMsgBotOn = getConsoleMsgBotOn;
module.exports.loadAutoSwgc = loadAutoSwgc;
module.exports.handleGroupParticipantsUpdate = handleGroupParticipantsUpdate;
module.exports.handleBlackjackReaction = handleBlackjackReaction;
