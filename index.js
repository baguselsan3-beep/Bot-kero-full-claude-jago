'use strict';

// ── Block stdout langsung (pino nulis ke sini, bukan console) ──
const _origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...args) => {
    const msg = chunk.toString();
    if (
        msg.includes('Closing session') ||
        msg.includes('Closing open session') ||
        msg.includes('incoming prekey bundle') ||
        msg.includes('Decrypted message with closed session') ||
        msg.includes('rootKey') ||
        msg.includes('indexInfo') ||
        msg.includes('ephemeralKeyPair') ||
        msg.includes('pendingPreKey') ||
        msg.includes('currentRatchet') ||
        msg.includes('lastRemoteEphemeralKey') ||
        msg.includes('baseKey') ||
        msg.includes('privKey') ||
        msg.includes('pubKey') ||
        msg.includes('preKeyId') ||
        msg.includes('signedKeyId') ||
        msg.includes('chainKey') ||
        msg.includes('chainType') ||
        msg.includes('messageKeys') ||
        msg.includes('registrationId') ||
        msg.includes('_chains') ||
        msg.includes('remoteIdentityKey') ||
        msg.includes('previousCounter')
    ) return true;
    return _origWrite(chunk, ...args);
};

if (!globalThis.crypto) {
    globalThis.crypto = require('crypto').webcrypto;
}

console.log('🐟 Fisch Bot — Starting...\n');

// ── Filter spam log dari console juga (double protection) ──────
const SPAM_KEYWORDS = [
    'Closing session',
    'Closing open session',
    'incoming prekey bundle',
    'Decrypted message with closed session',
    '_chains', 'ephemeralKeyPair', 'pendingPreKey',
    'indexInfo', 'registrationId', 'currentRatchet',
    'lastRemoteEphemeralKey', 'rootKey', 'baseKey',
    'privKey', 'pubKey', 'preKeyId', 'signedKeyId',
    'chainKey', 'chainType', 'messageKeys',
    'remoteIdentityKey', 'previousCounter',
];

const isSpam = (...args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    return SPAM_KEYWORDS.some(k => msg.includes(k));
};

const _origLog = console.log.bind(console);
console.log = (...args) => { if (isSpam(...args)) return; _origLog(...args); };

const _origError = console.error.bind(console);
console.error = (...args) => { if (isSpam(...args)) return; _origError(...args); };

const _origWarn = console.warn.bind(console);
console.warn = (...args) => { if (isSpam(...args)) return; _origWarn(...args); };

const config  = require('./settings/config');
const pino    = require('pino');
const fs      = require('fs');
const path    = require('path');
const { Boom } = require('@hapi/boom');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidDecode,
    isJidBroadcast,
    proto,
    delay,
    downloadContentFromMessage,
    makeCacheableSignalKeyStore,
    Browsers,
} = require('@itsliaaa/baileys');

const FileType = require('file-type');
const { color }   = require('./w-shennmine/lib/color');
const { smsg, sleep, getBuffer } = require('./w-shennmine/lib/myfunction');
const { writeExifImg, addExif }  = require('./w-shennmine/lib/exif');

if (!config.mongoSrv || config.mongoSrv.includes('USER:PASS')) {
    _origError('❌ mongoSrv belum diisi di settings/config.js!\n');
    process.exit(1);
}

const logger = pino({ level: 'silent' });

function createStore() {
    const msgs = {}, contacts = {};
    return {
        msgs, contacts,
        bind(ev) {
            ev.on('messages.upsert', ({ messages }) => {
                for (const m of messages) {
                    if (!m.key?.remoteJid || !m.key?.id) continue;
                    if (!msgs[m.key.remoteJid]) msgs[m.key.remoteJid] = {};
                    msgs[m.key.remoteJid][m.key.id] = m;
                }
            });
            ev.on('contacts.upsert', cs => cs.forEach(c => { contacts[c.id] = c; }));
        },
        loadMessage: (jid, id) => msgs[jid]?.[id] || null
    };
}

