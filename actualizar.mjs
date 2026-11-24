// Actualiza data/riesgo_pais.json: réplica del riesgo país (EMBI Global Diversified, Argentina) con datos
// públicos. Lo corre GitHub Actions cada 15 minutos en horario de rueda y una vez a la noche (para tomar el
// cierre oficial). También se puede correr a mano: node actualizar.mjs
//
// El cálculo es el mismo motor de clubfci2 (motor/riesgopais_calc.js + motor/flujo.js, copiados tal cual):
// 6 Globales ley NY, precio en dólar cable (pesos ÷ CCL implícito AL30/GD30), Z-spread sobre la curva cero
// del Tesoro de EE.UU. y promedio ponderado por valor de mercado × duration.
import fs from "node:fs";
import { GLOBALES, curvaCero, calcularReplica, cclImplicito, calibracion } from "./motor/riesgopais_calc.js";
import { liquidacion } from "./motor/flujo.js";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; riesgo-pais/1.0)" };
const ARCHIVO = "data/riesgo_pais.json", INTRADIA = "data/intradia.json";
const HIST_TICKERS = [...GLOBALES, "AL30", "AL30C", "GD30C"];
const RUEDAS_HIST = 190;   // ruedas guardadas (la página grafica 120; la calibración usa 20 y 60)

