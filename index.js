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
import { voz, infoVoz, imagen, mensajeConImagenes } from './voz.js';
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

/* ------------------------------ MongoDB (sesión de WhatsApp, lista de juegos y memoria de las charlas) ------------------------------ */

const Juego = mongoose.model('Juego', new mongoose.Schema({
    nombre: { type: String, required: true, unique: true }
}));

// Sesión de WhatsApp guardada en MongoDB (una fila por clave)
const AuthDoc = mongoose.model('BaileysAuth', new mongoose.Schema({
    _id: String,
    data: String
}, { versionKey: false }));

// Memoria de cada chat (una fila por chat); se borra sola a los 7 días sin actividad
const CharlaSchema = new mongoose.Schema({
    _id: String,
    ts: Number,
    msgs: { type: [mongoose.Schema.Types.Mixed], default: [] },
    expireAt: Date
}, { versionKey: false });
CharlaSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
const Charla = mongoose.model('Charla', CharlaSchema);

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
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const soloNumero = (j) => (j || '').split('@')[0].split(':')[0];
const limpiar = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

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

// Texto + marca de multimedia (las fotos del mensaje actual se le pasan a la IA aparte; audios y videos solo se anotan)
function descripcionMensaje(m) {
    const t = obtenerTexto(m).trim();
    const media = tipoMedia(m);
    return media ? `${media} ${t}`.trim() : t;
}

// Si un texto del bot empieza con ! o / se le antepone un carácter invisible para que nunca se lea como comando
const proteger = (t) => (/^[\/!]/.test(t) ? `\u200B${t}` : t);

// Una cola por chat para que las respuestas no se pisen entre sí
const colas = new Map();
function enCola(chat, tarea) {
    const previa = colas.get(chat) || Promise.resolve();
    const actual = previa.then(tarea).catch((e) => console.error('Error en cola:', e));
    colas.set(chat, actual);
    actual.then(() => { if (colas.get(chat) === actual) colas.delete(chat); });
    return actual;
}

function idsDelBot(sock) {
    return new Set([soloNumero(sock.user?.id), soloNumero(sock.user?.lid)].filter(Boolean));
}

/* ------------------------------ Personas del chat (para poder etiquetar) ------------------------------ */

// chat -> Map(número -> { jid, nombre }). Solo en RAM: sirve para convertir "@número" en una etiqueta real.
const personas = new Map();

function registrarPersona(chat, j, nombre) {
    if (!j || !chat.endsWith('@g.us')) return;
    const num = soloNumero(j);
    if (!num) return;
    let m = personas.get(chat);
    if (!m) { m = new Map(); personas.set(chat, m); }
    const previa = m.get(num);
    m.delete(num);
    m.set(num, { jid: `${num}@${String(j).split('@')[1] || 's.whatsapp.net'}`, nombre: nombre || previa?.nombre || num });
    if (m.size > 60) m.delete(m.keys().next().value);
}

const nombreGuardado = (chat, j) => personas.get(chat)?.get(soloNumero(j))?.nombre;

/** Busca "@número" en el texto y devuelve los JID a etiquetar (solo personas ya vistas en el chat). */
function extraerMenciones(chat, texto) {
    const mapa = personas.get(chat);
    const jids = [];
    if (!mapa) return jids;
    for (const m of String(texto).matchAll(/@(\d{5,})/g)) {
        const p = mapa.get(m[1]);
        if (p && !jids.includes(p.jid)) jids.push(p.jid);
    }
    return jids;
}

/* ------------------------------ Fotos que el bot puede leer ------------------------------ */

const MAX_FOTOS = 2;                 // la del mensaje + la del mensaje citado
const MAX_FOTO_BYTES = 8 * 1024 * 1024;

/**
 * Descarga la foto del mensaje (y la del mensaje al que responde, si la hay) para que la IA las vea.
 * Los stickers, videos y GIF no cuentan. Si una descarga falla, simplemente se ignora esa foto.
 */
