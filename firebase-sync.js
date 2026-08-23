// ===== FIREBASE: SYNCHRONIZACJA ARTYKUŁÓW MIĘDZY TELEFONEM A WINDOWS =====
// To NIE zastępuje lokalnego przechowywania (IndexedDB) — to DRUGA, dodatkowa
// droga synchronizacji danych przez internet. Jeśli internet nie działa,
// aplikacja działa normalnie z lokalnymi danymi.

const firebaseConfig = {
  apiKey: "AIzaSyDCSbrJHWX6IGnQxvMtJXM3RSPE3QYkvnI",
  authDomain: "vvblack-doktorat.firebaseapp.com",
  projectId: "vvblack-doktorat",
  storageBucket: "vvblack-doktorat.firebasestorage.app",
  messagingSenderId: "944519044723",
  appId: "1:944519044723:web:ae00ba8645bcb51413d406"
};

let fbApp = null;
let fbDb  = null;

// Inicjalizuje połączenie z Firebase — tylko przy pierwszej potrzebie
// i tylko jeśli biblioteka Firebase zdążyła się załadować.
function fbInit() {
  if (fbApp) return true;
  if (typeof firebase === 'undefined') return false;
  try {
    fbApp = firebase.initializeApp(firebaseConfig);
    fbDb  = firebase.firestore();
    return true;
  } catch (e) {
    // Może być już zainicjalizowane (np. drugie wywołanie)
    try {
      fbApp = firebase.app();
      fbDb  = firebase.firestore();
      return true;
    } catch (e2) {
      console.error('Firebase: błąd inicjalizacji', e2);
      return false;
    }
  }
}

// ── Unikalny identyfikator urządzenia ────────────────────────────────────
// Zapobiega nadpisaniu własnych danych przez synchronizację z tego samego urządzenia.
function getDeviceId() {
  let id = localStorage.getItem('vvblack_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
    localStorage.setItem('vvblack_device_id', id);
  }
  return id;
}

// ── WYSYŁANIE artykułów do Firestore ─────────────────────────────────────
// Zapisuje snapshot całej bazy artykułów do kolekcji 'vvblack_articles'.
// Jeden dokument 'snapshot' — zawsze nadpisywany najnowszą wersją.
async function fbPushArticles() {
  if (!navigator.onLine) return { ok: false, blad: 'offline' };
  if (!fbInit())         return { ok: false, blad: 'firebase_init' };

  try {
    const arts = await idbGet('articles') || [];
    const note = await idbGet('notepad')  || [];

    // Usuń zdjęcia i ogranicz teksty do 500 znaków na blok
    // Firestore limit: 1MB na dokument
    const MAX_BLOCK_TEXT = 500;
    const artsStripped = arts.map(a => ({
      id:         a.id,
      title:      a.title || '',
      link:       a.link  || '',
      date:       a.date  || '',
      addedAt:    a.addedAt || '',
      editedAt:   a.editedAt || '',
      entryType:  a.entryType || 'article',
      wordExported: a.wordExported || false,
      extraLinks: a.extraLinks || [],
      // Bloki: tylko tekst, max 500 znaków, bez zdjęć
      blocks: (a.blocks || [])
        .filter(b => b.type === 'text')
        .map(b => ({ type: 'text', value: (b.value || '').slice(0, MAX_BLOCK_TEXT) }))
    }));

    // Ogranicz łączny rozmiar do 800KB żeby mieć zapas
    const MAX_BYTES = 800 * 1024;
    let payload = JSON.stringify(artsStripped);
    let artsSent = artsStripped;

    if (new Blob([payload]).size > MAX_BYTES) {
      // Jeśli nadal za dużo — wyślij tylko ostatnie 200 artykułów
      artsSent = artsStripped.slice(-200);
      payload = JSON.stringify(artsSent);
    }

    const sizeKB = Math.round(new Blob([payload]).size / 1024);

    await fbDb.collection('vvblack_articles').doc('snapshot').set({
      articles:   payload,
      notepad:    JSON.stringify((note || []).map(b =>
        b.type === 'image' ? { type: 'text', value: '[zdjecie]' } : b
      )),
      updatedAt:  Date.now(),
      deviceId:   getDeviceId(),
      deviceName: navigator.userAgent.includes('Windows') ? 'Desktop' : 'Telefon',
      artCount:   arts.length,
      artSent:    artsSent.length,
      sizeKB:     sizeKB,
    });

    localStorage.setItem('fb_last_push', String(Date.now()));
    return { ok: true, count: arts.length, sent: artsSent.length, sizeKB };
  } catch (e) {
    console.error('Firebase: blad wysylki', e);
    return { ok: false, blad: e.message };
  }
}