// ── Group metadata cache ─────────────────────────────────
// Baileys secara internal fetch groupMetadata dari WA server SETIAP
// kali sendMessage() dipanggil ke JID grup (buat re-encrypt ke semua
// participant). Tanpa cache ini, itu jadi network round-trip ekstra
// di setiap pesan yang bot kirim ke grup — bikin respons di grup jauh
// lebih lambat (400-1000ms) dibanding private chat (4-9ms), padahal
// grup kecil maupun besar sama-sama kena.
// TTL 5 menit: cukup lama buat ngirit fetch berulang, cukup singkat
// biar perubahan member/admin grup tetap ke-refresh secara wajar.
const _groupMetadataCache = new Map();
const GROUP_META_TTL_MS = 5 * 60 * 1000;

function makeGroupCache(clientRef) {
    return {
        get: async (jid) => {
            const cached = _groupMetadataCache.get(jid);
            if (cached && (Date.now() - cached.ts) < GROUP_META_TTL_MS) {
                return cached.data;
            }
            try {
                const data = await clientRef.client.groupMetadata(jid);
                _groupMetadataCache.set(jid, { data, ts: Date.now() });
                return data;
            } catch (_) {
                return cached?.data; // fallback ke cache basi kalau fetch gagal
            }
        },
        set: (jid, data) => {
            _groupMetadataCache.set(jid, { data, ts: Date.now() });
        },
        del: (jid) => {
            _groupMetadataCache.delete(jid);
        }
    };
}

