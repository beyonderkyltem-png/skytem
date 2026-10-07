/**
 * voz.js — conexión con las IAs.
 *  - voz():    texto (y lectura de imágenes) con el SDK oficial de OpenAI contra varios proveedores compatibles
 *              (Gemini, Groq, OpenRouter, Pollinations). Si uno falla o se queda sin cuota,
 *              pasa solo al siguiente. Soporta function calling.
 *  - imagen(): genera una imagen con Pollinations y devuelve un Buffer.
 *
 * Variables de entorno (pon solo las de las IAs que quieras usar):
 *   GEMINI_API_KEY      + GEMINI_MODEL      (https://aistudio.google.com/apikey)
 *   GROQ_API_KEY        + GROQ_MODEL        (https://console.groq.com/keys)
 *   OPENROUTER_API_KEY  + OPENROUTER_MODEL  (https://openrouter.ai/keys)
 *   POLLINATIONS_API_KEY + POLLINATIONS_MODEL (respaldo final y generación de imágenes)
 *   IA_ORDEN=gemini,groq,openrouter,pollinations   (orden de prioridad)
 *   IA_VISION=gemini,pollinations                  (proveedores que pueden leer imágenes)
 *
 * Además:
 *  - buscar():     búsqueda web para que la IA consulte información actual (herramienta buscar_web).
 *                  TAVILY_API_KEY (https://tavily.com, plan gratis) la hace fiable; sin ella usa DuckDuckGo,
 *                  que desde algunos hostings bloquea las consultas automáticas.
 *  - transcribir(): pasa notas de voz a texto. Usa Groq (Whisper) y, si falla, Gemini.
 *                  GROQ_WHISPER_MODEL (por defecto whisper-large-v3-turbo) y AUDIO_IDIOMA (ej. es) son opcionales.
 *  - IA_TIEMPO_MAX_S: tiempo total máximo (por defecto 100 s) que voz() invierte probando proveedores en una respuesta.
 */
import OpenAI, { toFile } from 'openai';
import axios from 'axios';
import { spawn } from 'child_process';

// Limpia espacios, saltos de línea o comillas que se cuelan al pegar una key
const limpiarKey = (v) => String(v || '').trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();

const KEY = limpiarKey(process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_KEY || process.env.POLLINATIONS_TOKEN);
const IMG_BASE = (process.env.POLLINATIONS_IMAGE_URL || 'https://gen.pollinations.ai/image').replace(/\/+$/, '');
const IMG_MODELO = process.env.POLLINATIONS_IMAGE_MODEL || 'flux';

/* ------------------------------ Proveedores de texto ------------------------------ */

