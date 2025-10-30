import React, { useState, useEffect, useCallback, useRef } from 'react';
import { NavigationContainer, useFocusEffect } from '@react-navigation/native';
import { createBottomTabNavigator, useBottomTabBarHeight } from '@react-navigation/bottom-tabs';

import {
  Provider as PaperProvider,
  Button, Card, Title, Paragraph, TextInput, Chip,
  Portal, Modal, Surface, List, Switch, Divider, IconButton, ActivityIndicator
} from 'react-native-paper';

import { StatusBar } from 'expo-status-bar';
import {
  View, Text, StyleSheet, ScrollView, Alert, Share, Platform, Linking,
  KeyboardAvoidingView, useWindowDimensions
} from 'react-native';

import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

// === Funzione per convertire coordinate in indirizzo ===
export const getAddressFromCoords = async (lat, lon) => {
  try {
    const [place] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
    if (place) {
      return `${place.street || ''} ${place.name || ''}, ${place.city || ''}, ${place.country || ''}`;
    }
  } catch (e) {
    console.log('Errore geocoding:', e);
  }
  return `${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}`;
};

const withTimeout = (p, ms = 8000) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);

const normalizeLatLon = ({ latitude, longitude }) => {
  let lat = Number(latitude);
  let lon = Number(longitude);
  if (typeof latitude === 'string')  lat = parseFloat(latitude.replace(',', '.'));
  if (typeof longitude === 'string') lon = parseFloat(longitude.replace(',', '.'));
  if ((lat > 90 || lat < -90) && lon >= -90 && lon <= 90) {
    const t = lat; lat = lon; lon = t; // swap se invertiti
  }
  return { latitude: lat, longitude: lon };
};

// formatta un indirizzo leggibile da un risultato di reverseGeocodeAsync
const formatAddress = (a) => {
  if (!a) return null;
  const line1 = [a.street || a.name, a.streetNumber].filter(Boolean).join(' ').trim();
  const line2 = [a.city || a.district, a.region].filter(Boolean).join(', ').trim();
  const country = a.country;
  const pieces = [line1 || line2, line2 && line2 !== line1 ? line2 : null, country].filter(Boolean);
  return pieces.join(', ');
};

// --- STORAGE KEYS ---
const STORAGE_ITINERARIES = '@itineraries_v1';
const STORAGE_SETTINGS    = '@camper_settings_v1';
const STORAGE_LAST_GPS    = '@last_gps';
const STORAGE_GEOCACHE    = '@geocache_v1';

// --- utilità storage itinerari ---
const loadStoredItineraries = async () => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_ITINERARIES);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
};

const saveStoredItineraries = async (items) => {
  try {
    await AsyncStorage.setItem(STORAGE_ITINERARIES, JSON.stringify(items));
  } catch {}
};

// --- utilità storage impostazioni ---
const loadStoredSettings = async () => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_SETTINGS);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
};

const saveStoredSettings = async (partial) => {
  try {
    const current = (await loadStoredSettings()) ?? {};
    const merged = { ...current, ...partial };
    await AsyncStorage.setItem(STORAGE_SETTINGS, JSON.stringify(merged));
  } catch {}
};

// === ROUTING UTILITIES ===

const SYNONYMS = {
  cortina: 'cortina d ampezzo',
  "cortina d'ampezzo": 'cortina d ampezzo',
};

