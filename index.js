import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import mongoose from 'mongoose';
import pino from 'pino';
import ffmpegPath from 'ffmpeg-static';
import fluentFfmpeg from 'fluent-ffmpeg';
import stickerPkg from 'wa-sticker-formatter';
import { crearMemoria } from './memoria.js';
import makeWASocket, {
    Browsers,
    BufferJSON,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    initAuthCreds,
    makeCacheableSignalKeyStore,
    proto
} from '@whiskeysockets/baileys';

const { Sticker } = stickerPkg;

process.on('unhandledRejection', (r) => console.error('Promesa rechazada sin manejar:', r));
process.on('uncaughtException', (e) => console.error('Excepción sin capturar:', e));

// Servidor mínimo por si el hosting exige abrir un puerto
http.createServer((req, res) => res.end('SKYTEM activo')).listen(process.env.PORT || 3000);

// FFmpeg (binario incluido en npm, no requiere instalar nada en el sistema)
if (ffmpegPath) {
    fluentFfmpeg.setFfmpegPath(ffmpegPath);
    process.env.FFMPEG_PATH = ffmpegPath;
    process.env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH}`;
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('Error: Debes definir MONGO_URI en el archivo .env');
    process.exit(1);
}

const logger = pino({ level: 'silent' });

/* ------------------------------ MongoDB ------------------------------ */

const Juego = mongoose.model('Juego', new mongoose.Schema({
    nombre: { type: String, required: true, unique: true }
}));

// Memoria de SKYTEM: una ficha por persona y una memoria colectiva por chat
const Perfil = mongoose.model('Perfil', new mongoose.Schema({
    _id: String,
    nombre: String,
    apodo: String,
    hechos: [String],
    notas: String,
    cercania: Number,
    interacciones: Number,
    preguntasNombre: Number,
    muestras: [String],
    ultimaVez: Date
}, { versionKey: false }));

const Grupo = mongoose.model('Grupo', new mongoose.Schema({
    _id: String,
    resumen: String,
    chistes: [String],
    recientes: [new mongoose.Schema({
        j: String, n: String, t: String, r: String, b: Boolean, p: String, ts: Number
    }, { _id: false })],
    desdeActualizacion: Number
}, { versionKey: false }));

// Ajustes por chat (por ahora: si SKYTEM puede hablar libremente)
const Ajuste = mongoose.model('Ajuste', new mongoose.Schema({
    _id: String,
    libre: Boolean
}, { versionKey: false }));

// Sesión de WhatsApp guardada en MongoDB (una fila por clave)
const AuthDoc = mongoose.model('BaileysAuth', new mongoose.Schema({
    _id: String,
    data: String
}, { versionKey: false }));

const SESSION_ID = process.env.SESSION_ID || 'skytem';

async function useMongoAuthState() {
    const ser = (obj) => JSON.stringify(obj, BufferJSON.replacer);
    const de = (str) => JSON.parse(str, BufferJSON.reviver);
    const id = (name) => `${SESSION_ID}:${name}`;

    const readData = async (name) => {
        const doc = await AuthDoc.findById(id(name)).lean();
        return doc ? de(doc.data) : null;
    };
    const writeData = (name, value) =>
        AuthDoc.updateOne({ _id: id(name) }, { $set: { data: ser(value) } }, { upsert: true });
    const removeData = (name) => AuthDoc.deleteOne({ _id: id(name) });

    const creds = (await readData('creds')) || initAuthCreds();

    // Escrituras de creds en cola: siempre se guarda el estado MÁS reciente y en orden
    let cola = Promise.resolve();
    const guardarCreds = () => {
        cola = cola
            .then(() => writeData('creds', creds))
            .catch((e) => console.error('Error guardando creds en Mongo:', e.message));
        return cola;
    };

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (keyId) => {
                        let value = await readData(`${type}-${keyId}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[keyId] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tareas = [];
                    for (const category in data) {
                        for (const keyId in data[category]) {
                            const value = data[category][keyId];
                            const name = `${category}-${keyId}`;
                            tareas.push(value ? writeData(name, value) : removeData(name));
                        }
                    }
                    await Promise.all(tareas);
                }
            }
        },
        saveCreds: guardarCreds,
        flush: () => cola,
        clearAll: () => AuthDoc.deleteMany({ _id: new RegExp(`^${SESSION_ID}:`) })
    };
}

/* ------------------------------ Datos ------------------------------ */

const RESPUESTAS_8BALL = [
    'Sí.', 'No.', 'Puede ser.', 'Probablemente.',
    'Definitivamente no.', 'Pregunta de nuevo más tarde.'
];