async function obtenerFotos(sock, msg, contenido, ctx, chat) {
    const candidatas = [];
    if (contenido.imageMessage) candidatas.push({ objeto: msg, mime: contenido.imageMessage.mimetype });
    if (ctx?.quotedMessage) {
        const q = desenvolver(ctx.quotedMessage);
        if (q.imageMessage) {
            candidatas.push({
                objeto: { key: { remoteJid: chat, id: ctx.stanzaId, participant: ctx.participant }, message: ctx.quotedMessage },
                mime: q.imageMessage.mimetype
            });
        }
    }
    const fotos = [];
    for (const c of candidatas.slice(0, MAX_FOTOS)) {
        try {
            const buf = await downloadMediaMessage(c.objeto, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            if (buf?.length && buf.length <= MAX_FOTO_BYTES) fotos.push({ buf, mime: c.mime || 'image/jpeg' });
        } catch (e) {
            console.error('No pude descargar la foto:', e.message);
        }
    }
    return fotos;
}

// Pega las fotos al último mensaje del usuario (el que se está respondiendo)
function adjuntarFotos(mensajes, fotos) {
    if (!fotos.length) return mensajes;
    for (let i = mensajes.length - 1; i >= 0; i--) {
        if (mensajes[i].role === 'user') {
            mensajes[i] = mensajeConImagenes(String(mensajes[i].content), fotos);
            return mensajes;
        }
    }
    mensajes.push(mensajeConImagenes('', fotos));
    return mensajes;
}

/* ------------------------------ Asistente ------------------------------ */

const NOMBRE_BOT = /\bskytem\b|^\s*sky\b/i; // "sky" solo si abre el mensaje ("sky, ...")
const ZONA = process.env.ZONA_HORARIA || 'America/Santo_Domingo';
const MAX_MENSAJES = 80;                                            // mensajes recordados por chat
const CONTEXTO_MSGS = Number(process.env.CONTEXTO_MSGS ?? 40);      // cuántos se le mandan a la IA en cada respuesta
const OLVIDO_MS = Number(process.env.OLVIDO_HORAS ?? 24) * 3600 * 1000; // si el chat calla este tiempo, se olvida la charla

/* ------------------------------ Memoria de la charla ------------------------------ */

// chat -> { ts, msgs: [{ num, nombre, texto, ts } | { bot: true, texto, ts }], lista, timer }
// Se anota TODO lo que se escribe en el chat (no solo lo dirigido al bot) para poder seguir el hilo. Se guarda en Mongo.
const charlas = new Map();

function charla(chat) {
    let c = charlas.get(chat);
    if (!c) {
        c = { ts: 0, msgs: [], timer: null, lista: null };
        c.lista = Charla.findById(chat).lean()
            .then((d) => { if (d?.msgs?.length) { c.msgs = d.msgs; c.ts = d.ts || 0; } })
            .catch((e) => console.error('No pude cargar la memoria del chat:', e.message));
        charlas.set(chat, c);
    }
    return c.lista.then(() => {
        if (c.ts && Date.now() - c.ts > OLVIDO_MS) { c.msgs = []; c.ts = 0; }
        return c;
    });
}

function guardarLuego(chat, c) {
    if (c.timer) return;
    c.timer = setTimeout(() => {
        c.timer = null;
        Charla.updateOne(
            { _id: chat },
            { $set: { ts: c.ts, msgs: c.msgs, expireAt: new Date(Date.now() + 7 * 864e5) } },
            { upsert: true }
        ).catch((e) => console.error('No pude guardar la memoria del chat:', e.message));
    }, 5000);
}

async function anotar(chat, reg) {
    const c = await charla(chat);
    const r = { ...reg, texto: String(reg.texto ?? '').slice(0, 1500), ts: Date.now() };
    c.ts = r.ts;
    c.msgs.push(r);
    while (c.msgs.length > MAX_MENSAJES) c.msgs.shift();
    guardarLuego(chat, c);
    return r;
}

async function olvidar(chat) {
    const c = await charla(chat);
    c.msgs = []; c.ts = 0;
    if (c.timer) { clearTimeout(c.timer); c.timer = null; }
    await Charla.deleteOne({ _id: chat }).catch((e) => console.error('No pude borrar la memoria del chat:', e.message));
}

// Sin arrobas ni saltos de línea: así nadie puede hacerse pasar por otro "firmando" con su número en el nombre
const limpiarNombre = (s) => String(s ?? '').replace(/[@\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);

/**
 * Etiqueta de quien habla: su nombre; si DOS personas distintas comparten nombre en este chat, "Nombre (@número)".
 * Sin nombre, solo "@número". El número es lo único que identifica de verdad a cada persona.
 */
function crearEtiquetador(chat, registros) {
    const nombreDe = (r) => {
        const n = limpiarNombre(nombreGuardado(chat, r.num) || r.nombre);
        return n && n !== r.num ? n : '';
    };
    const nums = new Map(); // nombre en minúsculas -> Set de números
    const ver = (r) => {
        const n = nombreDe(r);
        if (!n) return;
        const k = n.toLowerCase();
        if (!nums.has(k)) nums.set(k, new Set());
        nums.get(k).add(r.num);
    };
    for (const [num, p] of personas.get(chat) || []) ver({ num, nombre: p.nombre });
    for (const r of registros) if (!r.bot) ver(r);
    return (r) => {
        const n = nombreDe(r);
        if (!n) return `@${r.num}`;
        return nums.get(n.toLowerCase()).size > 1 ? `${n} (@${r.num})` : n;
    };
}

// Convierte el registro del chat en mensajes para la IA (los consecutivos del mismo rol se juntan: algunas IAs lo exigen)
function armarMensajes(esGrupo, ventana, etiqueta) {
    const out = [];
    for (const r of ventana) {
        const role = r.bot ? 'assistant' : 'user';
        const texto = String(r.texto || '').slice(0, 700);
        // Las líneas siguientes van sangradas: nadie puede colar una línea falsa "Otro: ..." al inicio
        const contenido = (esGrupo && !r.bot) ? `${etiqueta(r)}: ${texto.replace(/\n/g, '\n  ')}` : texto;
        if (!contenido.trim()) continue;
        const ultimo = out[out.length - 1];
        if (ultimo && ultimo.role === role) ultimo.content += `\n${contenido}`;
        else out.push({ role, content: contenido });
    }
    while (out.length && out[0].role === 'assistant') out.shift();
    return out;
}

const FORMATOS = {
    cuadrada:   { ancho: 1024, alto: 1024 },
    vertical:   { ancho: 768,  alto: 1344 },
    horizontal: { ancho: 1344, alto: 768 }
};

const HERRAMIENTAS_IA = [{
    type: 'function',
    function: {
        name: 'generar_imagen',
        description: 'Genera una imagen con IA a partir de una descripción. Úsala siempre que pidan una imagen, foto, dibujo, ilustración, logo, fondo de pantalla, arte, etc.',
        parameters: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Descripción detallada de la imagen (estilo, sujeto, escena, luz). Preferiblemente en inglés.' },
                formato: { type: 'string', enum: ['cuadrada', 'vertical', 'horizontal'], description: 'Proporción de la imagen. Por defecto cuadrada.' }
            },
            required: ['prompt']
        }
    }
}];