// Los límites gratuitos y los nombres de modelo cambian seguido: si alguno da 404, ajusta su *_MODEL en el .env.
const CATALOGO = {
    gemini: {
        key: limpiarKey(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        modelo: process.env.GEMINI_MODEL || 'gemini-3.6-flash'
    },
    groq: {
        key: limpiarKey(process.env.GROQ_API_KEY),
        baseURL: 'https://api.groq.com/openai/v1',
        modelo: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
    },
    openrouter: {
        key: limpiarKey(process.env.OPENROUTER_API_KEY),
        baseURL: 'https://openrouter.ai/api/v1',
        modelo: process.env.OPENROUTER_MODEL || 'openrouter/free'
    },
    pollinations: {
        key: KEY,
        baseURL: process.env.POLLINATIONS_BASE_URL || 'https://gen.pollinations.ai/v1',
        modelo: process.env.POLLINATIONS_MODEL || 'openai',
        sinKey: true // funciona (limitado) sin key
    }
};

const ORDEN = (process.env.IA_ORDEN || 'gemini,groq,openrouter,pollinations')
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

const PROVEEDORES = ORDEN
    .filter((id) => CATALOGO[id] && (CATALOGO[id].key || CATALOGO[id].sinKey))
    .map((id) => ({ id, ...CATALOGO[id], cliente: null, pausa: 0 }));

function clienteDe(p) {
    if (!p.cliente) {
        p.cliente = new OpenAI({
            baseURL: p.baseURL,
            apiKey: p.key || 'sin-key',                       // el SDK exige un valor; si no hay key se quita la cabecera
            defaultHeaders: p.key ? undefined : { Authorization: null },
            timeout: 45_000,
            maxRetries: 0                                     // el respaldo lo hacemos nosotros pasando a otra IA
        });
    }
    return p.cliente;
}

const infoTexto = () => (PROVEEDORES.length
    ? `[VOZ] IAs de texto (en orden): ${PROVEEDORES.map((p) => `${p.id}:${p.modelo}`).join(' -> ')}. Imagen: Pollinations ${IMG_MODELO}${KEY ? '' : ' (sin key)'}.`
    : '[VOZ] ATENCIÓN: no hay ninguna IA configurada. Define GEMINI_API_KEY, GROQ_API_KEY u OPENROUTER_API_KEY.');

export const infoVoz = () => {
    const audio = [CATALOGO.groq.key && `groq:${WHISPER_MODELO}`, CATALOGO.gemini.key && `gemini:${CATALOGO.gemini.modelo}`].filter(Boolean);
    return `${infoTexto()}\n[VOZ] Transcripción de audios: ${audio.length ? audio.join(' -> ') : 'NO disponible (define GROQ_API_KEY o GEMINI_API_KEY)'}. `
        + `Búsqueda web: ${TAVILY_KEY ? 'Tavily' : 'DuckDuckGo (sin TAVILY_API_KEY puede fallar)'}.`;
};

function avisar401() {
    console.error(KEY
        ? `[VOZ] 401: Pollinations rechazó la key (empieza por "${KEY.slice(0, 3)}", ${KEY.length} caracteres). Debe ser una key de https://enter.pollinations.ai/keys (sk_...).`
        : '[VOZ] 401: no se envió ninguna key a Pollinations. Define POLLINATIONS_API_KEY en las variables de entorno y vuelve a desplegar.');
}

/* ------------------------------ Llamadas con respaldo ------------------------------ */

/** Tras un fallo, ese proveedor descansa un rato para no gastar intentos (429 = cuota, 401/403/404 = key o modelo mal). */
function pausar(p, e) {
    if (e?.vacia) return;
    const s = e?.status;
    const ms = s === 429 ? 60_000
        : (s === 401 || s === 403 || s === 404) ? 10 * 60_000
        : (!s || s >= 500) ? 15_000
        : 0;
    if (ms) p.pausa = Date.now() + ms;
}

// Proveedores que aceptan imágenes. Gemini sí; los demás dependen del modelo: añádelos con IA_VISION=gemini,groq,...
const VISION = new Set((process.env.IA_VISION || 'gemini,pollinations')
    .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));

const traeImagen = (msgs) => msgs.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url'));

// Si ningún proveedor ve imágenes, se manda solo el texto (con un aviso) en vez de fallar
const sinImagenes = (msgs) => msgs.map((m) => (Array.isArray(m.content)
    ? { ...m, content: m.content.map((c) => (c.type === 'text' ? c.text : '[imagen no disponible]')).join('\n') }
    : m));

function candidatos(preferido, soloVision = false) {
    const lista = soloVision ? PROVEEDORES.filter((p) => VISION.has(p.id)) : PROVEEDORES;
    const base = preferido && lista.includes(preferido) ? [preferido, ...lista.filter((p) => p !== preferido)] : lista;
    const libres = base.filter((p) => p.pausa <= Date.now());
    return libres.length ? libres : base; // si todos descansan, se prueban igual
}

/** Mensaje de usuario con texto + imágenes ({ buf, mime }) para que la IA las "vea". */
export function mensajeConImagenes(texto, fotos, role = 'user') {
    return {
        role,
        content: [
            { type: 'text', text: texto || 'Describe esta imagen.' },
            ...fotos.map((f) => ({ type: 'image_url', image_url: { url: `data:${f.mime || 'image/jpeg'};base64,${f.buf.toString('base64')}` } }))
        ]
    };
}

// Gemini añade datos propios a las llamadas a herramientas; los demás proveedores no los aceptan
const sinExtras = (msgs) => msgs.map((m) => (m.tool_calls
    ? { ...m, tool_calls: m.tool_calls.map(({ extra_content, ...t }) => t) }
    : m));

/** Una llamada a UN proveedor. Algunos modelos rechazan ciertos parámetros (400), así que se va quitando lo opcional. */
async function llamarProveedor(p, messages, { temperature, maxTokens, extra, tools, toolChoice }) {
    const base = { temperature, max_tokens: maxTokens };
    const conTools = tools?.length ? { tools, tool_choice: toolChoice } : {};
    const intentos = [
        { ...base, ...extra, ...conTools },
        { ...base, ...conTools },
        ...(tools?.length ? [base] : []),   // el modelo no acepta herramientas: se responde solo con texto
        {}
    ];
    for (let i = 0; i < intentos.length; i++) {
        try {
            const r = await clienteDe(p).chat.completions.create({ model: p.modelo, messages, ...intentos[i] });
            const m = r?.choices?.[0]?.message;
            if (!m || (!m.content && !m.tool_calls?.length)) throw Object.assign(new Error('respuesta vacía'), { vacia: true });
            return r;
        } catch (e) {
            if (e?.status === 400 && i < intentos.length - 1) continue;
            throw e;
        }
    }
    return null;
}