// ── POBIERANIE artykułów z Firestore ─────────────────────────────────────
// Pobiera snapshot tylko jeśli jest NOWSZY niż lokalny timestamp ostatniego pobrania.
async function fbPullArticles() {
  if (!navigator.onLine) return { ok: false, blad: 'offline' };
  if (!fbInit())         return { ok: false, blad: 'firebase_init' };

  try {
    const doc = await fbDb.collection('vvblack_articles').doc('snapshot').get();
    if (!doc.exists) return { ok: true, brak: true, msg: 'Brak danych w chmurze' };

    const data = doc.data();

    // Nie pobieraj jeśli to dane z TEGO samego urządzenia
    if (data.deviceId === getDeviceId()) {
      return { ok: true, brak: true, msg: 'Dane już aktualne (to samo urządzenie)' };
    }

    // Nie pobieraj jeśli dane w chmurze są starsze niż lokalne
    const lastPull = parseInt(localStorage.getItem('fb_last_pull') || '0');
    if (data.updatedAt <= lastPull) {
      return { ok: true, brak: true, msg: 'Dane już aktualne' };
    }

    const articles = JSON.parse(data.articles || '[]');
    const notepad  = JSON.parse(data.notepad  || '[]');

    localStorage.setItem('fb_last_pull', String(data.updatedAt));

    return {
      ok: true,
      articles,
      notepad,
      updatedAt:  data.updatedAt,
      deviceName: data.deviceName || 'inne urządzenie',
      artCount:   data.artCount   || articles.length,
    };
  } catch (e) {
    console.error('Firebase: błąd pobierania', e);
    return { ok: false, blad: e.message };
  }
}

// ── Sprawdź status synchronizacji ────────────────────────────────────────
function updateFbStatus() {
  const el = document.getElementById('fbStatus');
  if (!el) return;

  const configured = typeof firebase !== 'undefined';
  const online     = navigator.onLine;
  const lastPush   = localStorage.getItem('fb_last_push');
  const lastPull   = localStorage.getItem('fb_last_pull');

  if (!configured) {
    el.innerHTML = '<span style="color:#f87171;font-size:11px">⚠️ Firebase niedostępny</span>';
    return;
  }
  if (!online) {
    el.innerHTML = '<span style="color:#f59e0b;font-size:11px">📶 Offline</span>';
    return;
  }

  const pushStr = lastPush
    ? new Date(parseInt(lastPush)).toLocaleString('pl-PL')
    : 'nigdy';
  el.innerHTML = `<span style="color:#34d399;font-size:11px">☁️ Ostatnia synchronizacja: ${pushStr}</span>`;
}

// ── Przycisk WYŚLIJ ───────────────────────────────────────────────────────
async function fbSyncPush() {
  const btn = document.getElementById('fbPushBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Wysyłam…'; }

  const wynik = await fbPushArticles();

  if (btn) { btn.disabled = false; btn.textContent = '☁️ Wyślij'; }

  if (wynik.ok) {
    if (typeof toast === 'function')
      toast(`✓ Wysłano ${wynik.count} artykułów (${wynik.sizeKB} KB) — zdjęcia lokalne`);
    updateFbStatus();
  } else {
    const msg = wynik.blad === 'offline'
      ? 'Brak internetu — spróbuj ponownie'
      : 'Błąd wysyłki: ' + wynik.blad;
    if (typeof toast === 'function') toast(msg, false);
  }
}

// ── Przycisk POBIERZ ──────────────────────────────────────────────────────
async function fbSyncPull() {
  const btn = document.getElementById('fbPullBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Sprawdzam…'; }

  const wynik = await fbPullArticles();

  if (btn) { btn.disabled = false; btn.textContent = '⬇️ Pobierz'; }

  if (!wynik.ok) {
    const msg = wynik.blad === 'offline'
      ? 'Brak internetu — spróbuj ponownie'
      : 'Błąd pobierania: ' + wynik.blad;
    if (typeof toast === 'function') toast(msg, false);
    return;
  }

  if (wynik.brak) {
    if (typeof toast === 'function') toast(wynik.msg || 'Dane już aktualne ✓');
    return;
  }

  // Mamy nowsze dane — pytamy czy nadpisać
  const dt = new Date(wynik.updatedAt).toLocaleString('pl-PL');
  const ok = confirm(
    `Znaleziono nowsze artykuły w chmurze.\n\n` +
    `Urządzenie: ${wynik.deviceName}\n` +
    `Data: ${dt}\n` +
    `Liczba artykułów: ${wynik.artCount}\n\n` +
    `Czy zastąpić lokalne dane danymi z chmury?\n` +
    `(lokalne zmiany od tego czasu zostaną utracone)`
  );

  if (!ok) {
    if (typeof toast === 'function') toast('Anulowano — dane lokalne bez zmian');
    return;
  }

  // Zapisz do IndexedDB i odśwież UI
  await idbSet('articles', wynik.articles);
  await idbSet('notepad',  wynik.notepad);

  // Odśwież zmienne w pamięci i UI
  if (typeof articles !== 'undefined') {
    // eslint-disable-next-line no-global-assign
    articles = wynik.articles;
  }
  if (typeof noteBlocks !== 'undefined') {
    // eslint-disable-next-line no-global-assign
    noteBlocks = wynik.notepad.length ? wynik.notepad : [{type:'text',value:''}];
  }

  if (typeof updateCounter    === 'function') updateCounter();
  if (typeof sortAndRenderArts === 'function') sortAndRenderArts();
  else if (typeof renderArts  === 'function') renderArts();
  if (typeof renderNoteBlocks === 'function') renderNoteBlocks();

  if (typeof toast === 'function')
    toast(`✓ Pobrano ${wynik.artCount} artykułów z chmury`);

  updateFbStatus();
}

// ── Automatyczny flush przy powrocie internetu ────────────────────────────
window.addEventListener('online',  () => updateFbStatus());
window.addEventListener('offline', () => updateFbStatus());

// Odśwież status po załadowaniu
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    fbInit();
    updateFbStatus();
  }, 1500);
});