const clientstart = async (sessionName = config.session, isBot2 = false, isBot3 = false) => {
    const sessDir = path.resolve(`./${sessionName}`);
    if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });

    const store = createStore();
    const { state, saveCreds } = await useMultiFileAuthState(sessDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    // Cache groupMetadata butuh akses ke `client`, tapi `client` belum ada
    // saat makeWASocket() dipanggil (chicken-egg). Trik: cache.get() pakai
    // referensi lazy (_clientRef) yang diisi setelah client selesai dibuat.
    const _clientRef = {};
    const groupCache = makeGroupCache(_clientRef);

    const client = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys:  makeCacheableSignalKeyStore(state.keys, logger)
        },
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        markOnlineOnConnect:  false,
        connectTimeoutMs:     60_000,
        cachedGroupMetadata: async (jid) => groupCache.get(jid),
        shouldSyncHistoryMessage: () => false,
        patchMessageBeforeSending: (msg) => {
            const requiresPatch = !!(
                msg.buttonsMessage ||
                msg.listMessage ||
                msg.templateMessage
            );
            if (requiresPatch) {
                msg = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadataVersion: 2,
                                deviceListMetadata: {},
                            },
                            ...msg,
                        },
                    },
                };
            }
            return msg;
        },
        getMessage: async (key) => {
            try {
                const msg = store.loadMessage(key.remoteJid, key.id);
                if (msg?.message) return msg.message;
            } catch (_) {}
            return undefined;
        }
    });

    // Isi lazy reference biar groupCache.get() bisa akses client.groupMetadata
    _clientRef.client = client;

    // Invalidasi cache saat ada perubahan di grup — biar data nggak basi
    // kalau ada member masuk/keluar/promote/demote/ganti nama grup dll.
    client.ev.on('groups.update', (updates) => {
        for (const u of updates) if (u.id) groupCache.del(u.id);
    });
    client.ev.on('group-participants.update', (u) => {
        if (u.id) groupCache.del(u.id);
    });

    // Tandai client sebagai bot2/bot3 agar bisa dicek di message handler
    client.isBot2 = isBot2;
    client.isBot3 = isBot3;

    // ── Pairing code Bot 2 — dipanggil dari command !pairing ──
    // Simpan pending request agar bisa di-trigger saat fase connecting
    if (isBot2) {
        // Ekspos fungsi untuk set nomor target pairing dari message.js
        global.requestBot2Pairing = async (phoneNumber) => {
            const num = String(phoneNumber).replace(/\D/g, '');
            // Kalau bot2 sudah registered (sudah login), tidak perlu pairing
            if (client.authState?.creds?.registered) {
                return { success: false, error: 'Bot 2 sudah terhubung ke nomor lain. Hapus folder sesi dulu.' };
            }
            try {
                await delay(1500);
                const code = await client.requestPairingCode(num);
                return { success: true, code };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        };

        // Ekspos fungsi untuk minta QR (dipanggil dari !pairingqr di message.js)
        // Menunggu event 'qr' berikutnya lalu resolve dengan buffer PNG-nya.
        global.requestBot2QR = async (timeoutMs = 20000) => {
            if (client.authState?.creds?.registered) {
                return { success: false, error: 'Bot 2 sudah terhubung ke nomor lain. Hapus folder sesi dulu.' };
            }
            // Kalau QR sudah ada & masih fresh (< 20 detik), langsung pakai itu
            if (global._bot2QRBuffer && Date.now() - (global._bot2QRGeneratedAt || 0) < 20000) {
                return { success: true, buffer: global._bot2QRBuffer };
            }
            try {
                const buffer = await new Promise((resolve, reject) => {
                    global._resolveBot2QR = resolve;
                    setTimeout(() => {
                        if (global._resolveBot2QR) {
                            global._resolveBot2QR = null;
                            reject(new Error('Timeout menunggu QR dari WhatsApp.'));
                        }
                    }, timeoutMs);
                });
                return { success: true, buffer };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        };
    }

    // ── Pairing code Bot 3 — dipanggil dari command !pairing (auto slot) ──
    if (isBot3) {
        global.requestBot3Pairing = async (phoneNumber) => {
            const num = String(phoneNumber).replace(/\D/g, '');
            if (client.authState?.creds?.registered) {
                return { success: false, error: 'Bot 3 sudah terhubung ke nomor lain. Hapus folder sesi dulu.' };
            }
            try {
                await delay(1500);
                const code = await client.requestPairingCode(num);
                return { success: true, code };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        };

        global.requestBot3QR = async (timeoutMs = 20000) => {
            if (client.authState?.creds?.registered) {
                return { success: false, error: 'Bot 3 sudah terhubung ke nomor lain. Hapus folder sesi dulu.' };
            }
            if (global._bot3QRBuffer && Date.now() - (global._bot3QRGeneratedAt || 0) < 20000) {
                return { success: true, buffer: global._bot3QRBuffer };
            }
            try {
                const buffer = await new Promise((resolve, reject) => {
                    global._resolveBot3QR = resolve;
                    setTimeout(() => {
                        if (global._resolveBot3QR) {
                            global._resolveBot3QR = null;
                            reject(new Error('Timeout menunggu QR dari WhatsApp.'));
                        }
                    }, timeoutMs);
                });
                return { success: true, buffer };
            } catch (e) {
                return { success: false, error: e.message || String(e) };
            }
        };
    }

    client.ev.on('connection.update', async (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            // QR muncul = sesi tidak valid / belum ada
            // Apapun status registered-nya, kalau WA kirim QR berarti sesi sudah rejected
            // Jangan reconnect terus — log sekali dan tunggu pairing manual
            if (!global._pairingInfoShown) global._pairingInfoShown = {};
            const botLabel = isBot3 ? 'Bot 3' : (isBot2 ? 'Bot 2' : 'Bot 1');
            if (!global._pairingInfoShown[botLabel]) {
                global._pairingInfoShown[botLabel] = true;
                _origLog(color(`\n[${botLabel}] ⚠️  Sesi tidak valid / belum ada. Ketik !pairing <nomor> atau !pairingqr untuk pairing.\n`, 'yellow'));
            }
            // Reset attempts agar tidak exit saat reconnect nanti
            // (attempts di-manage di connect.js, set via global)
            if (!global._qrReceived) global._qrReceived = {};
            global._qrReceived[botLabel] = true;

            // ── Generate PNG dari string QR & simpan ke global agar bisa dikirim via !pairingqr ──
            if (isBot2 || isBot3) {
                (async () => {
                    try {
                        const QRCode = require('qrcode');
                        const buffer = await QRCode.toBuffer(qr, { type: 'png', width: 512, margin: 2 });
                        if (isBot3) {
                            global._bot3QRBuffer = buffer;
                            global._bot3QRGeneratedAt = Date.now();
                            if (typeof global._resolveBot3QR === 'function') {
                                const resolve = global._resolveBot3QR;
                                global._resolveBot3QR = null;
                                resolve(buffer);
                            }
                        } else {
                            global._bot2QRBuffer = buffer;
                            global._bot2QRGeneratedAt = Date.now();
                            if (typeof global._resolveBot2QR === 'function') {
                                const resolve = global._resolveBot2QR;
                                global._resolveBot2QR = null;
                                resolve(buffer);
                            }
                        }
                    } catch (e) {
                        _origError('[Bot 2/3 QR] Gagal generate gambar QR:', e.message);
                    }
                })();
            }

            // ── Bot 1: auto-request pairing code pakai config.botNumber, tanpa nunggu command manual ──
            if (!isBot2 && !isBot3) {
                if (!client.authState?.creds?.registered && !global._bot1PairingRequested) {
                    const bot1Num = String(config.botNumber || '').replace(/\D/g, '');
                    if (bot1Num) {
                        global._bot1PairingRequested = true;
                        (async () => {
                            try {
                                await new Promise(r => setTimeout(r, 1500)); // beri jeda sebelum request
                                const code = await client.requestPairingCode(bot1Num);
                                _origLog(color(`\n[Bot 1] 🔑 Kode pairing untuk ${bot1Num}: ${code}\n_Buka WhatsApp → Linked Devices → Link with Phone Number → masukkan kode ini._\n`, 'green'));
                            } catch (e) {
                                _origError('[Bot 1] Gagal auto-request pairing code:', e.message);
                                global._bot1PairingRequested = false; // izinkan coba lagi di reconnect berikutnya
                            }
                        })();
                    } else {
                        _origLog(color('\n[Bot 1] ⚠️  config.botNumber kosong — tidak bisa auto-pairing. Isi dulu di settings/config.js\n', 'yellow'));
                    }
                }
            }

            return; // jangan teruskan ke konek — tunggu pairing
        }

        try {
            const { konek } = require('./w-shennmine/lib/connection/connect');
            await konek({ client, update, clientstart: () => clientstart(sessionName, isBot2, isBot3), DisconnectReason, Boom });
        } catch (e) {
            _origError('[connection.update]', e.message);
        }
    });


    // Restore autoswgc dari MongoDB saat bot connect
    client.ev.on("connection.update", async ({ connection }) => {
        if (connection === "open") {
            // Reset flag pairing info agar bisa tampil lagi kalau disconnect
            const botLabel = isBot3 ? 'Bot 3' : (isBot2 ? 'Bot 2' : 'Bot 1');
            if (global._pairingInfoShown) global._pairingInfoShown[botLabel] = false;
            if (botLabel === 'Bot 1') global._bot1PairingRequested = false;

            setTimeout(async () => {
                try {
                    const { loadAutoSwgc } = require("./message");
                    if (typeof loadAutoSwgc === "function") await loadAutoSwgc(client);
                } catch (e) { _origError("[AutoSwgc] gagal restore:", e.message); }
            }, 15000);
        }
    });
    client.ev.on('creds.update', saveCreds);

    const msgHandler = require('./message');

    client.ev.on('group-participants.update', async (update) => {
        try {
            if (isBot2 && global.BOT2_DISABLED) return;
            if (isBot3 && global.BOT3_DISABLED) return;
            const { id: groupJid, participants, action } = update;
            if (!groupJid || !participants?.length) return;
            const { handleGroupParticipantsUpdate } = require('./message');
            await handleGroupParticipantsUpdate(client, groupJid, participants, action);
        } catch (e) {
            _origError('[group-participants-update]', String(e?.message || e).slice(0, 300));
        }
    });

    // ── Reaction ke pesan game (Blackjack: 👊 hit, ⛔ stand, 2️⃣ double) ──
    client.ev.on('messages.reaction', async (updates) => {
        try {
            if (isBot2 && global.BOT2_DISABLED) return;
            if (isBot3 && global.BOT3_DISABLED) return;

            const list = Array.isArray(updates) ? updates : [updates];
            for (const update of list) {
                const emoji = update?.reaction?.text;
                if (!emoji) continue; // reaction dihapus (text kosong), abaikan

                // senderNumber diambil dari siapa yang kasih reaction, bukan dari pemilik pesan yang di-react
                const reactorJid = update?.reaction?.key?.participant || update?.reaction?.key?.remoteJid || update?.key?.participant || update?.key?.remoteJid;
                if (!reactorJid) continue;

                let senderNumber = String(reactorJid).split('@')[0];
                if (reactorJid.endsWith('@lid')) {
                    try {
                        const ids = await client.findUserId(reactorJid);
                        if (ids?.phoneNumber) senderNumber = String(ids.phoneNumber).split('@')[0];
                    } catch (_) {}
                }

                const { handleBlackjackReaction } = require('./message');
                await handleBlackjackReaction(client, senderNumber, emoji, null);
            }
        } catch (e) {
            _origError('[messages-reaction]', String(e?.message || e).slice(0, 300));
        }
    });

    client.ev.on('messages.upsert', async chatUpdate => {
        try {
            // ── Kalau ini bot 2/bot 3 dan disabled, skip semua ──
            if (isBot2 && global.BOT2_DISABLED) return;
            if (isBot3 && global.BOT3_DISABLED) return;

            const mek = chatUpdate.messages[0];
            if (!mek?.message) return;

            // ── Log pesan bot (fromMe) — type 'append', bukan 'notify' ──
            // Hanya log, tidak diproses sebagai command
            if (mek.key?.fromMe && chatUpdate.type === 'append') {
                const { getConsoleMsgBotOn } = require('./message');
                const botId = client.user?.id || '';
                if (typeof getConsoleMsgBotOn === 'function' && getConsoleMsgBotOn(botId)) {
                    const chalk = require('chalk');
                    const body  = mek.message?.conversation
                        || mek.message?.extendedTextMessage?.text
                        || mek.message?.imageMessage?.caption
                        || mek.message?.videoMessage?.caption
                        || mek.message?.stickerMessage && '[Sticker]'
                        || Object.keys(mek.message || {})[0]
                        || '-';
                    const preview = String(body).slice(0, 80);
                    console.log(chalk.bgHex('#27ae60').bold(' ▢ Bot Message '));
                    console.log(chalk.cyan(`   Tanggal : ${new Date().toLocaleString()}`));
                    console.log(chalk.white(`   Pesan   : ${preview}`));
                    console.log(chalk.white(`   Ke      : ${mek.key?.remoteJid || '-'}`));
                }
                return; // jangan proses sebagai command
            }

            if (chatUpdate.type !== 'notify') return;
            const m = await smsg(client, mek, store);
            if (!m) return;
            await msgHandler(client, m, chatUpdate, store);
        } catch (e) {
            const errStr = String(e?.stack || e?.message || e);
            const IGNORED_ERRS = ['SessionError', 'Bad MAC', 'decryptSenderKey',
                'buffer underflow', 'Message decryption', 'item-not-found',
                'Connection Closed', 'Timed Out', 'rate-overlimit'];
            if (!IGNORED_ERRS.some(s => errStr.includes(s))) {
                _origError('[messages.upsert]', errStr.slice(0, 500));
            }
        }
    });

    client.decodeJid = (jid) => {
        if (!jid) return jid;
        const d = jidDecode(jid) || {};
        return d.user && d.server ? `${d.user}@${d.server}` : jid;
    };

    return client;
};

const IGNORED = ['timeout', 'Closed', 'Timed Out', 'errored', 'conflict', '401'];

process.on('unhandledRejection', r => {
    if (!IGNORED.some(e => String(r).includes(e))) _origLog('Unhandled:', r);
});

// Jalankan Bot 1
if (!global.BOT2_DISABLED) global.BOT2_DISABLED = false;
if (global.BOT2_PAIRING_DISABLED === undefined) global.BOT2_PAIRING_DISABLED = false;

clientstart(config.session, false).catch(e => _origError('[Bot 1] Fatal:', e.message));

// ── Bot 2 — hanya start kalau sesi sudah ada ──────────────────────
// Kalau sesi kosong, jangan start sama sekali — tunggu !pairing dari user
const sessDir2 = path.resolve(`./${config.session2 || 'sesi_bot2'}`);
const sesiAda  = fs.existsSync(sessDir2) && fs.readdirSync(sessDir2).some(f => f.endsWith('.json'));

if (sesiAda && !global.BOT2_PAIRING_DISABLED) {
    _origLog('[Bot 2] ✅ Sesi ditemukan — memulai Bot 2...');
    clientstart(config.session2 || 'sesi_bot2', true).catch(e => _origError('[Bot 2] Fatal:', e.message));
} else if (!sesiAda) {
    _origLog('[Bot 2] ⏳ Sesi belum ada — Bot 2 tidak dijalankan. Ketik !pairing <nomor> untuk mulai pairing.');
} else {
    _origLog('[Bot 2] ⛔ Pairing Bot 2 dimatikan — sesi tidak dijalankan.');
}

// Ekspos fungsi start/restart Bot 2 — dipanggil dari !pairing di message.js
global.startBot2 = () => {
    if (global.BOT2_PAIRING_DISABLED) {
        _origLog('[Bot 2] ⛔ Tidak bisa start — BOT2_PAIRING_DISABLED masih true.');
        return;
    }
    _origLog('[Bot 2] 🔄 Memulai sesi Bot 2...');
    clientstart(config.session2 || 'sesi_bot2', true).catch(e => _origError('[Bot 2] Fatal:', e.message));
};

// ── Bot 3 — hanya start kalau sesi sudah ada ──────────────────────
// Kalau sesi kosong, jangan start sama sekali — tunggu !pairing dari user
if (!global.BOT3_DISABLED) global.BOT3_DISABLED = false;
if (global.BOT3_PAIRING_DISABLED === undefined) global.BOT3_PAIRING_DISABLED = false;

const sessDir3 = path.resolve(`./${config.session3 || 'sesi_bot3'}`);
const sesiAda3 = fs.existsSync(sessDir3) && fs.readdirSync(sessDir3).some(f => f.endsWith('.json'));

if (sesiAda3 && !global.BOT3_PAIRING_DISABLED) {
    _origLog('[Bot 3] ✅ Sesi ditemukan — memulai Bot 3...');
    clientstart(config.session3 || 'sesi_bot3', false, true).catch(e => _origError('[Bot 3] Fatal:', e.message));
} else if (!sesiAda3) {
    _origLog('[Bot 3] ⏳ Sesi belum ada — Bot 3 tidak dijalankan. Ketik !pairing <nomor> untuk mulai pairing (otomatis pilih slot kosong).');
} else {
    _origLog('[Bot 3] ⛔ Pairing Bot 3 dimatikan — sesi tidak dijalankan.');
}

// Ekspos fungsi start/restart Bot 3 — dipanggil dari !pairing di message.js
global.startBot3 = () => {
    if (global.BOT3_PAIRING_DISABLED) {
        _origLog('[Bot 3] ⛔ Tidak bisa start — BOT3_PAIRING_DISABLED masih true.');
        return;
    }
    _origLog('[Bot 3] 🔄 Memulai sesi Bot 3...');
    clientstart(config.session3 || 'sesi_bot3', false, true).catch(e => _origError('[Bot 3] Fatal:', e.message));
};
