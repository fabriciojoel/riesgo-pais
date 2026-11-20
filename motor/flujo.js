// Construcción del flujo de fondos a partir de los términos de un bono.
// Módulo puro (sin fs ni red): lo usan tanto el generador de planillas en Node
// como la app en el navegador, para no duplicar la lógica.

export const parseISO = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const isoDe = (dt) => dt.toISOString().slice(0, 10);

// Días 30/360 (convención de la planilla) o actual/365.
export function dias(desde, hasta, base) {
  if (base === 360) {
    // DAYS360 método US (el de Sheets/Excel por defecto), con la regla de fin de febrero:
    // sin ella 28-feb -> 30-ago daba 182 días en vez de 180 (AEC2O, cupón de ago-2025).
    const finFeb = (dt) => dt.getUTCMonth() === 1 && new Date(Date.UTC(dt.getUTCFullYear(), 2, 1) - 86400000).getUTCDate() === dt.getUTCDate();
    let d1 = desde.getUTCDate(), d2 = hasta.getUTCDate();
    if (finFeb(desde) && finFeb(hasta)) d2 = 30;
    if (finFeb(desde)) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
    if (d1 === 31) d1 = 30;
    return (hasta.getUTCFullYear() - desde.getUTCFullYear()) * 360
         + (hasta.getUTCMonth() - desde.getUTCMonth()) * 30 + (d2 - d1);
  }
  return Math.round((hasta - desde) / 86400000);
}

// Tasa vigente en una fecha (fija o step-up).
export function tasaEn(t, dt) {
  if (t.tasa.fija != null) return t.tasa.fija;
  for (const tr of t.tasa.tramos) if (dt <= parseISO(tr.hasta)) return tr.tasa;
  return t.tasa.tramos[t.tasa.tramos.length - 1].tasa;
}

// Fechas de cupón: desde el primer cupón hasta el vencimiento, cada 12/freq meses.
// Si el bono trae `fechas` (cronograma explícito: cupones irregulares, cuotas que no
// caen en fecha de cupón, períodos cortos), mandan esas. Las ON dólar-linked
// cargadas desde el Excel del motor (planilla/terminos.js) vienen así.
export function fechasCupon(t) {
  if (t.fechas) return t.fechas.map(parseISO);
  const paso = 12 / t.freq, fin = parseISO(t.vto), out = [];
  const p = parseISO(t.primerCupon);
  const y = p.getUTCFullYear(), m = p.getUTCMonth(), d = p.getUTCDate();
  for (let i = 0; i < 400; i++) {
    const dt = new Date(Date.UTC(y, m + i * paso, d));
    if (dt > fin) break;
    out.push(dt);
  }
  if (!out.length || isoDe(out[out.length - 1]) !== t.vto) out.push(fin);
  return out;
}

// Flujo completo por cada 100 de valor nominal.
// `residual` es el capital que QUEDA luego del pago (convención de la planilla original);
// el interés devenga sobre el capital ANTERIOR al pago.
export function construirFlujo(t) {
  const cupones = fechasCupon(t);
  const amort = t.amort.alVto ? [{ fecha: t.vto, pct: 100 }] : t.amort.cuotas;
  const porFecha = new Map();
  for (const c of amort) porFecha.set(c.fecha, (porFecha.get(c.fecha) || 0) + c.pct);

  // `residualInicial`: capital vigente al arrancar el cronograma (100 salvo ON que el Sheet ya
  // traía con capital amortizado, ej. SA24D 90). Los % de amortización son sobre el VN original.
  let residual = t.residualInicial != null ? t.residualInicial : 100;
  let anterior = parseISO(t.emision);
  const filas = [];
  for (const [i, dt] of cupones.entries()) {
    // `tasasPeriodo` (opcional, mismo largo que `fechas`): tasa del período que TERMINA en
    // cada fecha. Cubre step-ups que no cambian justo en una fecha de cupón y los cupones
    // pagados en especie a tasa incrementada (Tango).
    const tasa = t.tasasPeriodo ? t.tasasPeriodo[i] : tasaEn(t, dt);
    const dd = dias(anterior, dt, t.base);
    const interes = residual * (tasa / 100) * (dd / t.base);
    const am = porFecha.get(isoDe(dt)) || 0;
    const residualPrevio = residual;
    residual = +(residual - am).toFixed(10);
    filas.push({ dt, tasa, dias: dd, interes, amort: am, residualPrevio, residual, flujo: interes + am });
    anterior = dt;
  }
  return filas;
}

// Adapta el flujo al formato que consume la app (mismo shape que loadCashflow):
// { flows: [{fecha, dias, tasa, amort, residual, interes, flujo}], dirtyPrice }
// `dias` se mide desde la liquidación: T+1 HÁBIL (un viernes o un sábado liquidan el lunes).
// No contempla feriados (no hay calendario de feriados en el proyecto).
export function liquidacion(hoy = new Date()) {
  // fecha LOCAL de hoy: con getUTC*, de 21 a 24 h en Argentina "hoy" ya era mañana
  const liq = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1));
  while (liq.getUTCDay() === 0 || liq.getUTCDay() === 6) liq.setUTCDate(liq.getUTCDate() + 1);
  return liq;
}

export function cashflowApp(t, hoy = new Date()) {
  const liq = liquidacion(hoy);
  // `dias` = días CORRIDOS desde la liquidación, sin importar la base del bono: así lo hace la
  // planilla (col "Dias" = fecha − settlement) y es lo que espera la TIR act/365 de finance.js.
  // (Antes se medía en 30/360 para los bonos base 360 y la TIR quedaba levemente corrida.)
  const corridos = (dt) => Math.round((dt - liq) / 86400000);
  const local = (dt) => new Date(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()); // como parseDate
  const filas = construirFlujo(t);
  const flows = filas.map((f) => {
    const dd = corridos(f.dt);
    return {
      fecha: local(f.dt),
      dias: dd,
      tasa: f.tasa,
      amort: f.amort,
      residual: f.residual,
      residualPrevio: f.residualPrevio,   // capital vigente antes de este pago
      interes: f.interes,
      flujo: dd > 0 ? f.flujo : 0,   // la planilla pone 0 en cupones ya pagados
    };
  });
  // Fila de emisión (sin pago), como la primera fila de la planilla: sin ella el interés corrido
  // del primer cupón daba 0 (accruedInterest necesita la fecha de inicio del período vigente).
  const emi = parseISO(t.emision);
  flows.unshift({
    fecha: local(emi), dias: corridos(emi), tasa: filas.length ? filas[0].tasa : 0,
    amort: 0, residual: t.residualInicial != null ? t.residualInicial : 100,
    residualPrevio: t.residualInicial != null ? t.residualInicial : 100, interes: 0, flujo: 0,
  });
  // El precio lo aporta el mercado; `precioRef` (ON del universo: último dirty que tenía el Sheet)
  // queda de respaldo si no hay cotización, como la fila de liquidación de la planilla.
  return { flows, dirtyPrice: t.precioRef > 0 ? t.precioRef : null };
}
