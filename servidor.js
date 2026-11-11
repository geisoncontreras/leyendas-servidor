// Servidor del modo en línea de "Leyendas del Puño".
//
// Es el "cartero": guarda las salas, junta a los jugadores de la partida
// rápida, pasa los golpes de un teléfono al otro y cuenta las victorias del
// ranking. El juego se conecta por WebSocket (funciona en Android y en la
// versión web del iPhone).
//
// Mensajes (JSON, siempre con "t" = tipo):
//   cliente → servidor
//     hola        {pid, nombre, v}          identificarse (pid = id secreto del teléfono, v = versión del protocolo)
//     crear       {luchador, max}           crear sala privada (max 2, o 4 = los 4 a la vez) → "sala" {codigo, max}
//     unirse      {codigo, luchador}        entrar a una sala con su código
//     rapida      {luchador}                partida rápida con cualquiera que espere
//     cancelar    {}                        dejar de esperar
//     golpe       {q, tejas, dano}          mi golpe de esta ronda (calidad 0..1). Los dos golpean
//                                           A LA VEZ, cuando quieran; nadie puede ir más de una ronda
//                                           por delante del otro.
//     barras      {f, ...}                  cómo van mis barras (se reenvía tal cual al rival)
//     revancha    {}                        quiero la revancha
//     crear_torneo {luchador}               crear un torneo de 4 (los demás entran con "unirse" y su código)
//     salir       {}                        me voy de la partida (pierdo si estaba jugando)
//     ranking     {}                        pedir el ranking
//   servidor → cliente
//     bienvenida  {nombre, victorias}
//     error       {msg}
//     sala        {codigo}
//     empieza     {yo, primero, jugadores:[{nombre, luchador, victorias}]}
//     golpe       {lado, q, ronda}
//     barras      {f, ...}                  las barras del rival
//     revancha    {}                        el rival pide revancha
//     fin         {ganador, victorias:[v0, v1]}
//     rival_se_fue {}                        (duelo de 2)
//     sala4       {codigo, jugadores:[nombre]}  quién está en la sala de 4 esperando
//     jugador_se_fue {lado}                  alguien dejó la partida de 4
//     torneo      {codigo, estado, jugadores:[{nombre, luchador}], semis:[[i,j],[k,l]],
//                  ganadores:[i|-1, i|-1], campeon:i|-1, yo}   cómo va el torneo
//     empieza también trae {torneo: "semifinal"|"final"} si el duelo es del torneo
//     ranking     {top:[{puesto, nombre, luchador, victorias}], yo:{puesto, victorias}}
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { nombreValido } = require("./filtro");

const PUERTO = Number(process.env.PORT || 8080);
const ARCHIVO = process.env.DATOS || path.join(__dirname, "datos.json");
const RONDAS = 3;
const TEJAS = 8;
const TOP = 50;
/** Versión del protocolo: la 2 golpea a la vez (sin turnos). */
const PROTOCOLO = 2;   // el juego 3 además puede jugar entre 4

// --- Jugadores y ranking (se guardan en datos.json) --------------------------

/** pid → {nombre, victorias, jugadas, luchador} */
let perfiles = {};
try {
  perfiles = JSON.parse(fs.readFileSync(ARCHIVO, "utf8")).perfiles || {};
} catch (_) {
  perfiles = {};
}
let guardarPendiente = null;
function guardar() {
  if (guardarPendiente) return;
  guardarPendiente = setTimeout(() => {
    guardarPendiente = null;
    fs.writeFile(ARCHIVO, JSON.stringify({ perfiles }), () => {});
  }, 2000);
}

function ranking(pid) {
  const lista = Object.entries(perfiles)
    .filter(([, p]) => p.victorias > 0)
    .sort((a, b) => b[1].victorias - a[1].victorias || a[1].jugadas - b[1].jugadas);
  const top = lista.slice(0, TOP).map(([, p], i) => ({
    puesto: i + 1, nombre: p.nombre, luchador: p.luchador, victorias: p.victorias,
  }));
  const i = lista.findIndex(([id]) => id === pid);
  const yo = { puesto: i >= 0 ? i + 1 : 0, victorias: perfiles[pid] ? perfiles[pid].victorias : 0 };
  return { t: "ranking", top, yo };
}

// --- Salas -------------------------------------------------------------------

