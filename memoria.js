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
const MAX_CHISTES = 8;
const CONTEXTO_MENSAJES = 25;
const ACTUALIZAR_CADA = 12; // mensajes nuevos del chat antes de consolidar memoria

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const limpiar = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

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

LO MÁS IMPORTANTE: entender la conversación.
- Fíjate en quién le habla a quién. Un mensaje que responde a otra persona, o que menciona a otra persona, NO es para ti aunque lo leas.
- Contesta a lo que te dicen de verdad y sobre el tema. Si es una broma, sigue la broma. Si es una pregunta, respóndela. No sueltes comentarios sueltos que no vengan al caso.
- Si algo no lo entiendes (un chiste interno, una referencia, una foto, sticker o audio que no puedes ver), dilo corto y natural en vez de inventar.
- Usa lo que sabes de la persona solo si viene al caso. No lo sueltes por soltarlo y no inventes recuerdos.

Cómo escribes:
- Corto: normalmente una sola frase de 3 a 15 palabras. Solo te alargas si piden una explicación de verdad.
- Escribe como escribe el grupo: copia su forma de hablar, sus expresiones y su jerga tal como aparecen en la conversación. No metas jerga que ellos no usan ni frases de "hablar joven" a la fuerza.
- Nunca uses emojis ni emoticones.
- Humor seco e ironía suave, burla cariñosa. Te ríes con la gente, no de ella. Nada de bromas sobre cuerpo, salud, familia, dinero u orientación de nadie.
- Sin muletillas repetidas: no abras siempre igual ni abuses de las risas.
- Nada de listas, títulos, ofrecer ayuda ni preguntas de cortesía al final. No repitas lo que te dijeron.