const ACCIONES = {
    golpear:   { api: 'punch',    con: 'ha golpeado a',            solo: 'ha lanzado un golpe al aire' },
    patear:    { api: 'kick',     con: 'ha pateado a',             solo: 'ha pateado el aire' },
    acariciar: { api: 'pat',      con: 'ha acariciado a',          solo: 'acaricia el aire' },
    abrazar:   { api: 'hug',      con: 'ha abrazado a',            solo: 'abraza al aire' },
    besar:     { api: 'kiss',     con: 'ha besado a',              solo: 'lanza un beso al aire' },
    bofetada:  { api: 'slap',     con: 'ha abofeteado a',          solo: 'ha dado una bofetada al aire' },
    acurrucar: { api: 'cuddle',   con: 'se ha acurrucado con',     solo: 'se acurruca con el aire' },
    matar:     { api: 'shoot',    con: 'le ha disparado a',        solo: 'dispara al aire' },
    lanzar:    { api: 'yeet',     con: 'ha lanzado por los aires a', solo: 'lanza algo por los aires' },
    bonk:      { api: 'bonk',     con: 'le ha dado un bonk a',     solo: 'da un bonk al aire' },
    morder:    { api: 'bite',     con: 'ha mordido a',             solo: 'muerde el aire' },
    saludar:   { api: 'wave',     con: 'saluda a',                 solo: 'saluda al aire' },
    bailar:    { api: 'dance',    con: 'baila con',                solo: 'baila solo' },
    sonreir:   { api: 'smile',    con: 'le sonríe a',              solo: 'sonríe al aire' },
    cosquillas:{ api: 'tickle',   con: 'le hace cosquillas a',     solo: 'hace cosquillas al aire' },
    picar:     { api: 'poke',     con: 'ha picado a',              solo: 'pica al aire' },
    chocar5:   { api: 'highfive', con: 'chocó los cinco con',      solo: 'choca los cinco con el aire' },
    llorar:    { api: 'cry',      con: 'llora frente a',           solo: 'llora' },
    reir:      { api: 'laugh',    con: 'se ríe de',                solo: 'se ríe' },
    sonrojar:  { api: 'blush',    con: 'se sonroja con',           solo: 'se sonroja' },
    mirar:     { api: 'stare',    con: 'mira fijamente a',         solo: 'mira fijamente al vacío' },
    guino:     { api: 'wink',     con: 'le guiña el ojo a',        solo: 'guiña el ojo' },
    alimentar: { api: 'feed',     con: 'ha dado de comer a',       solo: 'come algo rico' },
    cargar:    { api: 'carry',    con: 'carga a',                  solo: 'carga al aire' },
    manos:     { api: 'handhold', con: 'toma de la mano a',        solo: 'toma la mano del aire' },
    saludomilitar: { api: 'salute', con: 'saluda militarmente a',  solo: 'hace un saludo militar' },
    enojo:     { api: 'angry',    con: 'se enoja con',             solo: 'se enoja' },
    facepalm:  { api: 'facepalm', con: 'se hace facepalm por',     solo: 'se hace facepalm' },
    baka:      { api: 'baka',     con: 'le dice baka a',           solo: 'dice baka al aire' }
};

/* ------------------------------ Utilidades ------------------------------ */

