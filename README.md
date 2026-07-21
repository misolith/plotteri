# Plotteri

Plotteri on selaimessa toimiva kalastus- ja veneilykartta Suomen vesille. Sovellus toimii staattisena web-appina, tallentaa käyttäjän omat tiedot selaimeen ja voidaan asentaa puhelimen tai tabletin kotinäytölle PWA-sovelluksena.

Tuotanto: https://lith.fi/app/map/

## Ominaisuudet

- Leaflet-kartta MML:n maastokartalla, OpenStreetMapilla, Traficomin merikartalla ja SYKE:n syvyyskerroksilla.
- GPS-seuranta nopeudella, suunnalla, tarkkuudella, wake lockilla ja reitin tallennuksella.
- Tallennetut reitit ja kalapaikat, ensisijaisesti IndexedDB:ssä localStorage-migraatiolla ja varmistuksella.
- Nopeuden mukaan värittyvä reittiviiva, jotta hidas uistelu erottuu nopeammasta ajosta.
- MML:n paikannimihaku suomalaisille saarille, lahdille, niemille, selille, kunnille ja muille nimetyille kohteille.
- OSM-pohjaiset karttakohteet: nuotiopaikat, laavut, bensa-asemat ja terassit/ulkotarjoilu.
- FMI:n sadetutka karttaoverlaynä.
- Vesijärven syvyysalueet, jotka ladataan vasta tarvittaessa ja tallennetaan ensimmäisen latauksen jälkeen IndexedDB:hen.
- Selaimen tile-cache vain oikeasti katsotuille karttatileille, rajatulla tilemäärällä ja säilytysajalla.
- PWA-manifesti ja ikoni kotinäyttöasennusta varten.

## Datalähteet

Plotteri käyttää julkisia kartta- ja ympäristöaineistoja useista lähteistä:

- Maanmittauslaitos (MML): maastokartta ja paikannimihaku.
- OpenStreetMap: taustakartta ja POI-kohteet.
- Traficom: julkiset merikarttatiilet.
- Suomen ympäristökeskus (SYKE): WMS-karttatasot.
- Ilmatieteen laitos (FMI): WMS-sadetutka.
- Open-Meteo: säädata, pyöristetyillä koordinaateilla.
- Vesijärven syvyysalueiden GeoJSON-lähde, joka on määritelty sovelluksessa.

Osa palveluista voi edellyttää käyttäjän omaa API-avainta. MML API-avain tallennetaan vain käyttäjän selaimeen, eikä sitä ole mukana repossa.

## Tietosuoja Ja Tallennus

Plotteri on staattinen selainapp. Sillä ei ole omaa sovelluspalvelinta.

- Reitit, kalapaikat, asetukset ja välimuistiin tallennettu Vesijärvi-data ovat selaimen IndexedDB:ssä.
- Asetuksia peilataan tarvittaessa localStorageen yhteensopivuuden vuoksi.
- MML API-avain tallennetaan selaimeen, koska MML:n avoimen avaimen malli on tarkoitettu selainkäyttöön.
- Säähaut lähettävät Open-Meteolle pyöristetyn sijainnin.
- Tile-cache tallentaa vain ne karttatiilet, joita käyttäjä on oikeasti katsonut.
- FMI:n sadetutkaa ei cacheteta, koska sääkuva vanhenee nopeasti.

Selaimen, käyttöjärjestelmän tai käyttäjän oma tyhjennys voi poistaa paikalliset tiedot. Tärkeät reitit ja kalapaikat kannattaa viedä talteen tarvittaessa.

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
map-sw.js               Service worker katsottujen tilejen cachelle
manifest.json           PWA-manifesti
icons/plotteri-icon.svg PWA-ikoni
README.md               Projektin dokumentaatio
LICENSE                 MIT-lisenssi
```

## Julkaisu

Tuotantoversio palvellaan tällä hetkellä osoitteesta:

```text
https://lith.fi/app/map/
```

Julkaisukohde odottaa näitä staattisia tiedostoja sellaisenaan:

- `index.html`
- `map-sw.js`
- `manifest.json`
- `icons/plotteri-icon.svg`

## Mahdollisia Jatkokehityksiä

Hyviä seuraavia kohteita:

- FMI-sadetutkan animaatio tai aikaleiman valinta.
- Paremmat veneilykohteet: vierasvenesatamat, rampit, septiasemat ja vesipisteet.
- Kalastusrajoitukset ja lupa-alueet karttatasoina.
- Reittien rakenteisemmat haut, esimerkiksi kuukauden tai vesialueen mukaan.
- Reittien ja kalapaikkojen tuonti/vienti käyttöliittymästä.

## Lisenssi

MIT. Katso [LICENSE](LICENSE).
