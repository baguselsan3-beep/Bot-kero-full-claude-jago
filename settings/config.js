'use strict';

const config = {
    // ══════════════════════════════════════
    //   WAJIB DIISI SEBELUM MENJALANKAN BOT
    // ══════════════════════════════════════

    // Nomor WA owner (format internasional tanpa +, misal "6281234567890")
    owner: "",
    botNumber: "",                          // Nomor WA bot 1
    botNumber2: "",                         // ⚠️ Ganti dengan nomor WA bot ke-2 (tanpa +)
    botNumber3: "",                         // ⚠️ Isi setelah pairing Bot 3 (nomor WA bot ke-3, tanpa +)
    session: "sesi_bot",                    // Nama folder session bot 1
    session2: "sesi_bot2",                  // Nama folder session bot 2
    session3: "sesi_bot3",                  // Nama folder session bot 3

    // MongoDB connection string
    // Format: mongodb+srv://USER:PASS@cluster.mongodb.net/?appName=APPNAME
    mongoSrv: "",  // ⚠️ WAJIB DIGANTI dengan MongoDB Atlas connection string kamu

    // Nomor admin bot (bisa lebih dari 1, tanpa @ dan tanpa +)
    admins: [],  // Format sama dengan owner: 62xxx

    // ══════════════════════════════════════
    //   TELEGRAM BOT (OPSIONAL)
    // ══════════════════════════════════════
    telegram: {
        enabled: false,
        botToken: "ISI_TOKEN_DARI_BOTFATHER",
        channelId: ""           // ID channel log (kosongkan jika tidak dipakai)
    },

    // ══════════════════════════════════════
    //   GROQ AI
    // ══════════════════════════════════════
    groqApiKey: "",
    cerebrasApiKey: "",

    // ══════════════════════════════════════
    //   INFO & TAMPILAN BOT
    // ══════════════════════════════════════
    version: "v0.0.5",
    settings: {
        title:       "Makan Bot",
        packname:    "Fisch",
        description: "Bot Pentol— by Mango",
        author:      "Rusdi",
        footer:      "Jomok Bot • Selamat Ngawi!"
    },

    // ══════════════════════════════════════
    //   STATUS & FITUR
    // ══════════════════════════════════════
    status: {
        public:   true,    // true = siapapun bisa pakai
        terminal: true,    // true = pairing code via terminal
        reactsw:  false    // true = auto react status WA
    },

    // Timeout sesi menu reply-angka (ms)
    sessionTTL: 60000,

    // ══════════════════════════════════════
    //   PESAN SISTEM
    // ══════════════════════════════════════
    message: {
        owner:   "⛔ Perintah ini hanya untuk owner bot.",
        group:   "⛔ Perintah ini hanya untuk group.",
        admin:   "⛔ Perintah ini hanya untuk admin group.",
        private: "⛔ Perintah ini hanya untuk chat private."
    },

    // ══════════════════════════════════════
    //   SOCIAL MEDIA (OPSIONAL)
    // ══════════════════════════════════════
    socialMedia: {
        YouTube:   "https://youtube.com/@-",
        GitHub:    "https://github.com/-",
        Telegram:  "https://t.me/-",
        ChannelWA: "https://whatsapp.com/channel/-"
    }
};

module.exports = config;

// Hot-reload saat file diubah
let _file = require.resolve(__filename);
require('fs').watchFile(_file, () => {
    require('fs').unwatchFile(_file);
    delete require.cache[_file];
    console.log('[CONFIG] settings/config.js diperbarui!');
});