/** Prueba los proveedores en orden hasta que uno responda. Devuelve la respuesta y quién la dio. */
async function llamar({ messages, ...resto }, preferido, limite) {
    let ultimo;
    let msgs = messages;
    let lista = [];
    if (traeImagen(msgs)) {
        lista = candidatos(preferido, true);
        if (!lista.length) { console.error('[VOZ] ningún proveedor con visión configurado: se responde sin la imagen'); msgs = sinImagenes(msgs); }
    }
    if (!lista.length) lista = candidatos(preferido);
    for (const p of lista) {
        if (limite && ultimo && Date.now() > limite) break; // no seguir probando: el chat estaría esperando demasiado
        try {
            const r = await llamarProveedor(p, p.id === 'gemini' ? msgs : sinExtras(msgs), resto);
            return { r, p };
        } catch (e) {
            ultimo = e;
            pausar(p, e);
            if (e?.status === 401 && p.id === 'pollinations') avisar401();
            console.error(`[VOZ] ${p.id} (${p.modelo}) falló: ${e?.status ?? e?.code ?? ''} ${String(e?.message || '').slice(0, 160)}`);
        }
    }
    throw ultimo ?? new Error('No hay ninguna IA configurada');
}

// Algunos modelos de razonamiento devuelven su "pensamiento" entre etiquetas
const quitarPensamiento = (t) => String(t ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

const MAX_LLAMADAS_POR_RONDA = 3;
const MAX_SALIDA_HERRAMIENTA = 3000;
const TIEMPO_MAX_MS = Math.max(15, Number(process.env.IA_TIEMPO_MAX_S ?? 100)) * 1000;

/**
 * @param {{messages: Array, temperature?: number, maxTokens?: number, extra?: object,
 *          tools?: Array, ejecutarHerramienta?: (nombre: string, args: object) => Promise<string>, maxRondas?: number}} p
 * @returns {Promise<string>}
 *
 * Sin `tools` hace una llamada y devuelve texto. Con `tools`, si el modelo pide una herramienta se ejecuta con
 * `ejecutarHerramienta`, se le devuelve el resultado y se vuelve a llamar, hasta `maxRondas`.
 */
export async function voz({ messages, temperature = 0.7, maxTokens = 800, extra = {}, tools, ejecutarHerramienta, maxRondas = 2 }) {
    const usaTools = !!(tools?.length && ejecutarHerramienta);
    const msgs = [...messages];
    const limite = Date.now() + TIEMPO_MAX_MS;
    let preferido = null; // la IA que respondió primero sigue con la conversación de herramientas
    for (let ronda = 0; ; ronda++) {
        const ultima = ronda >= maxRondas;
        const { r, p } = await llamar({
            messages: msgs, temperature, maxTokens, extra,
            tools: usaTools ? tools : null, toolChoice: ultima ? 'none' : 'auto'
        }, preferido, limite);
        preferido = p;
        const m = r.choices[0].message;
        const pedidas = usaTools && !ultima ? m.tool_calls : null;
        if (!pedidas?.length) return quitarPensamiento(m.content);

        msgs.push({ role: 'assistant', content: m.content ?? null, tool_calls: pedidas });
        for (const [k, t] of pedidas.entries()) {
            let salida;
            if (k >= MAX_LLAMADAS_POR_RONDA) salida = 'omitido: demasiadas herramientas a la vez';
            else {
                let args = {};
                try { args = JSON.parse(t.function?.arguments || '{}'); } catch { /* argumentos mal formados: se llama sin ellos */ }
                try { salida = await ejecutarHerramienta(t.function?.name, args); }
                catch (e) { salida = `error: ${e.message}`; }
            }
            msgs.push({ role: 'tool', tool_call_id: t.id, content: String(salida ?? '').slice(0, MAX_SALIDA_HERRAMIENTA) });
        }
    }
}

/* ------------------------------ Imágenes ------------------------------ */

/**
 * Genera una imagen con Pollinations. Devuelve un Buffer (jpeg/png).
 * Si tu cuenta usa otra URL o modelo: POLLINATIONS_IMAGE_URL y POLLINATIONS_IMAGE_MODEL en el .env.
 */
export async function imagen(prompt, { ancho = 1024, alto = 1024 } = {}) {
    const r = await axios.get(`${IMG_BASE}/${encodeURIComponent(prompt)}`, {
        params: { model: IMG_MODELO, width: ancho, height: alto, nologo: true, seed: Math.floor(Math.random() * 1e9) },
        headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
        responseType: 'arraybuffer',
        timeout: 90_000,
        validateStatus: () => true
    });
    const tipo = String(r.headers['content-type'] || '');
    if (r.status !== 200 || !tipo.startsWith('image/')) {
        if (r.status === 401) avisar401();
        const detalle = Buffer.from(r.data || '').toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
        throw new Error(`imagen Pollinations ${r.status}: ${detalle}`);
    }
    return Buffer.from(r.data);
}

/* ------------------------------ Texto a voz (notas de voz) ------------------------------ */

const AUDIO_BASE = (process.env.POLLINATIONS_AUDIO_URL || 'https://gen.pollinations.ai/audio').replace(/\/+$/, '');
const VOCES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const VOZ_TTS = process.env.TTS_VOZ || 'nova';

/** Convierte texto en un audio mp3 (Buffer) con Pollinations. */
export async function hablar(texto, vozElegida) {
    const t = String(texto ?? '').trim().slice(0, 900);
    if (!t) throw new Error('texto vacío');
    const v = VOCES.includes(String(vozElegida).toLowerCase()) ? String(vozElegida).toLowerCase() : VOZ_TTS;
    const r = await axios.get(`${AUDIO_BASE}/${encodeURIComponent(t)}`, {
        params: { voice: v },
        headers: KEY ? { Authorization: `Bearer ${KEY}` } : {},
        responseType: 'arraybuffer',
        timeout: 60_000,
        validateStatus: () => true
    });
    const tipo = String(r.headers['content-type'] || '');
    if (r.status !== 200 || !tipo.startsWith('audio/')) {
        if (r.status === 401) avisar401();
        const detalle = Buffer.from(r.data || '').toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
        throw new Error(`audio Pollinations ${r.status}: ${detalle}`);
    }
    return Buffer.from(r.data);
}

/** mp3 -> ogg/opus: el formato de las notas de voz de WhatsApp. */
export function aNotaDeVoz(buf) {
    return new Promise((resolve, reject) => {
        const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg',
            ['-v', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
        const salida = [];
        let err = '';
        ff.stdout.on('data', (d) => salida.push(d));
        ff.stderr.on('data', (d) => { err += d; });
        ff.stdin.on('error', () => {});
        ff.on('error', reject);
        ff.on('close', (code) => (code === 0 && salida.length
            ? resolve(Buffer.concat(salida))
            : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 120)}`))));
        ff.stdin.end(buf);
    });
}

/* ------------------------------ Búsqueda web ------------------------------ */

const TAVILY_KEY = limpiarKey(process.env.TAVILY_API_KEY);
const recortar = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function buscarTavily(q, max) {
    const r = await axios.post('https://api.tavily.com/search',
        { query: q, max_results: max, include_answer: true, search_depth: 'basic' },
        { headers: { Authorization: `Bearer ${TAVILY_KEY}` }, timeout: 15_000 });
    return {
        resumen: recortar(r.data?.answer, 500),
        items: (r.data?.results || []).map((x) => ({ titulo: recortar(x.title, 100), url: x.url, texto: recortar(x.content, 280) }))
    };
}

const sinHtml = (t) => String(t ?? '').replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/** Saca título, enlace y fragmento de la versión HTML de DuckDuckGo. */
function parsearDDG(html, max) {
    const items = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="result__a"|$)/g;
    for (const m of String(html).matchAll(re)) {
        let url = m[1].replace(/&amp;/g, '&');
        if (url.startsWith('//')) url = `https:${url}`;
        try { const real = new URL(url).searchParams.get('uddg'); if (real) url = real; } catch { /* se deja el enlace tal cual */ }
        if (/duckduckgo\.com\/y\.js/.test(url)) continue; // anuncios
        const sn = m[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        items.push({ titulo: recortar(sinHtml(m[2]), 100), url, texto: recortar(sinHtml(sn?.[1]), 280) });
        if (items.length >= max) break;
    }
    return items;
}

async function buscarDDG(q, max) {
    const r = await axios.get('https://html.duckduckgo.com/html/', {
        params: { q },
        headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
        },
        timeout: 15_000
    });
    return { resumen: '', items: parsearDDG(r.data, max) };
}

/**
 * Busca en internet y devuelve un texto compacto para la IA (título, fragmento y enlace de cada resultado).
 * Nunca lanza por falta de resultados: devuelve un aviso para que la IA lo diga en vez de inventar.
 */
export async function buscar(consulta, max = 4) {
    const q = recortar(consulta, 200);
    if (!q) throw new Error('consulta vacía');
    let res = { resumen: '', items: [] };
    if (TAVILY_KEY) {
        try { res = await buscarTavily(q, max); }
        catch (e) { console.error(`[VOZ] búsqueda Tavily falló: ${e?.response?.status ?? ''} ${String(e?.message || '').slice(0, 120)}`); }
    }
    if (!res.items.length) {
        try { res = await buscarDDG(q, max); }
        catch (e) { console.error(`[VOZ] búsqueda DuckDuckGo falló: ${e?.response?.status ?? ''} ${String(e?.message || '').slice(0, 120)}`); }
    }
    if (!res.items.length) return 'No se pudo obtener resultados de búsqueda ahora. Dilo con claridad y no inventes datos actuales.';
    const cuerpo = res.items.map((x, i) => `${i + 1}. ${x.titulo}\n${x.texto}\n${x.url}`).join('\n\n');
    return `${res.resumen ? `Resumen del buscador: ${res.resumen}\n\n` : ''}${cuerpo}`.slice(0, MAX_SALIDA_HERRAMIENTA - 100);
}

/* ------------------------------ Transcripción de audios ------------------------------ */

const WHISPER_MODELO = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
const clientesApi = new Map();
function clienteApi(id) {
    if (!clientesApi.has(id)) {
        clientesApi.set(id, new OpenAI({ baseURL: CATALOGO[id].baseURL, apiKey: CATALOGO[id].key, timeout: 60_000, maxRetries: 0 }));
    }
    return clientesApi.get(id);
}

/** Convierte cualquier audio (ogg/opus de WhatsApp, m4a...) a mp3 mono con el ffmpeg incluido, sin archivos temporales. */
function aMp3(buf) {
    return new Promise((resolve, reject) => {
        const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg',
            ['-v', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-f', 'mp3', 'pipe:1']);
        const salida = [];
        let err = '';
        ff.stdout.on('data', (d) => salida.push(d));
        ff.stderr.on('data', (d) => { err += d; });
        ff.stdin.on('error', () => {});
        ff.on('error', reject);
        ff.on('close', (code) => (code === 0 && salida.length
            ? resolve(Buffer.concat(salida))
            : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 120)}`))));
        ff.stdin.end(buf);
    });
}

