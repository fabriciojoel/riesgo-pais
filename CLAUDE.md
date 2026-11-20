# riesgo-pais

Réplica propia del riesgo país de J.P. Morgan (EMBI Global Diversified, Argentina) con datos públicos.
Repo público de Fabricio, publicado con GitHub Pages: https://fabriciojoel.github.io/riesgo-pais/

- `actualizar.mjs` (Node 22, sin dependencias): baja precios (data912), curva del Tesoro (CNBC en vivo,
  treasury.gov de respaldo e histórico), serie oficial (ArgentinaDatos) y Ámbito; calcula y escribe
  `data/riesgo_pais.json` (vivo + último oficial + calibración + histórico de 190 ruedas) y
  `data/intradia.json` (fotos del día). El histórico se recalcula solo cuando hay un cierre oficial nuevo.
- `.github/workflows/actualizar.yml`: cada 15 min de 11 a 17 h ART (lun-vie) y dos veces a la noche;
  commitea solo si cambió. Correrlo a mano: `gh workflow run actualizar.yml`.
- `index.html`: página standalone que lee `data/riesgo_pais.json` (misma estética que clubfci2).
- `motor/riesgopais_calc.js` y `motor/flujo.js` son COPIAS de `E:\clubfci2\js\`: si se cambia el motor
  allá, copiarlo acá (y al revés). `data/terminos_globales.json` = términos de los 6 Globales sacados de
  `E:\clubfci2\data\universo.json`.
- **clubfci2 lee de acá** (`#/riesgo-pais` usa `https://fabriciojoel.github.io/riesgo-pais/data/riesgo_pais.json`
  y cae al cálculo propio si el JSON no responde o está viejo). Cuando se integre del todo en Netlify,
  esto puede quedar como respaldo o archivarse.
- Metodología, validación y fuentes: sección "Riesgo país en vivo" del CLAUDE.md de clubfci2.