function promptSistema(chat, esGrupo, etiqueta, nombre) {
    const l = [
        'Eres SKYTEM, un asistente de IA general que vive dentro de WhatsApp. Ayudas con lo que te pidan: preguntas, explicaciones, redacción, traducción, código, matemáticas, ideas, consejos, resúmenes, planes, análisis, juegos y charla.',
        '',
        'Cómo respondes:',
        '- Piensa bien antes de contestar y da respuestas correctas y útiles. Si no sabes algo o no estás seguro, dilo: no inventes datos, cifras, citas ni enlaces.',
        '- Responde en el idioma de quien te escribe y refleja su registro (formal, casual, jerga). Ve al grano: breve por defecto, con detalle solo cuando la tarea lo pide (código, explicaciones, listas).',
        '- Adapta el tono a lo que pida la persona: serio, gracioso, sarcástico, irónico, picante. Puedes bromear y hacer burlas ligeras entre amigos si te lo piden, pero sin inventar datos sobre nadie.',
        '- Sin sermones ni avisos innecesarios. Si algo implica un riesgo real, una advertencia breve y práctica después de la solución.',
        '- NO uses emojis, emoticonos ni kaomojis. Escribe solo texto normal, aunque el usuario los use.',
        '- No repitas siempre las mismas frases ni cierres cada respuesta con una pregunta. Pregunta solo cuando de verdad te falte un dato.',
        '',
        'Formato WhatsApp: *negrita* con un solo asterisco, _cursiva_ con guion bajo, ``` para código. No uses encabezados con # ni tablas.',
        'Si piden una imagen, foto, dibujo, ilustración, logo o arte, usa la herramienta generar_imagen (no digas que no puedes). Puedes ver las fotos que te llegan en el mensaje actual (o la foto del mensaje al que responden): descríbelas, léelas, respóndeles sobre ellas. De fotos anteriores del historial solo sabes que existieron; si te piden mirar una vieja, que la reenvíen. No puedes ver videos, GIF ni audios: solo sabes que existen.',
        `Fecha y hora actuales: ${new Date().toLocaleString('es-ES', { timeZone: ZONA })} (${ZONA}).`
    ];
    if (esGrupo) {
        l.push('');
        l.push('Estás en un grupo con varias personas. El historial trae los mensajes de TODOS, en orden, y cada línea empieza con la etiqueta de quien habla ("Nombre: texto").');
        l.push('Si dos personas distintas tienen el mismo nombre, su etiqueta incluye el número ("Nombre (@número): texto"): el número es lo que identifica a cada una, así que nunca las confundas ni le atribuyas a una lo que dijo otra.');
        l.push('Muchos mensajes del historial son charla entre las personas y no van dirigidos a ti: úsalos solo como contexto. Responde al ÚLTIMO mensaje, dirigiéndote a quien lo escribió, y recuerda lo que cada quien dijo antes.');
        l.push('Para etiquetar a alguien escribe su @número exactamente como aparece en la lista. Etiqueta solo cuando te lo pidan o sea realmente necesario.');
        const lista = [...(personas.get(chat)?.entries() || [])]
            .filter(([num, p]) => p.nombre !== num).slice(-40)
            .map(([num, p]) => `${etiqueta({ num, nombre: p.nombre })} = @${num}`);
        if (lista.length) l.push(`Personas del chat que puedes etiquetar: ${lista.join('; ')}.`);
    } else if (nombre) {
        l.push('');
        l.push(`Estás en un chat privado con ${limpiarNombre(nombre) || 'una persona'}. Recuerdas lo que se ha dicho antes en este chat.`);
    }
    return l.join('\n');
}