// Cache geocoding
const getGeoCache = async () => {
  try { const raw = await AsyncStorage.getItem(STORAGE_GEOCACHE); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
};
const setGeoCache = async (cache) => { try { await AsyncStorage.setItem(STORAGE_GEOCACHE, JSON.stringify(cache)); } catch {} };
const readGeo     = async (key) => (await getGeoCache())[key] ?? null;
const rememberGeo = async (key, val) => { const c = await getGeoCache(); c[key] = val; await setGeoCache(c); };

// Normalizzazione
const toKey = (s = '') => {
  const noAccent = s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return noAccent.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
};

// Levenshtein
const lev = (a, b) => {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
};

// Disambiguazione locale
const disambiguateLocalKey = (raw) => {
  const k = toKey(raw);
  if (!k) return null;
  if (CITY_COORDS[k]) return k;
  if (SYNONYMS[k]) return SYNONYMS[k];

  let bestKey = null, bestScore = -1;
  for (const key of Object.keys(CITY_COORDS)) {
    let score = 0;
    if (key.startsWith(k) || k.startsWith(key)) score = 0.9;
    if (score === 0) {
      const d = lev(k, key);
      const sim = 1 - d / Math.max(k.length, key.length);
      score = sim;
    }
    if (score > bestScore) { bestScore = score; bestKey = key; }
  }
  return bestScore >= 0.6 ? bestKey : null;
};

// Parsing coordinate
const parseLatLon = (s = '') => {
  const m = String(s).trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
};


const isCoordPoint = (p) => p && typeof p === 'object' && 'lat' in p && 'lon' in p;

// parole che indicano punto in città (SOSTA)
// parole che indicano punto urbano → SOSTA
// parole chiave che vogliamo riconoscere come "SOSTA"
// 🔎 parole chiave che fanno trattare la tappa come SOSTA (anche senza civico)
const STOP_KEYWORDS_RE =
  /\b(centro(?:\s+storico)?|centro\s+citt[aà]|stazione(?:\s+centrale)?|staz\.?|fs|ferroviaria|aeroporto|aereoporto|airport|porto|traghetti|ferry|duomo|cattedrale|cathedral|ospedale|hospital|fiera|expo|quartiere\s+fieristico|stadio|universit[aà]|university|politecnico)\b/i;

// 🛣️ tipi di strada → anche questo rende la tappa una SOSTA
const ROAD_TOKENS_RE =
  /\b(via|viale|corso|piazza|piazzetta|piazzale|largo|vicolo|strada|borgo|lungarno|lungomare)\b/i;

// Indizi che il testo è un POI (ponte/piazza/…)
const POI_HINT_RE =
  /\b(ponte|piazza|viale|corso|via|piazzetta|piazzale|largo|vicolo|strada|borgo|lungarno|lungomare|basilica|chiesa|cattedrale|duomo|museo|palazzo|teatro|parco|giardini|porta|rotonda)\b/i;


// 🧭 “centro, Bologna” / “Bologna, centro”
const CITY_CENTER_LEFT_RE  = /^\s*(centro(?:\s+storico)?|centro\s+citt[aà])\s*,\s*(.+)$/i;
const CITY_CENTER_RIGHT_RE = /^(.+?)\s*,\s*(centro(?:\s+storico)?|centro\s+citt[aà])\s*$/i;

// 🗺️ sinonimi/alias per costruire la query POI da passare al geocoder
// === MIGLIORAMENTI PER GEOCODING POI ITALIANI ===

// Aggiorna la lista KEYWORD_QUERIES (sostituisci quella esistente intorno alla riga 145):
const KEYWORD_QUERIES = [
  { base: 'stazione',   re: /\b(stazione(?:\s+centrale)?|staz\.?|fs|ferroviaria|ferrov\.)\b/i },
  { base: 'aeroporto',  re: /\b(aeroporto|aereoporto|airport)\b/i },
  { base: 'porto',      re: /\b(porto|traghetti|ferry|harbo[u]?r)\b/i },
  { base: 'duomo',      re: /\b(duomo|cattedrale|cathedral)\b/i },
  { base: 'ospedale',   re: /\b(ospedale|hospital)\b/i },
  { base: 'fiera',      re: /\b(fiera|expo|quartiere\s+fieristico)\b/i },
  { base: 'stadio',     re: /\b(stadio)\b/i },
  { base: 'università', re: /\b(universit[aà]|university|politecnico)\b/i },
  { base: 'piazzale',   re: /\b(piazzale)\b/i }, // AGGIUNTO per "Piazzale Roma"
];

// Aggiorna CITY_COORDS con POI specifici (sostituisci quello esistente intorno alla riga 47):
const CITY_COORDS = {
  roma:                { lat: 41.9028, lon: 12.4964, label: 'Roma' },
  milano:              { lat: 45.4642, lon:  9.1900, label: 'Milano' },
  torino:              { lat: 45.0703, lon:  7.6869, label: 'Torino' },
  napoli:              { lat: 40.8518, lon: 14.2681, label: 'Napoli' },
  bologna:             { lat: 44.4949, lon: 11.3426, label: 'Bologna' },
  genova:              { lat: 44.4056, lon:  8.9463, label: 'Genova' },
  firenze:             { lat: 43.7696, lon: 11.2558, label: 'Firenze' },
  pisa:                { lat: 43.7160, lon: 10.3966, label: 'Pisa' },
  venezia:             { lat: 45.4408, lon: 12.3155, label: 'Venezia' },
  manduria:            { lat: 40.3987, lon: 17.6393, label: 'Manduria' },
  'cortina d ampezzo': { lat: 46.5405, lon: 12.1357, label: "Cortina d'Ampezzo" },

  // === POI SPECIFICI HARDCODED ===
  // Bologna
  'stazione centrale bologna':     { lat: 44.5058, lon: 11.3430, label: 'Stazione Centrale, Bologna' },
  'bologna stazione centrale':     { lat: 44.5058, lon: 11.3430, label: 'Stazione Centrale, Bologna' },
  'stazione bologna':              { lat: 44.5058, lon: 11.3430, label: 'Stazione Centrale, Bologna' },
  'bologna stazione':              { lat: 44.5058, lon: 11.3430, label: 'Stazione Centrale, Bologna' },

  // Venezia
  'piazzale roma venezia':         { lat: 45.4384, lon: 12.3194, label: 'Piazzale Roma, Venezia' },
  'venezia piazzale roma':         { lat: 45.4384, lon: 12.3194, label: 'Piazzale Roma, Venezia' },
  'stazione venezia':              { lat: 45.4408, lon: 12.3186, label: 'Stazione Santa Lucia, Venezia' },
  'venezia stazione':              { lat: 45.4408, lon: 12.3186, label: 'Stazione Santa Lucia, Venezia' },

  // Milano
  'stazione centrale milano':      { lat: 45.4862, lon: 9.2051, label: 'Stazione Centrale, Milano' },
  'milano centrale':               { lat: 45.4862, lon: 9.2051, label: 'Stazione Centrale, Milano' },
  'milano stazione':               { lat: 45.4862, lon: 9.2051, label: 'Stazione Centrale, Milano' },
  'stazione milano':               { lat: 45.4862, lon: 9.2051, label: 'Stazione Centrale, Milano' },

  // Roma
  'stazione termini roma':         { lat: 41.9010, lon: 12.5028, label: 'Stazione Termini, Roma' },
  'roma termini':                  { lat: 41.9010, lon: 12.5028, label: 'Stazione Termini, Roma' },
  'stazione roma':                 { lat: 41.9010, lon: 12.5028, label: 'Stazione Termini, Roma' },
  'roma stazione':                 { lat: 41.9010, lon: 12.5028, label: 'Stazione Termini, Roma' },

  // Firenze - aggiungi queste righe
  'stazione firenze':              { lat: 43.7760, lon: 11.2477, label: 'Stazione Santa Maria Novella, Firenze' },
  'firenze stazione':              { lat: 43.7760, lon: 11.2477, label: 'Stazione Santa Maria Novella, Firenze' },
  'santa maria novella firenze':   { lat: 43.7760, lon: 11.2477, label: 'Stazione Santa Maria Novella, Firenze' },
  'firenze santa maria novella':   { lat: 43.7760, lon: 11.2477, label: 'Stazione Santa Maria Novella, Firenze' },  // AGGIUNGI QUESTA
  'stazione centrale firenze':     { lat: 43.7760, lon: 11.2477, label: 'Stazione Santa Maria Novella, Firenze' },  // AGGIUNGI QUESTA
  'firenze centrale':              { lat: 43.7760, lon: 11.2477, label: 'Stazione Santa Maria Novella, Firenze' },  // AGGIUNGI QUESTA

  // Napoli
  'stazione napoli':               { lat: 40.8530, lon: 14.2742, label: 'Stazione Centrale, Napoli' },
  'napoli centrale':               { lat: 40.8530, lon: 14.2742, label: 'Stazione Centrale, Napoli' },
  'napoli stazione':               { lat: 40.8530, lon: 14.2742, label: 'Stazione Centrale, Napoli' },

  // Torino
  'stazione torino':               { lat: 45.0611, lon: 7.6758, label: 'Stazione Porta Nuova, Torino' },
  'torino stazione':               { lat: 45.0611, lon: 7.6758, label: 'Stazione Porta Nuova, Torino' },
  'porta nuova torino':            { lat: 45.0611, lon: 7.6758, label: 'Stazione Porta Nuova, Torino' },
  'torino porta nuova':            { lat: 45.0611, lon: 7.6758, label: 'Stazione Porta Nuova, Torino' },

  // Genova
  'stazione genova':               { lat: 44.4072, lon: 8.9324, label: 'Stazione Brignole, Genova' },
  'genova stazione':               { lat: 44.4072, lon: 8.9324, label: 'Stazione Brignole, Genova' },
  'genova brignole':               { lat: 44.4072, lon: 8.9324, label: 'Stazione Brignole, Genova' },
  'porto genova':                  { lat: 44.4037, lon: 8.9298, label: 'Porto, Genova' },
  'genova porto':                  { lat: 44.4037, lon: 8.9298, label: 'Porto, Genova' },

  // Pisa
  'stazione pisa':                 { lat: 43.7087, lon: 10.3969, label: 'Stazione Centrale, Pisa' },
  'pisa stazione':                 { lat: 43.7087, lon: 10.3969, label: 'Stazione Centrale, Pisa' },
  'torre pisa':                    { lat: 43.7230, lon: 10.3966, label: 'Torre di Pisa, Pisa' },
  'pisa torre':                    { lat: 43.7230, lon: 10.3966, label: 'Torre di Pisa, Pisa' },
  'aeroporto pisa':                { lat: 43.6839, lon: 10.3927, label: 'Aeroporto Galilei, Pisa' },
  'pisa aeroporto':                { lat: 43.6839, lon: 10.3927, label: 'Aeroporto Galilei, Pisa' },

  // Verona
  'stazione verona':               { lat: 45.4283, lon: 10.9821, label: 'Stazione Porta Nuova, Verona' },
  'verona stazione':               { lat: 45.4283, lon: 10.9821, label: 'Stazione Porta Nuova, Verona' },
  'verona porta nuova':            { lat: 45.4283, lon: 10.9821, label: 'Stazione Porta Nuova, Verona' },

  // Bari
  'stazione bari':                 { lat: 41.1087, lon: 16.8667, label: 'Stazione Centrale, Bari' },
  'bari stazione':                 { lat: 41.1087, lon: 16.8667, label: 'Stazione Centrale, Bari' },
  'bari centrale':                 { lat: 41.1087, lon: 16.8667, label: 'Stazione Centrale, Bari' },
  'porto bari':                    { lat: 41.1335, lon: 16.8698, label: 'Porto, Bari' },
  'bari porto':                    { lat: 41.1335, lon: 16.8698, label: 'Porto, Bari' },

  // Palermo
  'stazione palermo':              { lat: 38.1217, lon: 13.3655, label: 'Stazione Centrale, Palermo' },
  'palermo stazione':              { lat: 38.1217, lon: 13.3655, label: 'Stazione Centrale, Palermo' },
  'palermo centrale':              { lat: 38.1217, lon: 13.3655, label: 'Stazione Centrale, Palermo' },
  'porto palermo':                 { lat: 38.1330, lon: 13.3501, label: 'Porto, Palermo' },
  'palermo porto':                 { lat: 38.1330, lon: 13.3501, label: 'Porto, Palermo' },
  'aeroporto palermo':             { lat: 38.1759, lon: 13.0910, label: 'Aeroporto Falcone-Borsellino, Palermo' },

  // Catania
  'stazione catania':              { lat: 37.5065, lon: 15.0866, label: 'Stazione Centrale, Catania' },
  'catania stazione':              { lat: 37.5065, lon: 15.0866, label: 'Stazione Centrale, Catania' },
  'catania centrale':              { lat: 37.5065, lon: 15.0866, label: 'Stazione Centrale, Catania' },
  'aeroporto catania':             { lat: 37.4668, lon: 15.0664, label: 'Aeroporto Fontanarossa, Catania' },

  // Rimini
  'stazione rimini':               { lat: 44.0692, lon: 12.5664, label: 'Stazione, Rimini' },
  'rimini stazione':               { lat: 44.0692, lon: 12.5664, label: 'Stazione, Rimini' },

  // Livorno
  'porto livorno':                 { lat: 43.5473, lon: 10.3105, label: 'Porto, Livorno' },
  'livorno porto':                 { lat: 43.5473, lon: 10.3105, label: 'Porto, Livorno' },
  'stazione livorno':              { lat: 43.5446, lon: 10.3158, label: 'Stazione Centrale, Livorno' },

  // Ancona
  'stazione ancona':               { lat: 43.6047, lon: 13.5075, label: 'Stazione, Ancona' },
  'ancona stazione':               { lat: 43.6047, lon: 13.5075, label: 'Stazione, Ancona' },
  'porto ancona':                  { lat: 43.6232, lon: 13.5073, label: 'Porto, Ancona' },
  'ancona porto':                  { lat: 43.6232, lon: 13.5073, label: 'Porto, Ancona' },

  // Civitavecchia
  'porto civitavecchia':           { lat: 42.0954, lon: 11.7882, label: 'Porto, Civitavecchia' },
  'civitavecchia porto':           { lat: 42.0954, lon: 11.7882, label: 'Porto, Civitavecchia' },
  'stazione civitavecchia':        { lat: 42.0919, lon: 11.7973, label: 'Stazione, Civitavecchia' },
};
// ⛳ accetto un POI solo se non è troppo lontano dal centro città
const MAX_POI_DISTANCE_KM = 35;


const isSostaLabel = (raw='') =>
  /\d/.test(raw) || STOP_KEYWORDS_RE.test(raw) || ROAD_TOKENS_RE.test(raw);

// Normalizza per URL (preferisci lat,lon)
const toNavVal = (p) => {
  // Preferisci l'indirizzo (label/fullLabel) se disponibile; ricadi sul lat,lon in mancanza.
  if (isCoordPoint(p)) {
    return p.label || p.fullLabel || `${p.lat},${p.lon}`;
  }
  return String(p);
};

// Prendi solo le SOSTE tra i punti intermedi
const pickSosteWaypoints = (pts = []) => {
  const mids = pts.slice(1, -1);
  return mids.filter((p) => {
    const text = isCoordPoint(p)
      ? [p.raw, p.fullLabel, p.label].filter(Boolean).join(' ')
      : String(p);
    return isSostaLabel(text);
  });
};


// === Shared helpers: points + maps ===
const getPointsShared = (primary, secondary) => {
  if (Array.isArray(primary?.coords)) {
    const clean = primary.coords.filter(Boolean);
    if (clean.length >= 2) return clean;
  }
  if (Array.isArray(primary?.points) && primary.points.length >= 2) return primary.points;
  const fromPrimary = (primary?.route || '')
    .split('→')
    .map(s => (s || '').trim())
    .filter(Boolean);
  if (fromPrimary.length >= 2) return fromPrimary;

  if (Array.isArray(secondary?.points) && secondary.points.length >= 2) return secondary.points;
  const fromSecondary = (secondary?.route || '')
    .split('→')
    .map(s => (s || '').trim())
    .filter(Boolean);
  return fromSecondary.length >= 2 ? fromSecondary : null;
};


const buildGoogleMapsURL = (pts=[]) => {
  const originVal = toNavVal(pts[0]);
  const destVal   = toNavVal(pts[pts.length - 1]);
  const waypointVals = pickSosteWaypoints(pts).map(toNavVal);

  // Per garantire la VISUALIZZAZIONE DELL'ITINERARIO con waypoint,
  // usiamo SEMPRE la URL web su Android (le intent native ignorano i waypoint).
  const native = Platform.select({
    ios: `comgooglemaps://?saddr=${encodeURIComponent(originVal)}&daddr=${encodeURIComponent(destVal)}${waypointVals.length ? `&waypoints=${encodeURIComponent(waypointVals.join('|'))}` : ''}`,
    default: null
  });

  const web = `https://www.google.com/maps/dir/?api=1`
            + `&travelmode=driving&dir_action=navigate`
            + `&origin=${encodeURIComponent(originVal)}`
            + `&destination=${encodeURIComponent(destVal)}`
            + (waypointVals.length ? `&waypoints=${encodeURIComponent(waypointVals.join('|'))}` : '');
  return { native, web };
};

const buildWazeURL = (pts=[]) => {
  const destVal   = toNavVal(pts[pts.length - 1]);
  const sostaVals = pickSosteWaypoints(pts).map(toNavVal);
  const target    = sostaVals[0] ?? destVal;

  const useLL = /^-?\d+(\.\d+)?,\-?\d+(\.\d+)?$/.test(target);
  const native = useLL ? `waze://?ll=${target}&navigate=yes`
                       : `waze://?q=${encodeURIComponent(target)}&navigate=yes`;
  const web    = `https://waze.com/ul?${useLL ? `ll=${target}` : `q=${encodeURIComponent(target)}`}&navigate=yes`;
  return { native, web };
};

const openInMapsFromPoints = async (pts, app='auto') => {
  if (!pts || pts.length < 2) { Alert.alert('Percorso mancante', 'Calcola prima un percorso.'); return; }

  const tryOpen = async (nativeUrl, webUrl) => {
    if (nativeUrl) {
      try { 
        const can = await Linking.canOpenURL(nativeUrl);
        if (can) { await Linking.openURL(nativeUrl); return true; }
      } catch {}
    }
    try { await Linking.openURL(webUrl); return true; } catch {}
    return false;
  };

  if (app === 'google') {
    const { native, web } = buildGoogleMapsURL(pts);
    // Prima il WEB (mostra percorso e waypoints), poi eventuale native
    let ok = await tryOpen(null, web);
    if (!ok) ok = await tryOpen(native, web);
    if (!ok) Alert.alert('Errore', 'Non riesco ad aprire Google Maps.');
    return;
  }
  if (app === 'waze') {
    const { native, web } = buildWazeURL(pts);
    const ok = await tryOpen(native, web);
    if (!ok) Alert.alert('Errore', 'Non riesco ad aprire Waze.');
    return;
  }

  // auto: prefer native app if available, fall back gracefully
  const g = buildGoogleMapsURL(pts);
  const w = buildWazeURL(pts);
  // Mostra prima Google WEB per vedere bene l'itinerario con waypoint
  let tried = await tryOpen(null, g.web);
  if (tried) return;
  // Poi Waze (solo destinazione / prima sosta)
  tried = await tryOpen(w.native, w.web);
  if (tried) return;
  // Infine Google native (se disponibile)
  tried = await tryOpen(g.native, g.web);
  if (!tried) Alert.alert('Errore', 'Non riesco ad aprire né Waze né Google Maps.');
};
// === end shared helpers ===


// Geocoding online
const geocodeCityOnline = async (rawName, { countryBias = 'it' } = {}) => {
  // se sembra un POI (ponte/piazza/… e niente numero), prepara query “furba”
  const preferPoi = POI_HINT_RE.test(rawName) && !/\d/.test(rawName);

  // “Città, POI” → “POI, Città” (generico, non solo Firenze)
  const smartQuery = (() => {
    const parts = String(rawName).split(',').map(s => s.trim()).filter(Boolean);
    if (preferPoi && parts.length === 2) {
      const [p1, p2] = parts;
      // se il primo sembra città (nessun indizio POI) e il secondo sembra POI → inverti
      const looksCityFirst = !POI_HINT_RE.test(p1) && POI_HINT_RE.test(p2);
      if (looksCityFirst) return `${p2}, ${p1}`;
    }
    return rawName;
  })();

  const params = new URLSearchParams({
    format: 'jsonv2',
    addressdetails: '1',
    // se cerco un POI prendo più candidati e poi scelgo io
    limit: preferPoi ? '5' : '1',
    q: smartQuery,
  });
  if (countryBias) params.set('countrycodes', countryBias);

  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'CamperNavigatorPro/1.0 (webmaster@pierluigi.it)',
        'Accept-Language': 'it',
      },
    });
    if (!res.ok) return null;

    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;


    // Migliora la funzione geocodeCityOnline (sostituisci il blocco di preferenze POI intorno alla riga 224):
    // se è una ricerca POI, preferisci risultati specifici in quest'ordine
    let d = data[0];
    if (preferPoi && data.length > 1) {
      // 1° priorità: stazioni ferroviarie per ricerche di "stazione"
      const isStationSearch = /stazione|station|centrale|fs|ferroviaria/i.test(rawName);
      if (isStationSearch) {
        const byRailway = data.find(x => 
          (x?.class === 'railway' && x?.type === 'station') ||
          (x?.class === 'public_transport' && x?.type === 'station') ||
          /stazione|station|centrale/i.test(x?.display_name || '')
        );
        if (byRailway) d = byRailway;
      }
      
      // 2° priorità: altri POI specifici
      if (!isStationSearch || !d || d === data[0]) {
        const byType = data.find(x => /^(bridge|square|pedestrian|road|footway)$/.test(x?.type || ''));
        const byClass = data.find(x => /^(tourism|historic|amenity|highway|public_transport)$/.test(x?.class || ''));
        d = byType || byClass || d;
      }
    }

    const addr = d.address || {};
    const cityLike = addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || addr.county || '';
    const roadLike = addr.road || addr.pedestrian || addr.residential || addr.footway || addr.path || '';
    const house    = addr.house_number || '';

    const labelFromAddr = [[roadLike, house].filter(Boolean).join(' '), cityLike].filter(Boolean).join(', ');
    const displayParts  = (d.display_name || String(rawName)).split(',').map(s => s.trim());
    const labelFallback = displayParts.slice(0, 2).join(', ');
    const label = labelFromAddr || labelFallback;

    const fullLabel = d.display_name || [[roadLike, house].filter(Boolean).join(' '), cityLike, addr.state, addr.postcode, addr.country].filter(Boolean).join(', ');

    return { lat: parseFloat(d.lat), lon: parseFloat(d.lon), label, fullLabel };
  } catch {}
  return null;
};

