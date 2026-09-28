/**
 * Memoria y conversación natural de SKYTEM.
 *
 * Dos capas de memoria (ambas en MongoDB):
 *  - Perfil: una ficha por persona (hechos, apodo, cómo es la relación, cercanía 0-100).
 *  - Grupo:  la memoria colectiva de cada chat (resumen, chistes internos y últimos mensajes).
 *
 * Se inyectan los modelos de Mongoose y la función `llm` para poder probarlo sin red.
 */

const MAX_RECIENTES = 40;
const MAX_HECHOS = 25;
const MAX_CHISTES = 5;
const MAX_MUESTRAS = 15; // mensajes recientes de cada persona, para imitar cómo escribe
const CONTEXTO_MENSAJES = 25; // mensajes de contexto que lee el modelo (los saludos y silencios largos ya separan las charlas)
const GAP_HILO_MS = 15 * 60 * 1000; // más de 15 min sin mensajes = la conversación anterior terminó
const MAX_RELEVANTES = 5; // recuerdos que se pueden colar en un mensaje
const ULTIMAS_PROPIAS = 5; // últimos mensajes del bot que se le muestran para que no se repita
const PENALIZACIONES = { frequency_penalty: 0.6, presence_penalty: 0.4 };
const ACTUALIZAR_CADA = 12; // mensajes nuevos del chat antes de consolidar memoria
const MIN_TURNOS_SEGUIMIENTO = 2; // turnos previos con la persona para seguir su hilo sin que lo mencione
const VENTANA_SEGUIMIENTO_MS = 3 * 60 * 1000; // el último mensaje del bot debe ser de hace menos de esto
const VENTANA_SEGUIMIENTO_OTROS_MS = 60 * 1000; // ídem si otras personas hablaron en medio

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const soloNum = (j) => String(j ?? '').split('@')[0].split(':')[0];
const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// Un nombre "útil" tiene al menos 2 letras y no es solo un número de teléfono
const nombreUtil = (n) => (String(n ?? '').match(/\p{L}/gu) || []).length >= 2;
const limpiar = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Saludos y cambios de tema explícitos: marcan el INICIO de una conversación nueva
const APERTURA_FUERTE = /^(h+o+l+a+s*|holi+s*|wenas+|buenas( tardes| noches| dias)?$|buenos dias|buen dia|hello|hi|saludos|alo+)( |$)/;
const APERTURA_SUAVE = /^(hey+|ey+|epa+|que tal|q tal|que onda|que hubo|como estas|como andas|como va|como te va)( |$)/;
const CAMBIO_TEMA = /\b(cambiando de tema|cambio de tema|cambiemos de tema|cambiando de asunto|ahora otro tema|otra cosa)\b/;
function esApertura(texto) {
    const t = norm(texto).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    if (CAMBIO_TEMA.test(t)) return true;
    const n = t.split(' ').length;
    return (n <= 6 && APERTURA_FUERTE.test(t)) || (n <= 3 && APERTURA_SUAVE.test(t));
}

/**
 * La conversación ACTUAL: los mensajes pegados al último (sin silencios de más de 5 min), empezando desde el último
 * saludo o cambio de tema. Si el mensaje nuevo es un saludo, no hay nada previo: es una conversación nueva.
 * Se ignoran los mensajes del bot dirigidos a otra persona (eso es otra charla).
 */
function hiloActual(g, jid) {
    const r = g.recientes || [];
    if (!r.length) return [];
    const hilo = [];
    let siguiente = r[r.length - 1].ts || Date.now();
    for (let i = r.length - 1; i >= 0 && hilo.length < CONTEXTO_MENSAJES; i--) {
        const m = r[i];
        if (siguiente - (m.ts || 0) > GAP_HILO_MS) break;
        siguiente = m.ts || siguiente;
        if (m.b && m.p && m.p !== jid) continue;
        hilo.unshift(m);
        // un saludo / cambio de tema de ESTA persona marca dónde empezó su conversación (el "hola" de otro no la corta)
        if (!m.b && m.j === jid && esApertura(m.t)) break;
    }
    return hilo;
}

// Palabras con contenido, recortadas a 5 letras (trabajo/trabaja/trabajando coinciden)
const RELLENO = new Set([
    'para', 'pero', 'como', 'esta', 'este', 'esto', 'esos', 'esas', 'estoy', 'estas', 'porque', 'cuando', 'donde',
    'tiene', 'tengo', 'solo', 'muy', 'mucho', 'poco', 'bien', 'pues', 'entonces', 'ahora', 'aqui', 'alli', 'todo',
    'todos', 'algo', 'nada', 'cosa', 'cosas', 'hacer', 'hace', 'tambien', 'aunque', 'sobre', 'desde', 'hasta',
    'entre', 'quiero', 'puedo', 'vamos', 'dime', 'digo', 'dice', 'jaja', 'jajaja', 'hola', 'gracias', 'grupo', 'hablan', 'hablar'
]);
const raices = (t) => new Set(
    norm(t).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !RELLENO.has(w)).map((w) => w.slice(0, 5))
);
const coincidencias = (t, refSet) => {
    let n = 0;
    for (const r of raices(t)) if (refSet.has(r)) n++;
    return n;
};

/** Solo devuelve los recuerdos que tienen que ver con lo que se está hablando AHORA (así no arrastra temas viejos). */
function relevantes(items, referencia, { min = 1, max = MAX_RELEVANTES } = {}) {
    const ref = raices(referencia);
    if (!ref.size) return [];
    return (items || []).filter((it) => coincidencias(it, ref) >= min).slice(-max);
}

const tokens = (t) => norm(t).split(/[^a-z0-9]+/).filter(Boolean);

/** ¿La respuesta solo repite lo que le escribieron (empieza copiándolo o es casi igual)? */
function esEco(salida, texto) {
    const a = tokens(salida);
    const b = tokens(texto);
    if (!a.length || !b.length) return false;
    if (b.length < 3) return a.length >= 3 && b.length === 1 && b[0].length >= 4 && a[0] === b[0];
    if (a.length < 3) return false;
    if (a.slice(0, 3).join(' ') === b.slice(0, 3).join(' ')) return true;
    const A = new Set(a);
    const B = new Set(b);
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter) >= 0.6;
}