// Acepta varios nombres de variable y limpia espacios, saltos de línea o comillas que se cuelan al pegar la key
const POLL_KEY = (process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_KEY || process.env.POLLINATIONS_TOKEN || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();

async function llm({ messages, temperature = 0.9, maxTokens = 200, extra = {} }) {
    const headers = { 'Content-Type': 'application/json' };
    if (POLL_KEY) {
        headers['Authorization'] = `Bearer ${POLL_KEY}`;
    }
    const pedir = (extra) => fetch('https://gen.pollinations.ai/v1/chat/completions', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
            model: process.env.POLLINATIONS_MODEL || 'openai',
            messages,
            ...extra
        })
    });

    // Algunos modelos rechazan ciertos parámetros: se reintenta quitando primero las penalizaciones y luego todo
    let response;
    for (const cuerpo of [
        { temperature, max_tokens: maxTokens, ...extra },
        { temperature, max_tokens: maxTokens },
        {}
    ]) {
        response = await pedir(cuerpo);
        if (response.status !== 400) break;
    }

    if (response.status === 401) {
        console.error(POLL_KEY
            ? `[LLM] 401: Pollinations rechazó la key enviada (empieza por "${POLL_KEY.slice(0, 3)}", ${POLL_KEY.length} caracteres). Debe ser una key de https://enter.pollinations.ai/keys (sk_...).`
            : '[LLM] 401: no se envió ninguna key. Define POLLINATIONS_API_KEY en las variables de entorno de Render y vuelve a desplegar.');
    }
    if (!response.ok) {
        const detalle = await response.text().catch(() => '');
        throw new Error(`Pollinations API error: ${response.status} ${response.statusText} ${detalle}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? '';
}

const memoria = crearMemoria({ Perfil, Grupo, llm });

function gifAMp4(entrada, salida) {
    return new Promise((resolve, reject) => {
        fluentFfmpeg(entrada)
            .outputOptions([
                '-movflags faststart',
                '-pix_fmt yuv420p',
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-an'
            ])
            .format('mp4')
            .on('end', resolve)
            .on('error', reject)
            .save(salida);
    });
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Saca el contenido real del mensaje (desenvuelve efímeros, view once, etc.)
function desenvolver(message) {
    let m = message;
    while (m) {
        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
        else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
        else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
        else break;
    }
    return m || {};
}

function obtenerTexto(m) {
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    );
}

function obtenerContexto(m) {
    const tipo = Object.keys(m).find((k) => m[k]?.contextInfo);
    return tipo ? m[tipo].contextInfo : null;
}

/* ------------------------------ Bot ------------------------------ */

const INICIO = Math.floor(Date.now() / 1000);
const procesados = new Set();

async function iniciarSocket() {
    const { state, saveCreds, flush, clearAll } = await useMongoAuthState();
    console.log(`[SESIÓN] al iniciar -> registrada: ${!!state.creds.registered}, cuenta: ${state.creds.me?.id || 'ninguna'}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Código de vinculación (sin QR)
    if (!sock.authState.creds.registered && !sock.authState.creds.account) {
        const numero = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
        if (!numero) {
            console.error('Define WHATSAPP_NUMBER (con código de país, solo dígitos) para vincular con código.');
        } else {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(numero);
                    console.log('=========================================');
                    console.log('CÓDIGO DE VINCULACIÓN:', code);
                    console.log('=========================================');
                } catch (e) {
                    console.error('No se pudo pedir el código de vinculación:', e.message);
                }
            }, 3000);
        }
    }

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
            console.log('[READY] SKYTEM conectado.');
        }
        if (connection === 'close') {
            const codigo = lastDisconnect?.error?.output?.statusCode;
            console.log('[DESCONECTADO] código:', codigo);

            if (codigo === DisconnectReason.loggedOut) {
                console.log('Sesión cerrada desde el teléfono. Borrando sesión guardada...');
                await clearAll();
            }
            // Espera a que las credenciales terminen de guardarse antes de reconectar
            await flush();
            // Reintenta siempre (si se cerró sesión, pedirá un código nuevo)
            setTimeout(() => iniciarSocket().catch((e) => console.error('Error al reconectar:', e)), 3000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const msg of messages) {
            try {
                if (!msg.message || !msg.key?.id) continue;
                if (procesados.has(msg.key.id)) continue;
                procesados.add(msg.key.id);
                if (procesados.size > 500) procesados.delete(procesados.values().next().value);

                const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0);
                if (ts && ts < INICIO - 10) continue; // ignora mensajes viejos

                await manejarComando(sock, msg);
                if (type === 'notify') await conversar(sock, msg);
            } catch (e) {
                console.error('Error procesando mensaje:', e);
            }
        }
    });
}

/* ------------------------------ Charla natural ------------------------------ */

// Probabilidad de que SKYTEM se meta solo en un grupo (0 = nunca, por defecto). Tiene 10 min de enfriamiento por chat.
const PROB_INTERVENCION = Number(process.env.INTERVENCION ?? 0);
const NOMBRE_BOT = /\b(skytem|sky)\b/i;

// HABLA LIBRE (se cambia con !libre on / !libre off, por chat)
//  ON  = sigue la conversación, responde si dicen su nombre y (si INTERVENCION > 0) se mete solo.
//  OFF = solo responde si lo mencionan, le responden a un mensaje suyo, escriben su nombre o usan !bot.
// Valor inicial de los chats que nunca lo han tocado: HABLA_LIBRE=false en el .env lo deja apagado por defecto.
const LIBRE_POR_DEFECTO = !/^(0|false|no|off)$/i.test(process.env.HABLA_LIBRE ?? 'true');
const ajustesLibre = new Map();
const pendientesBorrado = new Map(); // confirmaciones de !borrartodo (60 s)

async function hablaLibre(chat) {
    if (ajustesLibre.has(chat)) return ajustesLibre.get(chat);
    try {
        const a = await Ajuste.findById(chat).lean();
        const valor = typeof a?.libre === 'boolean' ? a.libre : LIBRE_POR_DEFECTO;
        ajustesLibre.set(chat, valor);
        return valor;
    } catch (e) {
        console.error('Error leyendo ajuste de habla libre:', e.message);
        return LIBRE_POR_DEFECTO;
    }
}

