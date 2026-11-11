// Prueba automática del servidor: dos jugadores falsos juegan un duelo
// completo por código, piden revancha, prueban la partida rápida, el filtro
// de nombres, el abandono y el ranking.  Uso: npm test
"use strict";
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const PUERTO = 18080 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [path.join(__dirname, "servidor.js")], {
  env: { ...process.env, PORT: String(PUERTO), DATOS: path.join(os.tmpdir(), `lp_${PUERTO}.json`) },
  stdio: "inherit",
});

function cliente(nombre) {
  const ws = new WebSocket(`ws://127.0.0.1:${PUERTO}`);
  const cola = [];
  const esperas = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    const i = esperas.findIndex((e) => e.t === m.t);
    if (i >= 0) esperas.splice(i, 1)[0].ok(m); else cola.push(m);
  });
  const c = {
    ws,
    pid: [...Array(32)].map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""),
    enviar: (m) => ws.send(JSON.stringify(m)),
    esperar: (t) => new Promise((ok, mal) => {
      const i = cola.findIndex((m) => m.t === t);
      if (i >= 0) return ok(cola.splice(i, 1)[0]);
      esperas.push({ t, ok });
      setTimeout(() => mal(new Error(`${nombre}: no llegó "${t}"`)), 3000);
    }),
  };
  return new Promise((ok) => ws.on("open", () => ok(c)));
}

function comprobar(cond, texto) {
  if (!cond) throw new Error("FALLA: " + texto);
  console.log("  ✓ " + texto);
}

async function duelo(a, b, empiezaA, empiezaB, qa, qb) {
  // a y b ya recibieron "empieza"; juegan los 6 golpes en el orden del servidor.
  const primero = empiezaA.primero;
  for (let n = 0; n < 6; n++) {
    const lado = (primero + Math.floor(n / 2) + (n % 2)) % 2;
    const quien = lado === empiezaA.yo ? a : b;
    const q = lado === empiezaA.yo ? qa : qb;
    quien.enviar({ t: "golpe", q, tejas: Math.round(q * 8), dano: q * 100 });
    const ga = await a.esperar("golpe");
    const gb = await b.esperar("golpe");
    if (ga.lado !== lado || gb.lado !== lado || ga.q !== q) throw new Error("golpe mal repartido");
  }
  return [await a.esperar("fin"), await b.esperar("fin")];
}

(async () => {
  await new Promise((r) => setTimeout(r, 500));
  console.log("Prueba del servidor:");
  const a = await cliente("A");
  const b = await cliente("B");

  a.enviar({ t: "hola", pid: a.pid, nombre: "Pendejo" });
  comprobar((await a.esperar("error")).msg.includes("nombre"), "rechaza nombres groseros");
  a.enviar({ t: "hola", pid: a.pid, nombre: "Geison" });
  comprobar((await a.esperar("bienvenida")).nombre === "Geison", "acepta el nombre Geison");
  b.enviar({ t: "hola", pid: b.pid, nombre: "Zorro Rayo" });
  await b.esperar("bienvenida");

  // Sala con código
  a.enviar({ t: "crear", luchador: "zorro" });
  const { codigo } = await a.esperar("sala");
  comprobar(/^\d{4}$/.test(codigo), `crea sala con código ${codigo}`);
  b.enviar({ t: "unirse", codigo: "0000", luchador: "panda" });
  comprobar((await b.esperar("error")).msg.includes("código"), "código equivocado da error");
  b.enviar({ t: "unirse", codigo, luchador: "panda" });
  let ea = await a.esperar("empieza");
  let eb = await b.esperar("empieza");
  comprobar(ea.yo !== eb.yo && ea.primero === eb.primero, "los dos reciben el inicio");
  comprobar(ea.jugadores[eb.yo].nombre === "Zorro Rayo", "A ve el nombre de su rival");

  // B golpea fuera de turno: se ignora
  const fuera = ea.primero === ea.yo ? b : a;
  fuera.enviar({ t: "golpe", q: 1, tejas: 8, dano: 999 });

  let [fa, fb] = await duelo(a, b, ea, eb, 0.95, 0.4);
  comprobar(fa.ganador === ea.yo && fb.ganador === ea.yo, "gana el que rompió más tejas");
  comprobar(fa.victorias[ea.yo] === 1, "se suma la victoria");

  // Revancha
  b.enviar({ t: "revancha" });
  await a.esperar("revancha");
  a.enviar({ t: "revancha" });
  ea = await a.esperar("empieza");
  eb = await b.esperar("empieza");
  comprobar(true, "revancha empieza cuando los dos la piden");
  [fa] = await duelo(a, b, ea, eb, 0.3, 0.9);
  comprobar(fa.ganador === eb.yo, "en la revancha gana B");

  // Partida rápida + abandono
  a.enviar({ t: "rapida", luchador: "zorro" });
  await a.esperar("buscando");
  b.enviar({ t: "rapida", luchador: "toro" });
  ea = await a.esperar("empieza");
  await b.esperar("empieza");
  comprobar(ea.jugadores.length === 2, "partida rápida junta a los dos");
  b.enviar({ t: "salir" });
  fa = await a.esperar("fin");
  await a.esperar("rival_se_fue");
  comprobar(fa.ganador === ea.yo, "si el rival se va, ganas tú");

  // Ranking
  a.enviar({ t: "ranking" });
  const r = await a.esperar("ranking");
  comprobar(r.top[0].nombre === "Geison" && r.top[0].victorias === 2 && r.yo.puesto === 1, "ranking: Geison 1º con 2 victorias");
  comprobar(r.top[1].nombre === "Zorro Rayo" && r.top[1].victorias === 1, "ranking: Zorro Rayo 2º con 1 victoria");

  console.log("TODO BIEN");
  a.ws.close(); b.ws.close(); srv.kill();
  process.exit(0);
})().catch((e) => { console.error(e.message); srv.kill(); process.exit(1); });