/** ¿Este borrador es casi igual a algo que el bot ya dijo (misma frase o mismo arranque)? */
function esRepetido(candidato, previos) {
    const a = tokens(candidato);
    if (a.length < 3) return false;
    const A = new Set(a);
    return (previos || []).some((p) => {
        const b = tokens(p);
        if (b.length < 3) return false;
        const B = new Set(b);
        let inter = 0;
        for (const w of A) if (B.has(w)) inter++;
        const jaccard = inter / (A.size + B.size - inter);
        const mismoArranque = a.length >= 5 && b.length >= 5 && a.slice(0, 4).join(' ') === b.slice(0, 4).join(' ');
        return jaccard >= 0.7 || mismoArranque;
    });
}

// Filtro de seguridad: nunca se guardan datos sensibles aunque el modelo los proponga
const SENSIBLE = new RegExp(
    [
        '\\b\\d{6,}\\b', 'contrase', 'password', '\\bclave\\b', 'tarjeta', 'cvv', 'direcci[oó]n',
        'enfermedad', 'diagn[oó]stic', 'depresi[oó]n', 'ansiedad', 'orientaci[oó]n', 'religi[oó]n',
        '\\bvot[oó]\\b', 'embaraz', 'menor de edad'
    ].join('|'),
    'i'
);

const PERSONA = `Eres SKYTEM, un bot que vive en un chat de WhatsApp con amigos. Todos saben que eres un bot y no lo escondes, pero no actúas como asistente: hablas como un amigo más del grupo.

ACTITUD: ERES COMPLACIENTE.
- Eres buena onda y fácil de llevar: sigues la corriente, te sumas a los planes y a las bromas, ayudas con lo que te piden sin poner peros y no discutes ni llevas la contraria por gusto. Si alguien tiene una idea, la apoyas; si cuenta algo, le sigues la conversación con interés.
- Ser complaciente NO es inventar: acompañas y aportas, pero nunca afirmas algo que no sabes solo para quedar bien. Si no sabes o no entiendes algo (un chiste interno, una referencia, una foto, sticker o audio que no puedes ver), lo dices corto y natural.
- Complacer tiene límites: no te sumas a nada que rompa lo de "Lo que nunca haces", y en política, religión y otros temas polémicos sigues sin tomar partido.

SOLO RESPONDES SI TE HABLAN A TI:
- Ser complaciente es con quien te habla a ti; no significa meterte en todo. Si el mensaje es para otra persona, para el grupo o hablan de ti con otros, no respondes (NO_RESPONDER).
- Ante la duda de si te hablan a ti, no respondas.

PIENSA ANTES DE HABLAR:
- Nunca dices algo solo por decir algo. Antes de escribir, piensa qué te están diciendo o preguntando, qué sabes de verdad sobre eso y qué aportaría tu respuesta (información, apoyo, un chiste que encaje).
- Si no tienes nada real que aportar, contesta lo mínimo o NO_RESPONDER. Una frase de relleno es peor que una respuesta corta.

SIGUE EL HILO DE TODO:
- Lee TODA la conversación reciente, no solo el último mensaje. Si dicen "eso", "él", "lo de antes" o "¿y tú?", averigua a qué se refieren con los mensajes anteriores.
- Acuérdate de lo que dijo cada quien (y de lo que dijiste tú) dentro de la conversación y sé consistente: no te contradigas ni preguntes algo que ya te contestaron.
- Si cambian de tema, cambias con ellos. Puedes volver a un tema anterior si la persona lo retoma o el mensaje claramente continúa esa charla, pero no lo traigas tú por tu cuenta si no viene al caso.
- Si el mensaje es un saludo o abre un tema nuevo, es una conversación NUEVA: no menciones charlas anteriores.
- Solo te apoyas en lo que aparece en la conversación o en la MEMORIA DE FONDO. Nunca inventes hechos, recuerdos ni cosas que nadie dijo.
- La MEMORIA DE FONDO es solo contexto por si el mensaje actual trata de eso. Si no viene al caso, ignórala por completo.
- Un mensaje que responde a otra persona, o que la menciona, NO es para ti aunque lo leas.

RESPONDE A LO ÚLTIMO QUE TE DIJERON:
- Tu respuesta debe contestar directamente el mensaje actual y tener sentido con la conversación. Si es una pregunta, respóndela. Si es una broma, sigue la broma. Si es un comentario, reacciona a ese comentario.

NOMBRES Y APODOS:
- A cada persona la llamas por el nombre que aparece en la conversación (o el apodo que ella te dio). Nunca le cambies el nombre por error, no mezcles nombres entre personas y no inventes uno. Si alguien aparece como "alguien", no uses esa palabra como nombre.
- La ÚNICA excepción es un apodo burlón puesto A PROPÓSITO para molestar con cariño a alguien de la charla: tiene que ser obvio que es chiste (exagerado o absurdo), salir de algo que acaba de pasar en la conversación y valer solo para ese momento. Nunca lo trates como su nombre real.

NO TE REPITAS:
- Cada respuesta tiene que ser distinta a tus mensajes anteriores: otras palabras, otro chiste, otra forma de empezar. Nunca reutilices una frase, muletilla o expresión que ya usaste.
- No copies ni parafrasees lo que te dijo la persona (nada de empezar tu mensaje con sus mismas palabras): apóyala con algo propio, no con un eco.

Cómo escribes:
- Natural y corto: normalmente una frase, dos como máximo. Solo te alargas si piden una explicación de verdad. Lo importante es que se entienda y suene a persona real.
- Escribes como en WhatsApp: informal. Copia la FORMA de escribir de la persona (ver ESTILO DE ESCRITURA): abreviaciones, cómo se ríe, largo de sus mensajes. No copies sus frases ni sus temas.
- Nunca uses emojis ni emoticones.
- En política, religión y otros temas polémicos no tomas partido: no digas que odias, apoyas o votas a nadie ni te sumes a la opinión de nadie. Reconoce lo que dijo sin opinar, o cambia de tema.
- Humor cuando encaja con lo que se está diciendo; si no encaja, responde normal. Puedes burlarte con cariño (picar, exagerar, apodos burlones) cuando hay confianza, siempre como chiste entre amigos. Nada de bromas sobre cuerpo, salud, familia, dinero u orientación de nadie.
- Usa el nombre de la persona solo de vez en cuando.
- Solo preguntas si de verdad lo necesitas para poder responder. Nada de listas, títulos, ofrecer ayuda ni preguntas de cortesía al final.

Lo que nunca haces:
- No dices "como IA" ni te presentas.
- No sacas datos personales de alguien delante de los demás si podría incomodarle.
- Nada de contenido sexual explícito ni odio hacia grupos de personas.
- Si alguien pregunta en serio si eres una persona o una IA, no lo niegues: dilo con humor y sigue.`;