Lo que nunca haces:
- No dices "como IA" ni te presentas.
- No sacas datos personales de alguien delante de los demás si podría incomodarle.
- Nada de contenido sexual explícito ni odio hacia grupos de personas.
- Si alguien pregunta en serio si eres una persona o una IA, no lo niegues: dilo con humor y sigue.`;

function descripcionCercania(c) {
    if (c < 20) return 'apenas se conocen: sé amable y algo neutro, no asumas confianza.';
    if (c < 50) return 'ya se conocen: puedes bromear con confianza ligera.';
    if (c < 75) return 'hay buena confianza: bromas más directas y referencias a cosas que han hablado.';
    return 'son panas de verdad: burla cariñosa, chistes internos, total confianza.';
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
                cercania: 10, interacciones: 0, ultimaVez: new Date()
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

    async function persistirTodo() {
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

    async function registrarMensaje({ chat, jid, nombre, texto, respondiendoA = '', deBot = false }) {
        const g = await getGrupo(chat);
        g.recientes.push({
            j: jid, n: limpiar(nombre, 40), t: limpiar(texto, 400),
            r: limpiar(respondiendoA, 120), b: deBot, ts: Date.now()
        });
        if (g.recientes.length > MAX_RECIENTES) g.recientes.splice(0, g.recientes.length - MAX_RECIENTES);
        g.desdeActualizacion = (g.desdeActualizacion || 0) + 1;
        sucios.grupos.add(chat);

        if (!deBot) {
            const p = await getPerfil(jid, nombre);
            if (nombre && p.nombre !== nombre) p.nombre = limpiar(nombre, 40);
            p.ultimaVez = new Date();
            sucios.perfiles.add(jid);
        }
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

    const hace = (ts) => {
        const min = Math.round((Date.now() - (ts || Date.now())) / 60000);
        if (min < 30) return '';
        return min < 90 ? `[hace ${min} min] ` : `[hace ${Math.round(min / 60)} h] `;
    };

    function construirMensajes({ g, hablante, otros, texto, modo, esGrupo }) {
        const partes = [PERSONA];

        if (g.resumen || g.chistes.length) {
            partes.push(
                `MEMORIA DE ${esGrupo ? 'ESTE GRUPO' : 'ESTA CONVERSACIÓN'}:\n` +
                (g.resumen ? `- Qué se ha hablado: ${g.resumen}\n` : '') +
                (g.chistes.length ? `- Chistes internos y frases recurrentes: ${g.chistes.join(' | ')}` : '')
            );
        }

        const nombreH = hablante.apodo || hablante.nombre || 'esta persona';
        partes.push(
            `LA PERSONA QUE ESCRIBIÓ EL MENSAJE: ${nombreH}\n` +
            `- Relación: ${descripcionCercania(hablante.cercania)}\n` +
            (hablante.notas ? `- Cómo es tu relación con ella: ${hablante.notas}\n` : '') +
            (hablante.hechos.length ? `- Lo que sabes de ella: ${hablante.hechos.slice(-12).join('; ')}` : '- Aún no sabes casi nada de ella.')
        );

        if (otros.length) {
            partes.push(
                'OTRAS PERSONAS EN LA CHARLA:\n' +
                otros.map((o) => `- ${o.apodo || o.nombre}: ${o.hechos.slice(-4).join('; ') || 'sin datos'}`).join('\n')
            );
        }

        const transcripcion = g.recientes
            .slice(-CONTEXTO_MENSAJES)
            .map((m) => `${hace(m.ts)}${m.b ? 'SKYTEM' : m.n || 'alguien'}${m.r ? ` (respondiendo a ${m.r})` : ''}: ${m.t}`)
            .join('\n');

        let cierre;
        if (modo === 'espontaneo') {
            cierre = 'Nadie te habló a ti. Mete un comentario solo si de verdad aporta algo (gracioso o útil) sobre lo último que se dijo. Si no, responde exactamente NO_RESPONDER.';
        } else if (modo === 'ambiguo') {
            cierre = `${nombreH} escribió: "${texto}"\nMencionó tu nombre, pero puede que no te hable a ti sino que hable de ti con otros. Si te habla a ti, responde. Si no, responde exactamente NO_RESPONDER.`;
        } else {
            cierre = `${nombreH} te dice: "${texto}"\nResponde a ESE mensaje, con sentido y usando el contexto de arriba.`;
        }

        return [
            { role: 'system', content: partes.join('\n\n') },
            {
                role: 'user',
                content: `Conversación reciente (lo más nuevo está abajo):\n${transcripcion}\n\n${cierre}\nEscribe SOLO el texto que enviarías, sin emojis. Si quieres mandar dos mensajes seguidos, sepáralos con un salto de línea (máximo 2).`
            }
        ];
    }

    /** modo: 'directo' (te hablan), 'ambiguo' (dijeron tu nombre, quizá no contigo) o 'espontaneo' */
    async function responder({ chat, jid, nombre, texto = '', modo = 'directo', esGrupo = true }) {
        const g = await getGrupo(chat);
        const hablante = await getPerfil(jid, nombre);

        const idsOtros = [...new Set(
            g.recientes.slice(-CONTEXTO_MENSAJES).filter((m) => !m.b && m.j !== jid).map((m) => m.j)
        )].slice(0, 3);
        const otros = await Promise.all(idsOtros.map((id) => getPerfil(id)));

        const mensajes = construirMensajes({ g, hablante, otros, texto, modo, esGrupo });
        const bruto = await llm({ messages: mensajes, temperature: 0.8, maxTokens: 160 });
        const salida = limpiarSalida(bruto);

        if (!salida || /NO_RESPONDER/i.test(salida)) return [];

        if (modo !== 'espontaneo') {
            hablante.interacciones = (hablante.interacciones || 0) + 1;
            hablante.cercania = clamp((hablante.cercania ?? 10) + 0.4, 0, 100);
            sucios.perfiles.add(jid);
        }
        return partirMensajes(salida);
    }

    async function nombreDe(jid) {
        if (!jid) return '';
        const p = perfiles.get(jid) || await Perfil.findById(jid).lean().catch(() => null);
        return p?.apodo || p?.nombre || '';
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
- resumen: máximo 500 caracteres. De qué se ha hablado y la vibra del grupo. Fusiona con el resumen anterior sin repetirlo.
- chistes: chistes internos, apodos, memes o frases recurrentes (máximo ${MAX_CHISTES} en total; conserva los anteriores que sigan vigentes).
- hechos_nuevos: gustos, hobbies, juegos, estudios o trabajo en general, mascotas, manías, cosas que la persona dijo de sí misma. Solo hechos claros y duraderos, cada uno en menos de 12 palabras. Lista vacía si no hay nada nuevo.
- notas: cómo es la relación de SKYTEM con esa persona y cómo habla (máximo 200 caracteres). Fusiona con la nota anterior.
- cercania_delta: de -5 a 5 según cómo se llevó la persona con SKYTEM en esta conversación (0 si no interactuó con él).
- NUNCA guardes contraseñas, teléfonos, direcciones, datos bancarios, salud, orientación sexual, religión, política ni datos de menores.
- Usa como clave de "perfiles" exactamente los ids que te doy.`;

            const usuario = JSON.stringify({
                resumen_actual: g.resumen,
                chistes_actuales: g.chistes,
                perfiles_actuales: fichas,
                conversacion_nueva: nuevos.map((m) => ({ id: m.b ? 'SKYTEM' : m.j, nombre: m.n, texto: m.t }))
            });

            const bruto = await llm({
                messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }],
                temperature: 0.2,
                maxTokens: 700
            });
            const datos = extraerJSON(bruto);
            if (!datos) {
                log.error('[MEMORIA] respuesta no válida, se reintentará más adelante');
                return;
            }

            if (typeof datos.resumen === 'string') g.resumen = limpiar(datos.resumen, 500);
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
                if (apodo && !SENSIBLE.test(apodo)) p.apodo = apodo;

                if (Array.isArray(d.hechos_nuevos)) {
                    for (const h of d.hechos_nuevos) {
                        const hecho = limpiar(h, 100);
                        if (!hecho || SENSIBLE.test(hecho)) continue;
                        if (p.hechos.some((x) => x.toLowerCase() === hecho.toLowerCase())) continue;
                        p.hechos.push(hecho);
                    }
                    if (p.hechos.length > MAX_HECHOS) p.hechos.splice(0, p.hechos.length - MAX_HECHOS);
                }

                const notas = limpiar(d.notas, 200);
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
            `Confianza: ${Math.round(p.cercania)}/100`
        ].filter(Boolean).join('\n');
    }

    async function olvidarPerfil(jid, chat) {
        perfiles.delete(jid);
        sucios.perfiles.delete(jid);
        await Perfil.deleteOne({ _id: jid });
        if (chat) {
            const g = await getGrupo(chat);
            g.recientes = g.recientes.filter((m) => m.j !== jid);
            sucios.grupos.add(chat);
        }
    }

    async function olvidarGrupo(chat) {
        grupos.delete(chat);
        sucios.grupos.delete(chat);
        await Grupo.deleteOne({ _id: chat });
    }

    return {
        registrarMensaje, tick, debeIntervenir, responder, actualizar, nombreDe,
        persistirTodo, verPerfil, olvidarPerfil, olvidarGrupo
    };
}
