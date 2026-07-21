# Plotteri

Kalastusplotteri selaimessa.

## Sisalto

- `index.html` - staattinen Leaflet-pohjainen karttasovellus
- `analysis.js` - kalapaikka-analyysin laskenta: syvyysruudukko, gradientti, tuulialtistus, paivakerroin
- `view3d.js` - jarven 3D-syvyysnakyma (ladataan vasta avattaessa, three.js cdnjs:sta)
- `map-sw.js` - service worker katsottujen karttatilejen valimuistille
- `manifest.json` ja `icons/` - PWA-asennus kotinaytolle

Sovellus kayttaa kayttajan selaimeen tallennettua MML API-avainta. Avainta ei ole mukana repossa. Reitit, kalapaikat ja muu sovellusdata tallennetaan selaimen IndexedDB:hen localStorage-varmistuksella.

## Kalapaikka-analyysi

- Syvyysdata haetaan vektorina SYKEn `inspire_el`-WFS:sta (jarvien syvyyskayrat ja -alueet, EPSG:3067). Kattaa vain luodatut jarvet, ei merialueita.
- Kalapaikka-indeksi (karttataso): syvanteen reunat (gradientti IDW-ruudukosta), tuulen altistamat rannat (0-kayran normaali vs. tuulen suunta) ja syvyysvyohykepainotus.
- Olosuhteet tanaan (HUD-merkki): ilmanpaineen 3 h trendi (Open-Meteo) + kuunkierto ja parhaat ajat (SunCalc). Ei riipu sijainnista kartalla.
- Syvyystiilet (6 km) cachetetaan IndexedDB:hen: TTL 30 pv, enintaan 150 tiilta / 12 Mt, LRU-siivous.
- 3D-nakyma rakennetaan samasta syvyysruudukosta; three.js ladataan vasta nakymaa avattaessa.
