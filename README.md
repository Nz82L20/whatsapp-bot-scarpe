# Bot WhatsApp — Verifica disponibilità scarpe

Bot che risponde ai clienti su WhatsApp controllando la disponibilità di modello e
taglia sul tuo Google Sheets, e notifica un operatore su Telegram quando il cliente
conferma interesse. Zero canoni mensili: gira sulla Cloud API ufficiale di Meta e su
hosting gratuito.

## Come funziona il flusso

1. Il cliente scrive per la prima volta → il bot chiede il modello
2. Il cliente scrive il modello → il bot chiede la taglia
3. Il bot controlla il tuo Google Sheets (tramite Sheety) e risponde con
   disponibilità e prezzo, oppure dice che non è disponibile
4. Se disponibile, chiede al cliente se vuole essere ricontattato
5. Se sì, manda una notifica Telegram all'operatore con un link diretto per
   rispondere al cliente su WhatsApp

## Passaggio 1 — Crea l'app su Meta for Developers

1. Vai su [developers.facebook.com](https://developers.facebook.com), accedi con
   l'account Facebook collegato alla documentazione aziendale già pronta
2. **Le mie app → Crea app → Tipo "Business"**
3. Dentro l'app, aggiungi il prodotto **WhatsApp**
4. Meta ti assegna automaticamente un **numero di telefono di test** gratuito — usalo
   per le prove, prima di passare al tuo numero reale del negozio
5. Nella sezione WhatsApp → **Configurazione API**, copia:
   - il **Token di accesso temporaneo** (dura 24h, va bene per i primi test)
   - il **Phone number ID**

Questi due valori vanno nel file `.env.example` (rinominalo in `.env` quando lo
usi in locale, o incollali come variabili d'ambiente su Render — vedi sotto).

> Per un token permanente (necessario in produzione, quello temporaneo scade),
> dovrai creare un **System User** nel Business Manager e generare un token da lì.
> Te lo mostro quando arriviamo a quel punto.

## Passaggio 2 — Crea il bot Telegram per le notifiche operatore

1. Su Telegram, cerca **@BotFather** e scrivi `/newbot`
2. Segui le istruzioni, alla fine ti dà un **token** (va in `TELEGRAM_BOT_TOKEN`)
3. Cerca il tuo bot appena creato e premi **Start**
4. Per sapere il tuo `chat_id`, apri questo indirizzo nel browser (sostituendo il
   token) subito dopo aver premuto Start:
   `https://api.telegram.org/bot<IL_TUO_TOKEN>/getUpdates`
5. Nel risultato JSON cerca `"chat":{"id": ...}` — quel numero è il tuo
   `TELEGRAM_CHAT_ID`

## Passaggio 3 — Collega il tuo Google Sheets

Se hai già seguito i passaggi precedenti, hai un URL Sheety tipo:
```
https://api.sheety.co/xxxxx/inventarioScarpePulito/inventario
```
Incollalo in `SHEETY_URL` nel file `.env`.

## Passaggio 4 — Testalo in locale (facoltativo ma consigliato)

```bash
npm install
cp .env.example .env
# apri .env e incolla le tue credenziali vere
npm start
```

Il server parte su `http://localhost:3000`. Non riceverà ancora messaggi veri da
WhatsApp finché non è online pubblicamente (passaggio successivo) — ma puoi già
controllare che parta senza errori.

## Passaggio 5 — Metti il bot online gratis (Render)

1. Crea un account su [render.com](https://render.com) (gratuito)
2. Carica questo progetto su un repository GitHub (nuovo repo, carica tutti questi
   file tranne `node_modules` e `.env`)
3. Su Render: **New → Web Service** → collega il repository
4. Impostazioni:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Piano**: Free
5. In **Environment**, aggiungi tutte le variabili che hai nel tuo `.env` (una per
   una, come coppie chiave/valore)
6. Premi **Deploy** — dopo un paio di minuti avrai un URL pubblico tipo
   `https://scarpe-whatsapp-bot.onrender.com`

> Nota sul piano gratuito di Render: il server "si addormenta" dopo 15 minuti di
> inattività e impiega qualche secondo a risvegliarsi al primo messaggio. Per un
> negozio con traffico moderato non è un problema — il cliente aspetta solo
> qualche secondo in più sulla primissima risposta della giornata.

## Passaggio 6 — Collega il webhook su Meta

1. Torna su Meta for Developers → la tua app → WhatsApp → **Configurazione**
2. Nel campo **Callback URL**, metti: `https://tuo-progetto.onrender.com/webhook`
3. Nel campo **Verify token**, metti lo stesso valore che hai messo in
   `WHATSAPP_VERIFY_TOKEN` (una parola a caso, decisa da te)
4. Premi **Verifica e salva** — se tutto è a posto, Meta conferma subito
5. Iscriviti al campo webhook **messages**

## Passaggio 7 — Prova vera

Scrivi un messaggio al numero di test WhatsApp che Meta ti ha assegnato. Dovresti
ricevere la risposta del bot in pochi secondi.

## File del progetto

- `index.js` — tutta la logica del bot (server, conversazione, chiamate API)
- `package.json` — dipendenze del progetto
- `.env.example` — modello delle variabili da configurare (copialo in `.env`)

## Prossimi passi possibili

- Passare dal numero di test al numero WhatsApp reale del negozio (richiede
  verifica del numero nel Business Manager)
- Generare un token permanente invece di quello temporaneo da 24h
- Gestire più modelli scritti con errori di battitura (corrispondenza approssimata)