// Haversine
const haversineKm = (a, b) => {
  const R = 6371;
  const dLat = (Math.PI / 180) * (b.lat - a.lat);
  const dLon = (Math.PI / 180) * (b.lon - a.lon);
  const lat1 = (Math.PI / 180) * a.lat;
  const lat2 = (Math.PI / 180) * b.lat;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
};

// Risolvi città
const resolveCityObj = async (rawName) => {
  if (!rawName) return null;

  // Coordinate dirette
  const direct = parseLatLon(rawName);
  if (direct) return direct;

  // Posizione corrente
  const k0 = toKey(rawName);
  if (!k0) return null;
  if (k0 === 'posizione corrente') {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_LAST_GPS);
      if (raw) {
        const gps = JSON.parse(raw);
        if (gps?.lat && gps?.lon) return gps;
      }
    } catch {}
  }
  // --- "centro, Città" / "Città, centro" → usa il baricentro della città ---
  {
    const s = String(rawName || '');
    let cityRaw = null;

    let m = s.match(CITY_CENTER_LEFT_RE);   // "centro, Bologna"
    if (m) cityRaw = m[2].trim();

    if (!cityRaw) {                         // "Bologna, centro"
      m = s.match(CITY_CENTER_RIGHT_RE);
      if (m) cityRaw = m[1].trim();
    }

    if (cityRaw) {
      // risolvi la città "pura" e usa quelle coordinate come centro
      const base = await resolveCityObj(cityRaw);
      if (base) {
        const ret = {
          lat: base.lat,
          lon: base.lon,
          label: `Centro, ${base.label}`,
          fullLabel: `Centro, ${base.fullLabel || base.label}`,
        };
        try { await rememberGeo(toKey(s), ret); } catch {}
        return ret;
      }
    }
  }

  //  - e i casi di "centro" con e senza virgola
  const detectKeywordCity = (s) => {
    const txt = String(s || '').trim();
    if (!txt) return null;

    // 3.1 — prima i casi CENTRO in tutte le varianti
    let m = txt.match(/^\s*(centro(?:\s+storico)?|centro\s+citt[aà])\s*,\s*(.+)$/i);
    if (m) return { base: 'centro', city: m[2].trim(), isCenter: true };
    m = txt.match(/^(.+?)\s*,\s*(centro(?:\s+storico)?|centro\s+citt[aà])\s*$/i);
    if (m) return { base: 'centro', city: m[1].trim(), isCenter: true };
    m = txt.match(/^\s*(centro(?:\s+storico)?|centro\s+citt[aà])\s+(.+)$/i);
    if (m) return { base: 'centro', city: m[2].trim(), isCenter: true };
    m = txt.match(/^(.+?)\s+(centro(?:\s+storico)?|centro\s+citt[aà])\s*$/i);
    if (m) return { base: 'centro', city: m[1].trim(), isCenter: true };

    // 3.2 — poi gli altri keyword
    for (const { base, re } of KEYWORD_QUERIES) {
      let mm = txt.match(new RegExp(`^\s*(${re.source})\s*,\s*(.+)$`, 'i')); // "keyword, città"
      if (mm) return { base, city: mm[2].trim(), isCenter: false };

      mm = txt.match(new RegExp(`^(.+?)\s*,\s*(${re.source})\s*$`, 'i'));    // "città, keyword"
      if (mm) return { base, city: mm[1].trim(), isCenter: false };

      mm = txt.match(new RegExp(`^\s*(${re.source})\s+(.+)$`, 'i'));          // "keyword città"
      if (mm) return { base, city: mm[2].trim(), isCenter: false };

      mm = txt.match(new RegExp(`^(.+?)\s+(${re.source})\s*$`, 'i'));         // "città keyword"
      if (mm) return { base, city: mm[1].trim(), isCenter: false };
    }

    return null;
  };

// --- keyword + città (stazione/aeroporto/porto/duomo/ospedale/fiera/stadio/università) ---
{
  const hit = detectKeywordCity(rawName);
  if (hit) {
    const { base, city, isCenter } = hit;

    // 1) "centro" → usa il baricentro della città
    if (base === 'centro' || isCenter) {
      const baseCity = await resolveCityObj(city); // risolve la città "pura"
      if (baseCity) {
        const ret = {
          lat: baseCity.lat,
          lon: baseCity.lon,
          label: `Centro, ${baseCity.label}`,
          fullLabel: `Centro, ${baseCity.fullLabel || baseCity.label}`,
        };
        try { await rememberGeo(toKey(rawName), ret); } catch {}
        return ret;
      }
    }

    // 2) POI specifico → prova "base city", poi valida distanza dal centro
    const baseCity = await resolveCityObj(city); // per controllo distanza/fallback
    const poi = await geocodeCityOnline(`${base} ${city}`, { countryBias: 'it' });

    if (poi) {
      if (baseCity && typeof MAX_POI_DISTANCE_KM === 'number') {
        const dist = haversineKm(
          { lat: baseCity.lat, lon: baseCity.lon },
          { lat: poi.lat,     lon: poi.lon }
        );
        if (dist > MAX_POI_DISTANCE_KM) {
          // troppo lontano (es. Imola per Bologna) → fallback al centro città
          const ret = {
            lat: baseCity.lat,
            lon: baseCity.lon,
            label: `${base[0].toUpperCase() + base.slice(1)} (centro città), ${baseCity.label}`,
            fullLabel: `${base} ${baseCity.fullLabel || baseCity.label}`,
          };
          try { await rememberGeo(toKey(rawName), ret); } catch {}
          return ret;
        }
      }

      // POI ok nella città giusta
      const ret = {
        lat: poi.lat,
        lon: poi.lon,
        label: `${base[0].toUpperCase() + base.slice(1)}, ${poi.label || city}`,
        fullLabel: poi.fullLabel || `${base} ${city}`,
      };
      try { await rememberGeo(toKey(rawName), ret); } catch {}
      return ret;
    }

    // 3) Nessun POI trovato → almeno centro città
    if (baseCity) {
      const ret = {
        lat: baseCity.lat,
        lon: baseCity.lon,
        label: `${base[0].toUpperCase() + base.slice(1)} (centro città), ${baseCity.label}`,
        fullLabel: `${base} ${baseCity.fullLabel || baseCity.label}`,
      };
      try { await rememberGeo(toKey(rawName), ret); } catch {}
      return ret;
    }
  }
}

// Dizionario locale
  const localKey = disambiguateLocalKey(rawName);
  if (localKey) return CITY_COORDS[localKey];

  // Cache geocoding (smart)
  const cached = await readGeo(k0);
  const hasNumber = /\d/.test(String(rawName));
  if (cached) {
    const cachedHasNumber = /\d/.test(String(cached.fullLabel || cached.label || ''));
    // Se l'input ha un civico ma la cache no, ignora la cache e vai online
    if (!hasNumber || cachedHasNumber) {
      return cached;
    }
    // altrimenti continua e prova a cercare un risultato più preciso online
  }

  // Online (prima Italia, poi globale)
  let online = await geocodeCityOnline(rawName, { countryBias: 'it' });
  if (!online) {
    online = await geocodeCityOnline(rawName, { countryBias: null }); // ricerca globale
  }
  if (online) {
    const onlineHasNumber = /\d/.test(String(online.fullLabel || online.label || ''));
    // Aggiorna cache se più precisa (o se non c'era cache)
    if (onlineHasNumber || !cached) {
      await rememberGeo(k0, online);
    }
    return online;
  }

  return null;

};

const legKmObj = (a, b) => (a && b) ? haversineKm(a, b) : 300;

