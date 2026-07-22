# Plotteri

Plotteri on selaimessa toimiva kalastus- ja veneilykartta Suomen vesille. Sovellus toimii staattisena web-appina, tallentaa käyttäjän omat tiedot selaimeen ja voidaan asentaa puhelimen tai tabletin kotinäytölle PWA-sovelluksena.

Tuotanto: https://lith.fi/map/

## Ominaisuudet

- Leaflet-kartta MML:n maastokartalla, OpenStreetMapilla, Traficomin merikartalla ja SYKE:n syvyyskerroksilla.
- GPS-seuranta nopeudella, suunnalla, tarkkuudella, näytön hereilläpidolla ja reitin tallennuksella.
- Tallennetut reitit ja kalapaikat, ensisijaisesti IndexedDB:ssä localStorage-migraatiolla ja varmistuksella. Reitit näkyvät kartalla oletuksena omana layerinään.
- Reittien ja kalapaikkojen GeoJSON-vienti ja -tuonti laitteelta toiselle siirtymistä varten.
- Nopeuden mukaan värittyvä reittiviiva, jotta hidas uistelu erottuu nopeammasta ajosta.
- Kalapaikka-indeksi: SYKEn vektorimuotoisesta järvisyvyysdatasta laskettu karttataso, joka korostaa syvänteiden reunat ja tuulen altistamat rannat.
- Olosuhteet tänään -merkki: ilmanpaineen trendistä ja kuunkierrosta laskettu päiväkerroin parhaine aikoineen.
- Järven 3D-syvyysnäkymä, joka ladataan vasta avattaessa.
- MML:n paikannimihaku suomalaisille saarille, lahdille, niemille, selille, kunnille ja muille nimetyille kohteille.
- OSM-pohjaiset karttakohteet: nuotiopaikat, laavut, bensa-asemat, terassit, veneenlaskupaikat, satamat, vesipisteet sekä kiinnitys- ja ankkuripaikat. Kohteet ladataan appin mukana jaettavasta staattisesta aineistosta (`pois/`), ei ajonaikaisista Overpass-kutsuista. Layer-valitsimessa yksi Karttakohteet-rasti, kategoriat valitaan asetuksista.
- FMI:n sadetutka karttaoverlaynä.
- Vesijärven syvyysalueet, jotka ladataan vasta tarvittaessa ja tallennetaan ensimmäisen latauksen jälkeen IndexedDB:hen.
- Selaimen tile-cache vain oikeasti katsotuille karttatileille, rajatulla tilemäärällä ja säilytysajalla.
- PWA-manifesti, ikoni ja asetuspaneelin asennusnappi kotinäyttöasennusta varten.

## Kalapaikka-analyysi