// Los modelos escriben **negrita** y # títulos; WhatsApp usa *negrita*
const aFormatoWhatsApp = (t) => t.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

function partir(texto, max = 3500) {
    const out = [];
    let r = texto.trim();
    while (r.length > max) {
        let c = r.lastIndexOf('\n', max);
        if (c < max * 0.5) c = r.lastIndexOf(' ', max);
        if (c < max * 0.5) c = max;
        out.push(r.slice(0, c).trim());
        r = r.slice(c).trim();
    }
    if (r) out.push(r);
    return out;
}

async function enviarTexto(sock, chat, texto, opciones) {
    const trozos = partir(texto);
    for (let i = 0; i < trozos.length; i++) {
        await sock.sendMessage(chat, {
            text: proteger(trozos[i]),
            mentions: extraerMenciones(chat, trozos[i])
        }, i === 0 ? opciones : undefined);
    }
}

async function responderAsistente(sock, msg, { chat, esGrupo, registro, nombre, fotos = [] }) {
    const imagenes = [];
    const ejecutarHerramienta = async (nombre, args) => {
        if (nombre !== 'generar_imagen') return 'Esa herramienta no existe.';
        if (imagenes.length >= 2) return 'Límite de imágenes por mensaje alcanzado.';
        const prompt = limpiar(args?.prompt, 800);
        if (!prompt) return 'error: falta la descripción de la imagen';
        const buf = await imagen(prompt, FORMATOS[args?.formato] || FORMATOS.cuadrada);
        imagenes.push({ buf, prompt });
        return 'Imagen generada; se enviará sola junto con tu texto. Responde breve.';
    };

    // Memoria: los últimos mensajes del chat hasta el que se está respondiendo (por si llegaron otros mientras esperaba en la cola)
    const c = await charla(chat);
    const idx = c.msgs.lastIndexOf(registro);
    const fin = idx < 0 ? c.msgs.length : idx + 1;
    const ventana = c.msgs.slice(Math.max(0, fin - CONTEXTO_MSGS), fin);
    if (idx < 0) ventana.push(registro);
    const etiqueta = crearEtiquetador(chat, ventana);

    const bruto = await voz({
        messages: [
            { role: 'system', content: promptSistema(chat, esGrupo, etiqueta, nombre) },
            ...adjuntarFotos(armarMensajes(esGrupo, ventana, etiqueta), fotos)
        ],
        temperature: 0.7,
        maxTokens: 2000,
        tools: HERRAMIENTAS_IA,
        ejecutarHerramienta,
        maxRondas: 2
    });

    const texto = aFormatoWhatsApp(String(bruto ?? '').trim());
    if (!texto && !imagenes.length) throw new Error('respuesta vacía');

    const opciones = esGrupo ? { quoted: msg } : undefined;
    if (imagenes.length === 1 && texto && texto.length <= 900) {
        await sock.sendMessage(chat, {
            image: imagenes[0].buf,
            caption: proteger(texto),
            mentions: extraerMenciones(chat, texto)
        }, opciones);
    } else {
        for (let i = 0; i < imagenes.length; i++) {
            await sock.sendMessage(chat, { image: imagenes[i].buf }, i === 0 ? opciones : undefined);
        }
        if (texto) await enviarTexto(sock, chat, texto, imagenes.length ? undefined : opciones);
    }

    const notaImg = imagenes.length ? ` (imagen enviada: ${imagenes.map((i) => i.prompt).join(' | ').slice(0, 300)})` : '';
    await anotar(chat, { bot: true, texto: `${texto}${notaImg}`.trim() });
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
    // Foto, sticker, audio... sin texto: se anota en la charla pero no dispara respuesta
    // (en privado, una foto sin texto sí se responde: se supone que quieres que la mire)
    const esGrupo = chat.endsWith('@g.us');
    const soloMedia = !forzar && /^\[[^\]]+\]$/.test(texto) && !(contenido.imageMessage && !esGrupo);

    const jid = msg.key.participant || chat;
    const nombre = msg.pushName || soloNumero(jid);
    const ctx = obtenerContexto(contenido);
    const yo = idsDelBot(sock);

    // Se anota a quien escribe, a quienes etiqueta y a quien cita (así el bot puede etiquetarlos después)
    registrarPersona(chat, jid, msg.pushName);
    for (const j of ctx?.mentionedJid || []) if (!yo.has(soloNumero(j))) registrarPersona(chat, j);
    if (ctx?.participant && !yo.has(soloNumero(ctx.participant))) registrarPersona(chat, ctx.participant);

    // Se le llama por: nombre (en cualquier parte del mensaje), @mención, responder a un mensaje suyo, !bot/!ia o chat privado.
    // Etiquetar o responder a OTRA persona en el mismo mensaje no impide que conteste.
    const mencionaAlBot = ctx?.mentionedJid?.some((j) => yo.has(soloNumero(j)));
    const respondeAlBot = ctx?.participant && yo.has(soloNumero(ctx.participant));
    const llamado = forzar || !esGrupo || mencionaAlBot || respondeAlBot || NOMBRE_BOT.test(texto);

    // Quita la etiqueta al propio bot del texto
    for (const n of yo) texto = texto.split(`@${n}`).join('');
    texto = texto.trim() || (llamado ? 'Hola' : '');

    // Mensaje al que está respondiendo (si cita alguno)
    let citado = '';
    if (ctx?.quotedMessage) {
        const qt = descripcionMensaje(desenvolver(ctx.quotedMessage)).slice(0, 600);
        if (qt) {
            const autor = yo.has(soloNumero(ctx.participant))
                ? 'SKYTEM'
                : nombreGuardado(chat, ctx.participant) || `@${soloNumero(ctx.participant)}`;
            citado = `[Responde al mensaje de ${autor}: "${qt}"]\n`;
        }
    }

    // Todo lo que se escribe en el chat entra en la memoria (también lo que no va dirigido al bot), con quién lo dijo
    const paraMemoria = `${citado}${texto}`.trim();
    if (!paraMemoria) return;
    const registro = await anotar(chat, { num: soloNumero(jid), nombre: limpiarNombre(msg.pushName), texto: paraMemoria });

    if (!llamado || soloMedia) return;

    await enCola(chat, async () => {
        sock.sendPresenceUpdate('composing', chat).catch(() => {});
        try {
            const fotos = await obtenerFotos(sock, msg, contenido, ctx, chat);
            await responderAsistente(sock, msg, { chat, esGrupo, registro, nombre, fotos });
        } catch (e) {
            console.error('Error generando respuesta:', e.message);
            await sock.sendMessage(chat, { text: 'No pude generar la respuesta ahora mismo. Intenta de nuevo en un momento.' }, { quoted: msg }).catch(() => {});
        } finally {
            sock.sendPresenceUpdate('paused', chat).catch(() => {});
        }
    });
}