// === Funzione per semplificare gli indirizzi troppo lunghi ===
function simplifyAddress(placeOrString) {
  if (!placeOrString) return '';

  let s = '';
  if (typeof placeOrString === 'object') {
    // Se è un oggetto geocodificato, prova i campi principali
    s = [
      placeOrString.name || placeOrString.street || '',
      placeOrString.city || placeOrString.town || placeOrString.village || '',
      placeOrString.region || placeOrString.state || '',
      placeOrString.postalCode || placeOrString.postcode || '',
      placeOrString.country || ''
    ].filter(Boolean).join(', ');
  } else {
    s = String(placeOrString);
  }

  // 🔹 Rimuove quartieri, distretti e parole lunghe inutili
  s = s
    .replace(/Municipio.*?,/gi, '')
    .replace(/Quartiere.*?,/gi, '')
    .replace(/Distrito.*?,/gi, '')
    .replace(/District.*?,/gi, '')
    .replace(/Sector.*?,/gi, '')
    .replace(/Area.*?,/gi, '')
    .replace(/Casco.*?,/gi, '')
    .replace(/Villa.*?,/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 🔹 Taglia dopo massimo 3 parti (es. Via, Città, Regione)
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  return parts.slice(0, 3).join(', ');
}

// === Calcolo percorso con velocità e consumi personalizzati ===
const calculateRouteSmart = async (
  start,
  end,
  waypoints = [],
  speedKmh = 100,
  consumptionPer100km = 12,
  dieselPrice = 1.55
) => {
  const v = Math.max(1, Number(speedKmh) || 100);
  const rawPoints = [start, ...waypoints.filter(w => w && w.trim()), end];

  // risolvi indirizzi (geocoding)
  const resolved = await Promise.all(rawPoints.map(resolveCityObj));

  // semplifica i nomi per ogni punto
  const labels = resolved.map((o, i) => {
    if (o?.place) return simplifyAddress(o.place);
    const raw = o?.fullLabel || o?.label || rawPoints[i];
    return simplifyAddress(raw);
  });

  const coords = resolved.map((o, i) =>
    o
      ? {
          lat: o.lat,
          lon: o.lon,
          label: labels[i],     // già semplificato
          fullLabel: labels[i], // stesso testo breve
          raw: rawPoints[i],
        }
      : null
  );

  const legsText = [];
  const segments = [];
  let totalKm = 0;
  const unresolved = [];

  for (let i = 0; i < resolved.length - 1; i++) {
    const a = resolved[i];
    const b = resolved[i + 1];
    const km = legKmObj(a, b);
    totalKm += km;

    const durSec = Math.round((km / v) * 3600);
    segments.push({
      from: labels[i],
      to: labels[i + 1],
      km: Math.round(km * 10) / 10,
      durationSec: durSec,
    });

    legsText.push(`Segui verso ${labels[i + 1]} per ${Math.round(km)} km`);
    if (!a || !b) unresolved.push(`${labels[i]} → ${labels[i + 1]}`);
  }

  const durationSec = Math.round((totalKm / v) * 3600);
  const fuelLiters = (totalKm / 100) * consumptionPer100km;
  const fuelCost = fuelLiters * dieselPrice;

  return {
    distance: Math.round(totalKm) * 1000,
    duration: durationSec,
    route: labels.join(' → '),
    instructions: [`Parti da ${labels[0]}`, ...legsText, 'Arrivo a destinazione'],
    segments,
    points: labels,
    coords,
    unresolved,
    speedKmh: v,
    fuelLiters: Math.round(fuelLiters * 10) / 10,
    fuelCost: Math.round(fuelCost * 100) / 100,
    consumptionPer100km,
    dieselPrice,
  };
};

// Utility condivisa per parsing route
const parsePointsFromRoute = (routeStr) =>
  (routeStr || '').split('→').map(s => (s || '').trim()).filter(Boolean);

// Fallback Web con Nominatim (OpenStreetMap) se il geocoder nativo non ritorna nulla
const reverseGeocodeHuman = async ({ latitude, longitude }) => {
  try {
    if (Platform.OS !== 'web') {
      const places = await withTimeout(
        Location.reverseGeocodeAsync({ latitude, longitude }),
        5000
      );
      if (places?.[0]) {
        const s = formatAddress(places[0]);
        if (s) return s;
      }
    }
  } catch (_) {}

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&zoom=18&accept-language=it`;
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      if (j.display_name) return j.display_name;
      if (j.address) {
        const { road, house_number, city, town, village, municipality, state, country } = j.address;
        const l1 = [road, house_number].filter(Boolean).join(' ');
        const l2 = [city || town || village || municipality, state].filter(Boolean).join(', ');
        const human = [l1 || l2, l2 && l2 !== l1 ? l2 : null, country].filter(Boolean).join(', ');
        if (human) return human;
      }
    }
  } catch (_) {}

  return null;
};

// --- ROUTE SCREEN ---
const RouteScreen = ({ camperSettings, onRouteCalculated }) => {
  const [startLocation, setStartLocation] = useState('');
  const [endLocation, setEndLocation] = useState('');
  const [waypoints, setWaypoints] = useState([]);
  const [routeResult, setRouteResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [startCoords, setStartCoords] = useState(null); // { latitude, longitude }
  const [startText, setStartText] = useState('');

  // Coord per destinazione selezionata da un POI (lat/lon). Se definito, sarà usato per la navigazione e il calcolo
  const [endCoords, setEndCoords] = useState(null);

  // --- stati mancanti per gestione aree sosta ---
  const [showSostaAreas, setShowSostaAreas] = useState({});
  const [radiusKm, setRadiusKm] = useState({});
  const [results, setResults] = useState({});
  const [loadingIdx, setLoadingIdx] = useState(null);
  const cacheRef = useRef(new Map());

  // stati per la destinazione:
  const [showDestinationSosta, setShowDestinationSosta] = useState(false);
  const [destinationRadiusKm, setDestinationRadiusKm] = useState('25');
  const [destinationResults, setDestinationResults] = useState([]);
  const [loadingDestination, setLoadingDestination] = useState(false);

  // Stato per la finestra modale che mostra i risultati delle aree sosta.
  // Quando non è null, viene mostrata una finestra con l'elenco delle aree sosta
  // per una tappa specifica o per la destinazione finale.
  // Esempi: { type: 'waypoint', index: 0 } o { type: 'destination' }
  const [sostaModal, setSostaModal] = useState(null);

  const timerRef = useRef(null);

  const clearPending = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setLoading(false);
  };

  useEffect(() => {
    clearPending();
    setRouteResult(null);
  }, [startLocation, endLocation, waypoints]);

  useEffect(() => {
    return () => clearPending();
  }, []);

const useCurrentPosition = async () => {
  try {
    setLocating(true);

    // 1) Permessi
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permesso negato', 'Abilita la posizione per usare il mirino.');
      return null;
    }

    // 2) Posizione veloce (cache recente)
    let best = await Location.getLastKnownPositionAsync({ maxAge: 60_000 }).catch(() => null);

    // 3) Posizione precisa con timeout
    const precise = await withTimeout(
      Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        mayShowUserSettingsDialog: true,
        maximumAge: 10_000,
      }),
      8000
    ).catch(() => null);

    if (precise) best = precise;
    if (!best?.coords) {
      Alert.alert('Posizione non disponibile', 'Attiva il GPS o imposta una posizione nell’emulatore.');
      return null;
    }

    // 4) Coordinate normalizzate
    const { latitude, longitude } = normalizeLatLon(best.coords);
    const coordsText = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;

    // 5) Prova nativo; se non trova nulla, fai fallback Web
    let display = coordsText;
    let foundHuman = false;
    try {
      const places = await withTimeout(
        Location.reverseGeocodeAsync({ latitude, longitude }),
        5000
      );
      if (places?.[0]) {
        const human = formatAddress(places[0]);
        if (human) { display = human; foundHuman = true; }
      }
    } catch (_) {}

    if (!foundHuman) {
      const humanWeb = await reverseGeocodeHuman({ latitude, longitude });
      if (humanWeb) display = humanWeb;
    }

    // 6) Aggiorna stati + persisti
    setStartCoords({ latitude, longitude });
    setStartLocation(display);
    setStartText(display);

    const gps = { latitude, longitude, label: display, timestamp: Date.now() };
    await AsyncStorage.setItem(STORAGE_LAST_GPS, JSON.stringify(gps));

    return gps;
  } catch (e) {
    Alert.alert('Errore', 'Impossibile ottenere la posizione.');
    return null;
  } finally {
    setLocating(false);
  }
};

  const addWaypoint = () => setWaypoints((w) => [...w, '']);
  const updateWaypoint = (idx, v) => setWaypoints((w) => w.map((x, i) => (i === idx ? v : x)));
  const removeWaypoint = (idx) => setWaypoints((w) => w.filter((_, i) => i !== idx));

  // Geocoding avanti
const geocode = async (q) => {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'CamperApp/1.0 (contact: you@example.com)' } });
  const j = await r.json();
  return Array.isArray(j) && j[0] ? { lat: +j[0].lat, lon: +j[0].lon } : null;
};

// Reverse geocoding per etichetta “umana” quando scegli un POI
const reverseGeocode = async (lat, lon) => {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'CamperApp/1.0 (contact: you@example.com)' } });
  const j = await r.json();
  return j?.display_name || null;
};

//==================================================================================================
// Overpass: motorhome_stopover + caravan_site nel raggio

const overpassSosta = async (lat, lon, rKm) => {
  const rM = Math.round(rKm * 1000);
  const q = `
    [out:json][timeout:40];
    (
      node["amenity"="motorhome_stopover"](around:${rM},${lat},${lon});
      way["amenity"="motorhome_stopover"](around:${rM},${lat},${lon});
      relation["amenity"="motorhome_stopover"](around:${rM},${lat},${lon});

      node["tourism"~"caravan_site|camp_site"](around:${rM},${lat},${lon});
      way["tourism"~"caravan_site|camp_site"](around:${rM},${lat},${lon});
      relation["tourism"~"caravan_site|camp_site"](around:${rM},${lat},${lon});

      node["motorcaravan"="yes"](around:${rM},${lat},${lon});
      way["motorcaravan"="yes"](around:${rM},${lat},${lon});
      relation["motorcaravan"="yes"](around:${rM},${lat},${lon});

      node["motorhome"="yes"](around:${rM},${lat},${lon});
      way["motorhome"="yes"](around:${rM},${lat},${lon});
      relation["motorhome"="yes"](around:${rM},${lat},${lon});

      node["caravan"="yes"](around:${rM},${lat},${lon});
      way["caravan"="yes"](around:${rM},${lat},${lon});
      relation["caravan"="yes"](around:${rM},${lat},${lon});

      node["parking:caravan"="yes"](around:${rM},${lat},${lon});
      way["parking:caravan"="yes"](around:${rM},${lat},${lon});
      relation["parking:caravan"="yes"](around:${rM},${lat},${lon});

      node["highway"="rest_area"]["caravan"="yes"](around:${rM},${lat},${lon});
      way["highway"="rest_area"]["caravan"="yes"](around:${rM},${lat},${lon});
      relation["highway"="rest_area"]["caravan"="yes"](around:${rM},${lat},${lon});
    );
    out center tags;
  `;
  const resp = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'CamperApp/1.0 (contact: you@example.com)'
    },
    body: `data=${encodeURIComponent(q)}`
  });
  const data = await resp.json();
  const list = (data?.elements || []).map((el) => {
    const c = el.center || el; // se è un node ha già lat/lon
    return {
      id: `${el.type}/${el.id}`,
      name: el.tags?.name,
      lat: c.lat,
      lon: c.lon,
      tags: el.tags
    };
  });
  return list;
};

//====================================================================================

// Lancia la ricerca per una tappa + raggio
const findSostaAreas = async (label, idx, rStr) => {
  const q = (label || '').trim();
  if (!q) return;
  const rKm = Math.max(1, parseInt(rStr ?? radiusKm[idx] ?? '25', 10) || 25);
  const key = `${q.toLowerCase()}|${rKm}`;

  if (cacheRef.current.has(key)) {
    setResults((p) => ({ ...p, [idx]: cacheRef.current.get(key) }));
    return;
  }

  try {
    setLoadingIdx(idx);
    const g = await geocode(q);
    if (!g) { setResults((p) => ({ ...p, [idx]: [] })); return; }
    const pois = await overpassSosta(g.lat, g.lon, rKm);
    cacheRef.current.set(key, pois);
    setResults((p) => ({ ...p, [idx]: pois }));
  } finally {
    setLoadingIdx(null);
  }
};

// Quando tocchi un risultato: scrivi l’indirizzo nella tappa
const applyPoiToWaypoint = async (poi, idx) => {
  const addr = await reverseGeocode(poi.lat, poi.lon);
  // Costruisci l'etichetta evitando di duplicare il nome se è già all'inizio dell'indirizzo
  let label;
  if (poi.name && addr) {
    const name = String(poi.name).trim();
    const address = String(addr).trim();
    // Se l'indirizzo inizia con il nome (ignorando differenze di maiuscole/minuscole), non ripetere il nome
    if (address.toLowerCase().startsWith(name.toLowerCase())) {
      label = address;
    } else {
      label = `${name} – ${address}`;
    }
  } else if (addr) {
    label = addr;
  } else if (poi.name) {
    label = `${poi.name} (${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)})`;
  } else {
    label = `${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}`;
  }

  setWaypoints((prev) => prev.map((w, i) => (i === idx ? label : w)));
  // opzionale: chiudi lista risultati dopo la scelta
  setShowSostaAreas((prev) => ({ ...prev, [idx]: false }));
};

// Aggiungi questa funzione per cercare aree sosta vicino alla destinazione:
const findDestinationSostaAreas = async (label, rStr) => {
  const q = (label || '').trim();
  if (!q) return;
  const rKm = Math.max(1, parseInt(rStr ?? destinationRadiusKm ?? '25', 10) || 25);
  const key = `dest_${q.toLowerCase()}|${rKm}`;

  if (cacheRef.current.has(key)) {
    setDestinationResults(cacheRef.current.get(key));
    return;
  }

  try {
    setLoadingDestination(true);
    const g = await geocode(q);
    if (!g) { setDestinationResults([]); return; }
    const pois = await overpassSosta(g.lat, g.lon, rKm);
    cacheRef.current.set(key, pois);
    setDestinationResults(pois);
  } finally {
    setLoadingDestination(false);
  }
};

// Aggiungi questa funzione per applicare un POI alla destinazione:
const applyPoiToDestination = async (poi) => {
  const addr = await reverseGeocode(poi.lat, poi.lon);
  // Costruisci l'etichetta evitando di duplicare il nome se è già all'inizio dell'indirizzo
  let label;
  if (poi.name && addr) {
    const name = String(poi.name).trim();
    const address = String(addr).trim();
    if (address.toLowerCase().startsWith(name.toLowerCase())) {
      label = address;
    } else {
      label = `${name} – ${address}`;
    }
  } else if (addr) {
    label = addr;
  } else if (poi.name) {
    label = `${poi.name} (${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)})`;
  } else {
    label = `${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}`;
  }
  setEndLocation(label);
  // Memorizza le coordinate selezionate per evitare errori di geocoding e usare lat/lon nei calcoli
  setEndCoords({ lat: poi.lat, lon: poi.lon });
  setShowDestinationSosta(false); // Chiudi la lista dopo la selezione
};

  const actuallyCalculate = async () => {
    clearPending();
    setLoading(true);
    try {
      // Usa l'indirizzo inserito per la partenza se disponibile; altrimenti ricadi sulle coordinate o su un fallback
      const start = startLocation.trim() || (startCoords && startCoords.latitude && startCoords.longitude
        ? `${startCoords.latitude},${startCoords.longitude}`
        : (waypoints[0]?.trim() || 'Roma'));
      // Per la destinazione preferisci sempre l'indirizzo inserito; ricadi sulle coordinate solo se non presente testo
      const end = endLocation.trim() || (endCoords ? `${endCoords.lat},${endCoords.lon}` : '');
      const normWaypoints = waypoints.map(w => (w || '').trim()).filter(Boolean);

      await new Promise(r => setTimeout(r, 150));

      const result = await calculateRouteSmart(
        start, 
        end, 
        normWaypoints, 
        camperSettings.speed,
        camperSettings.consumption || 12.0,
        camperSettings.dieselPrice || 1.55
      );
      setRouteResult(result);
      onRouteCalculated && onRouteCalculated(result);

      if (result.unresolved?.length) {
        Alert.alert(
          'Attenzione',
          `Alcune tratte non sono state riconosciute e sono state stimate (300 km):\n• ${result.unresolved.join('\n• ')}`
        );
      }

      Alert.alert(
        'Percorso Calcolato! 🎉',
        `Distanza: ${(result.distance / 1000).toFixed(1)} km\nTempo: ${Math.floor(result.duration / 3600)}h ${Math.floor((result.duration % 3600) / 60)}min\nVelocità media: ${result.speedKmh} km/h\n⛽ Consumo: ${result.fuelLiters}L (€${result.fuelCost})`,
        [
          { text: 'OK' },
          { text: 'Salva Itinerario', onPress: () => saveItinerary(result) },
        ]
      );
    } finally {
      setLoading(false);
      timerRef.current = null;
    }
  };

  const handleCalculateRoute = async () => {
    if (!endLocation.trim()) {
      Alert.alert('Errore', 'Inserisci la destinazione');
      return;
    }
    if (!startLocation.trim()) {
      Alert.alert(
        'Partenza mancante',
        'Vuoi usare la tua posizione attuale o inserirla manualmente?',
        [
          { text: 'Inserisco manualmente', style: 'cancel' },
          {
            text: 'Usa la mia posizione',
            onPress: async () => {
              const lbl = await useCurrentPosition();
              if (lbl) actuallyCalculate();
            },
          },
        ]
      );
      return;
    }

    actuallyCalculate();
  };

  const saveItinerary = async (route) => {
    try {
      const existing = (await loadStoredItineraries()) ?? [];
      const now = new Date();
      const item = {
        id: Date.now(),
        name: `Percorso ${route.route}`,
        route: route.route,
        distance: `${(route.distance / 1000).toFixed(0)} km`,
        duration: `${Math.floor(route.duration / 3600)}h ${Math.floor((route.duration % 3600) / 60)}min`,
        speed: `${route.speedKmh} km/h`,
        fuel: route.fuelLiters ? `${route.fuelLiters}L` : undefined,
        cost: route.fuelCost ? `€${route.fuelCost}` : undefined,
        date: now.toLocaleDateString('it-IT'),
      };
      const updated = [item, ...existing];
      await saveStoredItineraries(updated);
      Alert.alert('Salvato!', 'Itinerario salvato in "I Miei Itinerari"');
    } catch {
      Alert.alert('Errore', 'Impossibile salvare l\'itinerario');
    }
  };

// RouteScreen: usa SEMPRE routeResult (non lastRoute)
  const getPoints = () => getPointsShared(routeResult, null);

  const openInGoogleMaps = async () => {
  const pts = getPoints();
  if (!pts) { Alert.alert('Percorso mancante', 'Calcola prima un percorso.'); return; }
  await openInMapsFromPoints(pts, 'google');
};

  const openInWaze = async () => {
  const pts = getPoints();
  if (!pts) { Alert.alert('Percorso mancante', 'Calcola prima un percorso.'); return; }
  // Nota: Waze calcola SEMPRE dal punto attuale del telefono
  await openInMapsFromPoints(pts, 'waze');
};

  const chooseNavigation = () => {
    if (Platform.OS === 'web') {
      openInGoogleMaps();
      return;
    }

    Alert.alert(
      'Apri navigazione',
      'Scegli l\'app da usare',
      [
        { text: 'Google Maps', onPress: openInGoogleMaps },
        { text: 'Waze', onPress: openInWaze },
        { text: 'Annulla', style: 'cancel' },
      ],
      { cancelable: true }
    );
  };

  return (
    <ScrollView style={styles.container}>
      <Card style={styles.card}>
        <Card.Content>
          <Title>🗺️ Pianifica Percorso</Title>
          <Paragraph>Crea itinerari ottimizzati per il tuo camper</Paragraph>

          <TextInput
            mode="outlined"
            label="Partenza"
            value={startLocation}
            onChangeText={setStartLocation}
            placeholder="es. Roma, Milano, Torino"
            style={styles.input}
            left={<TextInput.Icon icon="flag" />}
          />

          <View style={styles.quickActions}>
            <IconButton
              icon={locating ? 'progress-clock' : 'crosshairs-gps'} // icona “in attesa”
              size={22}
              onPress={useCurrentPosition}
              disabled={locating}                                  // usa locating, non loading
              style={styles.iconOnly}
              accessibilityLabel="Usa la mia posizione"
            />

            <Button
              mode="outlined"
              compact
              icon="pencil-outline"
              onPress={() => { setStartLocation(''); setStartCoords(null); }} // pulisco anche le coords
              style={styles.manualButton}
            >
              Inserisco manualmente
            </Button>
          </View>

{/* inizio Pulsante aggiungi tappa */}

          {waypoints.map((waypoint, index) => (
            <View key={index} style={{ marginBottom: 12 }}>
              <TextInput
                mode="outlined"
                label={`Tappa ${index + 1}`}
                value={waypoint}
                onChangeText={(v) => updateWaypoint(index, v)}
                placeholder="Tappa intermedia (opzionale)"
                style={styles.input}
                left={<TextInput.Icon icon="map-marker" />}
              />

              {!!waypoint.trim() && (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    marginTop: -6,
                    marginBottom: 0,
                    gap: 8,
                  }}
                >
                  <Switch
                    value={!!showSostaAreas[index]}
                    onValueChange={(value) => {
                      setShowSostaAreas((p) => ({ ...p, [index]: value }));
                      if (value) {
                        findSostaAreas(waypoint, index);
                        setSostaModal({ type: 'waypoint', index });
                      }
                    }}
                  />
                  <Text style={{ fontSize: 12 }}>Area Sosta</Text>
                  <TextInput
                    mode="outlined"
                    keyboardType="numeric"
                    value={String(radiusKm[index] ?? '25')}
                    onChangeText={(v) =>
                      setRadiusKm((p) => ({ ...p, [index]: v.replace(/[^\d]/g, '') }))
                    }
                    style={{ width: 90 }}
                    right={<TextInput.Affix text="km" />}
                    label="Raggio"
                  />
                  <Button
                    compact
                    onPress={() => removeWaypoint(index)}
                    labelStyle={{ fontSize: 12 }}
                    icon="close"
                  >
                    Cancella
                  </Button>
                  {loadingIdx === index && <ActivityIndicator />}
                </View>
              )}
            </View>
          ))}

          <Button mode="outlined" onPress={addWaypoint} style={styles.addWaypointButton} icon="plus">
            Aggiungi Tappa
          </Button>

{/* Fine Pulsante aggiungi tappa */}


{/* inizio Pulsante destinazione */}

            <TextInput
                        mode="outlined"
                        label="Destinazione"
                        value={endLocation}
                        onChangeText={(v) => {
                          // aggiorna testo destinazione e resetta le coordinate memorizzate
                          setEndLocation(v);
                          setEndCoords(null);
                        }}
                        placeholder="es. Milano, Torino, Napoli"
                        style={styles.input}
                        left={<TextInput.Icon icon="flag-checkered" />}
                      />

                      {/* Controlli area sosta destinazione - sotto il campo destinazione */}
                      {!!endLocation.trim() && (
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            marginTop: -6,
                            marginBottom: 12,
                            gap: 8,
                          }}
                        >
                          <Switch
                            value={showDestinationSosta}
                            onValueChange={(value) => {
                              setShowDestinationSosta(value);
                              if (value) {
                                findDestinationSostaAreas(endLocation);
                                setSostaModal({ type: 'destination' });
                              }
                            }}
                          />
                          <Text style={{ fontSize: 12 }}>Area Sosta</Text>
                          <TextInput
                            mode="outlined"
                            keyboardType="numeric"
                            value={destinationRadiusKm}
                            onChangeText={(v) => setDestinationRadiusKm(v.replace(/[^\d]/g, ''))}
                            style={{ width: 90 }}
                            right={<TextInput.Affix text="km" />}
                            label="Raggio"
                          />
                          <Button
                            compact
                            onPress={() => {
                              setEndLocation('');
                              setEndCoords(null);
                              setShowDestinationSosta(false);
                              setDestinationResults([]);
                            }}
                            labelStyle={{ fontSize: 12 }}
                            icon="close"
                          >
                            Cancella
                          </Button>
                          {loadingDestination && <ActivityIndicator />}
                        </View>
                      )}

{/* Fine Pulsante destinazione */}

          <Button
            mode="contained"
            onPress={handleCalculateRoute}
            loading={loading}
            style={styles.button}
            icon="directions"
            disabled={!endLocation.trim()}
          >
            {loading ? 'Calcolo in corso...' : 'Calcola Percorso'}
          </Button>
        </Card.Content>
      </Card>

      <Card style={styles.card}>
        <Card.Content>
          <Title>🚐 Configurazione Camper</Title>
                      <View style={styles.dimensionsContainer}>
            <Chip icon="arrow-up-down">H: {camperSettings.height}m</Chip>
            <Chip icon="arrow-left-right">L: {camperSettings.width}m</Chip>
            <Chip icon="weight">P: {camperSettings.weight}t</Chip>
            <Chip icon="arrow-expand-horizontal">Lun: {camperSettings.length}m</Chip>
            <Chip icon="speedometer">V: {camperSettings.speed} km/h</Chip>
            <Chip icon="gas-station">⛽ {camperSettings.consumption}L/100km</Chip>
            <Chip icon="currency-eur">€{camperSettings.dieselPrice}/L</Chip>
          </View>
          <Paragraph style={styles.hint}>Vai in Impostazioni per modificare dimensioni, velocità e consumi</Paragraph>
</Card.Content>
      </Card>

      {routeResult && (
        <Card style={styles.card}>
          <Card.Content>
            <Title>✅ Percorso Calcolato</Title>
            <Paragraph>📍 {routeResult.route}</Paragraph>
            <Paragraph>📏 Distanza: {(routeResult.distance / 1000).toFixed(1)} km</Paragraph>
            <Paragraph>
              ⏱️ Tempo stimato: {Math.floor(routeResult.duration / 3600)}h {Math.floor((routeResult.duration % 3600) / 60)}min
            </Paragraph>
            <Paragraph>🚚 Velocità media: {routeResult.speedKmh} km/h</Paragraph>
            {routeResult.fuelLiters && (
              <>
                <Paragraph>⛽ Consumo stimato: {routeResult.fuelLiters} litri</Paragraph>
                <Paragraph>💰 Costo carburante: €{routeResult.fuelCost}</Paragraph>
              </>
            )}

            {routeResult.segments?.length > 0 && (
              <>
                <Divider style={{ marginVertical: 8 }} />
                <Title style={{ fontSize: 18, marginBottom: 8 }}>Segmenti dettagliati</Title>
                {routeResult.segments.map((s, idx) => {
                  const h = Math.floor(s.durationSec / 3600);
                  const m = Math.floor((s.durationSec % 3600) / 60);
                  return (
                    <View key={idx} style={{ marginBottom: 10 }}>
                      <Paragraph>{`--- SEGMENTO ${idx + 1} ---`}</Paragraph>
                      <Paragraph>{`📍 Da: ${s.from}`}</Paragraph>
                      <Paragraph>{`📍 A: ${s.to}`}</Paragraph>
                      <Paragraph>{`📏 Distanza: ${s.km.toFixed(1)} km`}</Paragraph>
                      <Paragraph>{`⏱️ Durata: ${h}h ${m}m`}</Paragraph>
                    </View>
                  );
                })}
              </>
            )}

{/* Nel RouteScreen, modifica i pulsanti nella sezione routeActions: */}

            <View style={styles.routeActions}>
              <Button
                mode="contained"
                onPress={openInGoogleMaps}
                style={styles.routeButton}
                icon="google-maps"  // Cambiato da MaterialCommunityIcons component a stringa
              >
                {/* Rimuovi il testo o lascia solo "Maps" */}
                Maps
              </Button>

              <Button
                mode="contained"
                onPress={openInWaze}
                style={styles.routeButton}
                icon="waze"  // Cambiato da MaterialCommunityIcons component a stringa
              >
                {/* Rimuovi il testo o lascia solo "Waze" */}
                Waze
              </Button>

              <Button
                mode="outlined"
                onPress={() => saveItinerary(routeResult)}
                style={styles.routeButton}
                icon="content-save"
              >
                Salva
              </Button>
            </View>
          </Card.Content>
        </Card>
      )}

      {/* Modale per la selezione delle aree sosta */}
      <Portal>
        {sostaModal && (
          <Modal
            visible={true}
            onDismiss={() => setSostaModal(null)}
            style={styles.modalOverlay}
            contentContainerStyle={styles.modal}
          >
            <Surface style={styles.modalSurface}>
              <Title>
                {sostaModal.type === 'destination'
                  ? 'Seleziona area sosta destinazione'
                  : 'Seleziona area sosta'}
              </Title>
              {((sostaModal.type === 'waypoint' && loadingIdx === sostaModal.index) ||
                (sostaModal.type === 'destination' && loadingDestination)) ? (
                <ActivityIndicator style={{ marginVertical: 12 }} />
              ) : (
                <>
                  {((sostaModal.type === 'waypoint'
                    ? (results[sostaModal.index] ?? [])
                    : destinationResults) ?? []).length > 0 ? (
                    <ScrollView style={{ maxHeight: 400 }}>
                      {(sostaModal.type === 'waypoint'
                        ? results[sostaModal.index]
                        : destinationResults
                      ).slice(0, 20).map((item) => (
                        <Card
                          key={item.id}
                          style={{ marginVertical: 6 }}
                          onPress={() => {
                            if (sostaModal.type === 'destination') {
                              applyPoiToDestination(item);
                            } else {
                              applyPoiToWaypoint(item, sostaModal.index);
                            }
                            setSostaModal(null);
                          }}
                        >
                          <Card.Title
                            title={item.name || ''}
                            subtitle={`${item.lat.toFixed(5)}, ${item.lon.toFixed(5)} · Tocca per selezionare`}
                          />
                          
<Card.Content>
  <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
    {!!item.tags?.fee && <Chip icon="cash-multiple" style={{ margin: 2 }}>Tariffa: {item.tags.fee}</Chip>}
    {!!item.tags?.power_supply && <Chip icon="flash" style={{ margin: 2 }}>Corrente</Chip>}
    {!!item.tags?.water_point && <Chip icon="water" style={{ margin: 2 }}>Acqua</Chip>}
    {!!item.tags?.toilets && <Chip icon="toilet" style={{ margin: 2 }}>Servizi</Chip>}
    {!!item.tags?.shower && <Chip icon="shower-head" style={{ margin: 2 }}>Docce</Chip>}
    {!!item.tags?.waste_disposal && <Chip icon="delete" style={{ margin: 2 }}>Scarico</Chip>}
  </View>
</Card.Content>

                        </Card>
                      ))}
                    </ScrollView>
                  ) : (
                    <Text style={{ marginVertical: 8 }}>
                      Nessuna area sosta trovata nel raggio selezionato.
                    </Text>
                  )}
                </>
              )}
              
<View style={styles.modalActions}>
                <Button onPress={() => setSostaModal(null)} style={styles.modalButton}>
                  Annulla
                </Button>
              </View>
            </Surface>
          </Modal>
        )}
      </Portal>

    </ScrollView>
  );
};

// --- NAVIGATION SCREEN ---
const NavigationScreen = ({ lastRoute }) => {
  const [isNavigating, setIsNavigating] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const timerRef = useRef(null);

  const steps = Array.isArray(lastRoute?.instructions) ? lastRoute.instructions : [];
  const total = steps.length;

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };
  
  useEffect(() => clearTimer, []);

  useEffect(() => {
    clearTimer();
    setIsNavigating(false);
    setCurrentStep(0);
  }, [lastRoute?.route]);

  const startNavigation = () => {
    if (!total) {
      Alert.alert('Nessun percorso', 'Calcola prima un percorso nella tab "Pianifica Percorso".');
      return;
    }
    setIsNavigating(true);
    timerRef.current = setInterval(() => {
      setCurrentStep((prev) => {
        if (prev >= total - 1) {
          clearTimer();
          setIsNavigating(false);
          Alert.alert('🎉 Arrivo!', 'Hai raggiunto la destinazione!');
          return prev;
        }
        return prev + 1;
      });
    }, 3000);
  };

  const stopNavigation = () => {
    clearTimer();
    setIsNavigating(false);
    setCurrentStep(0);
  };

  const getPoints = () => getPointsShared(routeResult, lastRoute);

  // --- Map/Waze openers (Navigation screen) ---
  const openInGoogleMaps = async () => {
    try {
      const routeStr = lastRoute?.route || '';
      if (!routeStr) {
        Alert.alert('Percorso mancante', 'Calcola prima un percorso.');
        return;
      }
      const enc = encodeURIComponent;
      // Se abbiamo indirizzi salvati
      const origin = lastRoute.startAddress || (lastRoute.startCoords ? `${lastRoute.startCoords.latitude},${lastRoute.startCoords.longitude}` : '');
      const dest = lastRoute.endAddress || (lastRoute.endCoords ? `${lastRoute.endCoords.latitude},${lastRoute.endCoords.longitude}` : '');
      const url = `https://www.google.com/maps/dir/?api=1&origin=${enc(origin)}&destination=${enc(dest)}&travelmode=driving`;
      Linking.openURL(url);
    } catch (e) {
      Alert.alert('Errore', 'Non riesco ad aprire Google Maps.');
    }
  };

  const openInWaze = async () => {
    try {
      const dest = lastRoute?.endCoords
        ? `${lastRoute.endCoords.latitude},${lastRoute.endCoords.longitude}`
        : (lastRoute?.endAddress || '');
      if (!dest) {
        Alert.alert('Percorso mancante', 'Calcola prima un percorso.');
        return;
      }
      const enc = encodeURIComponent;
      const nativeUrl = `waze://?q=${enc(dest)}&navigate=yes`;
      const webUrl = `https://waze.com/ul?q=${enc(dest)}&navigate=yes`;
      const can = await Linking.canOpenURL('waze://');
      Linking.openURL(can ? nativeUrl : webUrl);
    } catch (e) {
      Alert.alert('Errore', 'Non riesco ad aprire Waze.');
    }
  };

  return (
    <View style={styles.centerContainer}>
      <Card style={styles.card}>
        <Card.Content>
          <Title>🧭 Navigazione Turn-by-Turn</Title>

          {total ? (
            <>
              {isNavigating ? (
                <>
                  <Title style={styles.navigationInstruction}>
                    {steps[currentStep] || '...'}
                  </Title>
                  <Paragraph>Passo {currentStep + 1} di {total}</Paragraph>
                  <Button mode="outlined" onPress={stopNavigation} style={styles.button} icon="stop">
                    Stop Navigazione
                  </Button>
                </>
              ) : (
                <>
                  <Paragraph>Tap su "Parti" per seguire le istruzioni del tuo ultimo percorso calcolato.</Paragraph>
                  <Button mode="contained" onPress={startNavigation} style={styles.button} icon="play">
                    Parti
                  </Button>
                </>
              )}

              <Divider style={styles.divider} />
              <View style={styles.routeActions}>
                <Button mode="contained" onPress={openInGoogleMaps} style={styles.routeButton} icon="map">
                  Apri in Google Maps
                </Button>
                <Button mode="outlined" onPress={openInWaze} style={styles.routeButton} icon="navigation">
                  Apri in Waze
                </Button>
              </View>
            </>
          ) : (
            <>
              <Paragraph>Qui vedrai le istruzioni dopo aver calcolato un percorso.</Paragraph>
              <Button
                mode="contained"
                onPress={() => Alert.alert('Nessun percorso', 'Vai su "Pianifica Percorso" e calcola un itinerario.')}
                style={styles.button}
              >
                Calcola un percorso
              </Button>
            </>
          )}
        </Card.Content>
      </Card>
    </View>
  );
};

