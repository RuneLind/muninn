# Fra YouTube-video til søkbar kunnskap — med AI og vektorsøk

Du har akkurat sett en fantastisk YouTube-video om et teknisk emne. 40 minutter med innsikt, konkrete eksempler og nye perspektiver. To uker senere husker du vagt at «noen forklarte det der med tool use», men ikke hvem, ikke hvilken video, og definitivt ikke detaljene.

Kjenner du deg igjen? Jeg gjorde det. Etter å ha sett hundrevis av tekniske videoer — om Claude Code, AI-arkitektur, RAG-mønstre — innså jeg at YouTube-kunnskapen min hadde en halveringstid på dager. Samtidig hadde jeg tusenvis av Notion-sider, Confluence-dokumenter og Claude Code-sesjoner liggende i separate siloer. Når jeg skulle sette meg inn i noe nytt, kryss-refererte jeg manuelt mellom kilder. Det tar tid, og du mister kontekst.

Så jeg bygde et system som løser tre problemer: det **fanger kunnskap** fra YouTube med ett klikk, det gjør alt **søkbart på tvers** av alle kilder, og det **forsker for meg** — gir jeg det en artikkel, finner det relevant kunnskap og skriver en rapport.

## Tre prosjekter, én kunnskapspipeline

Systemet består av tre uavhengige prosjekter som snakker sammen via HTTP:

**Chrome-extensionen** detekterer YouTube-videoer og gir deg en «Summarize»-knapp. Ett klikk sender video-IDen til backend.

**Knowledge API** (documents-vector-search) er en FastAPI-server som eier all indeksering og søk. Den kjører FAISS-vektorsøk og BM25-nøkkelordsøk i parallell, kombinerer resultatene med Reciprocal Rank Fusion, og rerangerer med en cross-encoder. Mer om dette senere.

**Muninn** er AI-agenten som orkestrerer alt. Den henter transkripsjoner, sender dem til Claude for oppsummering, lagrer resultatet som strukturert markdown, og indekserer det i kunnskapsbasen. Den driver også research workbenchen — dashboardet der du kan forske på tvers av alle kildene dine.

```
Chrome Extension ──▶ Muninn (AI-agent) ──▶ Knowledge API (vektorsøk)
  "Summarize"          oppsummerer             indekserer + søker
                       analyserer               13 collections
                       streamer                  10.000+ dokumenter
```

## Fra video til søkbar kunnskap på 30 sekunder

Flyten er enkel. Du er på YouTube og ser en video om, la oss si, streaming tool use i Claude. Du klikker «Summarize» i Chrome-extensionen. Bak kulissene skjer dette:

Extensionen sender video-ID og tittel til muninn. Muninn henter transkripsjonen, sender den til Claude med en oppsummeringsprompt, og Claude returnerer en strukturert markdown-oppsummering med overskrifter, uthevede nøkkelbegreper og kategorisering. Resultatet lagres som en markdown-fil med YAML-frontmatter:

```markdown
---
date: 2026-01-13
url: https://www.youtube.com/watch?v=r65rR5AIwcg
category: ai/claude-code
tags: "ai, claude-code"
---

### Streaming Tool Use Architecture

**Attention heads** beregner hvilke tokens som er relevante
ved å tildele høye vekter til viktige tokens...
```

Filen indekseres i kunnskapsbasen — delt opp i søkbare chunks, embeddet som vektorer, og tilgjengelig via API. Dashboardet åpnes automatisk med en live-strøm av oppsummeringen mens Claude jobber. 30-60 sekunder etter at du klikket, er videoen søkbar for alltid.

I dag har jeg 238 oppsummeringer på tvers av 13 kategorier — fra Claude Code-arkitektur og AI-nyheter til helse og karriere.

## Research workbench: AI som forsker for deg

Dette er den virkelig interessante delen. YouTube-oppsummeringene er nyttige alene, men verdien eksploderer når du kombinerer dem med andre kunnskapskilder.

