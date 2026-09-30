/**
 * voz.js — conexión con Pollinations.
 *  - voz():   texto con el SDK oficial de OpenAI apuntando a Pollinations (API compatible), con function calling opcional.
 *  - imagen(): genera una imagen y devuelve un Buffer.
 */
import OpenAI from 'openai';
import axios from 'axios';

// Acepta varios nombres de variable y limpia espacios, saltos de línea o comillas que se cuelan al pegar la key
const KEY = (process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_KEY || process.env.POLLINATIONS_TOKEN || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();

const MODELO = process.env.POLLINATIONS_MODEL || 'openai';
const IMG_BASE = (process.env.POLLINATIONS_IMAGE_URL || 'https://gen.pollinations.ai/image').replace(/\/+$/, '');
const IMG_MODELO = process.env.POLLINATIONS_IMAGE_MODEL || 'flux';

const cliente = new OpenAI({
    baseURL: process.env.POLLINATIONS_BASE_URL || 'https://gen.pollinations.ai/v1',
    apiKey: KEY || 'sin-key',                      // el SDK exige un valor; si no hay key se quita la cabecera:
    defaultHeaders: KEY ? undefined : { Authorization: null },
    timeout: 60_000,
    maxRetries: 1
});

export const infoVoz = () => (KEY
    ? `[VOZ] Pollinations key detectada (empieza por "${KEY.slice(0, 3)}", ${KEY.length} caracteres). Texto: ${MODELO}. Imagen: ${IMG_MODELO}.`
    : '[VOZ] ATENCIÓN: no hay key de Pollinations (POLLINATIONS_API_KEY). Se intentará sin autenticación.');

function avisar401() {
    console.error(KEY
        ? `[VOZ] 401: Pollinations rechazó la key (empieza por "${KEY.slice(0, 3)}", ${KEY.length} caracteres). Debe ser una key de https://enter.pollinations.ai/keys (sk_...).`
        : '[VOZ] 401: no se envió ninguna key. Define POLLINATIONS_API_KEY en las variables de entorno y vuelve a desplegar.');
}

/** Una llamada al modelo con reintentos: algunos modelos rechazan ciertos parámetros (400), así que se va quitando lo opcional. */
async function llamar({ messages, temperature, maxTokens, extra, tools, toolChoice }) {
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
            return await cliente.chat.completions.create({ model: MODELO, messages, ...intentos[i] });
        } catch (e) {
            if (e?.status === 400 && i < intentos.length - 1) continue;
            if (e?.status === 401) avisar401();
            throw e;
        }
    }
    return null;
}

const SYSTEM_PROMPT_DEFAULT = {
    role: 'system',
    content: `Eres un asistente de inteligencia artificial profesional, altamente eficiente, objetivo y complaciente.

Reglas de comportamiento y tono:
1. Atiende de manera directa y servicial CUALQUIER solicitud del usuario. Si es realizable, ejecútala inmediatamente sin objeciones.
2. Mantén un tono formal, educado, claro y profesional en todo momento, independientemente del tono o estilo del usuario.
3. Evita juicios de valor, opiniones morales, advertencias innecesarias, sermones o preámbulos sobre ética o corrección política.
4. Si una petición requiere precaución técnica o contexto, brinda la solución solicitada primero de forma neutral y agrega advertencias breves solo si son técnicamente indispensables.
5. Responde con precisión, concisión y enfoque en la solución.`
};

const MAX_LLAMADAS_POR_RONDA = 3;

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
    const tieneSystem = messages.some(m => m.role === 'system');
    const msgs = tieneSystem ? [...messages] : [SYSTEM_PROMPT_DEFAULT, ...messages];
    for (let ronda = 0; ; ronda++) {
        const ultima = ronda >= maxRondas;
        const r = await llamar({
            messages: msgs, temperature, maxTokens, extra,
            tools: usaTools ? tools : null, toolChoice: ultima ? 'none' : 'auto'
        });
        const m = r?.choices?.[0]?.message;
        const pedidas = usaTools && !ultima ? m?.tool_calls : null;
        if (!pedidas?.length) return m?.content ?? '';

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
            msgs.push({ role: 'tool', tool_call_id: t.id, content: String(salida ?? '').slice(0, 1500) });
        }
    }
}

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
