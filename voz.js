/**
 * voz.js — el córtex motor / lenguaje. SOLO traduce a palabras lo que el cerebro ya decidió.
 * No guarda estado ni decide nada: recibe mensajes, devuelve texto.
 *
 * Usa el SDK oficial de OpenAI apuntando a Pollinations (API compatible con OpenAI).
 */
import OpenAI from 'openai';

// Acepta varios nombres de variable y limpia espacios, saltos de línea o comillas que se cuelan al pegar la key
const KEY = (process.env.POLLINATIONS_API_KEY || process.env.POLLINATIONS_KEY || process.env.POLLINATIONS_TOKEN || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^Bearer\s+/i, '')
    .trim();

const MODELO = process.env.POLLINATIONS_MODEL || 'openai';

const cliente = new OpenAI({
    baseURL: process.env.POLLINATIONS_BASE_URL || 'https://gen.pollinations.ai/v1',
    apiKey: KEY || 'sin-key',                      // el SDK exige un valor; si no hay key se quita la cabecera:
    defaultHeaders: KEY ? undefined : { Authorization: null },
    timeout: 30_000,
    maxRetries: 1
});

export const infoVoz = () => (KEY
    ? `[VOZ] Pollinations key detectada (empieza por "${KEY.slice(0, 3)}", ${KEY.length} caracteres). Modelo: ${MODELO}.`
    : '[VOZ] ATENCIÓN: no hay key de Pollinations (POLLINATIONS_API_KEY). Se intentará sin autenticación.');

/**
 * @param {{messages: Array, temperature?: number, maxTokens?: number, extra?: object}} p
 * @returns {Promise<string>}
 */
export async function voz({ messages, temperature = 0.7, maxTokens = 160, extra = {} }) {
    // Algunos modelos rechazan ciertos parámetros: se reintenta quitando primero las penalizaciones y luego todo
    const intentos = [
        { temperature, max_tokens: maxTokens, ...extra },
        { temperature, max_tokens: maxTokens },
        {}
    ];
    for (let i = 0; i < intentos.length; i++) {
        try {
            const r = await cliente.chat.completions.create({ model: MODELO, messages, ...intentos[i] });
            return r.choices?.[0]?.message?.content ?? '';
        } catch (e) {
            if (e?.status === 400 && i < intentos.length - 1) continue;
            if (e?.status === 401) {
                console.error(KEY
                    ? `[VOZ] 401: Pollinations rechazó la key (empieza por "${KEY.slice(0, 3)}", ${KEY.length} caracteres). Debe ser una key de https://enter.pollinations.ai/keys (sk_...).`
                    : '[VOZ] 401: no se envió ninguna key. Define POLLINATIONS_API_KEY en las variables de entorno de Render y vuelve a desplegar.');
            }
            throw e;
        }
    }
    return '';
}