// --- Helper conferma cross-platform ---
const confirmDelete = (title, message) => {
  if (Platform.OS === 'web') {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Annulla', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Elimina', style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
};

// --- ITINERARIES SCREEN ---
const ItinerariesScreen = () => {
  const [itineraries, setItineraries] = useState([]);

  const ensureLoaded = useCallback(async () => {
    const stored = await loadStoredItineraries();
    if (stored && Array.isArray(stored)) {
      setItineraries(stored);
    } else {
      const demo = [
        { id: 1, name: 'Viaggio Roma-Torino', route: 'Roma → Torino', distance: '669 km', duration: '6h 30min', speed: '100 km/h', fuel: '80.3L', cost: '€124.47', date: '24/08/2025' },
        { id: 2, name: 'Tour del Nord', route: 'Milano → Torino → Genova', distance: '320 km', duration: '4h 15min', speed: '80 km/h', fuel: '38.4L', cost: '€59.52', date: '23/08/2025' },
      ];
      setItineraries(demo);
      await saveStoredItineraries(demo);
    }
  }, []);

  useEffect(() => { ensureLoaded(); }, [ensureLoaded]);
  useFocusEffect(useCallback(() => { ensureLoaded(); }, [ensureLoaded]));

const shareItinerary = async (it) => {
 try {
   const pts = parsePointsFromRoute(it.route);
   const enc = encodeURIComponent;

   let mapsUrl = '';
   if (pts.length >= 2) {
     const origin = pts[0];
     const destination = pts[pts.length - 1];
     const waypoints = pts.slice(1, -1);
     mapsUrl =
       `https://www.google.com/maps/dir/?api=1` +
       `&origin=${enc(origin)}` +
       `&destination=${enc(destination)}` +
       `&travelmode=driving` +
       (waypoints.length ? `&waypoints=${enc(waypoints.join('|'))}` : '');
   }

      const text =
        `🚐 ${it.name}\n` +
        `📍 ${it.route}\n` +
        `📏 ${it.distance} • ⏱️ ${it.duration}` +
        (it.speed ? ` • 🚐 ${it.speed}` : '') +
        (it.fuel && it.cost ? ` • ⛽ ${it.fuel} (${it.cost})` : '') +
        (mapsUrl ? `\n\n🌍 Apri in Maps: ${mapsUrl}` : '') +
        `\n\nCondiviso da Camper Navigator Pro`;

      const waApp = `whatsapp://send?text=${enc(text)}`;
      const waWeb = `https://wa.me/?text=${enc(text)}`;

      if (Platform.OS === 'web') {
        await Linking.openURL(waWeb);
        return;
      }

      const can = await Linking.canOpenURL('whatsapp://send?text=');
      await Linking.openURL(can ? waApp : waWeb);
    } catch {
      try {
        await Share.share({ 
          message: `🚐 ${it.name}\n📍 ${it.route}\n📏 ${it.distance} • ⏱️ ${it.duration}${it.speed ? ` • 🚐 ${it.speed}` : ''}${it.fuel && it.cost ? ` • ⛽ ${it.fuel} (${it.cost})` : ''}`, 
          title: it.name 
        });
      } catch {
        Alert.alert('Errore', 'Impossibile condividere l\'itinerario.');
      }
    }
  };

  const deleteItinerary = async (id) => {
    const ok = await confirmDelete('Elimina Itinerario', 'Sei sicuro di voler eliminare questo itinerario?');
    if (!ok) return;
    setItineraries((prev) => {
      const updated = prev.filter((x) => String(x.id) !== String(id));
      saveStoredItineraries(updated);
      return updated;
    });
  };


// --- AGGIUNGI QUESTO ---
const openInGoogleMapsFromRoute = async (routeStr) => {
  const pts = parsePointsFromRoute(routeStr);
  if (pts.length < 2) {
    Alert.alert('Errore', 'Itinerario non valido.');
    return;
  }

  const origin = pts[0];
  const destination = pts[pts.length - 1];
  const waypoints = pts.slice(1, -1);
  const enc = encodeURIComponent;

  const url =
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${enc(origin)}` +
    `&destination=${enc(destination)}` +
    `&travelmode=driving` +
    (waypoints.length ? `&waypoints=${enc(waypoints.join('|'))}` : '');

  try {
    await Linking.openURL(url);
  } catch {
    Alert.alert('Errore', 'Non riesco ad aprire Google Maps.');
  }
};

const openInWazeFromRoute = async (routeStr) => {
  const pts = parsePointsFromRoute(routeStr);
  if (pts.length < 2) { Alert.alert('Errore', 'Itinerario non valido.'); return; }
  const destination = pts[pts.length - 1];
  const enc = encodeURIComponent;

  const nativeUrl = `waze://?q=${enc(destination)}&navigate=yes`;
  const webUrl = `https://waze.com/ul?q=${enc(destination)}&navigate=yes`;

  try {
    const can = await Linking.canOpenURL('waze://');
    await Linking.openURL(can ? nativeUrl : webUrl);
  } catch {
    Alert.alert('Errore', 'Non riesco ad aprire Waze.');
  }
};

  const chooseNavigationForRoute = (routeStr) => {
    if (Platform.OS === 'web') {
      openInGoogleMapsFromRoute(routeStr);
      return;
    }
    Alert.alert(
      'Apri navigazione',
      'Scegli l\'app da usare',
      [
        { text: 'Google Maps', onPress: () => openInGoogleMapsFromRoute(routeStr) },
        { text: 'Waze', onPress: () => openInWazeFromRoute(routeStr) },
        { text: 'Annulla', style: 'cancel' },
      ],
      { cancelable: true }
    );
  };

  return (
    <ScrollView style={styles.container}>
      <Card style={styles.card}>
        <Card.Content>
          <Title>📱 I Miei Itinerari</Title>
          <Paragraph>Gestisci e condividi i tuoi itinerari salvati</Paragraph>
        </Card.Content>
      </Card>

      {itineraries.map((it) => (
        <Card key={it.id} style={styles.card}>
          <Card.Content>
            <View style={styles.itineraryHeader}>
              <View style={styles.itineraryInfo}>
                <Title style={styles.itineraryTitle}>{it.name}</Title>
                <Paragraph>{it.route}</Paragraph>
                <View style={styles.itineraryStats}>
                  <Chip compact icon="map-marker-distance">{it.distance}</Chip>
                  <Chip compact icon="clock-outline" style={styles.statChip}>{it.duration}</Chip>
                  {it.speed && <Chip compact icon="speedometer" style={styles.statChip}>{it.speed}</Chip>}
                  {it.fuel && <Chip compact icon="gas-station" style={styles.statChip}>{it.fuel}</Chip>}
                  {it.cost && <Chip compact icon="currency-eur" style={styles.statChip}>{it.cost}</Chip>}
                </View>
                <Paragraph style={styles.dateText}>Creato: {it.date}</Paragraph>
              </View>
            </View>
            <View style={styles.itineraryActions}>
              <Button mode="contained" onPress={() => chooseNavigationForRoute(it.route)} style={styles.actionButton} compact icon="navigation">
                Naviga
              </Button>
              <Button mode="outlined" onPress={() => shareItinerary(it)} style={styles.actionButton} compact icon="share">
                Condividi
              </Button>
              <Button mode="outlined" onPress={() => deleteItinerary(it.id)} style={styles.actionButton} compact icon="delete" textColor="#F44336">
                Elimina
              </Button>
            </View>
          </Card.Content>
        </Card>
      ))}
    </ScrollView>
  );
};

// --- SETTINGS SCREEN ---
const SettingsScreen = ({ camperSettings, onCamperSettingsChange }) => {
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const BOTTOM_GAP = insets.bottom + tabBarHeight + 24; // spazio extra sotto
  const { width, height } = useWindowDimensions();
  const MODAL_MAX_H = Math.round(height * 0.8);

  // Default robusti per campi mancanti
  const DEFAULTS = {
    height: 3.5,
    width: 2.5,
    weight: 3.5,
    length: 7.44,
    speed: 100,
    consumption: 12.0,
    dieselPrice: 1.55,
  };

  // Stato "visuale" corrente (chip / card)
  const [localSettings, setLocalSettings] = useState({ ...DEFAULTS, ...camperSettings });

  // Preferenze app
  const [voiceNavigation, setVoiceNavigation] = useState(true);
  const [notifications, setNotifications] = useState(true);

  // Modale dimensioni
  const [showDimensionsModal, setShowDimensionsModal] = useState(false);

  // Form del modale (stringhe per input)
  const [form, setForm] = useState({
    height: String(localSettings.height),
    width: String(localSettings.width),
    weight: String(localSettings.weight),
    length: String(localSettings.length),
    speed: String(localSettings.speed),
    consumption: String(localSettings.consumption),
    dieselPrice: String(localSettings.dieselPrice),
  });

  // Helpers -------------------------------------------------------
  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
  const round2 = (n) => Math.round(n * 100) / 100;

  const onChangeForm = (key, text) => {
    // accetta "3,5" o "3.5"
    const normalized = (text ?? '').replace(',', '.');
    if (/^\d*\.?\d*$/.test(normalized)) {
      setForm((prev) => ({ ...prev, [key]: normalized }));
    }
  };

  const toNum = (s) => {
    const n = parseFloat((s ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  };

  // Persiste un "patch" senza perdere altre chiavi già salvate
  const persistSettings = async (patch) => {
    try {
      const curr = (await loadStoredSettings()) || {};
      await saveStoredSettings({ ...curr, ...patch });
    } catch (e) {
      console.warn('Persist error:', e);
    }
  };

  // Sync quando cambia lo stato globale
  useEffect(() => {
    setLocalSettings((prev) => ({ ...prev, ...camperSettings }));
  }, [camperSettings]);

  // Carica preferenze salvate all’avvio
  useEffect(() => {
    (async () => {
      const s = await loadStoredSettings();
      if (s?.voiceNavigation !== undefined) setVoiceNavigation(!!s.voiceNavigation);
      if (s?.notifications !== undefined) setNotifications(!!s.notifications);
      if (s?.camperSettings) {
        setLocalSettings({ ...DEFAULTS, ...s.camperSettings });
      }
    })();
  }, []);

  // Quando apro il modale, porta i valori correnti nel form
  useEffect(() => {
    if (showDimensionsModal) {
      setForm({
        height: String(localSettings.height ?? DEFAULTS.height),
        width: String(localSettings.width ?? DEFAULTS.width),
        weight: String(localSettings.weight ?? DEFAULTS.weight),
        length: String(localSettings.length ?? DEFAULTS.length),
        speed: String(localSettings.speed ?? DEFAULTS.speed),
        consumption: String(localSettings.consumption ?? DEFAULTS.consumption),
        dieselPrice: String(localSettings.dieselPrice ?? DEFAULTS.dieselPrice),
      });
    }
  }, [showDimensionsModal, localSettings]);

  // Azioni --------------------------------------------------------
  const saveDimensions = async () => {
    const updated = {
      height: toNum(form.height),
      width: toNum(form.width),
      weight: toNum(form.weight),
      length: toNum(form.length),
      speed: toNum(form.speed),
      consumption: toNum(form.consumption),
      dieselPrice: toNum(form.dieselPrice),
    };

    const inRangeDimensions = (n) => n >= 0 && n <= 100;
    const inRangeSpeed = (n) => n >= 10 && n <= 200;
    const inRangeConsumption = (n) => n >= 5 && n <= 50;
    const inRangeDieselPrice = (n) => n >= 0.5 && n <= 5.0;

    if (![updated.height, updated.width, updated.weight, updated.length].every(inRangeDimensions)) {
      Alert.alert('Valori non validi', 'Inserisci dimensioni tra 0 e 100.');
      return;
    }
    if (!inRangeSpeed(updated.speed)) {
      Alert.alert('Velocità non valida', 'Inserisci una velocità tra 10 e 200 km/h.');
      return;
    }
    if (!inRangeConsumption(updated.consumption)) {
      Alert.alert('Consumo non valido', 'Inserisci un consumo tra 5 e 50 L/100km.');
      return;
    }
    if (!inRangeDieselPrice(updated.dieselPrice)) {
      Alert.alert('Prezzo non valido', 'Inserisci un prezzo diesel tra €0.50 e €5.00/L.');
      return;
    }

    setLocalSettings(updated);
    onCamperSettingsChange(updated);
    await persistSettings({ camperSettings: updated });
    setShowDimensionsModal(false);
    Alert.alert('Salvato!', 'Configurazione camper aggiornata');
  };

  const resetDimensions = async () => {
    const def = { ...DEFAULTS };
    setLocalSettings(def);
    onCamperSettingsChange(def);
    await persistSettings({ camperSettings: def });
    Alert.alert('Reset', 'Configurazione ripristinata ai valori predefiniti');
  };

  const toggleVoice = async (v) => {
    setVoiceNavigation(v);
    await persistSettings({ voiceNavigation: v });
  };

  const toggleNotifs = async (v) => {
    setNotifications(v);
    await persistSettings({ notifications: v });
  };

  // Controlli rapidi (se li usi altrove)
  const adjustQuick = (key, delta) => {
    setLocalSettings((prev) => {
      const next = { ...prev };
      if (key === 'speed')         next.speed       = clamp((prev.speed ?? 100) + delta, 10, 200);
      else if (key === 'consumption') next.consumption = clamp(round2((prev.consumption ?? 12) + delta), 5, 50);
      else if (key === 'dieselPrice') next.dieselPrice = clamp(round2((prev.dieselPrice ?? 1.55) + delta), 0.5, 5.0);
      return next;
    });
  };

  const applyQuickControls = async () => {
    onCamperSettingsChange(localSettings);
    await persistSettings({ camperSettings: localSettings });
    Alert.alert('Aggiornato', 'Velocità, consumi e prezzo diesel aggiornati.');
  };

  // Render --------------------------------------------------------
  return (
    <>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.container}
          contentContainerStyle={{ paddingBottom: BOTTOM_GAP }}
          keyboardShouldPersistTaps="handled"
        >
          <Card style={styles.card}>
            <Card.Content>
              <Title>⚙️ Impostazioni</Title>
              <Paragraph>Configurazione dell'app e del camper</Paragraph>
            </Card.Content>
          </Card>

          <Card style={styles.card}>
            <Card.Content>
              <Title>🚐 Configurazione Camper</Title>
              <View style={styles.dimensionsContainer}>
                <Chip icon="arrow-up-down">Altezza: {localSettings.height}m</Chip>
                <Chip icon="arrow-left-right">Larghezza: {localSettings.width}m</Chip>
                <Chip icon="weight">Peso: {localSettings.weight}t</Chip>
                <Chip icon="arrow-expand-horizontal">Lunghezza: {localSettings.length}m</Chip>
                <Chip icon="speedometer">Velocità: {localSettings.speed} km/h</Chip>
                <Chip icon="gas-station">Consumo: {localSettings.consumption} L/100km</Chip>
                <Chip icon="currency-eur">Diesel: €{localSettings.dieselPrice}/L</Chip>
              </View>

              <Paragraph style={styles.configNote}>
                La velocità influisce sui tempi stimati. Consumo e prezzo diesel determinano il costo viaggio.
              </Paragraph>

              <View style={styles.settingsActions}>
                <Button
                  mode="contained"
                  onPress={() => setShowDimensionsModal(true)}
                  style={styles.settingsButton}
                  icon="pencil"
                >
                  Modifica Configurazione
                </Button>
                <Button
                  mode="outlined"
                  onPress={resetDimensions}
                  style={styles.settingsButton}
                  icon="refresh"
                >
                  Reset
                </Button>
              </View>
            </Card.Content>
          </Card>

          <Card style={styles.card}>
            <Card.Content>
              <Title>📱 Preferenze App</Title>
              <List.Item
                title="Navigazione vocale"
                description="Attiva le indicazioni vocali"
                right={() => <Switch value={voiceNavigation} onValueChange={toggleVoice} />}
              />
              <List.Item
                title="Notifiche"
                description="Ricevi notifiche dall'app"
                right={() => <Switch value={notifications} onValueChange={toggleNotifs} />}
              />
              <Divider style={styles.divider} />
              <Paragraph>• Mappe: Standard</Paragraph>
              <Paragraph>• Unità di misura: Metriche</Paragraph>
              <Paragraph>• Versione: 1.0.0</Paragraph>
            </Card.Content>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>

      <Portal>
        <Modal
          visible={showDimensionsModal}
          onDismiss={() => setShowDimensionsModal(false)}
          style={styles.modalOverlay}
          contentContainerStyle={styles.modal}
        >
          <Surface style={styles.modalSurface}>
            <Title style={{ marginBottom: 12, fontSize: 16 }}>Modifica Configurazione Camper</Title>
            <ScrollView
              style={{ maxHeight: MODAL_MAX_H }}
              contentContainerStyle={{ paddingBottom: 24 }}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >


            {/* Dimensioni fisiche - griglia 2x2 */}
            <Text style={styles.sectionTitle}>Dimensioni Camper</Text>
            <View style={styles.twoColumnRow}>
              <View style={styles.halfInput}>
                <Text style={styles.compactLabel}>Altezza (m)</Text>
                <TextInput dense contentStyle={{ paddingVertical: 0, fontSize: 12 }}
                  mode="outlined"
                  value={form.height}
                  onChangeText={(v) => onChangeForm('height', v)}
                  keyboardType="decimal-pad"
                  placeholder="3.5"
                  style={styles.modalInput}
                />
              </View>
              <View style={styles.halfInput}>
                <Text style={styles.compactLabel}>Larghezza (m)</Text>
                <TextInput dense contentStyle={{ paddingVertical: 0, fontSize: 12 }}
                  mode="outlined"
                  value={form.width}
                  onChangeText={(v) => onChangeForm('width', v)}
                  keyboardType="decimal-pad"
                  placeholder="2.5"
                  style={styles.modalInput}
                />
              </View>
            </View>

            <View style={styles.twoColumnRow}>
              <View style={styles.halfInput}>
                <Text style={styles.compactLabel}>Peso (t)</Text>
                <TextInput dense contentStyle={{ paddingVertical: 0, fontSize: 12 }}
                  mode="outlined"
                  value={form.weight}
                  onChangeText={(v) => onChangeForm('weight', v)}
                  keyboardType="decimal-pad"
                  placeholder="3.5"
                  style={styles.modalInput}
                />
              </View>
              <View style={styles.halfInput}>
                <Text style={styles.compactLabel}>Lunghezza (m)</Text>
                <TextInput dense contentStyle={{ paddingVertical: 0, fontSize: 12 }}
                  mode="outlined"
                  value={form.length}
                  onChangeText={(v) => onChangeForm('length', v)}
                  keyboardType="decimal-pad"
                  placeholder="7.44"
                  style={styles.modalInput}
                />
              </View>
            </View>

            {/* Performance - velocità */}
            <Text style={styles.sectionTitle}>Performance</Text>
            <View style={styles.dimensionInputContainer}>
              <Text style={styles.compactLabel}>Velocità media (km/h)</Text>
              <TextInput dense contentStyle={{ paddingVertical: 0, fontSize: 12 }}
                mode="outlined"
                value={form.speed}
                onChangeText={(v) => onChangeForm('speed', v)}
                keyboardType="decimal-pad"
                placeholder="100"
                style={styles.modalInput}
              />
              <Text style={styles.speedHint}>
                Autostrada 110-130 · Extraurbane 70-90 · Urbane 30-50
              </Text>
            </View>

            {/* Consumi - 2 campi in riga */}
            <Text style={styles.sectionTitle}>Consumi e Costi</Text>
            <View style={styles.twoColumnRow}>
              <View style={styles.halfInput}>
                <Text style={styles.compactLabel}>Consumo (L/100km)</Text>
                <TextInput dense contentStyle={{ paddingVertical: 0, fontSize: 12 }}
                  mode="outlined"
                  value={form.consumption}
                  onChangeText={(v) => onChangeForm('consumption', v)}
                  keyboardType="decimal-pad"
                  placeholder="12.0"
                  style={styles.modalInput}
                />
              </View>
              <View style={styles.halfInput}>
                <Text style={styles.compactLabel}>Prezzo diesel (€/L)</Text>
                <TextInput dense contentStyle={{ paddingVertical: 0, fontSize: 12 }}
                  mode="outlined"
                  value={form.dieselPrice}
                  onChangeText={(v) => onChangeForm('dieselPrice', v)}
                  keyboardType="decimal-pad"
                  placeholder="1.55"
                  style={styles.modalInput}
                />
              </View>
            </View>
            <Text style={styles.speedHint}>
              Consumo tipico: 10-15 urbano · 8-12 extraurbano
            </Text>

            
            </ScrollView>
<View style={styles.modalActions}>
              <Button mode="outlined" onPress={() => setShowDimensionsModal(false)} style={styles.modalButton}>
                Annulla
              </Button>
              <Button mode="contained" onPress={saveDimensions} style={styles.modalButton} labelStyle={{ fontSize: 13 }}>
                Salva
              </Button>
            </View>
          </Surface>
        </Modal>
      </Portal>
    </>
  );
};


// --- APP PRINCIPALE ---
const theme = {
  colors: {
    primary: '#2196F3',
    accent: '#FF9800',
    background: '#f5f5f5',
    surface: '#ffffff',
    text: '#000000',
  },
};

const Tab = createBottomTabNavigator();

export default function App() {
  const [camperSettings, setCamperSettings] = useState({
    height: 3.5,
    width: 2.5,
    weight: 3.5,
    length: 7.44,
    speed: 100,
    consumption: 12.0, // L/100 km
    dieselPrice: 1.55, // €/L (riferimento 2025)
  });

  const [lastRoute, setLastRoute] = useState(null);

  // 1) carica camperSettings all'avvio
  useEffect(() => {
    (async () => {
      try {
        const s = await loadStoredSettings();
        if (s?.camperSettings) {
          setCamperSettings(prev => ({
            ...prev,            // mantieni eventuali nuove chiavi di default
            ...s.camperSettings // sovrascrivi con quelle salvate
          }));
        }
      } catch (e) {
        console.warn('Errore caricando le impostazioni:', e);
      }
    })();
  }, []);

  // 2) salva camperSettings ad ogni modifica
  useEffect(() => {
    saveStoredSettings({ camperSettings });
  }, [camperSettings]);

  const iconMap = {
    Route: 'map-search',
    Navigation: 'navigation',
    Itineraries: 'format-list-bulleted',
    Settings: 'cog',
  };

  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <NavigationContainer>
          <StatusBar style="auto" />
          <Tab.Navigator
            screenOptions={({ route }) => ({
              tabBarIcon: ({ color, size }) => (
                <MaterialCommunityIcons name={iconMap[route.name]} size={size} color={color} />
              ),
              tabBarActiveTintColor: theme.colors.primary,
              tabBarInactiveTintColor: 'gray',
              headerStyle: { backgroundColor: theme.colors.primary },
              headerTintColor: '#fff',
              headerTitleStyle: { fontWeight: 'bold' },
              tabBarHideOnKeyboard: true, // ⬅️ evita che la tastiera copra la tab bar
              headerShown: true,
            })}
          >
            <Tab.Screen name="Route" options={{ title: 'Pianifica Percorso' }}>
              {() => (
                <RouteScreen
                  camperSettings={camperSettings}
                  onRouteCalculated={setLastRoute}
                />
              )}
            </Tab.Screen>

            <Tab.Screen name="Navigation" options={{ title: 'Navigazione' }}>
              {() => <NavigationScreen lastRoute={lastRoute} />}
            </Tab.Screen>

            <Tab.Screen
              name="Itineraries"
              component={ItinerariesScreen}
              options={{ title: 'I Miei Itinerari' }}
            />

            <Tab.Screen name="Settings" options={{ title: 'Impostazioni' }}>
              {() => (
                <SettingsScreen
                  camperSettings={camperSettings}
                  onCamperSettingsChange={setCamperSettings}
                />
              )}
            </Tab.Screen>
          </Tab.Navigator>
        </NavigationContainer>
      </PaperProvider>
    </SafeAreaProvider>
  );
}

// --- STILI ---
const styles = StyleSheet.create({
  // Layout generali
  container: { flex: 1, backgroundColor: '#f5f5f5', padding: 16 },
  centerContainer: { flex: 1, justifyContent: 'center', backgroundColor: '#f5f5f5', padding: 16 },

  // Card / Inputs
  card: { marginBottom: 16, borderRadius: 14, overflow: 'hidden' },
  input: { marginBottom: 12 },
  button: { marginTop: 12 },

  // Riga con mirino + "Inserisco manualmente"
  quickActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },

  // Mirino chip-like (per IconButton)
  iconOnly: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#2196F3',
    backgroundColor: '#E8F3FF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },

  // Pulsante "Inserisco manualmente"
  manualButton: {
    flex: 1,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
  },

  // Waypoints
  waypointContainer: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  waypointInput: { flex: 1, marginRight: 8 },
  removeButton: { minWidth: 40 },
  addWaypointButton: { marginBottom: 12 },

  // Chip dimensioni camper
  dimensionsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 10 },

  // Hint
  hint: { fontSize: 12, opacity: 0.7, fontStyle: 'italic', marginTop: 8 },
  configNote: { fontSize: 12, opacity: 0.8, fontStyle: 'italic', marginTop: 8, lineHeight: 16 },

  // Risultato percorso
  routeActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  routeButton: { flex: 1 },

  // Navigazione mock
  navigationInstruction: { textAlign: 'center', color: '#2196F3', marginVertical: 16 },

  // Itinerari
  itineraryHeader: { marginBottom: 12 },
  itineraryInfo: { flex: 1 },
  itineraryTitle: { fontSize: 18 },
  itineraryStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 8 },
  statChip: { marginLeft: 4 },
  dateText: { fontSize: 12, opacity: 0.7 },
  itineraryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  actionButton: { flex: 1, minWidth: 100 },

  // Impostazioni
  settingsActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  settingsButton: { flex: 1 },
  divider: { marginVertical: 8 },

  //🎛️ Controlli rapidi
  quickRow: { marginTop: 12, marginBottom: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 2 },
  stepperValue: { minWidth: 72, textAlign: 'center', fontSize: 16, fontWeight: '600' },

  // Modali
  modalOverlay: { justifyContent: 'center' },
  modal: { backgroundColor: '#fff', padding: 16, margin: 16, borderRadius: 12 },
  modalSurface: { padding: 20, borderRadius: 12 },
  modalInput: { marginBottom: 12 , fontSize: 12, paddingVertical: 4, height: 42},
  modalActions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  modalButton: { flex: 1 },

  // Form dimensioni
  dimensionInputContainer: { marginBottom: 16 },
  dimensionLabel: { fontSize: 10, fontWeight: '600', marginBottom: 8, color: '#333' },
  speedHint: { fontSize: 11, color: '#666', fontStyle: 'italic', marginTop: 4 , fontSize: 11},
});