async function fijarLibre(chat, valor) {
    ajustesLibre.set(chat, valor);
    await Ajuste.updateOne({ _id: chat }, { $set: { libre: valor } }, { upsert: true });
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const soloNumero = (j) => (j || '').split('@')[0].split(':')[0];

function idsDelBot(sock) {
    return new Set([soloNumero(sock.user?.id), soloNumero(sock.user?.lid)].filter(Boolean));
}

// Una cola por chat para que las respuestas no se pisen entre sí
const colas = new Map();
function enCola(chat, tarea) {
    const previa = colas.get(chat) || Promise.resolve();
    const actual = previa.then(tarea).catch((e) => console.error('Error en charla:', e));
    colas.set(chat, actual);
    actual.then(() => { if (colas.get(chat) === actual) colas.delete(chat); });
    return actual;
}

function tipoMedia(m) {
    if (m.stickerMessage) return '[sticker]';
    if (m.imageMessage) return '[foto]';
    if (m.videoMessage) return m.videoMessage.gifPlayback ? '[gif]' : '[video]';
    if (m.audioMessage) return m.audioMessage.ptt ? '[nota de voz]' : '[audio]';
    if (m.documentMessage) return '[archivo]';
    if (m.locationMessage || m.liveLocationMessage) return '[ubicación]';
    if (m.contactMessage || m.contactsArrayMessage) return '[contacto]';
    if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) return '[encuesta]';
    return '';
}

// Texto + marca de multimedia, para que la memoria no tenga huecos cuando mandan fotos, stickers o audios
function descripcionMensaje(m) {
    const t = obtenerTexto(m).trim();
    const media = tipoMedia(m);
    return media ? `${media} ${t}`.trim() : t;
}

// Cambia "@5491234..." por el nombre de la persona mencionada
async function textoLegible(texto, ctx, yo) {
    let t = texto;
    for (const j of ctx?.mentionedJid || []) {
        const num = soloNumero(j);
        const nom = yo.has(num) ? 'SKYTEM' : (await memoria.nombreDe(j)) || 'alguien';
        t = t.split(`@${num}`).join(`@${nom}`);
    }
    return t;
}

async function conversar(sock, msg, { forzar = false, texto: textoForzado } = {}) {
    const chat = msg.key.remoteJid;
    if (!chat || chat === 'status@broadcast' || chat.endsWith('@newsletter')) return;
    if (msg.key.fromMe && !forzar) return;

    const contenido = desenvolver(msg.message);
    const crudo = (textoForzado ?? obtenerTexto(contenido)).trim();
    if (!forzar && /^[\/!]/.test(crudo)) return; // los comandos no son charla

    let texto = (textoForzado ?? descripcionMensaje(contenido)).trim();
    if (!texto) return;

    const esGrupo = chat.endsWith('@g.us');
    const jid = msg.key.participant || chat;
    const nombre = msg.pushName || soloNumero(jid);

    const ctx = obtenerContexto(contenido);
    const yo = idsDelBot(sock);
    texto = await textoLegible(texto, ctx, yo);

    // A quién le está respondiendo (si cita un mensaje)
    let respondiendoA = '';
    if (ctx?.quotedMessage) {
        const autor = yo.has(soloNumero(ctx.participant))
            ? 'SKYTEM'
            : (await memoria.nombreDe(ctx.participant)) || 'alguien';
        const citado = descripcionMensaje(desenvolver(ctx.quotedMessage)).slice(0, 80);
        respondiendoA = citado ? `${autor}: "${citado}"` : autor;
    }

    await memoria.registrarMensaje({ chat, jid, nombre, texto, respondiendoA });
    memoria.tick(chat);

    // Multimedia sin texto (sticker, foto, audio...): se guarda para el contexto, pero no dispara respuesta
    if (!forzar && /^\[[^\]]+\]$/.test(texto)) return;

    const mencionaAlBot = ctx?.mentionedJid?.some((j) => yo.has(soloNumero(j)));
    const respondeAlBot = ctx?.participant && yo.has(soloNumero(ctx.participant));
    const mencionaAOtro = ctx?.mentionedJid?.some((j) => !yo.has(soloNumero(j)));
    const respondeAOtro = ctx?.participant && !respondeAlBot;

    // directo: te hablan a ti · ambiguo: dijeron tu nombre, quizá no contigo · espontaneo: te metes solo
    // seguimiento: llevan una conversación seguida con SKYTEM (2+ turnos) y esta persona sigue sin citarlo ni mencionarlo
    const dirigidoAOtro = mencionaAOtro || respondeAOtro;

    // Con el habla libre apagada solo responde si lo llaman: mención, respuesta a un mensaje suyo, su nombre o !bot
    const libre = await hablaLibre(chat);
    const llamado = forzar || mencionaAlBot || respondeAlBot;
    const seg = libre && !dirigidoAOtro && esGrupo ? await memoria.seguimiento(chat, jid) : null;

    let modo = null;
    if (llamado || (libre && !esGrupo)) modo = 'directo';
    else if (seg) modo = 'seguimiento';
    else if (NOMBRE_BOT.test(texto)) modo = 'ambiguo';
    else if (libre && !dirigidoAOtro && memoria.debeIntervenir(chat, texto, PROB_INTERVENCION)) modo = 'espontaneo';
    if (!modo) return;

    await enCola(chat, async () => {
        let mensajes;
        try {
            if (modo === 'directo') sock.sendPresenceUpdate('composing', chat).catch(() => {});
            mensajes = await memoria.responder({ chat, jid, nombre, texto, modo, esGrupo });
        } catch (e) {
            console.error('Error generando respuesta:', e.message, `(modo: ${modo}, mensaje: "${texto.slice(0, 40)}")`);
            if (modo !== 'directo') return;
            mensajes = ['uff se me colgó el cerebro jaja, repite'];
        }

        for (let i = 0; i < mensajes.length; i++) {
            await sock.sendPresenceUpdate('composing', chat).catch(() => {});
            await esperar(Math.min(700 + mensajes[i].length * 45, 4000)); // efecto "escribiendo..."
            const opciones = i === 0 && esGrupo && modo !== 'espontaneo' ? { quoted: msg } : undefined;
            await sock.sendMessage(chat, { text: mensajes[i] }, opciones);
            await sock.sendPresenceUpdate('paused', chat).catch(() => {});
            await memoria.registrarMensaje({
                chat, jid: 'skytem', nombre: 'SKYTEM', texto: mensajes[i], deBot: true,
                para: modo === 'espontaneo' ? '' : jid
            });
        }
    });
}