/** codigo → sala. Una sala: {codigo, privada, jugadores:[ws, ws], estado, ...} */
const salas = new Map();
/** Sala pública esperando a su segundo jugador (partida rápida). */
let esperandoRapida = null;

/** codigo → torneo de 4: {codigo, jugadores:[ws...], estado, semis, ganadores, campeon, fuera:Set} */
const torneos = new Map();
/** Segundos entre el fin de las semifinales y el inicio de la final. */
const PAUSA_FINAL = Number(process.env.PAUSA_FINAL || 6);

function nuevoCodigo() {
  for (;;) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!salas.has(c) && !torneos.has(c)) return c;
  }
}

function enviar(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function crearSala(ws, privada, max = 2) {
  const sala = { codigo: nuevoCodigo(), privada, max, jugadores: [ws], estado: "esperando", revancha: [false, false], fuera: new Set() };
  salas.set(sala.codigo, sala);
  ws.sala = sala;
  return sala;
}

function empezar(sala) {
  const n = sala.jugadores.length;
  sala.estado = "jugando";
  sala.cuenta = Array(n).fill(0);
  sala.tejas = Array(n).fill(0);
  sala.dano = Array(n).fill(0);
  sala.revancha = Array(n).fill(false);
  sala.fuera = new Set();
  sala.primero = Math.random() < 0.5 ? 0 : 1;   // el que empieza, al azar
  const jugadores = sala.jugadores.map((w) => ({
    nombre: w.perfil.nombre, luchador: w.luchador, victorias: w.perfil.victorias,
  }));
  sala.jugadores.forEach((w, i) => enviar(w, { t: "empieza", yo: i, primero: sala.primero, jugadores, torneo: sala.fase || null }));
}

function terminar(sala, ganador) {
  sala.estado = "fin";
  sala.jugadores.forEach((w) => {
    w.perfil.jugadas += 1;
    w.perfil.luchador = w.luchador;
  });
  if (ganador >= 0) {
    sala.jugadores[ganador].perfil.victorias += 1;
    if (sala.jugadores.length > 2) sala.jugadores[ganador].perfil.victorias += 1;   // ganar entre 4 vale doble
  }
  guardar();
  const victorias = sala.jugadores.map((w) => w.perfil.victorias);
  sala.jugadores.forEach((w) => enviar(w, { t: "fin", ganador, victorias }));
  if (sala.torneo) {
    // En el torneo siempre hay un ganador: si empatan del todo, a la suerte.
    duelosDelTorneo(sala.torneo, sala, ganador >= 0 ? ganador : (Math.random() < 0.5 ? 0 : 1));
  }
}

// --- Torneo de 4 -------------------------------------------------------------
// 4 jugadores entran con el mismo código. Al llegar el 4º se sortean las dos
// semifinales, que se juegan a la vez. Los ganadores juegan la final y el
// campeón gana una victoria extra para el ranking. Si alguien se va, su rival
// pasa directo.

function estadoTorneo(t) {
  const idx = (w) => t.jugadores.indexOf(w);
  const base = {
    t: "torneo", codigo: t.codigo, estado: t.estado,
    jugadores: t.jugadores.map((w) => ({ nombre: w.perfil.nombre, luchador: w.luchador, fuera: t.fuera.has(w) })),
    semis: t.semis ? t.semis.map((par) => par.map(idx)) : null,
    ganadores: t.ganadores.map((w) => (w ? idx(w) : -1)),
    campeon: t.campeon ? idx(t.campeon) : -1,
  };
  t.jugadores.forEach((w, i) => enviar(w, { ...base, yo: i }));
}

function crearTorneo(ws) {
  const t = { codigo: nuevoCodigo(), jugadores: [ws], estado: "esperando", semis: null, ganadores: [null, null], campeon: null, fuera: new Set() };
  torneos.set(t.codigo, t);
  ws.torneo = t;
  estadoTorneo(t);
}

function empezarTorneo(t) {
  t.estado = "semifinales";
  const j = t.jugadores.slice().sort(() => Math.random() - 0.5);
  t.semis = [[j[0], j[1]], [j[2], j[3]]];
  estadoTorneo(t);
  t.semis.forEach((par, i) => duelo(t, par, "semifinal", i));
}

function duelo(t, par, fase, idx) {
  // Si alguien ya no está, el otro pasa sin jugar.
  const vivos = par.filter((w) => !t.fuera.has(w) && w.readyState === 1);
  if (vivos.length < 2) {
    const g = vivos[0] || par[0];
    return avanzar(t, fase, idx, g);
  }
  const sala = { codigo: "t" + t.codigo + fase + idx, privada: false, jugadores: par.slice(), estado: "esperando",
    revancha: [false, false], torneo: t, fase, idx };
  par.forEach((w) => { w.sala = sala; });
  setTimeout(() => {
    if (par.some((w) => w.sala !== sala)) return;
    empezar(sala);
  }, 1500);
}

function duelosDelTorneo(t, sala, ganador) {
  avanzar(t, sala.fase, sala.idx, sala.jugadores[ganador]);
}

function avanzar(t, fase, idx, ganador) {
  if (fase === "semifinal") {
    if (t.ganadores[idx]) return;
    t.ganadores[idx] = ganador;
    estadoTorneo(t);
    if (t.ganadores[0] && t.ganadores[1]) {
      t.estado = "final";
      setTimeout(() => {
        estadoTorneo(t);
        duelo(t, t.ganadores.slice(), "final", 0);
      }, PAUSA_FINAL * 1000);
    }
  } else if (fase === "final" && !t.campeon) {
    t.campeon = ganador;
    t.estado = "fin";
    ganador.perfil.victorias += 1;     // premio extra del campeón
    ganador.perfil.coronas = (ganador.perfil.coronas || 0) + 1;
    guardar();
    estadoTorneo(t);
    setTimeout(() => torneos.delete(t.codigo), 60000);
  }
}

/** El jugador deja su torneo (salir o se cortó internet). */
function dejarTorneo(ws) {
  const t = ws.torneo;
  if (!t) return;
  ws.torneo = null;
  if (t.estado === "esperando") {
    t.jugadores.splice(t.jugadores.indexOf(ws), 1);
    if (t.jugadores.length === 0) torneos.delete(t.codigo);
    else estadoTorneo(t);
    return;
  }
  t.fuera.add(ws);
  // Si esperaba la final, su rival será campeón al empezarla.
  if (t.estado === "final" && t.ganadores.includes(ws) && !(ws.sala && ws.sala.estado === "jugando")) {
    const otro = t.ganadores.find((w) => w !== ws);
    if (!t.campeon && otro && !(otro.sala && otro.sala.fase === "final")) avanzar(t, "final", 0, otro);
  }
  if (t.jugadores.every((w) => t.fuera.has(w))) torneos.delete(t.codigo);
  else estadoTorneo(t);
}

/** El jugador ws se va de su sala (salir, cancelar o se cortó internet). */
function abandonar(ws) {
  const sala = ws.sala;
  if (!sala) return;
  ws.sala = null;
  if (esperandoRapida === sala) esperandoRapida = null;
  const yo = sala.jugadores.indexOf(ws);
  if (sala.max > 2) return abandonarSala4(sala, ws, yo);
  const otro = sala.jugadores[1 - yo];
  if (sala.estado === "jugando" && otro) {
    // Gana el que se queda.
    terminar(sala, 1 - yo);
  } else if (sala.torneo && sala.estado === "esperando" && otro) {
    // Se fue justo antes de su duelo del torneo: el otro pasa.
    avanzar(sala.torneo, sala.fase, sala.idx, otro);
  }
  // Ojo: el otro puede estar ya en otra sala (no hay que sacarlo de ahí).
  if (otro && otro.sala === sala) {
    enviar(otro, { t: "rival_se_fue" });
    otro.sala = null;
  }
  salas.delete(sala.codigo);
}

/** Alguien deja la partida de 4: los demás siguen; si queda uno, gana. */
function abandonarSala4(sala, ws, yo) {
  if (sala.estado === "esperando") {
    sala.jugadores.splice(yo, 1);
    if (sala.jugadores.length === 0) salas.delete(sala.codigo);
    else avisarSala4(sala);
    return;
  }
  sala.fuera.add(ws);
  sala.jugadores.forEach((w) => { if (w !== ws) enviar(w, { t: "jugador_se_fue", lado: yo }); });
  const activos = sala.jugadores.filter((w) => !sala.fuera.has(w));
  if (activos.length === 0) { salas.delete(sala.codigo); return; }
  if (sala.estado === "jugando") {
    if (activos.length === 1) terminar(sala, sala.jugadores.indexOf(activos[0]));
    else comprobarFin(sala);
  }
}

function avisarSala4(sala) {
  const jugadores = sala.jugadores.map((w) => w.perfil.nombre);
  sala.jugadores.forEach((w) => enviar(w, { t: "sala4", codigo: sala.codigo, jugadores }));
}

/** ¿Ya golpearon todos los que siguen en la partida sus 3 veces? Gana quien rompió más. */
function comprobarFin(sala) {
  const activos = sala.jugadores.map((w, i) => i).filter((i) => !sala.fuera.has(sala.jugadores[i]));
  if (!activos.every((i) => sala.cuenta[i] >= RONDAS)) return;
  let ganador = -1;
  let mejor = null;
  let empate = false;
  for (const i of activos) {
    const k = [sala.tejas[i], sala.dano[i]];
    if (mejor === null || k[0] > mejor[0] || (k[0] === mejor[0] && k[1] > mejor[1] + 1e-6)) {
      mejor = k; ganador = i; empate = false;
    } else if (k[0] === mejor[0] && Math.abs(k[1] - mejor[1]) <= 1e-6) {
      empate = true;
    }
  }
  terminar(sala, empate ? -1 : ganador);
}

function salirDeTodo(ws) {
  abandonar(ws);
  dejarTorneo(ws);
}

// --- Mensajes ----------------------------------------------------------------

function alRecibir(ws, msg) {
  if (msg.t !== "hola" && !ws.perfil) {
    enviar(ws, { t: "error", msg: "Primero di hola" });
    return;
  }
  switch (msg.t) {
    case "hola": {
      const pid = String(msg.pid || "");
      const nombre = String(msg.nombre || "").trim();
      if (!/^[a-f0-9]{16,64}$/.test(pid)) return enviar(ws, { t: "error", msg: "Teléfono no reconocido" });
      ws.v = Number(msg.v || 1);
      if (Number(msg.v || 1) < PROTOCOLO) {
        return enviar(ws, { t: "error", msg: "Hay una versión nueva del juego. Actualízalo para jugar en línea.", actualizar: true });
      }
      if (!nombreValido(nombre)) return enviar(ws, { t: "error", msg: "Ese nombre no se puede usar. Prueba con otro." });
      const p = perfiles[pid] || { victorias: 0, jugadas: 0, luchador: "zorro" };
      p.nombre = nombre;
      perfiles[pid] = p;
      ws.pid = pid;
      ws.perfil = p;
      guardar();
      return enviar(ws, { t: "bienvenida", nombre, victorias: p.victorias });
    }
    case "crear": {
      salirDeTodo(ws);
      ws.luchador = String(msg.luchador || "zorro").slice(0, 24);
      const max = Number(msg.max) === 4 ? 4 : 2;
      const sala = crearSala(ws, true, max);
      enviar(ws, { t: "sala", codigo: sala.codigo, max });
      if (max === 4) avisarSala4(sala);
      return;
    }
    case "crear_torneo": {
      salirDeTodo(ws);
      ws.luchador = String(msg.luchador || "zorro").slice(0, 24);
      return crearTorneo(ws);
    }
    case "unirse": {
      const t = torneos.get(String(msg.codigo || ""));
      if (t) {
        if (t.estado !== "esperando" || t.jugadores.length >= 4 || t.jugadores.includes(ws)) {
          return enviar(ws, { t: "error", msg: "Ese torneo ya empezó o está lleno." });
        }
        salirDeTodo(ws);
        ws.luchador = String(msg.luchador || "zorro").slice(0, 24);
        t.jugadores.push(ws);
        ws.torneo = t;
        estadoTorneo(t);
        if (t.jugadores.length === 4) setTimeout(() => { if (t.jugadores.length === 4 && t.estado === "esperando") empezarTorneo(t); }, 2500);
        return;
      }
      const sala = salas.get(String(msg.codigo || ""));
      if (!sala || !sala.privada || sala.estado !== "esperando" || sala.jugadores.length >= sala.max || sala.jugadores.includes(ws)) {
        return enviar(ws, { t: "error", msg: "No encontré esa sala. Revisa el código." });
      }
      if (sala.max > 2 && (ws.v || 2) < 3) {
        return enviar(ws, { t: "error", msg: "Para jugar entre 4 hay que actualizar el juego." });
      }
      salirDeTodo(ws);
      ws.luchador = String(msg.luchador || "zorro").slice(0, 24);
      sala.jugadores.push(ws);
      ws.sala = sala;
      if (sala.max > 2) avisarSala4(sala);
      if (sala.jugadores.length === sala.max) {
        if (sala.max > 2) setTimeout(() => { if (sala.estado === "esperando" && sala.jugadores.length === sala.max) empezar(sala); }, 1500);
        else empezar(sala);
      }
      return;
    }
    case "rapida": {
      salirDeTodo(ws);
      ws.luchador = String(msg.luchador || "zorro").slice(0, 24);
      const sala = esperandoRapida;
      if (sala && sala.jugadores.length === 1 && sala.jugadores[0].readyState === 1) {
        esperandoRapida = null;
        sala.jugadores.push(ws);
        ws.sala = sala;
        return empezar(sala);
      }
      esperandoRapida = crearSala(ws, false);
      return enviar(ws, { t: "buscando" });
    }
    case "cancelar":
    case "salir":
      return salirDeTodo(ws);
    case "golpe": {
      const sala = ws.sala;
      if (!sala || sala.estado !== "jugando") return;
      const lado = sala.jugadores.indexOf(ws);
      if (sala.fuera.has(ws)) return;
      // Ya golpeó en esta ronda y alguien todavía no: espera.
      const minimo = Math.min(...sala.jugadores.map((w, i) => (sala.fuera.has(w) ? RONDAS : sala.cuenta[i])));
      if (sala.cuenta[lado] >= RONDAS || sala.cuenta[lado] > minimo) return;
      const ronda = sala.cuenta[lado];
      sala.cuenta[lado] += 1;
      const q = Math.min(Math.max(Number(msg.q) || 0, 0), 1);
      sala.tejas[lado] += Math.min(Math.max(Math.floor(Number(msg.tejas) || 0), 0), TEJAS);
      sala.dano[lado] += Math.max(Number(msg.dano) || 0, 0);
      sala.jugadores.forEach((w) => enviar(w, { t: "golpe", lado, q, ronda }));
      if (sala.max > 2) return comprobarFin(sala);
      if (sala.cuenta[0] >= RONDAS && sala.cuenta[1] >= RONDAS) {
        const [a, b] = sala.tejas;
        let ganador = -1;
        if (a !== b) ganador = a > b ? 0 : 1;
        else if (Math.abs(sala.dano[0] - sala.dano[1]) > 1e-6) ganador = sala.dano[0] > sala.dano[1] ? 0 : 1;
        terminar(sala, ganador);
      }
      return;
    }
    case "barras": {
      const sala = ws.sala;
      if (!sala || sala.estado !== "jugando") return;
      const lado = sala.jugadores.indexOf(ws);
      const f = Math.floor(Number(msg.f) || 0);
      const v = Math.min(Math.max(Number(msg.v) || 0, 0), 1);
      const hz = Math.min(Math.max(Number(msg.hz) || 0, 0), 3);
      sala.jugadores.forEach((w, i) => { if (i !== lado) enviar(w, { t: "barras", f, v, hz, lado }); });
      return;
    }
    case "revancha": {
      const sala = ws.sala;
      if (!sala || sala.torneo || sala.estado !== "fin" || sala.fuera.size > 0) return;
      const lado = sala.jugadores.indexOf(ws);
      sala.revancha[lado] = true;
      if (sala.revancha.every(Boolean)) return empezar(sala);
      sala.jugadores.forEach((w, i) => { if (i !== lado) enviar(w, { t: "revancha", lado }); });
      return;
    }
    case "ranking":
      return enviar(ws, ranking(ws.pid));
    default:
      return;
  }
}

// --- Arranque ----------------------------------------------------------------

const servidor = http.createServer((req, res) => {
  // Página simple para comprobar que el servidor está encendido.
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`Leyendas del Puño · servidor en línea OK · ${wss.clients.size} conectados\n`);
});
const wss = new WebSocketServer({ server: servidor, maxPayload: 4096 });

wss.on("connection", (ws) => {
  ws.vivo = true;
  ws.on("pong", () => { ws.vivo = true; });
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (_) { return; }
    if (msg && typeof msg.t === "string") alRecibir(ws, msg);
  });
  ws.on("close", () => salirDeTodo(ws));
});

// Cada 20 s: los que no responden se dan por desconectados (y el proxy no
// cierra las conexiones tranquilas).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.vivo) { ws.terminate(); continue; }
    ws.vivo = false;
    ws.ping();
  }
}, 20000);

servidor.listen(PUERTO, () => console.log(`Servidor de Leyendas del Puño en el puerto ${PUERTO}`));
