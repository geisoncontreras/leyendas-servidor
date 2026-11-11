// Filtro de nombres para un juego de niños: 3 a 12 letras/números y sin groserías.
// La misma lista está en el juego (modules/online/name_filter.gd).
"use strict";

// Prohibidas en cualquier parte del nombre ("ElPutoAmo" → no).
const SUBCADENAS = [
  "puta", "puto", "mierda", "verga", "vrga", "pija", "polla", "chocho", "culia", "culiao",
  "joder", "jodid", "follar", "cojer", "mamon", "pendej", "pndj", "cabron", "maricon",
  "marica", "weon", "huevon", "gilipoll", "imbecil", "idiota", "estupid", "baboso",
  "nazi", "hitler", "sexo", "sexy", "porno", "xxx", "violar", "suicid", "droga",
  "marihuana", "chinga", "fuck", "shit", "bitch", "dick", "pussy", "cunt", "nigg", "porn", "rape",
];
// Prohibidas solo como palabra entera (así "Penélope" o "Pitón" sí valen).
const PALABRAS = [
  "pene", "culo", "cono", "pito", "caca", "pipi", "teta", "tetas", "perra", "zorra", "mamar",
  "matar", "tonto", "tonta", "coca", "coger", "chupa", "ass", "sex", "kill", "fag", "cock",
];

function normalizar(s) {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a")
    .replace(/5/g, "s").replace(/7/g, "t").replace(/@/g, "a").replace(/\$/g, "s")
    .replace(/[^a-z ]/g, "")
    .replace(/(.)\1+/g, "$1");   // "puuuta" → "puta"
}

function nombreValido(nombre) {
  if (typeof nombre !== "string") return false;
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 ]{3,12}$/.test(nombre)) return false;
  if (!/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(nombre)) return false;
  const n = normalizar(nombre);
  const junto = n.replace(/ /g, "");
  if (SUBCADENAS.some((p) => junto.includes(normalizar(p)))) return false;
  const palabras = n.split(" ").filter(Boolean);
  const malas = PALABRAS.map(normalizar);
  return !palabras.some((w) => malas.includes(w)) && !malas.includes(junto);
}

module.exports = { nombreValido, normalizar };
