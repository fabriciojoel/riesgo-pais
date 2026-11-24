// Réplica del riesgo país: spread del subíndice Argentina del J.P. Morgan EMBI Global Diversified.
// Módulo puro (sin DOM ni red): lo usa la pantalla #/riesgo-pais (js/riesgopais.js) y puede usarlo
// una función programada en Node. Metodología investigada y validada el 20/11/2026 contra la serie
// oficial (backtest 2/1/2025–19/11/2026, 453 ruedas: error típico 7–8 pb, RMSE 11 pb desde el 4/9/2026):
//   - Bonos: solo los 6 Globales ley Nueva York. La guía de J.P. Morgan dice "Local law instruments are
//     not eligible": Bonares, AE38, AN29/AO27/AO28/AO29 y BOPREAL no entran al EMBI.
//   - Precio: dólar CABLE = precio en pesos ÷ CCL implícito (promedio AL30/AL30C y GD30/GD30C). J.P.
//     Morgan usa el precio del mercado internacional; con el MEP (línea D) la réplica quedaba hasta
//     140 pb abajo cuando se abrió la brecha CCL/MEP (6% en nov-2026).
//   - Spread por bono: Z-spread = spread constante sobre la curva CERO del Tesoro de EE.UU. que lleva el
//     valor presente de los flujos al precio sucio (definición de "Spread (to worst)" de J.P. Morgan).
//     La curva cero sale por bootstrap semestral de la curva par (CMT); hasta 1 año, par = cero (letras).
//   - País: promedio de los Z-spreads ponderado por valor de mercado × duration de spread (forma que
//     J.P. Morgan publica desde principios de septiembre de 2026). Ponderar solo por valor de mercado
//     sobrepondera a los bonos cortos (RMSE 22 pb vs 11).
// Convenciones (las mismas del prototipo en Python que dio esos números): flujos por 100 de VN original
// (construirFlujo de flujo.js), liquidación T+1 hábil, tiempo = días corridos / 365,25, capitalización
// semestral tanto en la curva como en el spread.

import { construirFlujo } from "./flujo.js";

export const GLOBALES = ["GD29", "GD30", "GD35", "GD38", "GD41", "GD46"];

// VN ORIGINAL en circulación (USD), neto de recompras. Las amortizaciones las descuenta el cronograma
// (el precio de BYMA es por 100 de VN original). Fuente: mercadosargentina.com.ar (emisión por canje del
// 4/9/2020 y eventos de recompra). Revisar si hay recompras o un Global nuevo (rebalanceo de fin de mes).
export const VN_ORIGINAL = {
  GD29: 2620524443,    // 2.635.028.874 emitido − 14.504.431 recompra 2023
  GD30: 13587430959,   // 16.090.612.138 − 1.516.892.647 (2023) − 986.288.532 (2025)
  GD35: 20501717804,
  GD38: 11405065289,
  GD41: 10482111279,
  GD46: 2091997126,
};

// Pares para el CCL implícito: precio en pesos ÷ precio en la línea C (cable) del mismo bono.
export const PARES_CCL = ["AL30", "GD30"];

// Cambios del índice (para marcar en los gráficos y explicar la serie oficial).
export const EVENTOS = [
  { fecha: "2025-09-30", texto: "Pasa al EMBIGD" },
  { fecha: "2026-09-04", texto: "Pondera por duration" },
];

const ANIO = 365.25 * 86400000;

function interp(pts, t) {
  if (t <= pts[0][0]) return pts[0][1];
  const n = pts.length;
  if (t >= pts[n - 1][0]) return pts[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (t <= pts[i][0]) {
      const [t0, y0] = pts[i - 1], [t1, y1] = pts[i];
      return y0 + (y1 - y0) * (t - t0) / (t1 - t0);
    }
  }
  return pts[n - 1][1];
}

/**
 * Curva cero del Tesoro desde la curva par.
 * @param par [[plazo en años, rendimiento en DECIMAL]] (1 mes a 30 años, en cualquier orden)
 */