Research workbenchen er en side i muninn-dashboardet der du limer inn en artikkel, en Jira-sak, eller en vilkårlig tekst — og lar AI forske på den på tvers av alle kildene dine.

Prosessen har tre faser, og alt streames live til nettleseren via Server-Sent Events (SSE):

**Fase 1: Spørringsgenerering.** Claude leser artikkelen din og genererer 3-5 fokuserte søkespørringer. Ikke nøkkelordekstraksjon — faktisk domeneforståelse. Forskjellen er enorm. Gir du systemet en Jira-sak om en EU-forordning, genererer Claude søk som «lovvalg artikkel 13 forordning 883/2004» og «A008 SED utsending flyt» — presise spørringer som treffer relevant dokumentasjon.

**Fase 2: Parallelt søk.** Hver spørring kjøres mot hver valgt collection parallelt. Fem spørringer mot tre collections gir 15 samtidige søk. Resultatene dedupliseres per collection, og de mest relevante beholdes.

**Fase 3: Analyse.** Claude mottar den opprinnelige artikkelen pluss alle søkeresultatene, og skriver en strukturert rapport med funn per kilde, koblinger mellom kildene, og hull i kunnskapen.

Det nyttige her er at systemet kobler kilder du aldri ville ha koblet manuelt. En Jira-sak om SED-mapping kan finne relevante YouTube-videoer om lignende implementeringer, Confluence-dokumentasjon om eksisterende flyt, og Notion-notater fra møter der temaet ble diskutert.

## Hvorfor hybridsøk slår rent vektorsøk

Kjernen i kunnskaps-APIet er et hybridsøk som kombinerer to fundamentalt forskjellige søkemetoder.

**FAISS** (vektorsøk) er god på semantisk likhet. Den forstår at «trygdekoordinering» og «social security coordination» handler om det samme, selv om ordene er helt forskjellige. Men den kan misse eksakte termer som «artikkel 13» eller «A008» — fordi vektorrommet ikke nødvendigvis plasserer slike identifikatorer nær hverandre.

**BM25** (nøkkelordsøk) er det motsatte. Presis på eksakte termer, men forstår ikke synonymer eller semantisk likhet.

**Reciprocal Rank Fusion** (RRF) kombinerer begge. For hvert dokument summeres inversene av rangeringene fra begge søk. Et dokument som scorer høyt i begge metoder får best totalrangering. Et dokument som bare treffer på én metode kommer fortsatt med, men lenger ned i listen.

På toppen av dette kjører en **cross-encoder reranking** — en mer presis modell som rerangerer topp-resultatene og fjerner falske positiver. Den legger til omtrent halvannet sekund latens, men produserer tydelig separerte scorer som gjør det mulig å filtrere bort støy.

Embedding-modellen (`multilingual-e5-base`) støtter over 100 språk. Det betyr at norsk og engelsk innhold søkes likt — en forutsetning for et kunnskapssystem der kildene er på begge språk.

## Domenekunnskap gjør søkene bedre

Et subtilt men viktig designvalg: spørringsgeneratoren bruker botens persona. Muninn er en multi-bot-plattform der hver bot har sin egen personlighet, sine egne verktøy og sine egne kunnskapskilder. Når du velger en bot i research-UIet, populeres relevante collections automatisk, og Claude bruker botens domenekunnskap til å formulere bedre søk.

En personlig assistent-bot søker i YouTube-oppsummeringer, helsedokumenter og karrierenotater. En jobbassistent-bot søker i Confluence, Notion og Jira. Samme research-motor, helt forskjellig kontekst — og dermed forskjellige søk og forskjellige funn.

## Hva som er søkbart i dag

Systemet har i dag 13 collections med over 10 000 dokumenter og rundt 60 000 søkbare chunks:

