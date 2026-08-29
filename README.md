# GundogHunting

En installerbar app (PWA) som analyserer GPX-spor fra GPS-halsbånd (f.eks. Garmin T20)
og håndenhet (f.eks. Alpha 300i): distanse, stand-deteksjon, avstand fører–hund, og
søksmønster relativt til vindretning.

All data lagres **kun lokalt i telefonens nettleser** (IndexedDB). Ingen server,
ingen konto, ingen deling mellom enheter — hver bruker har sine egne data.

## Legg ut på GitHub Pages (ca. 2 minutter)

1. Opprett et nytt repo på github.com (offentlig eller privat — begge fungerer med Pages
   på et gratis GitHub-abonnement, men privat repo krever GitHub Pro for Pages).
2. Last opp **alle filene i denne mappen** til repoet (dra-og-slipp i GitHub sitt nettgrensesnitt,
   eller `git push` om du foretrekker det).
3. Gå til repoets **Settings → Pages**.
4. Under "Source", velg branch `main` og mappe `/ (root)`. Lagre.
5. Vent ca. 1 minutt — GitHub gir deg en adresse som
   `https://dittbrukernavn.github.io/repo-navn/`.

## Installer på telefon

- **iPhone:** åpne adressen i Safari → del-ikonet → "Legg til på Hjemskjerm"
- **Android:** åpne adressen i Chrome → meny (⋮) → "Installer app" / "Legg til på startskjerm"

Fra da av oppfører den seg som en vanlig app: eget ikon, fullskjerm, fungerer offline
etter første åpning.

## Bruk

1. "+ Ny jakttur" → last opp GPX fra hundens halsbånd (påkrevd) og evt. håndenheten (valgfritt)
2. Velg vindretning
3. Dra i håndtakene for å trimme bort båndtur i hver ende — kartet og tallene
   oppdateres live
4. Lagre — turen havner i loggen med full statistikk og kart

## Backup

Bruk "Eksporter alle data" på forsiden for å laste ned en JSON-fil med alt.
"Importer backup" gjenoppretter fra en slik fil. Nyttig hvis du bytter telefon
eller sletter appen ved et uhell.

## Hvis en oppdatering ikke slår igjennom

Trykk "Tving oppdatering av appen" nederst på forsiden. Fjerner kun mellomlagret
app-kode, aldri jakthistorikken din.

## Filstruktur

```
index.html      — app-skallet
styles.css      — design
app.js          — all logikk: GPX-parsing, statistikk, kart, 3D, lagring
manifest.json   — PWA-konfigurasjon
sw.js           — offline-støtte
icons/          — app-ikoner (jakthund-silhuett)
```