export function curvaCero(par) {
  const p = par.filter(([t, y]) => t > 0 && Number.isFinite(y)).sort((a, b) => a[0] - b[0]);
  if (p.length < 3) throw new Error("curva del Tesoro incompleta");
  const cero = p.filter(([t]) => t <= 1);
  const df = [];
  for (let n = 1; n <= 60; n++) {          // 0,5 a 30 años
    const t = n / 2;
    if (t <= 1) { df[n] = Math.pow(1 + interp(p, t) / 2, -2 * t); continue; }
    const c = interp(p, t);
    let suma = 0;
    for (let k = 1; k < n; k++) suma += df[k];
    df[n] = (1 - (c / 2) * suma) / (1 + c / 2);
    cero.push([t, 2 * (Math.pow(df[n], -1 / (2 * t)) - 1)]);
  }
  cero.sort((a, b) => a[0] - b[0]);
  return { par: p, cero, z: (t) => interp(cero, t), parEn: (t) => interp(p, t) };
}

function resolver(f, lo, hi, tol = 1e-10) {
  let flo = f(lo);
  if (flo * f(hi) > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (Math.abs(fm) < tol) return mid;
    if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/** Flujos posteriores a la liquidación: [{t (años), cf, amort, residualPrevio, fecha}] por 100 de VN original. */
export function flujosFuturos(terminos, liq) {
  return construirFlujo(terminos)
    .filter((f) => f.dt > liq)
    .map((f) => ({ t: (f.dt - liq) / ANIO, cf: f.flujo, amort: f.amort, residualPrevio: f.residualPrevio, fecha: f.dt }));
}

/**
 * Métricas de un bono a un precio sucio (por 100 de VN original, en dólares cable).
 * zspread, tir y las diferencias van en DECIMAL (0,1 = 1.000 pb); dur en años.
 */
export function analizarBono(tick, terminos, sucio, curva, liq) {
  const fl = flujosFuturos(terminos, liq);
  if (!fl.length || !(sucio > 0)) return null;
  const zs = fl.map((f) => curva.z(f.t));
  const vp = (s) => { let v = 0; for (let i = 0; i < fl.length; i++) v += fl[i].cf * Math.pow(1 + (zs[i] + s) / 2, -2 * fl[i].t); return v; };
  const zspread = resolver((s) => vp(s) - sucio, -0.05, 3);
  if (!Number.isFinite(zspread)) return null;
  const tir = resolver((y) => { let v = 0; for (const f of fl) v += f.cf * Math.pow(1 + y / 2, -2 * f.t); return v - sucio; }, -0.05, 5);
  const bp = 1e-4;
  const dur = -(vp(zspread + bp) - vp(zspread - bp)) / (2 * bp * sucio);
  const am = fl.reduce((s, f) => s + f.amort, 0);
  const vidaMedia = am ? fl.reduce((s, f) => s + f.t * f.amort, 0) / am : 0;
  const ult = fl[fl.length - 1];
  return {
    tick, sucio, zspread, tir, dur, vidaMedia,
    residual: fl[0].residualPrevio,                 // capital vigente (por 100 de VN original)
    ispread: tir - curva.parEn(ult.t),              // spread de rendimiento contra el Tesoro al vencimiento
    vto: ult.fecha,
  };
}

/**
 * Agregación del país. `bonos` = resultados de analizarBono.
 * rp = VM × duration (la réplica); rpVM = solo valor de mercado (comparación). En pb.
 */
export function agregar(bonos, vn = VN_ORIGINAL) {
  const vm = bonos.map((b) => vn[b.tick] * b.sucio / 100);
  const totVM = vm.reduce((s, v) => s + v, 0);
  const wd = bonos.map((b, i) => vm[i] * b.dur);
  const totWD = wd.reduce((s, v) => s + v, 0);
  const detalle = bonos.map((b, i) => ({
    ...b,
    vmUSD: vm[i],
    peso: vm[i] / totVM,
    pesoEfectivo: wd[i] / totWD,
    aporte: (wd[i] / totWD) * b.zspread * 1e4,
  }));
  return {
    rp: detalle.reduce((s, b) => s + b.aporte, 0),
    rpVM: bonos.reduce((s, b, i) => s + vm[i] * b.zspread, 0) / totVM * 1e4,
    durMedia: wd.reduce((s, v) => s + v, 0) / totVM,   // duration promedio por VM (regla práctica: 1% de precio ≈ 100/durMedia pb)
    vmTotal: totVM,
    bonos: detalle,
  };
}

/**
 * CCL implícito de los pares líquidos. `px(sim)` devuelve el precio de un símbolo o null.
 * Devuelve { valor, pares: [{par, valor}] } o null si no hay ningún par con los dos precios.
 */
export function cclImplicito(px, pares = PARES_CCL) {
  const out = [];
  for (const base of pares) {
    const pesos = px(base), cable = px(base + "C");
    if (pesos > 0 && cable > 0) out.push({ par: base, valor: pesos / cable });
  }
  if (!out.length) return null;
  return { valor: out.reduce((s, p) => s + p.valor, 0) / out.length, pares: out };
}

/**
 * Precio en pesos de cada Global, en este orden (pedido de Fabricio, 24/11/2026):
 *   1. el de pesos en vivo (operado hoy o punta media razonable);
 *   2. si no hay, el de la línea C (cable): su precio operado hoy o, si no operó, su punta compradora
 *      (la que usa J.P. Morgan para valuar el índice), pasado a pesos con el CCL implícito (C × CCL);
 *   3. si tampoco hay un dato firme, el cierre anterior en pesos.
 * En pesos, una sola punta o puntas separadas más de un 5% no cuentan como precio en vivo. En la línea C, la
 * punta compradora tampoco cuenta si está más de un 5% abajo de su último precio (una oferta perdida no es precio).
 * @param q    Map símbolo → {last, bid, tipo, operado, soloPunta, cierre} (precioData912 de data912 /live/arg_bonds)
 * @param ccl  pesos por dólar cable (cclImplicito)
 * @returns {pesos: {GD29: …}, origen: {GD29: "operado" | "línea C …" | "cierre anterior …"}}
 */
export function preciosGlobales(q, ccl) {
  const vivo = (s) => { const x = q.get(s); return x && !x.soloPunta && x.tipo !== "cierre anterior" && x.last > 0 ? x.last : null; };
  const lineaC = (s) => {
    const x = q.get(s);
    if (!x) return null;
    if (x.operado && x.last > 0) return { precio: x.last, como: "operado" };
    const ref = x.cierre || x.last;
    if (x.bid > 0 && !(ref > 0 && x.bid < ref * 0.95)) return { precio: x.bid, como: "punta compradora" };
    return null;
  };
  const pesos = {}, origen = {};
  for (const t of GLOBALES) {
    const x = q.get(t);
    const p = vivo(t), c = ccl > 0 ? lineaC(t + "C") : null;
    if (p) { pesos[t] = p; origen[t] = x.tipo; }
    else if (c) { pesos[t] = c.precio * ccl; origen[t] = `línea C: ${t}C ${c.precio} (${c.como}) × CCL ${ccl.toFixed(1)}`; }
    else if (x && x.cierre > 0) { pesos[t] = x.cierre; origen[t] = `cierre anterior${x.tipo && x.tipo !== "cierre anterior" ? ` (${x.tipo})` : ""}`; }
    else pesos[t] = null;
  }
  return { pesos, origen };
}

/**
 * Réplica completa de un día o del momento.
 * @param terminos  {GD29: terminos, …} (los `generado` del universo)
 * @param pesos     {GD29: precio en pesos, …}
 * @param ccl       pesos por dólar cable
 * @param curva     curvaCero(...)
 * @param liq       fecha de liquidación (Date UTC, liquidacion() de flujo.js)
 */
export function calcularReplica({ terminos, pesos, ccl, curva, liq, vn = VN_ORIGINAL }) {
  const bonos = [];
  for (const t of GLOBALES) {
    if (!terminos[t] || !(pesos[t] > 0) || !(ccl > 0)) return null;
    const b = analizarBono(t, terminos[t], pesos[t] / ccl, curva, liq);
    if (!b) return null;
    bonos.push(b);
  }
  return agregar(bonos, vn);
}

/**
 * Sesgo y dispersión del error de las últimas `n` ruedas. `serie` = [{fecha, oficial, replica}] ascendente.
 * El sesgo se resta de la réplica en vivo ("calibrada"); la banda es ±2 desvíos del error ya corregido.
 */
export function calibracion(serie, n = 20, nDesvio = 60) {
  const ok = serie.filter((x) => x.oficial > 0 && Number.isFinite(x.replica));
  if (ok.length < 5) return null;
  const ult = ok.slice(-n);
  const err = ult.map((x) => x.replica - x.oficial);
  const sesgo = err.reduce((s, e) => s + e, 0) / err.length;
  const largo = ok.slice(-nDesvio).map((x) => x.replica - x.oficial - sesgo);
  const desvio = Math.sqrt(largo.reduce((s, e) => s + e * e, 0) / largo.length);
  const abs = ult.map((e) => Math.abs(e.replica - e.oficial)).sort((a, b) => a - b);
  return { sesgo, desvio, banda: 2 * desvio, tipico: abs[Math.floor(abs.length / 2)], n: ult.length };
}