- Syvyysdata haetaan vektorina kahdesta WFS-lähteestä: SYKEn `inspire_el` (järvien syvyyskäyrät ja -vyöhykkeet) ja Traficomin `inspirepalvelu/rajoitettu` (merialueen syvyyskäyrät, -alueet ja luotaukset; vapaa kattavuus talousvyöhyke + Vuoksen ja Kymijoen vesistöt). Molemmat: bbox EPSG:3067, ulostulo EPSG:4326.
- Kalapaikka-indeksi (karttataso): syvänteen reunat (gradientti IDW-syvyysruudukosta), tuulen altistamat rannat (0-käyrän normaali vs. tuulen suunta; merellä rantaviiva syntetisoidaan DRVAL1=0-syvyysalueiden reunoista) ja lajikohtainen syvyyspainotus. Painot ovat `analysis.js`:n `SCORE_WEIGHTS`- ja `SPECIES_TRAITS`-objekteissa.
- Tuulisignaali: 6 h vektorikeskituuli (Open-Meteo; kääntyilevä tuuli kumoutuu keskiarvossa), voimakkuusvaste 2→5 m/s nousu, 5–8 m/s taso ja 8–14 m/s lasku (sekoittuminen), vaikutuskaista ~250 m rannasta, ja pyyhkäisymatka (fetch): täysi vaikutus vaatii ~2 km avovettä tuulen puolella.
- Kohdelaji valitaan asetuksista: pohjasuhteiset (hauki, kuha, ahven) käyttävät lajikohtaista syvyyspreferenssiä jota valoisuus (SunCalc) ja kerrostumiskausi siirtävät; pelagiset (muikku, silakka) pisteytetään termokliiniarvion tuntumaan, ja keväällä/syksyllä (ei kerrostumaa) niiden indeksi tyhjenee tarkoituksella. Termokliini on kalenteri+leveysaste-heuristiikka, ei mitattua lämpötilaa.
- Kun indeksi käyttää Traficomin dataa, kartalla näytetään: "Lähde: Liikenne- ja viestintävirasto. Ei navigointikäyttöön. Ei täytä asianmukaisen merikartan vaatimuksia."
- Olosuhteet tänään (HUD-merkki): ilmanpaineen 3 h trendi (Open-Meteo) + kuunkierto ja parhaat ajat (SunCalc). Ei riipu sijainnista kartalla.
- Syvyystiilet (6 km) cachetetaan IndexedDB:hen: TTL 30 pv, enintään 150 tiiltä / 12 Mt, LRU-siivous. Paneelissa tila ja tyhjennys.
- 3D-näkymä rakennetaan samasta syvyysruudukosta; three.js ladataan cdnjs:stä vasta näkymää avattaessa.
- 3D-näkymän Seuraa-tila: kamera seuraa venettä GPS-sijainnin ja suunnan mukaan ja näyttää pohjan muodot ajosuuntaan; syvyys veneen alla otsikkorivillä. Analyysialue rakennetaan lennossa uudelleen veneen ympärille kun ajetaan reunalle. Raahaus vaihtaa vapaaseen kameraan.

## POI-aineisto

Karttakohteet (nuotiopaikat, laavut, bensa-asemat, terassit, veneenlaskupaikat, satamat, vesipisteet sekä kiinnitys- ja ankkuripaikat) jaetaan staattisina tiedostoina `pois/`-hakemistossa, jotta appi ei riipu Overpass-rajapinnan saatavuudesta. Aineisto on pilkottu 0.5° × 1.0° soluihin (`pois/p_<la>_<lo>.json`), jotka appi lataa näkymän mukaan; `pois/index.json` kertoo mitkä solut ovat olemassa. Jos aineisto puuttuu deploysta, appi käyttää Overpassia fallbackina.

Aineiston päivitys:

```bash
# ensisijainen: Geofabrikin Suomi-ekstrakti (vaatii osmium-tool:n)
node scripts/update-pois.mjs

# vaihtoehto ilman riippuvuuksia: suora Overpass-haku
node scripts/update-pois.mjs --source overpass
```

Geofabrik-ekstrakti (~700 MB) cachetetaan `scripts/.cache/`-hakemistoon vuorokaudeksi. Päivityksen jälkeen committaa muuttunut `pois/`-hakemisto.

## Datalähteet

Plotteri käyttää julkisia kartta- ja ympäristöaineistoja useista lähteistä:

- Maanmittauslaitos (MML): maastokartta ja paikannimihaku.
- OpenStreetMap: taustakartta; POI-kohteet Geofabrikin Suomi-ekstraktista (ODbL) esiladattuna.
- Traficom: julkiset merikarttatiilet.
- Suomen ympäristökeskus (SYKE): WMS-karttatasot ja järvisyvyysdata WFS-vektoreina.
- Ilmatieteen laitos (FMI): WMS-sadetutka.
- Open-Meteo: säädata ja ilmanpaineen trendi, pyöristetyillä koordinaateilla.
- Vesijärven syvyysalueiden GeoJSON-lähde, joka on määritelty sovelluksessa.

Osa palveluista voi edellyttää käyttäjän omaa API-avainta. MML API-avain tallennetaan vain käyttäjän selaimeen, eikä sitä ole mukana repossa.

## Tietosuoja Ja Tallennus

Plotteri on staattinen selainapp. Sillä ei ole omaa sovelluspalvelinta.

