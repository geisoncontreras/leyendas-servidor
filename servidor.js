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
//     crear       {luchador}                crear sala privada → recibe "sala" {codigo}
//     unirse      {codigo, luchador}        entrar a una sala con su código
//     rapida      {luchador}                partida rápida con cualquiera que espere
//     cancelar    {}                        dejar de esperar
//     golpe       {q, tejas, dano}          mi golpe de esta ronda (calidad 0..1). Los dos golpean
//                                           A LA VEZ, cuando quieran; nadie puede ir más de una ronda
//                                           por delante del otro.
//     barras      {f, ...}                  cómo van mis barras (se reenvía tal cual al rival)
//     revancha    {}                        quiero la revancha
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
//     rival_se_fue {}
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
const PROTOCOLO = 2;

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

function nuevoCodigo() {
  for (;;) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!salas.has(c)) return c;
  }
}

function enviar(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function crearSala(ws, privada) {
  const sala = { codigo: nuevoCodigo(), privada, jugadores: [ws], estado: "esperando", revancha: [false, false] };
  salas.set(sala.codigo, sala);
  ws.sala = sala;
  return sala;
}

function empezar(sala) {
  sala.estado = "jugando";
  sala.cuenta = [0, 0];
  sala.tejas = [0, 0];
  sala.dano = [0, 0];
  sala.revancha = [false, false];
  sala.primero = Math.random() < 0.5 ? 0 : 1;   // el que empieza, al azar
  const jugadores = sala.jugadores.map((w) => ({
    nombre: w.perfil.nombre, luchador: w.luchador, victorias: w.perfil.victorias,
  }));
  sala.jugadores.forEach((w, i) => enviar(w, { t: "empieza", yo: i, primero: sala.primero, jugadores }));
}

function terminar(sala, ganador) {
  sala.estado = "fin";
  sala.jugadores.forEach((w) => {
    w.perfil.jugadas += 1;
    w.perfil.luchador = w.luchador;
  });
  if (ganador >= 0) sala.jugadores[ganador].perfil.victorias += 1;
  guardar();
  const victorias = sala.jugadores.map((w) => w.perfil.victorias);
  sala.jugadores.forEach((w) => enviar(w, { t: "fin", ganador, victorias }));
}

/** El jugador ws se va de su sala (salir, cancelar o se cortó internet). */
function abandonar(ws) {
  const sala = ws.sala;
  if (!sala) return;
  ws.sala = null;
  if (esperandoRapida === sala) esperandoRapida = null;
  const yo = sala.jugadores.indexOf(ws);
  const otro = sala.jugadores[1 - yo];
  if (sala.estado === "jugando" && otro) {
    // Gana el que se queda.
    terminar(sala, 1 - yo);
  }
  if (otro) {
    enviar(otro, { t: "rival_se_fue" });
    otro.sala = null;
  }
  salas.delete(sala.codigo);
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
      abandonar(ws);
      ws.luchador = String(msg.luchador || "zorro").slice(0, 24);
      const sala = crearSala(ws, true);
      return enviar(ws, { t: "sala", codigo: sala.codigo });
    }
    case "unirse": {
      const sala = salas.get(String(msg.codigo || ""));
      if (!sala || !sala.privada || sala.jugadores.length !== 1 || sala.jugadores[0] === ws) {
        return enviar(ws, { t: "error", msg: "No encontré esa sala. Revisa el código." });
      }
      abandonar(ws);
      ws.luchador = String(msg.luchador || "zorro").slice(0, 24);
      sala.jugadores.push(ws);
      ws.sala = sala;
      return empezar(sala);
    }
    case "rapida": {
      abandonar(ws);
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
      return abandonar(ws);
    case "golpe": {
      const sala = ws.sala;
      if (!sala || sala.estado !== "jugando") return;
      const lado = sala.jugadores.indexOf(ws);
      // Ya golpeó en esta ronda y el rival todavía no: espera.
      if (sala.cuenta[lado] >= RONDAS || sala.cuenta[lado] > sala.cuenta[1 - lado]) return;
      const ronda = sala.cuenta[lado];
      sala.cuenta[lado] += 1;
      const q = Math.min(Math.max(Number(msg.q) || 0, 0), 1);
      sala.tejas[lado] += Math.min(Math.max(Math.floor(Number(msg.tejas) || 0), 0), TEJAS);
      sala.dano[lado] += Math.max(Number(msg.dano) || 0, 0);
      sala.jugadores.forEach((w) => enviar(w, { t: "golpe", lado, q, ronda }));
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
      return enviar(sala.jugadores[1 - lado], { t: "barras", f, v, hz });
    }
    case "revancha": {
      const sala = ws.sala;
      if (!sala || sala.estado !== "fin" || sala.jugadores.length !== 2) return;
      const lado = sala.jugadores.indexOf(ws);
      sala.revancha[lado] = true;
      if (sala.revancha[0] && sala.revancha[1]) return empezar(sala);
      return enviar(sala.jugadores[1 - lado], { t: "revancha" });
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
  ws.on("close", () => abandonar(ws));
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
