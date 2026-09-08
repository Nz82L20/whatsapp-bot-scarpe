require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  SHEETY_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PORT = 3000,
} = process.env;

// -----------------------------------------------------------------
// STATO DELLA CONVERSAZIONE
// Per ogni cliente (numero di telefono) teniamo traccia di dove si
// trova nella conversazione. E' in memoria: se il server si riavvia,
// le conversazioni a meta' si perdono e il cliente riparte da capo.
// Per un piccolo negozio va benissimo; se in futuro serve qualcosa
// di piu' robusto si puo' spostare su un database.
// -----------------------------------------------------------------
const sessioni = new Map();

function nuovaSessione() {
  return { step: 'chiedi_modello', modello: null, taglia: null };
}

// -----------------------------------------------------------------
// 1) VERIFICA DEL WEBHOOK (richiesta da Meta una sola volta, quando
//    colleghi il webhook nel pannello Meta for Developers)
// -----------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verificato con successo');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// -----------------------------------------------------------------
// 2) RICEZIONE DEI MESSAGGI (Meta chiama questo endpoint ogni volta
//    che un cliente scrive al numero WhatsApp del negozio)
// -----------------------------------------------------------------
app.post('/webhook', async (req, res) => {
  // Rispondiamo subito 200 a Meta, per non far scadere la richiesta.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const messaggio = change?.value?.messages?.[0];

    if (!messaggio) return; // notifica di stato (letto/consegnato), non un messaggio vero

    const telefonoCliente = messaggio.from; // es. "50588881234"
    const testo = (messaggio.text?.body || '').trim();

    await gestisciMessaggio(telefonoCliente, testo);
  } catch (errore) {
    console.error('Errore nella gestione del messaggio:', errore);
  }
});

// -----------------------------------------------------------------
// LOGICA DELLA CONVERSAZIONE
// -----------------------------------------------------------------
async function gestisciMessaggio(telefono, testo) {
  let sessione = sessioni.get(telefono);
  if (!sessione) {
    sessione = nuovaSessione();
    sessioni.set(telefono, sessione);
    await inviaMessaggioWhatsApp(
      telefono,
      'Ciao! Benvenuto/a. Dimmi il modello che ti interessa (es. AGATHA-22) e controllo subito la disponibilita.'
    );
    return;
  }

  switch (sessione.step) {
    case 'chiedi_modello': {
      sessione.modello = testo.toUpperCase();
      sessione.step = 'chiedi_taglia';
      await inviaMessaggioWhatsApp(telefono, `Perfetto, ${sessione.modello}. Che taglia ti serve?`);
      break;
    }

    case 'chiedi_taglia': {
      sessione.taglia = testo.replace(',', '.'); // nel caso scrivano 6,5 invece di 6.5
      const risultato = await cercaDisponibilita(sessione.modello, sessione.taglia);

      if (risultato && risultato.quantitàDisponibile > 0) {
        sessione.step = 'chiedi_conferma';
        sessione.trovato = risultato;
        await inviaMessaggioWhatsApp(
          telefono,
          `Si, disponibile! ${sessione.modello} taglia ${sessione.taglia} — prezzo $${risultato.prezzoAlPaioUSD || risultato['prezzoAlPaio (usd)']}.\n\nVuoi che un nostro operatore ti contatti per completare l'acquisto? Rispondi SI o NO.`
        );
      } else {
        sessione.step = 'chiedi_modello';
        await inviaMessaggioWhatsApp(
          telefono,
          `Mi dispiace, al momento non abbiamo il modello ${sessione.modello} in taglia ${sessione.taglia}. Vuoi provare con un altro modello? Scrivimi il nome.`
        );
      }
      break;
    }

    case 'chiedi_conferma': {
      const risposta = testo.toLowerCase();
      if (risposta.startsWith('s')) {
        await notificaOperatoreTelegram(telefono, sessione.modello, sessione.taglia);
        await inviaMessaggioWhatsApp(
          telefono,
          'Perfetto, un operatore ti scrivera a breve per completare l\'acquisto. Grazie!'
        );
      } else {
        await inviaMessaggioWhatsApp(telefono, 'Va bene! Se vuoi controllare un altro modello, scrivimi il nome.');
      }
      sessione.step = 'chiedi_modello';
      break;
    }

    default: {
      sessione.step = 'chiedi_modello';
      await inviaMessaggioWhatsApp(telefono, 'Dimmi pure il modello che ti interessa.');
    }
  }
}

// -----------------------------------------------------------------
// INTERROGAZIONE DEL DATABASE (Sheety -> Google Sheets)
// -----------------------------------------------------------------
async function cercaDisponibilita(modello, taglia) {
  const url = `${SHEETY_URL}?modello=${encodeURIComponent(modello)}&taglia=${encodeURIComponent(taglia)}`;
  const risposta = await fetch(url);
  if (!risposta.ok) {
    console.error('Errore Sheety:', risposta.status, await risposta.text());
    return null;
  }
  const dati = await risposta.json();
  const righe = dati.inventario || [];
  return righe[0] || null; // prendiamo la prima corrispondenza
}

// -----------------------------------------------------------------
// INVIO MESSAGGIO WHATSAPP (Graph API di Meta)
// -----------------------------------------------------------------
async function inviaMessaggioWhatsApp(telefono, testo) {
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'text',
      text: { body: testo },
    }),
  });
}

// -----------------------------------------------------------------
// NOTIFICA TELEGRAM ALL'OPERATORE
// -----------------------------------------------------------------
async function notificaOperatoreTelegram(telefonoCliente, modello, taglia) {
  const linkWhatsApp = `https://wa.me/${telefonoCliente}`;
  const testo =
    `🔔 Nuova richiesta disponibile\n` +
    `Modello: ${modello}\n` +
    `Taglia: ${taglia}\n` +
    `Canale: WhatsApp\n\n` +
    `👉 Rispondi al cliente: ${linkWhatsApp}`;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: testo }),
  });
}

app.get('/', (req, res) => res.send('Bot scarpe attivo.'));

app.listen(PORT, () => console.log(`Server in ascolto sulla porta ${PORT}`));
