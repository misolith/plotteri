# Plotteri

Kalastusplotteri selaimessa.

## Sisalto

- `index.html` - staattinen Leaflet-pohjainen karttasovellus
- `map-sw.js` - service worker katsottujen karttatilejen valimuistille
- `manifest.json` ja `icons/` - PWA-asennus kotinaytolle

Sovellus kayttaa kayttajan selaimeen tallennettua MML API-avainta. Avainta ei ole mukana repossa. Reitit, kalapaikat ja muu sovellusdata tallennetaan selaimen IndexedDB:hen localStorage-varmistuksella.
