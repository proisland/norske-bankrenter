# norske-bankrenter

Automatisk oppdatert rentetabell for norske boliglån, billån og studielån.

Filen `data/rates.json` oppdateres **én gang i uken** (mandag morgen)
av en GitHub Actions-workflow som bruker Claude API til å hente gjeldende
renter fra bankenes nettsider.

## Bruk i Homey-appen

Homey-appen henter renter direkte fra:

```
https://raw.githubusercontent.com/proisland/norske-bankrenter/main/data/rates.json
```

Ingen autentisering eller API-nøkkel kreves for å lese filen.

## Dataformat

```json
{
  "updatedAt": "2026-04-28T07:00:00Z",
  "source": "Claude API web search (weekly)",
  "mortgage": [
    { "bank": "Bulder Bank", "rate": 4.77, "type": "flytende", "ltvMax": 85, "requiresProducts": "" }
  ],
  "car_loan": [ ... ],
  "student_loan": [ ... ]
}
```

## Oppsett (kun én gang)

**1. Fork eller opprett dette repoet under din GitHub-bruker.**

**2. Legg til API-nøkkel som secret:**
- Gå til **Settings → Secrets and variables → Actions**
- Trykk **New repository secret**
- Navn: `ANTHROPIC_API_KEY`
- Verdi: din nøkkel fra [console.anthropic.com](https://console.anthropic.com)

**3. Aktivér Actions:**
- Gå til **Actions**-fanen
- Trykk **"I understand my workflows, go ahead and enable them"** hvis du ser en advarsel

**4. Test manuelt:**
- Gå til **Actions → Update bank rates → Run workflow**
- Sjekk at jobben kjører og at `data/rates.json` oppdateres

## Tidsplan

Kjører **hver mandag kl. 07:00 UTC** (08:00 Oslo vintertid, 09:00 sommertid).

For å endre frekvens, rediger `cron`-uttrykket i `.github/workflows/update-rates.yml`:
- Daglig: `0 7 * * *`
- Ukentlig (mandag): `0 7 * * 1`
- To ganger i uken: `0 7 * * 1,4`

## Kostnad

Hver kjøring gjør 3 Claude-kall med web search (boliglån, billån, Lånekassen).
Typisk **$0.10–0.20 per kjøring** = ca. **$0.40–0.80 per måned** ved ukentlig frekvens.

## Fallback i Homey-appen

Dersom denne filen ikke er tilgjengelig, bruker appen:
1. Brukerens egen Claude-nøkkel (hvis konfigurert i app-innstillinger)
2. Innebygd statisk renteliste (oppdateres kun ved nye app-versjoner)