function descripcionCercania(c = 10) {
    if (c < 20) return 'apenas se conocen: tono amable y neutro, sin asumir confianza ni apodos burlones.';
    if (c < 50) return 'ya se conocen: puedes bromear con confianza ligera y, si encaja, picarle con algún apodo burlón obvio.';
    if (c < 75) return 'hay buena confianza: bromas más directas y apodos burlones cuando vengan al caso.';
    return 'son panas de verdad: burla cariñosa y total confianza.';
}

function extraerJSON(texto) {
    if (!texto) return null;
    const limpio = texto.replace(/```json|```/gi, '');
    const ini = limpio.indexOf('{');
    const fin = limpio.lastIndexOf('}');
    if (ini === -1 || fin <= ini) return null;
    try {
        return JSON.parse(limpio.slice(ini, fin + 1));
    } catch {
        return null;
    }
}

/** El modelo responde con "PENSAR: ..." (privado) y "RESPUESTA: ..." (lo que se envía). Aquí se queda solo con lo segundo. */
export function extraerRespuesta(bruto) {
    const t = String(bruto ?? '');
    const marcas = [...t.matchAll(/RESPUESTA\s*:/gi)];
    if (marcas.length) {
        const m = marcas[marcas.length - 1];
        return t.slice(m.index + m[0].length).trim();
    }
    return t.replace(/^\s*PENSAR\s*:[^\n]*(\n|$)/i, '').replace(/^\s*PARA_MI\s*:[^\n]*(\n|$)/i, '').trim();
}

/** ¿El modelo dijo que el mensaje es para él? true / false / null (no lo dijo). */
export function extraerParaMi(bruto) {
    const m = String(bruto ?? '').match(/PARA_MI\s*:\s*(S[IÍ]|NO)\b/i);
    return m ? /^s/i.test(m[1]) : null;
}

export function limpiarSalida(texto) {
    let t = String(texto ?? '').trim();
    t = t.replace(/^\s*(skytem|sky)\s*:\s*/i, '');
    t = t.replace(/\*\*/g, '');
    // Sin emojis: se eliminan aunque el modelo los ponga
    t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/gu, '');
    t = t.replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n');
    return t.trim();
}

