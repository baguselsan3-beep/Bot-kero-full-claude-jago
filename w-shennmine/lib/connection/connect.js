'use strict';

const chalk  = require('chalk');
const path   = require('path');
const config = require(path.resolve(__dirname, '../../../settings/config'));

const MAX_ATTEMPTS = 25;
const MAX_WAIT_MS  = 90_000;

// ── State per-instance (key = botLabel: 'bot1' | 'bot2' | 'bot3') ──
// Sebelumnya variabel ini module-level shared antar semua bot,
// menyebabkan reconnect logic salah satu bot ikut nge-reset/ngaruh ke bot lain.
const _state = new Map();
const getState = (key) => {
    if (!_state.has(key)) {
        _state.set(key, { attempts: 0, onlineLogged: false });
    }
    return _state.get(key);
};

exports.konek = async ({ client, update, clientstart, DisconnectReason, Boom, botLabel = 'bot1' }) => {
    const { connection, lastDisconnect, qr } = update;
    const st = getState(botLabel);
    const tag = `[${botLabel.toUpperCase()}]`;

    if (qr) {
        console.log(chalk.yellow(`\n📱 ${tag} QR muncul — scan atau set terminal:true di config untuk pairing code\n`));
    }

    if (connection === 'connecting') {
        st.onlineLogged = false;
        console.log(chalk.cyan(`\n⏳ ${tag} Menghubungkan ke WhatsApp...`));
        return;
    }

    if (connection === 'open') {
        st.attempts = 0;
        if (botLabel === 'bot1') global.WA_CONNECTED = true;

        if (!st.onlineLogged) {
            st.onlineLogged = true;
            console.log(chalk.green(`\n✅ ${tag} WhatsApp Bot Online!`));
            console.log(chalk.cyan(`🐟 ${tag} Fisch Bot — Aktif & siap menerima pesan!\n`));
        }
        return;
    }

    if (connection === 'close') {
        st.onlineLogged = false;
        if (botLabel === 'bot1') global.WA_CONNECTED = false;

        let code = 500, msg = '';
        try {
            code = new Boom(lastDisconnect?.error)?.output?.statusCode ?? 500;
            msg  = lastDisconnect?.error?.message ?? '';
        } catch (_) {}

        console.log(chalk.red(`\n❌ ${tag} [DISCONNECT] Code: ${code} | ${msg || '(no message)'}`));

        const reconnect = (baseMs = 4000) => {
            st.attempts++;
            if (st.attempts > MAX_ATTEMPTS) {
                console.log(chalk.red(`\n🚫 ${tag} Gagal reconnect ${MAX_ATTEMPTS}x berturut-turut.`));
                // Jangan exit process keseluruhan kalau ini bukan bot1 —
                // biar bot1/bot2/bot3 lain tetap jalan
                if (botLabel === 'bot1') {
                    return process.exit(1);
                } else {
                    console.log(chalk.red(`🚫 ${tag} Berhenti reconnect. Pakai !sesibot2/!sesibot3 atau !pairingbot3/!pairing untuk mulai ulang.`));
                    return;
                }
            }

            const wait = Math.min(baseMs * Math.pow(1.5, st.attempts - 1), MAX_WAIT_MS);
            console.log(chalk.yellow(`🔄 ${tag} Reconnect #${st.attempts}/${MAX_ATTEMPTS} dalam ${(wait / 1000).toFixed(0)}s...`));

            setTimeout(() => {
                try {
                    clientstart();
                } catch (e) {
                    console.error(`[${botLabel} reconnect]`, e.message);
                }
            }, wait);
        };

        switch (code) {
            case DisconnectReason.badSession:
                console.log(chalk.yellow(`⚠️  ${tag} Bad session — reconnect tanpa hapus session...`));
                st.attempts = 0;
                reconnect(2000);
                break;

            case DisconnectReason.connectionClosed:
                reconnect(3000);
                break;

            case DisconnectReason.connectionLost:
                reconnect(5000);
                break;

            case DisconnectReason.connectionReplaced:
                console.log(chalk.red(`⚠️  ${tag} Session digantikan perangkat lain.`));
                if (botLabel === 'bot1') {
                    process.exit(0);
                } else {
                    console.log(chalk.red(`⚠️  ${tag} Berhenti — sesi dipakai device lain. Pairing ulang via !pairing${botLabel === 'bot2' ? '' : botLabel}.`));
                }
                break;

            case DisconnectReason.loggedOut:
                // loggedOut = WA cabut sesi secara paksa (ban / logout manual)
                // Jangan reconnect terus — minta pairing ulang
                console.log(chalk.red(`🚪 ${tag} Logged out oleh WA — sesi tidak valid. Ketik !pairing${botLabel === 'bot1' ? '' : botLabel} untuk pairing ulang.`));
                st.attempts = 0;
                if (global._qrReceived) {
                    // Reset flag QR hanya untuk bot ini, jangan ganggu bot lain
                    const botKeyLabel = botLabel === 'bot1' ? 'Bot 1' : botLabel === 'bot2' ? 'Bot 2' : botLabel === 'bot4' ? 'Bot 4' : 'Bot 3';
                    global._qrReceived[botKeyLabel] = false;
                }
                if (global._pairingInfoShown) {
                    const botKeyLabel = botLabel === 'bot1' ? 'Bot 1' : botLabel === 'bot2' ? 'Bot 2' : botLabel === 'bot4' ? 'Bot 4' : 'Bot 3';
                    global._pairingInfoShown[botKeyLabel] = false;
                }
                // Bot2/3 yang logged out jangan reconnect otomatis terus —
                // cukup beberapa kali, lalu berhenti dan tunggu pairing manual
                if (botLabel === 'bot1') {
                    reconnect(8000);
                } else {
                    if (st.attempts < 3) {
                        reconnect(8000);
                    } else {
                        console.log(chalk.red(`🚪 ${tag} Berhenti reconnect setelah logout. Ketik !pairing${botLabel === 'bot2' ? '' : botLabel} <nomor> untuk pairing ulang.`));
                    }
                }
                break;

            case DisconnectReason.restartRequired:
                st.attempts = 0;
                reconnect(1500);
                break;

            case DisconnectReason.timedOut:
                reconnect(8000);
                break;

            case 401:
                console.log(chalk.red(`🔐 ${tag} 401 — reconnect tanpa hapus session...`));
                st.attempts = 0;
                reconnect(3000);
                break;

            case 403:
                console.log(chalk.red(`🚫 ${tag} Nomor mungkin dibanned WhatsApp.`));
                if (botLabel === 'bot1') {
                    process.exit(1);
                } else {
                    console.log(chalk.red(`🚫 ${tag} Berhenti — kemungkinan nomor dibanned.`));
                }
                break;

            case 408:
                // 408 = WA minta QR baru / session timeout
                // Kalau QR sudah diterima (sesi invalid), jangan loop reconnect
                // — tunggu pairing manual dari user
                {
                    const botKeyLabel = botLabel === 'bot1' ? 'Bot 1' : botLabel === 'bot2' ? 'Bot 2' : botLabel === 'bot4' ? 'Bot 4' : 'Bot 3';
                    if (global._qrReceived && global._qrReceived[botKeyLabel]) {
                        console.log(chalk.yellow(`⚠️  ${tag} 408 — QR diminta WA, menunggu pairing manual. Tidak reconnect otomatis.`));
                        st.attempts = 0; // reset agar tidak exit
                    } else {
                        reconnect(15000); // tunggu lebih lama sebelum retry
                    }
                }
                break;

            case 428:
                reconnect(5000);
                break;

            case 500:
            case 503:
                reconnect(15000);
                break;

            case 515:
                reconnect(10000);
                break;

            default:
                if (msg.includes('not-acceptable') || code === 406) {
                    console.log(chalk.yellow(`⚠️  ${tag} not-acceptable — reconnect cepat...`));
                    reconnect(2000);
                } else if (
                    msg.includes('Connection') ||
                    msg.includes('socket') ||
                    msg.includes('ECONNRESET') ||
                    msg.includes('stream')
                ) {
                    reconnect(6000);
                } else if (msg.includes('rate') || msg.includes('limit')) {
                    reconnect(30000);
                } else {
                    reconnect(5000);
                }
        }
    }
};