- Reitit, kalapaikat, asetukset ja välimuistiin tallennettu Vesijärvi-data ovat selaimen IndexedDB:ssä.
- Asetuksia peilataan tarvittaessa localStorageen yhteensopivuuden vuoksi.
- MML API-avain tallennetaan selaimeen, koska MML:n avoimen avaimen malli on tarkoitettu selainkäyttöön.
- Näytön hereilläpito käyttää selaimen Screen Wake Lock API:a, jos PWA/selaintila tukee sitä. Lukko vapautuu automaattisesti, jos appi ei ole näkyvissä.
- Sovelluksen asennusnappi käyttää selaimen `beforeinstallprompt`-tapahtumaa, kun se on saatavilla. iOS näyttää käyttäjälle ohjeen käyttää Jakaminen-valikon Lisää Koti-valikkoon -toimintoa.
- Säähaut lähettävät Open-Meteolle pyöristetyn sijainnin.
- Tile-cache tallentaa vain ne karttatiilet, joita käyttäjä on oikeasti katsonut.
- Syvyystiilet cachetetaan IndexedDB:hen rajatulla määrällä ja säilytysajalla.
- FMI:n sadetutkaa ei cacheteta, koska sääkuva vanhenee nopeasti.

Selaimen, käyttöjärjestelmän tai käyttäjän oma tyhjennys voi poistaa paikalliset tiedot. Tärkeät reitit ja kalapaikat kannattaa viedä talteen GeoJSON-tiedostona. GeoJSON-tuonti lisää tiedoston reitit ja kalapaikat nykyisten rinnalle ja ohittaa ilmeiset duplikaatit.

## Tile-Cache

Service worker tallentaa katsottuja karttatilejä, jotta kartta toimii paremmin hitaalla yhteydellä. Cache on tarkoituksella rajattu:

- Ei massalatausta offline-kartaksi.
- Ei automaattista laajojen järvialueiden esilatausta.
- Asetuksissa säädettävä enimmäismäärä ja säilytysaika.
- Asetuksissa manuaalinen cache-tyhjennys.

Tämä säästää kaistaa ja pitää kolmansien osapuolten tile-palveluiden käytön kohtuullisena.

## Paikallinen Kehitys

Sovellus on staattista HTML/CSS/JavaScriptiä.

```bash
cd /home/miso/.openclaw/workspace/projects/plotteri
python3 -m http.server 8080
```

Avaa sen jälkeen:

```text
http://localhost:8080/
```

Käytä paikallista web-palvelinta suoran `index.html`-avauksen sijaan, koska service workerit, moduuliskriptit ja osa selain-API:eista vaativat HTTP-originin.

## Repon Rakenne

```text
index.html              Pääsovellus
analysis.js             Kalapaikka-analyysin laskenta (syvyysruudukko, gradientti, tuulialtistus, päiväkerroin)
analysis-worker.js      Web Worker, joka ajaa analyysilaskennan pois karttasäikeestä
view3d.js               Järven 3D-syvyysnäkymä (lazy-ladattava)
map-sw.js               Service worker katsottujen tilejen cachelle
manifest.json           PWA-manifesti
icons/plotteri-icon.svg PWA-ikoni
pois/                   Staattinen POI-aineisto (index.json + solutiedostot)
scripts/update-pois.mjs POI-aineiston päivitysskripti (Geofabrik/Overpass)
README.md               Projektin dokumentaatio
LICENSE                 MIT-lisenssi
```

## Julkaisu

Tuotantoversio palvellaan tällä hetkellä osoitteesta:

```text
https://lith.fi/map/
```

Julkaisukohde odottaa näitä staattisia tiedostoja sellaisenaan:

- `index.html`
- `analysis.js`
- `analysis-worker.js`
- `view3d.js`
- `map-sw.js`
- `manifest.json`
- `icons/plotteri-icon.svg`
- `pois/`

## Mahdollisia Jatkokehityksiä

Hyviä seuraavia kohteita:

- FMI-sadetutkan animaatio tai aikaleiman valinta.
- Paremmat veneilykohteet: vierasvenesatamat, rampit, septiasemat ja vesipisteet.
- Kalastusrajoitukset ja lupa-alueet karttatasoina.
- Reittien rakenteisemmat haut, esimerkiksi kuukauden tai vesialueen mukaan.
- Kevyt palvelinpersistointi ja synkronointi usean laitteen välillä.

## Lisenssi

MIT. Katso [LICENSE](LICENSE).