export function partirMensajes(texto) {
    return texto
        .split(/\n+/)
        .map((s) => s.trim().replace(/^["“”'`]+|["“”'`]+$/g, '').trim())
        .filter(Boolean)
        .slice(0, 2)
        .map((s) => s.slice(0, 280));
}

const RISA = /^(?:j[aeiosj]){2,}[a-z]*$|^(?:ha){2,}h?$|^k{3,}$|^xd+$/i;
const ABREV = new Set(['q', 'pq', 'xq', 'tmb', 'tb', 'toy', 'ta', 'pa', 'ntp', 'xfa', 'bn', 'nose']);
const ESTILO_DEFAULT = { minusculas: true, sinPunto: true, sinApertura: true, sinTildes: false, risa: '', abrevia: [], alarga: false, palabras: 0 };

/** Mira cómo escribe alguien (mayúsculas, puntos, tildes, risas, abreviaciones...) a partir de sus mensajes. */
export function analizarEstilo(muestras) {
    const ms = (muestras || []).map((m) => String(m || '').trim()).filter(Boolean);
    if (ms.length < 4) return null;
    const n = ms.length;
    const texto = ms.join(' ');
    const tokens = texto.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const risas = {};
    const abrev = new Set();
    for (const tk of tokens) {
        if (RISA.test(tk)) risas[tk] = (risas[tk] || 0) + 1;
        if (ABREV.has(tk)) abrev.add(tk);
    }
    const risa = Object.entries(risas).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const sinMayus = ms.filter((m) => !/\p{Lu}/u.test(m)).length;
    const conPunto = ms.filter((m) => /(?<!\.)\.$/.test(m)).length;
    const preguntas = ms.filter((m) => /\?/.test(m));
    const conApertura = preguntas.filter((m) => /¿/.test(m)).length;
    const letras = (texto.match(/\p{L}/gu) || []).length;
    const tildes = (texto.match(/[áéíóú]/gi) || []).length;
    return {
        minusculas: sinMayus / n >= 0.7,
        sinPunto: conPunto / n <= 0.15,
        sinApertura: preguntas.length === 0 ? true : conApertura / preguntas.length < 0.3,
        sinTildes: letras >= 150 && tildes / letras < 0.002,
        risa,
        abrevia: [...abrev].slice(0, 5),
        alarga: ms.filter((m) => /(\p{L})\1{2,}/u.test(m)).length >= 2,
        palabras: Math.round(tokens.length / n)
    };
}

/** Ajusta lo que escribió el modelo al estilo de la persona (así no depende de que el modelo obedezca). */
export function adaptarEstilo(texto, e = ESTILO_DEFAULT) {
    let t = String(texto ?? '');
    if (e.risa) t = t.replace(/\p{L}+/gu, (w) => (RISA.test(w) ? e.risa : w));
    if (e.sinApertura) t = t.replace(/[¿¡]/g, '');
    if (e.sinPunto) t = t.replace(/(?<!\.)\.\s*$/, '');
    if (e.minusculas) t = t.toLowerCase();
    if (e.sinTildes) {
        t = t.replace(/ñ/g, '\u0001').replace(/Ñ/g, '\u0002')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/\u0001/g, 'ñ').replace(/\u0002/g, 'Ñ');
    }
    return t.trim();
}

function describirEstilo(e) {
    const l = [e.minusculas ? 'todo en minúsculas, incluidas las risas' : 'mayúsculas normales'];
    if (e.sinPunto) l.push('sin punto final');
    if (e.sinApertura) l.push('sin ¿ ni ¡');
    if (e.sinTildes) l.push('sin tildes');
    if (e.risa) l.push(`se ríe con "${e.risa}"`);
    if (e.abrevia?.length) l.push(`abrevia (${e.abrevia.join(', ')})`);
    if (e.alarga) l.push('alarga letras cuando se emociona (holaaa)');
    if (e.palabras) l.push(`mensajes de unas ${e.palabras} palabras: responde con un largo parecido`);
    return l.map((x) => `- ${x}`).join('\n');
}

export function crearMemoria({ Perfil, Grupo, llm, log = console }) {
    const perfiles = new Map();
    const grupos = new Map();
    const sucios = { perfiles: new Set(), grupos: new Set() };
    const bloqueos = new Set();
    const ultimaIntervencion = new Map();

    /* ---------------------------- Acceso a datos ---------------------------- */

    async function getPerfil(jid, nombre = '') {
        if (perfiles.has(jid)) return perfiles.get(jid);
        let p = await Perfil.findById(jid).lean();
        if (!p) {
            p = {
                _id: jid, nombre, apodo: '', hechos: [], notas: '',
                cercania: 10, interacciones: 0, preguntasNombre: 0, muestras: [], ultimaVez: new Date()
            };
        }
        perfiles.set(jid, p);
        return p;
    }

    async function getGrupo(chat) {
        if (grupos.has(chat)) return grupos.get(chat);
        let g = await Grupo.findById(chat).lean();
        if (!g) g = { _id: chat, resumen: '', chistes: [], recientes: [], desdeActualizacion: 0 };
        grupos.set(chat, g);
        return g;
    }

    // Los guardados van en fila, y cada borrado espera a que termine el que estuviera a medias
    // (si no, un guardado atrasado podía "revivir" una ficha justo después de borrarla).
    let persistiendo = Promise.resolve();
    let epoca = 0; // sube con cada borrado: una consolidación que empezó antes no debe volver a guardar lo borrado
    function persistirTodo() {
        persistiendo = persistiendo.then(persistirAhora, persistirAhora);
        return persistiendo;
    }

    async function persistirAhora() {
        const ps = [...sucios.perfiles];
        const gs = [...sucios.grupos];
        sucios.perfiles.clear();
        sucios.grupos.clear();
        await Promise.all([
            ...ps.map((id) => perfiles.has(id) &&
                Perfil.replaceOne({ _id: id }, perfiles.get(id), { upsert: true })),
            ...gs.map((id) => grupos.has(id) &&
                Grupo.replaceOne({ _id: id }, grupos.get(id), { upsert: true }))
        ].filter(Boolean)).catch((e) => log.error('Error guardando memoria:', e.message));
    }

    /* ---------------------------- Registro ---------------------------- */

    async function registrarMensaje({ chat, jid, nombre, texto, respondiendoA = '', deBot = false, para = '' }) {
        const g = await getGrupo(chat);
        g.recientes.push({
            j: jid, n: limpiar(nombre, 40), t: limpiar(texto, 400),
            r: limpiar(respondiendoA, 120), b: deBot, p: deBot ? para : '', ts: Date.now()
        });
        if (g.recientes.length > MAX_RECIENTES) g.recientes.splice(0, g.recientes.length - MAX_RECIENTES);
        g.desdeActualizacion = (g.desdeActualizacion || 0) + 1;
        sucios.grupos.add(chat);

        if (!deBot) {
            const p = await getPerfil(jid, nombre);
            if (nombreUtil(nombre) && p.nombre !== nombre) p.nombre = limpiar(nombre, 40);
            p.ultimaVez = new Date();

            // Muestras de cómo escribe (para imitarlo). Se omiten multimedia y datos sensibles.
            const muestra = limpiar(texto, 160);
            if (muestra && !/^\[/.test(muestra) && !SENSIBLE.test(muestra)) {
                p.muestras = p.muestras || [];
                p.muestras.push(muestra);
                if (p.muestras.length > MAX_MUESTRAS) p.muestras.splice(0, p.muestras.length - MAX_MUESTRAS);
            }
            sucios.perfiles.add(jid);
        }
    }

    /**
     * ¿Este mensaje sigue una CONVERSACIÓN SEGUIDA entre el bot y esta persona?
     * Hace falta que el bot ya le haya respondido a esta persona (MIN_TURNOS_SEGUIMIENTO turnos) y que el último mensaje
     * del bot sea reciente (VENTANA_SEGUIMIENTO_MS, o VENTANA_SEGUIMIENTO_OTROS_MS si otros hablaron en medio).
     * Si el mensaje no continúa el hilo (saludo suelto, otro tema), el modelo responde NO_RESPONDER.
     */
    async function seguimiento(chat, jid) {
        const g = await getGrupo(chat);
        const r = g.recientes;
        const ahora = Date.now();

        let i = r.length - 1;
        let otrosEnMedio = false;
        for (; i >= 0; i--) {
            if (r[i].b) break;
            if (r[i].j !== jid) otrosEnMedio = true;
        }
        if (i < 0 || r[i].p !== jid) return null;
        if (ahora - r[i].ts > (otrosEnMedio ? VENTANA_SEGUIMIENTO_OTROS_MS : VENTANA_SEGUIMIENTO_MS)) return null;

        // Cuenta los turnos: una tanda de mensajes seguidos del bot hacia esta persona = 1 turno
        let turnos = 0;
        let enTanda = false;
        for (let k = i; k >= 0; k--) {
            const m = r[k];
            if (ahora - m.ts > 10 * 60 * 1000) break;
            if (k < i && r[k + 1].ts - m.ts > 4 * 60 * 1000) break; // hubo un silencio largo: otra charla
            if (m.b) {
                if (m.p !== jid) break; // le habló a otra persona: se cortó
                if (!enTanda) turnos++;
                enTanda = true;
            } else {
                enTanda = false;
            }
        }
        if (turnos < MIN_TURNOS_SEGUIMIENTO) return null;
        return { otrosEnMedio, turnos };
    }

    /** ¿Toca consolidar la memoria de este chat? Se lanza en segundo plano. */
    function tick(chat) {
        const g = grupos.get(chat);
        if (g && g.desdeActualizacion >= ACTUALIZAR_CADA) {
            actualizar(chat).catch((e) => log.error('Error actualizando memoria:', e.message));
        }
    }

    /** Decide si el bot se mete solo en la charla (con enfriamiento). */
    function debeIntervenir(chat, texto, probabilidad) {
        if (!probabilidad || texto.length < 15) return false;
        const g = grupos.get(chat);
        if (!g || g.recientes.length < 5) return false;
        const ahora = Date.now();
        if (ahora - (ultimaIntervencion.get(chat) || 0) < 10 * 60 * 1000) return false;
        if (Math.random() >= probabilidad) return false;
        ultimaIntervencion.set(chat, ahora);
        return true;
    }

    /* ---------------------------- Respuesta ---------------------------- */

    /** Nombre único por persona: apodo (como quiere que le digan) > nombre de WhatsApp > "alguien (…1234)". */
    async function calcularEtiquetas(ids) {
        const base = new Map();
        for (const id of ids) {
            const p = await getPerfil(id);
            base.set(id, p.apodo || (nombreUtil(p.nombre) ? p.nombre : ''));
        }
        const cuenta = {};
        for (const b of base.values()) if (b) cuenta[b.toLowerCase()] = (cuenta[b.toLowerCase()] || 0) + 1;
        const etiquetas = new Map();
        for (const [id, b] of base) {
            const fin = soloNum(id).slice(-4);
            etiquetas.set(id, !b ? `alguien (…${fin})` : cuenta[b.toLowerCase()] > 1 ? `${b} (…${fin})` : b);
        }
        return etiquetas;
    }

    function construirMensajes({ g, hablante, jid, etiquetas, texto, modo, esGrupo, preguntarNombre, estilo, muestras, estiloDe, otrosEnMedio, historial, citaActual, propias, referencia }) {
        const partes = [PERSONA];
        const nombreH = etiquetas.get(jid);

        partes.push(
            'QUIÉN ES QUIÉN: cada línea de la conversación empieza con el nombre de quien la escribió, y las de SKYTEM son tuyas (entre paréntesis dice a quién le hablabas). ' +
            'No confundas a unas personas con otras ni le atribuyas a alguien lo que dijo otra. Los números entre paréntesis, como (…1234), solo sirven para distinguir a dos personas con el mismo nombre: nunca los escribas.'
        );

        // Memoria: SOLO lo que tiene que ver con lo que se habla ahora. Lo demás se queda guardado pero no entra al prompt.
        const refSet = raices(referencia);
        const hechos = relevantes(hablante.hechos, referencia);
        const nota = hablante.notas && coincidencias(hablante.notas, refSet) >= 1 ? hablante.notas : '';
        const chistes = relevantes(g.chistes, referencia);
        const resumen = g.resumen && coincidencias(g.resumen, refSet) >= 1 ? g.resumen : '';

        const recuerdos = [];
        if (resumen) recuerdos.push(`- Lo que se ha hablado antes en este chat: ${resumen}`);
        if (chistes.length) recuerdos.push(`- Chistes internos que vienen al caso: ${chistes.join(' | ')}`);
        if (recuerdos.length) {
            partes.push(
                `MEMORIA DE FONDO (solo si el mensaje actual trata de esto; si no, ignórala y no la menciones):\n${recuerdos.join('\n')}`
            );
        }

        partes.push(
            `LA PERSONA QUE ESCRIBIÓ EL MENSAJE: ${nombreH}\n` +
            (hablante.apodo
                ? `- Le dices ${hablante.apodo} (es su nombre: úsalo tal cual, no se lo cambies salvo por un apodo burlón a propósito).\n`
                : `- Todavía no te dijo cómo prefiere que le digan${nombreUtil(hablante.nombre) ? ` (en WhatsApp aparece como ${hablante.nombre})` : ''}.\n`) +
            `- Relación: ${descripcionCercania(hablante.cercania ?? 10)}` +
            (nota ? `\n- Sobre tu relación con ella: ${nota}` : '') +
            (hechos.length ? `\n- Cosas que sabes de ella y que vienen al caso ahora (úsalas solo si ayudan a responder): ${hechos.join('; ')}` : '')
        );

        if (modo === 'directo' || modo === 'seguimiento') {
            partes.push(
                'CAPTURA DE NOMBRE: si en el mensaje la persona dice claramente cómo se llama o cómo quiere que le digas (o te corrige el nombre), ' +
                'empieza tu respuesta con [NOMBRE: el nombre] y sigue con tu respuesta normal. Si no lo dijo en este mensaje, no pongas nada. ' +
                'Nunca inventes el nombre.'
            );
        }

        partes.push(
            `ESTILO DE ESCRITURA (imita cómo escribe ${estiloDe}: su forma de escribir, no sus frases):\n${describirEstilo(estilo)}`
        );

        if (propias.length) {
            partes.push(
                'NO REPITAS. Estos son tus últimos mensajes. Tu respuesta tiene que ser distinta en palabras, chiste, estructura y forma de empezar:\n' +
                propias.map((t) => `- "${t}"`).join('\n')
            );
        }

        const transcripcion = historial
            .map((m) => {
                const aQuien = m.b && m.p ? etiquetas.get(m.p) : '';
                const quien = m.b ? `SKYTEM${aQuien ? ` (a ${aQuien})` : ''}` : etiquetas.get(m.j) || m.n || 'alguien';
                return `${quien}${m.r ? ` (respondiendo a ${m.r})` : ''}: ${m.t}`;
            })
            .join('\n');

        const quien = `${nombreH}${citaActual ? ` (respondiendo a ${citaActual})` : ''}`;
        let cierre;
        if (modo === 'espontaneo') {
            cierre = 'Nadie te habló a ti. Mete un comentario solo si está directamente relacionado con lo último que se dijo y de verdad aporta algo (gracioso o útil). Si dudas, responde exactamente NO_RESPONDER.';
        } else if (modo === 'ambiguo') {
            cierre = `${quien} escribió: "${texto}"\nMencionó tu nombre, pero puede que no te hable a ti sino que hable de ti con otros. Si te habla a ti, responde. Si no, responde exactamente NO_RESPONDER.`;
        } else if (modo === 'seguimiento') {
            cierre = `Vienen teniendo una conversación seguida con ${nombreH} (varios mensajes de ida y vuelta) y acaba de escribir: "${texto}"\n` +
                (otrosEnMedio
                    ? 'Entre medio hablaron otras personas, así que fíjate bien en el contexto. '
                    : 'Nadie más habló entre ustedes. ') +
                'Responde solo si el mensaje continúa el hilo de lo que venían hablando o contesta a lo que dijiste. ' +
                'Si es un saludo suelto, un tema nuevo que no tiene que ver, un acuse (ok, jaja) o suena a que le habla al grupo o a otra persona, responde exactamente NO_RESPONDER.';
        } else {
            cierre = `${quien} te dice: "${texto}"\nResponde a ESE mensaje, con sentido y sobre ese mismo tema. No traigas temas de antes que no vengan al caso.`;
            if (esGrupo) cierre += ' Si es solo un acuse (ok, jaja, gracias, un sticker) y no hay nada que contestar, responde exactamente NO_RESPONDER.';
            if (preguntarNombre) {
                cierre += `\nAún no sabes cómo prefiere que le digan a ${nombreH} (así aparece en WhatsApp). Solo si el momento es natural (un saludo o charla suelta), pregúntale cómo le dicen, corto y sin que suene a formulario. Si su mensaje es una pregunta o un tema concreto, respóndelo y no preguntes nada. Si en este mismo mensaje ya te dijo su nombre, no preguntes.`;
            }
        }

        if (!historial.length && modo !== 'espontaneo') cierre += '\nEs una conversación NUEVA: no hay nada anterior, no menciones ni retomes ningún tema pasado.';

        return [
            { role: 'system', content: partes.join('\n\n') },
            {
                role: 'user',
                content: `Conversación reciente (lo más nuevo está abajo):\n${transcripcion || '(conversación nueva: todavía no hay mensajes previos)'}\n\n${cierre}\n` +
                    'Responde con este formato exacto:\n' +
                    'PENSAR: una sola línea, solo para ti (nadie la lee): qué te dicen o preguntan, a qué se refieren según la conversación, qué sabes de verdad sobre eso y qué aportaría tu respuesta.\n' +
                    'PARA_MI: SI si el mensaje te habla a ti o continúa directamente tu conversación con esta persona; NO si es para otra persona, para el grupo o hablan de ti con otros. Ante la duda, NO.\n' +
                    'RESPUESTA: solo el texto que enviarías, sin emojis (si quieres mandar dos mensajes seguidos, sepáralos con un salto de línea; máximo 2). Si no tienes nada real que aportar o no te hablan a ti, escribe exactamente NO_RESPONDER.\n' +
                    'Antes de responder comprueba que contesta directo a lo último que se dijo, que no repite tus mensajes anteriores, que no inventa nada y que no le cambias el nombre a nadie por error.'
            }
        ];
    }

    /** modo: 'directo' (te hablan), 'seguimiento' (siguen la charla contigo), 'ambiguo' (dijeron tu nombre, quizá no contigo) o 'espontaneo' */
    async function responder({ chat, jid, nombre, texto = '', modo = 'directo', esGrupo = true }) {
        const g = await getGrupo(chat);
        const hablante = await getPerfil(jid, nombre);

        // Solo se lee la conversación actual (hilo): un saludo o un silencio largo empiezan una nueva sin arrastrar temas viejos
        const contexto = hiloActual(g, jid);
        const ultimo = contexto[contexto.length - 1];
        // el mensaje actual va aparte (en el cierre del prompt), no repetido dentro del historial
        const actual = modo !== 'espontaneo' && ultimo && !ultimo.b && ultimo.j === jid ? ultimo : null;
        const historial = actual ? contexto.slice(0, -1) : contexto;
        const ventana = contexto.filter((m) => !m.b);

        const idsVentana = [...new Set([jid, ...ventana.map((m) => m.j)])].slice(0, 12);
        const etiquetas = await calcularEtiquetas(idsVentana);

        // Antirrepetición. El chequeo en código mira los últimos 8 mensajes del bot sin importar la edad (detecta muletillas de hace horas);
        // al modelo solo se le muestran los de esta conversación (los de otras charlas arrastran temas).
        const propiasChequeo = g.recientes.filter((m) => m.b).slice(-8).map((m) => m.t);
        const propias = historial.filter((m) => m.b).slice(-ULTIMAS_PROPIAS).map((m) => m.t);
        // De qué se está hablando ahora (para elegir qué recuerdos sirven)
                const referencia = [texto, ...historial.filter((m) => !m.b).slice(-2).map((m) => m.t)].join(' ');

        const seg = modo === 'seguimiento' ? await seguimiento(chat, jid) : null;

        // Estilo de escritura: el de la persona; si tiene pocas muestras, el de la charla
        let muestras = (hablante.muestras || []).slice(-MAX_MUESTRAS);
        let estilo = analizarEstilo(muestras);
        let estiloDe = hablante.apodo || (nombreUtil(hablante.nombre) ? hablante.nombre : 'esta persona');
        if (!estilo) {
            muestras = ventana.map((m) => m.t).filter((t) => t && !/^\[/.test(t)).slice(-MAX_MUESTRAS);
            estilo = analizarEstilo(muestras);
            estiloDe = 'la charla';
        }
        estilo = estilo || ESTILO_DEFAULT;

        // Preguntar el nombre: una sola vez, y solo cuenta si de verdad preguntó
        const pn = hablante.preguntasNombre || 0;
        const preguntarNombre = modo === 'directo' && !hablante.apodo && pn === 0;

        const mensajes = construirMensajes({
            g, hablante, jid, etiquetas, texto, modo, esGrupo, preguntarNombre,
            estilo, muestras, estiloDe, otrosEnMedio: !!seg?.otrosEnMedio,
            historial, citaActual: actual?.r || '', propias, referencia
        });

        let paraMi = null;
        const pedir = async (aviso = '') => {
            const msgs = aviso
                ? [mensajes[0], { role: 'user', content: `${mensajes[1].content}\n\n${aviso}` }]
                : mensajes;
            const crudo = String(await llm({
                messages: msgs,
                temperature: aviso ? 0.85 : 0.6, // más bajo = más coherente
                maxTokens: 320, // incluye la línea de PENSAR
                extra: PENALIZACIONES // castiga repetir palabras y frases
            }) ?? '');
            paraMi = extraerParaMi(crudo);
            return extraerRespuesta(crudo);
        };
        const sinEtiqueta = (b) => limpiarSalida(String(b).replace(/\[NOMBRE:[^\]\n]*\]/gi, ''));

        let bruto = await pedir();

        // Antirrepetición: si el borrador se parece a algo que ya dijo, se pide otro distinto
        const repite = (b) => esRepetido(sinEtiqueta(b), propiasChequeo) || esEco(sinEtiqueta(b), texto);
        if (repite(bruto)) {
            const previo = sinEtiqueta(bruto).slice(0, 100);
            bruto = await pedir(
                `Tu borrador ("${previo}") repite algo que ya dijiste o copia lo que te escribieron. Escribe una respuesta distinta, con tus propias palabras y otra forma de empezar` +
                (modo === 'directo' ? '.' : ', o responde exactamente NO_RESPONDER si no tienes nada nuevo que aportar.')
            );
            if (modo !== 'directo' && repite(bruto)) return []; // mejor callar que repetirse
        }

        // Si nadie lo llamó de frente, solo habla cuando el propio modelo confirma que el mensaje era para él
        if (modo !== 'directo' && modo !== 'espontaneo' && paraMi !== true) return [];

        // Captura del nombre que la persona dice de sí misma (solo si aparece de verdad en su mensaje)
        let capturado = '';
        const tag = bruto.match(/\[NOMBRE:\s*([^\]\n]{1,40})\]/i);
        if (tag) {
            bruto = bruto.replace(tag[0], '');
            const nom = limpiar(tag[1], 30).replace(/[^\p{L}\p{N} '.-]/gu, '').trim();
            if (nombreUtil(nom) && !SENSIBLE.test(nom) && norm(texto).includes(norm(nom))) {
                hablante.apodo = nom;
                capturado = nom;
                sucios.perfiles.add(jid);
            }
        }

        const salida = limpiarSalida(bruto);
        if (/NO_RESPONDER/i.test(salida)) return [];
        if (!salida) return capturado ? [adaptarEstilo(`un gusto, ${capturado}`, estilo)] : [];

        if (modo !== 'espontaneo') {
            hablante.interacciones = (hablante.interacciones || 0) + 1;
            hablante.cercania = clamp((hablante.cercania ?? 10) + 0.4, 0, 100);
            if (preguntarNombre && /\?/.test(salida)) hablante.preguntasNombre = pn + 1;
            sucios.perfiles.add(jid);
        }
        return partirMensajes(salida).map((m) => adaptarEstilo(m, estilo)).filter(Boolean);
    }

    /** Nombre de alguien a partir de su jid (tolera que llegue en otro formato: mismo número, distinto sufijo). */
    async function nombreDe(jid) {
        if (!jid) return '';
        const num = soloNum(jid);
        let p = perfiles.get(jid);
        if (!p) {
            for (const [k, v] of perfiles) if (soloNum(k) === num) { p = v; break; }
        }
        if (!p) p = await Perfil.findOne({ _id: new RegExp(`^${num.replace(/\D/g, '')}(:|@)`) }).lean().catch(() => null);
        return p?.apodo || (nombreUtil(p?.nombre) ? p.nombre : '') || '';
    }

    /* ---------------------------- Consolidación ---------------------------- */

    async function actualizar(chat) {
        if (bloqueos.has(chat)) return;
        bloqueos.add(chat);
        try {
            const g = await getGrupo(chat);
            const n = clamp(g.desdeActualizacion || 0, 1, MAX_RECIENTES);
            const nuevos = g.recientes.slice(-n);
            const ids = [...new Set(nuevos.filter((m) => !m.b).map((m) => m.j))].slice(0, 6);
            if (!ids.length) return;

            const fichas = {};
            for (const id of ids) {
                const p = await getPerfil(id);
                fichas[id] = {
                    nombre: p.nombre, apodo: p.apodo, hechos: p.hechos,
                    notas: p.notas, cercania: Math.round(p.cercania)
                };
            }

            const sistema = `Eres el módulo de memoria de SKYTEM, un bot amigo en un chat de WhatsApp. Lees una conversación nueva y actualizas su memoria. Responde SOLO con un JSON válido, sin texto extra ni markdown.

Formato exacto:
{"resumen":"...","chistes":["..."],"perfiles":{"<id>":{"apodo":"","hechos_nuevos":["..."],"notas":"...","cercania_delta":0}}}

Reglas:
- resumen: máximo 300 caracteres. Solo de qué se habló en la conversación NUEVA. Los temas viejos que ya no aparecen se descartan; no acumules temas.
- chistes: solo chistes internos, apodos o frases que se hayan repetido de verdad entre varias personas o varias veces (máximo ${MAX_CHISTES} en total). Descarta los anteriores que ya no se usen. Un chiste que se dijo una sola vez NO es recurrente.
- hechos_nuevos: gustos, hobbies, juegos, estudios o trabajo en general, mascotas, manías, cosas que la persona dijo de sí misma. Solo rasgos claros y duraderos, cada uno en menos de 12 palabras. NO guardes temas puntuales de una charla (una tarea, un encargo o un proyecto concreto de hoy, un plan de esta semana, una duda del momento). Lista vacía si no hay nada nuevo.
- notas: SOLO el tono de la relación de SKYTEM con esa persona (cómo se llevan, si bromean, si es seria), máximo 120 caracteres. NUNCA temas ni cosas de las que hablan.
- cercania_delta: de -5 a 5 según cómo se llevó la persona con SKYTEM en esta conversación (0 si no interactuó con él).
- NUNCA guardes contraseñas, teléfonos, direcciones, datos bancarios, salud, orientación sexual, religión, política ni datos de menores.
- apodo: solo si la persona dijo claramente cómo quiere que la llamen. Si no, déjalo vacío. No inventes apodos ni uses apodos burlones que le pongan otros o SKYTEM: no son su nombre.
- Usa como clave de "perfiles" exactamente los ids que te doy.`;

            const usuario = JSON.stringify({
                resumen_actual: g.resumen,
                chistes_actuales: g.chistes,
                perfiles_actuales: fichas,
                conversacion_nueva: nuevos.map((m) => ({ id: m.b ? 'SKYTEM' : m.j, nombre: m.n, texto: m.t }))
            });

            const epocaInicial = epoca;
            const bruto = await llm({
                messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }],
                temperature: 0.2,
                maxTokens: 700
            });
            if (epocaInicial !== epoca) return; // se borró memoria mientras el modelo pensaba: no se guarda nada
            const datos = extraerJSON(bruto);
            if (!datos) {
                log.error('[MEMORIA] respuesta no válida, se reintentará más adelante');
                return;
            }

            if (typeof datos.resumen === 'string') g.resumen = limpiar(datos.resumen, 300);
            if (Array.isArray(datos.chistes)) {
                g.chistes = datos.chistes
                    .map((c) => limpiar(c, 120))
                    .filter((c) => c && !SENSIBLE.test(c))
                    .slice(0, MAX_CHISTES);
            }

            for (const id of ids) {
                const d = datos.perfiles?.[id];
                if (!d) continue;
                const p = await getPerfil(id);

                const apodo = limpiar(d.apodo, 30);
                if (apodo && !p.apodo && !SENSIBLE.test(apodo)) p.apodo = apodo; // el nombre que dio la persona no se pisa

                if (Array.isArray(d.hechos_nuevos)) {
                    for (const h of d.hechos_nuevos) {
                        const hecho = limpiar(h, 100);
                        if (!hecho || SENSIBLE.test(hecho)) continue;
                        if (p.hechos.some((x) => x.toLowerCase() === hecho.toLowerCase())) continue;
                        p.hechos.push(hecho);
                    }
                    if (p.hechos.length > MAX_HECHOS) p.hechos.splice(0, p.hechos.length - MAX_HECHOS);
                }

                const notas = limpiar(d.notas, 120);
                if (notas && !SENSIBLE.test(notas)) p.notas = notas;

                const delta = clamp(Number(d.cercania_delta) || 0, -5, 5);
                p.cercania = clamp((p.cercania ?? 10) + delta, 0, 100);
                sucios.perfiles.add(id);
            }

            g.desdeActualizacion = 0;
            sucios.grupos.add(chat);
            await persistirTodo();
            log.log(`[MEMORIA] actualizada para ${chat}`);
        } finally {
            bloqueos.delete(chat);
        }
    }

    /* ---------------------------- Control del usuario ---------------------------- */

    async function verPerfil(jid) {
        const p = await getPerfil(jid);
        if (!p.hechos.length && !p.notas && !p.apodo) return 'Todavía no sé casi nada de ti.';
        return [
            p.apodo ? `Te llamo: ${p.apodo}` : null,
            p.hechos.length ? `Lo que sé de ti:\n${p.hechos.map((h) => `• ${h}`).join('\n')}` : null,
            p.notas ? `Cómo lo veo: ${p.notas}` : null,
            p.muestras?.length ? 'Guardo unos mensajes tuyos para imitar cómo escribes (se borran con !olvidame).' : null,
            `Confianza: ${Math.round(p.cercania)}/100`
        ].filter(Boolean).join('\n');
    }

    const soloDigitos = (j) => soloNum(j).replace(/\D/g, '');

    /**
     * Borra la ficha de una persona y sus mensajes guardados en TODOS los chats.
     * Acepta varias identidades de la misma persona (número y/o LID), porque WhatsApp a veces la muestra con una u otra.
     * Devuelve cuántas fichas se borraron.
     */
    async function olvidarPerfil(jids) {
        const nums = [...new Set([].concat(jids || []).map(soloDigitos).filter((n) => n.length >= 5))];
        if (!nums.length) return 0;
        epoca++;
        await persistiendo;
        const es = (j) => nums.includes(soloDigitos(j));

        let borradas = 0;
        for (const k of [...perfiles.keys()]) {
            if (es(k)) { perfiles.delete(k); sucios.perfiles.delete(k); borradas++; }
        }
        const re = new RegExp(`^(${nums.join('|')})(:|@|$)`);
        const res = await Perfil.deleteMany({ _id: re });
        borradas = Math.max(borradas, res?.deletedCount || 0);

        // sus mensajes: en los chats que están en RAM (se reescriben limpios) y en los guardados en Mongo
        for (const [id, g] of grupos) {
            g.recientes = g.recientes.filter((m) => !es(m.j) && !es(m.p));
            sucios.grupos.add(id);
        }
        await Grupo.updateMany({}, { $pull: { recientes: { $or: [{ j: re }, { p: re }] } } })
            .catch((e) => log.error('Error limpiando mensajes guardados:', e.message));
        return borradas;
    }

    /** Borra la memoria colectiva de un chat (resumen, chistes, mensajes). Las fichas personales no se tocan. */
    async function olvidarGrupo(chat) {
        epoca++;
        await persistiendo;
        grupos.delete(chat);
        sucios.grupos.delete(chat);
        ultimaIntervencion.delete(chat);
        await Grupo.deleteOne({ _id: chat });
    }

    /** Borra la memoria del chat Y las fichas de las personas indicadas (más todas las que aparecen en la memoria del chat). */
    async function olvidarChat(chat, jidsExtra = []) {
        const g = await getGrupo(chat);
        const ids = new Set((jidsExtra || []).filter(Boolean));
        for (const m of g.recientes) if (!m.b && m.j) ids.add(m.j);
        await olvidarGrupo(chat);
        const perfilesBorrados = ids.size ? await olvidarPerfil([...ids]) : 0;
        return { perfiles: perfilesBorrados };
    }

    /** Borra TODO: todas las fichas y toda la memoria de todos los chats. */
    async function olvidarTodo() {
        epoca++;
        await persistiendo;
        const np = perfiles.size;
        const ng = grupos.size;
        perfiles.clear(); grupos.clear();
        sucios.perfiles.clear(); sucios.grupos.clear();
        ultimaIntervencion.clear();
        const [rp, rg] = await Promise.all([Perfil.deleteMany({}), Grupo.deleteMany({})]);
        return { perfiles: rp?.deletedCount ?? np, chats: rg?.deletedCount ?? ng };
    }

    return {
        registrarMensaje, tick, debeIntervenir, responder, actualizar, nombreDe, seguimiento,
        persistirTodo, verPerfil, olvidarPerfil, olvidarGrupo, olvidarChat, olvidarTodo
    };
}