// Dueño(s) del bot: DUENOS=18091234567,18097654321 en el .env. Además, todo lo que se escriba desde el propio número del bot cuenta como del dueño.
const DUENOS = (process.env.DUENOS || process.env.OWNER_NUMBER || '')
    .split(/[,\s]+/).map((n) => n.replace(/\D/g, '')).filter(Boolean);
const esDueno = (msg, remitente) => !!msg?.key?.fromMe || DUENOS.includes(soloNumero(remitente));

// Compara por NÚMERO (sin sufijos de dispositivo/servidor) y acepta id, lid y número: WhatsApp los mezcla según el grupo.
// Si no se puede leer la lista de admins, lanza error (el que llama lo distingue de "no eres admin").
async function esAdminOPrivado(sock, chat, remitente, msg) {
    if (!chat.endsWith('@g.us')) return true;
    if (esDueno(msg, remitente)) return true;
    const meta = await sock.groupMetadata(chat);
    const yo = new Set([remitente, msg?.key?.participantAlt].map(soloNumero).filter(Boolean));
    return meta.participants.some(
        (p) => p.admin && [p.id, p.lid, p.phoneNumber].filter(Boolean).some((x) => yo.has(soloNumero(x)))
    );
}

// Menú: para quitar un comando del menú, añade su nombre a OCULTOS_DEL_MENU (las acciones con "/", ej. '/golpear').
// Ocultarlo del menú NO lo desactiva: sigue funcionando.
const OCULTOS_DEL_MENU = new Set(['olvidargrupo']);
const MENU = [
    ['s', '• !s / !sticker - Convierte imagen/GIF/video a sticker'],
    ['bot', '• !bot <mensaje> - Háblale a SKYTEM (también responde si lo mencionas o dices su nombre)'],
    ['juego', '• !juego - Selecciona un juego al azar'],
    ['addjuego', '• !addjuego <nombre> - Añade un juego'],
    ['listajuegos', '• !listajuegos - Muestra la lista de juegos'],
    ['deljuego', '• !deljuego <nombre> - Elimina un juego'],
    ['ruleta', '• !ruleta opc1, opc2... - Elige una opción'],
    ['8ball', '• !8ball <pregunta> - Pregunta a la bola 8'],
    ['moneda', '• !moneda - Lanza una moneda'],
    ['libre', '• !libre on/off - Activa o desactiva que SKYTEM hable libremente (admins). Sin nada muestra el estado'],
    ['perfil', '• !perfil - Lo que SKYTEM sabe de ti'],
    ['olvidame', '• !olvidame - Borra tu perfil y tus mensajes guardados'],
    ['olvidargrupo', '• !olvidargrupo - Borra solo la memoria del chat (admins)'],
    ['borrartodo', '• !borrartodo - Borra TODA la memoria del chat y las fichas de sus miembros, con confirmación (admins)']
];