const extensionAudio = (mime) => (/mp4|m4a|aac/i.test(mime) ? 'm4a' : /mpeg|mp3/i.test(mime) ? 'mp3' : /wav/i.test(mime) ? 'wav' : /webm/i.test(mime) ? 'webm' : 'ogg');

/**
 * Pasa un audio a texto. Devuelve '' si no hay voz. Lanza error si ningún proveedor pudo transcribir.
 * Orden: Groq (Whisper) y después Gemini.
 */
export async function transcribir(buf, mime = 'audio/ogg') {
    const errores = [];

    if (CATALOGO.groq.key) {
        try {
            const r = await clienteApi('groq').audio.transcriptions.create({
                file: await toFile(buf, `audio.${extensionAudio(mime)}`),
                model: WHISPER_MODELO,
                response_format: 'json',
                temperature: 0,
                ...(process.env.AUDIO_IDIOMA ? { language: process.env.AUDIO_IDIOMA } : {})
            });
            return String(r?.text ?? '').trim();
        } catch (e) {
            errores.push(`groq: ${e?.status ?? ''} ${String(e?.message || '').slice(0, 120)}`);
        }
    }

    if (CATALOGO.gemini.key) {
        try {
            const mp3 = await aMp3(buf);
            const r = await clienteApi('gemini').chat.completions.create({
                model: CATALOGO.gemini.modelo,
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Transcribe literalmente este audio en el idioma en que se habla. Responde solo con la transcripción, sin comentarios. Si no hay voz, responde exactamente: [sin voz]' },
                        { type: 'input_audio', input_audio: { data: mp3.toString('base64'), format: 'mp3' } }
                    ]
                }]
            });
            const t = quitarPensamiento(r?.choices?.[0]?.message?.content);
            if (!t) throw new Error('respuesta vacía');
            return /^\[sin voz\]$/i.test(t) ? '' : t;
        } catch (e) {
            errores.push(`gemini: ${e?.status ?? ''} ${String(e?.message || '').slice(0, 120)}`);
        }
    }

    if (!errores.length) throw new Error('No hay proveedor de transcripción (define GROQ_API_KEY o GEMINI_API_KEY)');
    throw new Error(`No se pudo transcribir -> ${errores.join(' | ')}`);
}