/* ------------------------------ Permisos ------------------------------ */

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

/* ------------------------------ Comandos ------------------------------ */

const SPAM_MAX = Math.max(1, Number(process.env.SPAM_MAX ?? 100));
const SPAM_DELAY_MS = Math.max(10, Number(process.env.SPAM_DELAY_MS ?? 20));
const spams = new Map(); // chat -> { cancelado }

// Menú: para quitar un comando del menú, añade su nombre a OCULTOS_DEL_MENU (las acciones con "/", ej. '/golpear').
// Ocultarlo del menú NO lo desactiva: sigue funcionando.
const OCULTOS_DEL_MENU = new Set([]);
const MENU = [
    ['bot', '• !bot <mensaje> - Háblale al asistente (también responde si lo mencionas, le respondes o dices "skytem")'],
    ['img', '• !img [vertical|horizontal] <descripción> - Genera una imagen con IA (también puedes pedírsela en la charla)'],
    ['s', '• !s / !sticker - Convierte imagen/GIF/video a sticker'],
    ['spam', '• !spam <veces> <texto> - Repite un mensaje (admins; puedes etiquetar con @). Máx. ' + SPAM_MAX],
    ['spamstop', '• !spamstop - Detiene el spam en curso (admins)'],
    ['todos', '• !todos [mensaje] - Etiqueta a todos los del grupo (admins)'],
    ['reset', '• !reset - Borra lo que el asistente recuerda de esta charla'],
    ['juego', '• !juego - Selecciona un juego al azar'],
    ['addjuego', '• !addjuego <nombre> - Añade un juego'],
    ['listajuegos', '• !listajuegos - Muestra la lista de juegos'],
    ['deljuego', '• !deljuego <nombre> - Elimina un juego'],
    ['ruleta', '• !ruleta opc1, opc2... - Elige una opción'],
    ['8ball', '• !8ball <pregunta> - Pregunta a la bola 8'],
    ['moneda', '• !moneda - Lanza una moneda']
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

    // Verifica admin y responde con el motivo correcto
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

    // Hablar con el asistente
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

    // Imagen con IA
    const cmdImg = text.match(/^!(?:img|imagen)(?:\s+([\s\S]*))?$/i);
    if (cmdImg) {
        let prompt = (cmdImg[1] || '').trim();
        let formato = 'cuadrada';
        const f = prompt.match(/^(vertical|horizontal|cuadrada)\s+/i);
        if (f) { formato = f[1].toLowerCase(); prompt = prompt.slice(f[0].length).trim(); }
        if (!prompt) {
            await reaccionar('❔');
            await responder('Escribe qué imagen quieres. Ej: !img un gato astronauta en la luna');
            return;
        }
        prompt = prompt.slice(0, 800);
        await enCola(jid, async () => {
            try {
                await reaccionar('❕');
                sock.sendPresenceUpdate('composing', jid).catch(() => {});
                const buf = await imagen(prompt, FORMATOS[formato]);
                await sock.sendMessage(jid, { image: buf, caption: proteger(prompt.slice(0, 200)) }, { quoted: msg });
                await reaccionar('✅');
            } catch (e) {
                console.error('Error generando imagen:', e.message);
                await reaccionar('❌');
                await responder('No pude generar la imagen. Intenta de nuevo en un momento.');
            } finally {
                sock.sendPresenceUpdate('paused', jid).catch(() => {});
            }
        });
        return;
    }

    // Sticker
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

    // Ayuda
    if (text === '!ayuda' || text === '!help') {
        await reaccionar('ℹ️');
        const acciones = Object.keys(ACCIONES).filter((c) => !OCULTOS_DEL_MENU.has('/' + c)).map((c) => '/' + c);
        const intro = '*SKYTEM - asistente de IA*\n' +
            'Para hablarle escribe "skytem ..." en cualquier parte del mensaje, arróbalo, responde a un mensaje suyo o usa !bot <mensaje>. En privado responde siempre.\n' +
            'También puedes pedirle imágenes hablando, ej: "skytem hazme una imagen de un gato astronauta".\n' +
            'Y puede ver fotos: mándale una con "skytem ..." de texto, o responde a una foto diciéndole "skytem qué es esto".\n\n' +
            'Los comandos hay que escribirlos con ! (las acciones con /). Hablándole no los ejecuta. Los de admin (spam, todos) solo funcionan si eres admin del grupo.\n\n';
        const menu = intro + `*Comandos:*\n` +
            MENU.filter(([id]) => !OCULTOS_DEL_MENU.has(id)).map(([, t]) => t).join('\n') +
            (acciones.length ? `\n\n*Acciones (usar con /):*\n• ${acciones.join(', ')}` : '');
        await responder(menu);
        return;
    }

    // Olvidar la charla del asistente en este chat
    if (text === '!reset') {
        await olvidar(jid);
        await reaccionar('✅');
        await responder('Listo, empecemos de cero.');
        return;
    }

    // Detener spam
    if (text === '!spamstop') {
        if (!(await exigirAdmin('Solo admins pueden detener el spam.'))) return;
        const s = spams.get(jid);
        if (!s) {
            await reaccionar('❔');
            await responder('No hay ningún spam en curso.');
            return;
        }
        s.cancelado = true;
        await reaccionar('✅');
        return;
    }

    // Spam: repite un mensaje N veces (con etiquetas si las incluyes)
    const cmdSpam = text.match(/^!spam(?:\s+(\d+))?(?:\s+([\s\S]+))?$/i);
    if (cmdSpam) {
        if (!(await exigirAdmin('Solo admins pueden usar !spam.'))) return;
        let veces = parseInt(cmdSpam[1], 10);
        let cuerpo = (cmdSpam[2] || '').trim();
        // Si no hay texto pero citó un mensaje, repite el mensaje citado
        if (veces && !cuerpo && contexto?.quotedMessage) cuerpo = descripcionMensaje(desenvolver(contexto.quotedMessage)).trim();
        if (!veces || !cuerpo) {
            await reaccionar('❔');
            await responder(`Uso: !spam <veces> <texto>\nEj: !spam 5 @persona despierta\nMáximo ${SPAM_MAX} veces.`);
            return;
        }
        if (spams.has(jid)) {
            await reaccionar('❔');
            await responder('Ya hay un spam en curso. Usa !spamstop para detenerlo.');
            return;
        }
        veces = Math.min(veces, SPAM_MAX);
        cuerpo = cuerpo.slice(0, 500);
        const menciones = contexto?.mentionedJid || [];
        const estado = { cancelado: false };
        spams.set(jid, estado);
        await reaccionar('✅');

        // En segundo plano para que !spamstop pueda entrar mientras tanto
        (async () => {
            try {
                for (let i = 0; i < veces && !estado.cancelado; i++) {
                    await sock.sendMessage(jid, { text: proteger(cuerpo), mentions: menciones });
                    if (i < veces - 1) await esperar(SPAM_DELAY_MS);
                }
            } catch (e) {
                console.error('Error en !spam:', e.message);
            } finally {
                spams.delete(jid);
            }
        })();
        return;
    }

    // Etiquetar a todos
    if (text === '!todos' || text.startsWith('!todos ')) {
        if (!jid.endsWith('@g.us')) {
            await reaccionar('❔');
            await responder('Este comando solo funciona en grupos.');
            return;
        }
        if (!(await exigirAdmin('Solo admins pueden etiquetar a todos.'))) return;
        try {
            const meta = await sock.groupMetadata(jid);
            const yo = idsDelBot(sock);
            const ids = meta.participants.map((p) => p.id).filter((id) => !yo.has(soloNumero(id)));
            const aviso = text.slice(6).trim();
            const lista = ids.map((id) => `@${soloNumero(id)}`).join(' ');
            await sock.sendMessage(jid, {
                text: proteger(`${aviso ? `${aviso}\n\n` : ''}${lista}`),
                mentions: ids
            }, { quoted: msg });
        } catch (e) {
            console.error('Error en !todos:', e.message);
            await reaccionar('❌');
            await responder('No pude leer la lista del grupo. Intenta de nuevo.');
        }
        return;
    }

    // Elegir juego
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

    // Agregar juego
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

    // Lista de juegos
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

    // Eliminar juego
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

    // Ruleta
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

    // Bola 8
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

    // Moneda
    if (text === '!moneda') {
        await reaccionar('✅');
        await responder(`Resultado: *${Math.random() < 0.5 ? 'Cara' : 'Cruz'}*`);
    }
}

async function main() {
    console.log('Conectando a MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('Conectado a MongoDB Atlas.');
    console.log(infoVoz());

    for (const senal of ['SIGINT', 'SIGTERM']) process.on(senal, () => process.exit(0));

    await iniciarSocket();
}

main().catch((e) => {
    console.error('Error fatal al iniciar:', e);
    process.exit(1);
});