async function manejarComando(sock, msg) {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;

    const contenido = desenvolver(msg.message);
    // Tolera "! perfil" o "!Perfil" (el teclado suele meter espacio o mayúscula)
    const text = obtenerTexto(contenido).trim().replace(/^!\s*(\S+)/, (_, c) => `!${c.toLowerCase()}`);
    if (!text.startsWith('/') && !text.startsWith('!')) return;

    const reaccionar = (emoji) =>
        sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {});
    const responder = (texto, extra = {}) =>
        sock.sendMessage(jid, { text: texto, ...extra }, { quoted: msg });

    const remitente = msg.key.participant || msg.key.remoteJid;
    const nombreDe = msg.pushName || remitente.split('@')[0];
    const contexto = obtenerContexto(contenido);

    // Verifica admin y responde con el motivo correcto (antes un fallo al leer el grupo se veía como "no eres admin")
    const exigirAdmin = async (mensajeNo) => {
        try {
            if (await esAdminOPrivado(sock, jid, remitente, msg)) return true;
            await reaccionar('❌');
            await responder(mensajeNo);
        } catch (e) {
            console.error('No se pudo verificar admin:', e.message);
            await reaccionar('❌');
            await responder('No pude verificar si eres admin (WhatsApp no me dio la lista del grupo). Intenta de nuevo en unos segundos.');
        }
        return false;
    };

    /* ----- Acciones anime ----- */
    if (text.startsWith('/')) {
        const comando = text.substring(1).split(/\s+/)[0].toLowerCase();
        const accion = ACCIONES[comando];
        if (!accion) return;

        const stamp = Date.now();
        const tmpGif = path.join(os.tmpdir(), `skytem_${stamp}.gif`);
        const tmpMp4 = path.join(os.tmpdir(), `skytem_${stamp}.mp4`);

        try {
            await reaccionar('❕');

            // Objetivo: primero menciones, luego mensaje respondido
            let objetivo = null;
            if (contexto?.mentionedJid?.length) objetivo = contexto.mentionedJid[0];
            else if (contexto?.participant) objetivo = contexto.participant;

            let caption;
            let menciones = [];
            if (objetivo) {
                caption = `${nombreDe} ${accion.con} @${objetivo.split('@')[0]}`;
                menciones = [objetivo];
            } else {
                caption = `${nombreDe} ${accion.solo}`;
            }

            const r = await axios.get(`https://nekos.best/api/v2/${accion.api}`, {
                headers: { 'User-Agent': 'SKYTEM-Bot/1.0' }
            });
            const gifUrl = r.data.results[0].url;
            const gif = await axios.get(gifUrl, { responseType: 'arraybuffer' });
            fs.writeFileSync(tmpGif, gif.data);
            await gifAMp4(tmpGif, tmpMp4);

            await sock.sendMessage(jid, {
                video: fs.readFileSync(tmpMp4),
                gifPlayback: true,
                caption,
                mentions: menciones
            }, { quoted: msg });

            await reaccionar('✅');
        } catch (error) {
            console.error('Error en acción anime:', error);
            await reaccionar('❌');
            await responder('Error al obtener la animación.');
        } finally {
            [tmpGif, tmpMp4].forEach((f) => { try { fs.unlinkSync(f); } catch {} });
        }
        return;
    }

    /* ----- Comandos con ! ----- */

    // 1. Sticker
    if (text === '!s' || text === '!sticker') {
        let objetoMedia = null;
        const tieneMedia = (m) => m.imageMessage || m.videoMessage || m.stickerMessage;

        if (tieneMedia(contenido)) {
            objetoMedia = msg;
        } else if (contexto?.quotedMessage && tieneMedia(desenvolver(contexto.quotedMessage))) {
            objetoMedia = {
                key: {
                    remoteJid: jid,
                    id: contexto.stanzaId,
                    participant: contexto.participant
                },
                message: contexto.quotedMessage
            };
        }

        if (!objetoMedia) {
            await reaccionar('❔');
            await responder('Envía o responde a una imagen, GIF o video corto con !s');
            return;
        }

        try {
            await reaccionar('❕');
            const buffer = await downloadMediaMessage(
                objetoMedia,
                'buffer',
                {},
                { logger, reuploadRequest: sock.updateMediaMessage }
            );
            const sticker = new Sticker(buffer, {
                pack: 'SKYTEM',
                author: 'Les Exitoses',
                type: 'full',
                quality: 50
            });
            await sock.sendMessage(jid, { sticker: await sticker.toBuffer() }, { quoted: msg });
            await reaccionar('✅');
        } catch (error) {
            console.error('Error creando sticker:', error);
            await reaccionar('❌');
            await responder('Error al crear el sticker.');
        }
        return;
    }

    // 2. Ayuda
    if (text === '!ayuda' || text === '!help') {
        await reaccionar('ℹ️');
        const acciones = Object.keys(ACCIONES).filter((c) => !OCULTOS_DEL_MENU.has('/' + c)).map((c) => '/' + c);
        const menu = `*Comandos disponibles:*\n` +
            MENU.filter(([id]) => !OCULTOS_DEL_MENU.has(id)).map(([, t]) => t).join('\n') +
            (acciones.length ? `\n\n*Acciones (usar con /):*\n• ${acciones.join(', ')}` : '');
        await responder(menu);
        return;
    }

    // 2b. Habla libre: activar / desactivar
    const cmdLibre = text.match(/^!(?:libre|hablar)(?:\s+(\S+))?\s*$/i);
    if (cmdLibre) {
        const arg = (cmdLibre[1] || '').toLowerCase();
        const ON = ['on', 'si', 'sí', 'activar', 'activa', '1'];
        const OFF = ['off', 'no', 'desactivar', 'desactiva', '0'];

        if (!arg || arg === 'estado') {
            const activo = await hablaLibre(jid);
            await reaccionar('ℹ️');
            await responder(
                `Habla libre: *${activo ? 'ACTIVADA' : 'DESACTIVADA'}*\n` +
                (activo
                    ? 'Sigo la conversación, respondo si dicen mi nombre' + (PROB_INTERVENCION > 0 ? ' y a veces me meto solo.' : '.')
                    : 'Solo respondo si me mencionan, me responden a un mensaje mío, escriben mi nombre o usan !bot.') +
                '\n\nCambiar: !libre on / !libre off'
            );
            return;
        }
        if (!ON.includes(arg) && !OFF.includes(arg)) {
            await reaccionar('❔');
            await responder('Usa !libre on, !libre off o !libre estado');
            return;
        }
        if (!(await exigirAdmin('Solo admins pueden cambiar esto.'))) return;
        const nuevo = ON.includes(arg);
        await fijarLibre(jid, nuevo);
        await reaccionar('✅');
        await responder(nuevo
            ? 'listo, hablo libremente: sigo la conversación y respondo si dicen mi nombre'
            : 'listo, modo callado: solo respondo si me mencionan, me responden un mensaje, escriben mi nombre o usan !bot');
        return;
    }

    // 3. Hablar con SKYTEM (con memoria)
    if (text.startsWith('!bot ') || text.startsWith('!ia ')) {
        const prompt = text.replace(/^!(bot|ia)\s+/, '').trim();
        if (!prompt) {
            await reaccionar('❔');
            await responder('Escribe algo.');
            return;
        }
        await conversar(sock, msg, { forzar: true, texto: prompt });
        return;
    }

    // 3b. Control de la memoria
    if (text === '!perfil' || text === '!mimemoria') {
        await responder(await memoria.verPerfil(remitente));
        return;
    }

    if (text === '!olvidame') {
        await memoria.olvidarPerfil([remitente, msg.key.participantAlt, msg.key.remoteJidAlt].filter(Boolean));
        await reaccionar('✅');
        await responder('listo, borré lo que sabía de ti y tus mensajes guardados en todos los chats');
        return;
    }

    if (text === '!olvidargrupo') {
        if (!(await exigirAdmin('Solo admins pueden borrar la memoria del grupo.'))) return;
        await memoria.olvidarGrupo(jid);
        await reaccionar('✅');
        await responder('memoria del chat borrada (las fichas de las personas siguen; para borrarlo todo usa !borrartodo)');
        return;
    }

    // 3c. Borrar TODO, con confirmación (60 s)
    //   !borrartodo          -> memoria del chat + fichas de sus miembros (admins)
    //   !borrartodo global   -> toda la memoria de todos los chats (solo dueño)
    const cmdBorrar = text.match(/^!borrartodo(?:\s+(global))?(?:\s+(confirmar))?\s*$/i);
    if (cmdBorrar) {
        const global = !!cmdBorrar[1];
        const confirma = !!cmdBorrar[2];
        const clave = `${jid}|${soloNumero(remitente)}|${global ? 'g' : 'c'}`;

        if (global) {
            if (!esDueno(msg, remitente)) {
                await reaccionar('❌');
                await responder(DUENOS.length
                    ? 'Solo el dueño del bot puede borrar todo de forma global.'
                    : 'Para el borrado global define DUENOS en el .env (tu número con código de país, solo dígitos) o escríbelo desde el número del bot.');
                return;
            }
        } else if (!(await exigirAdmin('Solo admins pueden borrar la memoria del chat.'))) {
            return;
        }

        if (!confirma) {
            pendientesBorrado.set(clave, Date.now());
            await reaccionar('⚠️');
            await responder(global
                ? 'Esto borra TODA la memoria de SKYTEM en TODOS los chats (todas las fichas y todos los resúmenes). No toca la sesión de WhatsApp, la lista de juegos ni el ajuste !libre.\n\nPara confirmar escribe *!borrartodo global confirmar* (vale 60 s).'
                : 'Esto borra TODA la memoria de este chat (resumen, chistes y mensajes guardados) y las fichas de las personas del chat, incluido lo que sé de ellas en otros chats. No toca la lista de juegos ni el ajuste !libre.\n\nPara confirmar escribe *!borrartodo confirmar* (vale 60 s).');
            return;
        }

        const t = pendientesBorrado.get(clave);
        pendientesBorrado.delete(clave);
        if (!t || Date.now() - t > 60_000) {
            await reaccionar('❔');
            await responder(`No hay un borrado pendiente (o pasó más de 1 minuto). Escribe primero *!borrartodo${global ? ' global' : ''}*`);
            return;
        }

        try {
            await reaccionar('❕');
            if (global) {
                const r = await memoria.olvidarTodo();
                await reaccionar('✅');
                await responder(`listo, borré todo: ${r.perfiles} fichas y la memoria de ${r.chats} chats`);
            } else {
                const ids = [];
                if (jid.endsWith('@g.us')) {
                    const meta = await sock.groupMetadata(jid).catch(() => null);
                    for (const p of meta?.participants || []) ids.push(p.id, p.lid, p.phoneNumber);
                } else {
                    ids.push(jid);
                }
                const r = await memoria.olvidarChat(jid, ids);
                await reaccionar('✅');
                await responder(`listo, borré la memoria del chat y ${r.perfiles} fichas de personas`);
            }
        } catch (e) {
            console.error('Error en !borrartodo:', e);
            await reaccionar('❌');
            await responder('Algo falló al borrar, intenta de nuevo.');
        }
        return;
    }

    // 4. Elegir juego
    if (text === '!juego') {
        const juegos = await Juego.find();
        if (juegos.length === 0) {
            await reaccionar('❔');
            await responder('La lista de juegos está vacía. Añade uno con !addjuego <nombre>');
        } else {
            await reaccionar('✅');
            const elegido = juegos[Math.floor(Math.random() * juegos.length)];
            await responder(`Juego seleccionado: *${elegido.nombre}*`);
        }
        return;
    }

    // 5. Agregar juego
    if (text.startsWith('!addjuego ')) {
        const nuevo = text.replace('!addjuego ', '').trim();
        if (!nuevo) {
            await reaccionar('❔');
            await responder('Especifica el nombre del juego.');
            return;
        }
        try {
            await Juego.create({ nombre: nuevo });
            await reaccionar('✅');
            await responder(`*${nuevo}* se ha añadido a la lista.`);
        } catch {
            await reaccionar('❌');
            await responder('El juego ya existe en la lista o ocurrió un error.');
        }
        return;
    }

    // 6. Lista de juegos
    if (text === '!listajuegos') {
        const juegos = await Juego.find();
        if (juegos.length === 0) {
            await reaccionar('❔');
            await responder('No hay juegos guardados.');
        } else {
            await reaccionar('✅');
            const lista = juegos.map((j, i) => `${i + 1}. ${j.nombre}`).join('\n');
            await responder(`*Lista de juegos:*\n\n${lista}`);
        }
        return;
    }

    // 7. Eliminar juego
    if (text.startsWith('!deljuego ')) {
        const nombre = text.replace('!deljuego ', '').trim();
        if (!nombre) {
            await reaccionar('❔');
            await responder('Especifica el juego a eliminar.');
            return;
        }
        const res = await Juego.deleteOne({ nombre: new RegExp(`^${escapeRegex(nombre)}$`, 'i') });
        if (res.deletedCount > 0) {
            await reaccionar('✅');
            await responder(`*${nombre}* fue eliminado.`);
        } else {
            await reaccionar('❌');
            await responder(`No se encontró el juego "${nombre}".`);
        }
        return;
    }

    // 8. Ruleta
    if (text.startsWith('!ruleta ')) {
        const opciones = text.replace('!ruleta ', '')
            .split(',').map((o) => o.trim()).filter((o) => o.length > 0);
        if (opciones.length < 2) {
            await reaccionar('❔');
            await responder('Ingresa al menos 2 opciones separadas por coma.');
        } else {
            await reaccionar('✅');
            const elegida = opciones[Math.floor(Math.random() * opciones.length)];
            await responder(`Opción seleccionada: *${elegida}*`);
        }
        return;
    }

    // 9. Bola 8
    if (text.startsWith('!8ball ')) {
        const pregunta = text.replace('!8ball ', '').trim();
        if (!pregunta) {
            await reaccionar('❔');
            await responder('Haz una pregunta.');
            return;
        }
        await reaccionar('✅');
        await responder(RESPUESTAS_8BALL[Math.floor(Math.random() * RESPUESTAS_8BALL.length)]);
        return;
    }

    // 10. Moneda
    if (text === '!moneda') {
        await reaccionar('✅');
        await responder(`Resultado: *${Math.random() < 0.5 ? 'Cara' : 'Cruz'}*`);
    }
}

async function main() {
    console.log('Conectando a MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('Conectado a MongoDB Atlas.');
    console.log(POLL_KEY
        ? `[LLM] Pollinations key detectada (empieza por "${POLL_KEY.slice(0, 3)}", ${POLL_KEY.length} caracteres).`
        : '[LLM] ATENCIÓN: no hay key de Pollinations (POLLINATIONS_API_KEY).');

    // La memoria vive en RAM y se guarda cada 30 s y al apagar
    setInterval(() => memoria.persistirTodo().catch((e) => console.error('Error guardando memoria:', e.message)), 30_000);
    for (const senal of ['SIGINT', 'SIGTERM']) {
        process.on(senal, async () => {
            await memoria.persistirTodo().catch(() => {});
            process.exit(0);
        });
    }

    await iniciarSocket();
}

main().catch((e) => {
    console.error('Error fatal al iniciar:', e);
    process.exit(1);
});