const terminos = JSON.parse(fs.readFileSync("data/terminos_globales.json", "utf8"));
const leer = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
async function json(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function texto(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// Mismo criterio de precio que clubfci2 (market.js → precioData912).
function precioData912(x) {
  const bid = x.px_bid > 0 ? x.px_bid : null, ask = x.px_ask > 0 ? x.px_ask : null;
  const operado = x.v > 0 && x.c > 0;
  const cierre = x.c > 0 ? x.c : null;
  if (operado) return { last: x.c, tipo: "operado", operado, soloPunta: false, cierre };
  if (bid != null && ask != null) {
    const last = (bid + ask) / 2;
    return { last, tipo: (ask - bid) / last > 0.05 ? "puntas muy separadas" : "punta media", operado, soloPunta: (ask - bid) / last > 0.05, cierre };
  }
  if (bid != null || ask != null) return { last: bid ?? ask, tipo: "una sola punta", operado, soloPunta: true, cierre };
  if (x.c > 0) return { last: x.c, tipo: "cierre anterior", operado, soloPunta: false };
  return null;
}

const CNBC_PLAZO = { US1M: 1 / 12, US3M: 0.25, US6M: 0.5, US1Y: 1, US2Y: 2, US3Y: 3, US5Y: 5, US7Y: 7, US10Y: 10, US20Y: 20, US30Y: 30 };
async function ustVivo() {
  const j = await json("https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols="
    + Object.keys(CNBC_PLAZO).join("%7C") + "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1");
  const pts = [];
  let hora = "";
  for (const x of j?.FormattedQuoteResult?.FormattedQuote || []) {
    const t = CNBC_PLAZO[x.symbol], y = parseFloat(String(x.last || "").replace("%", ""));
    if (t && Number.isFinite(y)) { pts.push([t, y]); if ((x.last_time || "") > hora) hora = x.last_time; }
  }
  if (pts.length < 6) throw new Error("CNBC: curva incompleta");
  return { fuente: "CNBC, en vivo", hora, pts };
}

const TES_PLAZO = { "1 Mo": 1 / 12, "1.5 Month": 1.5 / 12, "2 Mo": 2 / 12, "3 Mo": 0.25, "4 Mo": 4 / 12, "6 Mo": 0.5,
  "1 Yr": 1, "2 Yr": 2, "3 Yr": 3, "5 Yr": 5, "7 Yr": 7, "10 Yr": 10, "20 Yr": 20, "30 Yr": 30 };
async function ustHistorico(anio) {
  const lineas = (await texto("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
    + `${anio}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${anio}&page&_format=csv`)).trim().split(/\r?\n/);
  const cab = lineas[0].split(",").map((s) => s.replace(/"/g, "").trim());
  const out = [];
  for (const l of lineas.slice(1)) {
    const c = l.split(","), m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(c[0] || "");
    if (!m) continue;
    const pts = [];
    cab.forEach((h, i) => { const t = TES_PLAZO[h], y = parseFloat(c[i]); if (t && Number.isFinite(y)) pts.push([t, y]); });
    if (pts.length >= 6) out.push({ fecha: `${m[3]}-${m[1]}-${m[2]}`, pts: pts.sort((a, b) => a[0] - b[0]) });
  }
  return out.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
}

async function ambito() {
  try {
    const r = await fetch("https://mercados.ambito.com//riesgopais/variacion", { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const j = await r.json();
    const valor = Number(String(j.ultimo || "").replace(/\./g, "").replace(",", "."));
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(j.fecha || "");
    return valor > 0 ? { valor, fecha: m ? `${m[3]}-${m[2]}-${m[1]}` : null, variacion: j.variacion || null } : null;
  } catch { return null; }
}

const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

async function calcularHistoria(oficial) {
  const anio = new Date().getFullYear();
  const [ustAnt, ustAct, ...series] = await Promise.all([
    ustHistorico(anio - 1).catch(() => []), ustHistorico(anio),
    ...HIST_TICKERS.map((t) => json(`https://data912.com/historical/bonds/${t}`).catch(() => [])),
  ]);
  const cierre = {};
  HIST_TICKERS.forEach((t, i) => { cierre[t] = new Map((series[i] || []).filter((x) => x.c > 0).map((x) => [x.date, x.c])); });
  const ust = [...ustAnt, ...ustAct];
  const curvas = new Map();
  const serie = [];
  for (const { fecha, valor } of oficial.filter((x) => x.valor > 0).slice(-(RUEDAS_HIST + 20))) {
    const px = (s) => cierre[s].get(fecha) ?? null;
    const ccl = cclImplicito(px);
    const u = [...ust].reverse().find((x) => x.fecha <= fecha);
    if (!ccl || !u) continue;
    if (!curvas.has(u.fecha)) curvas.set(u.fecha, curvaCero(u.pts.map(([t, y]) => [t, y / 100])));
    const [y, m, d] = fecha.split("-").map(Number);
    const r = calcularReplica({ terminos, pesos: Object.fromEntries(GLOBALES.map((t) => [t, px(t)])), ccl: ccl.valor, curva: curvas.get(u.fecha), liq: liquidacion(new Date(y, m - 1, d)) });
    if (r) serie.push({ fecha, oficial: Number(valor), replica: r2(r.rp, 1) });
  }
  return serie.slice(-RUEDAS_HIST);
}

async function main() {
  const previo = leer(ARCHIVO, {});
  const [arr, oficial, amb] = await Promise.all([json("https://data912.com/live/arg_bonds"), json("https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais"), ambito()]);
  let ust;
  try { ust = await ustVivo(); }
  catch { const h = await ustHistorico(new Date().getFullYear()); const u = h[h.length - 1]; ust = { fuente: "Tesoro de EE.UU., cierre", hora: u.fecha, pts: u.pts }; }

  // en vivo
  const q = new Map();
  for (const x of arr) { const p = precioData912(x); if (p) q.set(x.symbol, p); }
  const px = (s) => { const x = q.get(s); return x && !x.soloPunta ? x.last : null; };
  const ccl = cclImplicito(px);
  if (!ccl) throw new Error("sin CCL implícito");
  const curva = curvaCero(ust.pts.map(([t, y]) => [t, y / 100]));
  // Un Global sin precio usable (no operó y una sola punta o puntas muy separadas, como GD46 el 24/11/2026)
  // entra con su cierre anterior en vez de tumbar toda la réplica (mismo criterio que clubfci2).
  const pesos = Object.fromEntries(GLOBALES.map((t) => {
    const p = px(t);
    if (p > 0) return [t, p];
    const x = q.get(t);
    if (x && x.cierre > 0) { q.set(t, { ...x, last: x.cierre, tipo: `cierre anterior (${x.tipo})` }); return [t, x.cierre]; }
    return [t, null];
  }));
  const r = calcularReplica({ terminos, pesos, ccl: ccl.valor, curva, liq: liquidacion(new Date()) });
  if (!r) throw new Error("faltan precios de algún Global");

  // histórico: se recalcula solo si hay un cierre oficial nuevo (o no hay histórico)
  const ultOficial = oficial.filter((x) => x.valor > 0).at(-1);
  let historia = previo.historia || [];
  if (!historia.length || historia.at(-1).fecha < ultOficial.fecha) historia = await calcularHistoria(oficial);
  const cal = calibracion(historia);

  const ahora = new Date().toISOString();
  const vivo = {
    hora: ahora,
    rp: r2(r.rp, 1), rpVM: r2(r.rpVM, 1), durMedia: r2(r.durMedia, 3),
    corregida: cal ? r2(r.rp - cal.sesgo, 1) : null,
    ccl: { valor: r2(ccl.valor), pares: ccl.pares.map((p) => ({ par: p.par, valor: r2(p.valor) })) },
    ust: { fuente: ust.fuente, hora: ust.hora, ust10: r2(curva.parEn(10) * 100, 3) },
    bonos: r.bonos.map((b) => ({
      tick: b.tick, pesos: q.get(b.tick)?.last ?? null, tipo: q.get(b.tick)?.tipo || null,
      sucio: r2(b.sucio, 3), residual: r2(b.residual, 2), tir: r2(b.tir * 100, 3), zspread: r2(b.zspread * 1e4, 1),
      dur: r2(b.dur, 3), peso: r2(b.peso * 100, 2), pesoEfectivo: r2(b.pesoEfectivo * 100, 2), aporte: r2(b.aporte, 1),
    })),
  };
  const salida = {
    generado: ahora,
    metodo: "Réplica propia del riesgo país de J.P. Morgan (EMBI Global Diversified, Argentina). No es el dato oficial.",
    vivo,
    oficial: { valor: ultOficial.valor, fecha: ultOficial.fecha, fuente: "ArgentinaDatos" },
    ambito: amb,
    calibracion: cal && { sesgo: r2(cal.sesgo, 1), desvio: r2(cal.desvio, 1), banda: r2(cal.banda, 1), tipico: r2(cal.tipico, 1), n: cal.n },
    historia,
  };
  fs.writeFileSync(ARCHIVO, JSON.stringify(salida));

  // Fotos del día para el gráfico intradiario: solo en horario de rueda (10:55 a 17:20 ART, lun-vie). Fuera de
  // horario no se toca el archivo, así el gráfico del último día queda hasta la primera foto de la rueda siguiente.
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "numeric", minute: "numeric", hour12: false })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const hoyAR = `${p.year}-${p.month}-${p.day}`, minAR = (Number(p.hour) % 24) * 60 + Number(p.minute);
  if (!["Sat", "Sun"].includes(p.weekday) && minAR >= 655 && minAR <= 1040) {
    const intra = leer(INTRADIA, {});
    const nuevo = intra.fecha !== hoyAR;
    const puntos = nuevo ? [] : intra.puntos;
    puntos.push({ hora: ahora, rp: vivo.rp, corregida: vivo.corregida });
    // cierre oficial anterior (referencia del gráfico): el último oficial con fecha anterior a hoy
    const previo = oficial.filter((x) => x.valor > 0 && x.fecha < hoyAR).at(-1);
    fs.writeFileSync(INTRADIA, JSON.stringify({ fecha: hoyAR, cierreAnterior: previo ? { valor: previo.valor, fecha: previo.fecha } : null, puntos }));
  }

  console.log(`réplica ${vivo.rp} pb (corregida ${vivo.corregida}) · oficial ${ultOficial.valor} del ${ultOficial.fecha} · CCL ${vivo.ccl.valor} · ${ust.fuente}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