| Collection | Dokumenter | Kilde |
|-----------|-----------|-------|
| YouTube-oppsummeringer | 238 | Chrome ext → Claude → markdown |
| Notion | 8 425 | Notion API, incremental updates |
| Confluence | 289 | Confluence API |
| Claude Code sessions | 1 220 | Session logs |
| Anthropic docs | — | GitHub/docs |
| Jira | — | Jira API |

Alle collections deler én embedding-modell, noe som sparer omtrent 180 MB RAM per collection. Inkrementelle oppdateringer betyr at nye Notion-sider og Confluence-endringer plukkes opp uten full re-indeksering.

## Lite kode, mye AI

Det mest overraskende med dette prosjektet er hvor lite kode som trengs. Chrome-extensionen er rundt 200 linjer JavaScript. Research-modulen i muninn er rundt 300 linjer TypeScript. Vektorsøk-serveren er rundt 500 linjer Python.

Claude gjør det tunge arbeidet — oppsummering, spørringsgenerering og analyse — mens koden orkestrerer flyten og håndterer data. SSE-strømming, pub/sub for live-oppdateringer, parallelle søk med `Promise.allSettled`, og en in-memory jobbstore med 1-times TTL. Enkle byggeklosser som sammen gir et kraftig verktøy.

Alt kjører lokalt, selvhostet, uten sky-tjenester utover Claude-APIet. Dataene forblir mine.

## Veien videre

Systemet er allerede nyttig i hverdagen, men planen er å utvide det i tre retninger:

**RAG over Claude Code-dokumentasjon.** Indeksere hele Anthropic-dokumentasjonen — API-referanser, Claude Code-guider, cookbook-eksempler — slik at research workbenchen kan finne relevant dokumentasjon automatisk når jeg jobber med Claude-relaterte problemer.

**On-demand indeksering.** I dag trigges YouTube-indeksering fra Chrome-extensionen. Neste steg er å utvide det til Jira-saker, Confluence-sider og vilkårlige nettsider — lim inn en URL, og systemet henter, oppsummerer og indekserer.

**Kunnskapsgraf.** Et graf-lag som kobler konsepter på tvers av collections, slik at systemet forstår at et YouTube-foredrag om «tool use» henger sammen med Anthropic-dokumentasjon om det samme temaet.

## Oppsummering

Det som startet som «jeg vil huske YouTube-videoer» har blitt et personlig kunnskapssystem som fanger, indekserer og kobler kunnskap fra mange kilder.

Kjernearkitekturen er enkel: en Chrome-extension for innfangning, et vektorsøk-API for indeksering og gjenfinning, og en AI-agent som orkestrerer alt og driver research workbenchen. Hybridsøk (FAISS + BM25 + cross-encoder reranking) gir søkeresultater som verken rent semantisk søk eller rent nøkkelordsøk kan matche alene. Og AI-drevet spørringsgenerering med domenekunnskap gjør at systemet finner relevante dokumenter du ikke ville funnet med manuelt søk.

Det viktigste designprinsippet er at AI gjør det tunge arbeidet, mens koden fokuserer på orkestrering. Det holder kodebasen liten, fleksibel og enkel å utvide med nye kilder.

Neste gang du ser en YouTube-video og tenker «dette burde jeg huske» — trykk på knappen. Et halvt minutt senere er det søkbart for alltid.

## Ressurser

- [FAISS — Facebook AI Similarity Search](https://github.com/facebookresearch/faiss)
- [intfloat/multilingual-e5-base — flerspråklig embedding-modell](https://huggingface.co/intfloat/multilingual-e5-base)
- [BAAI/bge-reranker-v2-m3 — cross-encoder reranker](https://huggingface.co/BAAI/bge-reranker-v2-m3)
- [Reciprocal Rank Fusion (RRF) — originalartikkel](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [Server-Sent Events (SSE) — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Claude Code headless mode](https://docs.anthropic.com/en/docs/claude-code)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
