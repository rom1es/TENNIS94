import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { performSessionCheckAndWarming, performBooking } from './scraper.js';
import { startWebServer } from './server.js';
import { sendBookingEmail } from './smtp.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const configPath = path.join(rootDir, 'booking-config.json');

/**
 * Log formaté standardisé
 */
function logEvent(component, status, message) {
  const isoString = new Date().toISOString();
  console.log(`[${isoString}] [${component}] [${status}] ${message}`);
}

/**
 * Retrouve un créneau de la configuration correspondant à l'heure système courante
 * @param {Object} config Objet JSON chargé depuis booking-config.json
 * @param {number} offsetMinutes Décalage en minutes à ajouter à l'heure actuelle (utile pour le warming de 8h59)
 */
function getMatchingSlot(config, offsetMinutes = 0) {
  const now = new Date();
  if (offsetMinutes !== 0) {
    now.setMinutes(now.getMinutes() + offsetMinutes);
  }
  
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const currentDay = dayNames[now.getDay()];
  const currentHour = now.getHours();
  
  return config.bookings.find(b => b.day === currentDay && b.start_hour === currentHour);
}

/**
 * Fonction d'aide à l'utilisation
 */
function printHelp() {
  console.log(`
Automate de réservation Padel Sport94 - Interface et moteur CLI
--------------------------------------------------------------
Usage:
  node src/main.js [options]

Options:
  --server           Démarre le serveur web Express de contrôle (URL par défaut: http://localhost:3000)
  --warming          Exécute le warming automatique (vérifie si le créneau dans 1 min est à réserver, pre-login si besoin)
  --booking          Exécute la réservation J-7 active si l'heure courante correspond à un créneau ciblé
  --force-warming    Exécute le warming immédiatement de force (sans vérifier le planning ni l'heure)
  --force-booking    Exécute la réservation J-7 immédiatement (prend le premier créneau cabled dans la config)
  --test-email       Envoie un email de test SMTP pour valider votre configuration .env
  --help             Affiche ce message d'aide
`);
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  // 1. Option Serveur Web de Contrôle
  if (args.includes('--server')) {
    startWebServer();
    return;
  }

  // 2. Option Test Email SMTP
  if (args.includes('--test-email')) {
    console.log('[MAIN] Lancement du test SMTP...');
    const testDetails = {
      day: 'Samedi (Test)',
      startHour: 9,
      courtName: 'Padel A (Test)',
      dateStr: '30/05/2026',
      account: process.env.SPORT94_EMAIL || 'test_account@sport94.fr'
    };
    await sendBookingEmail(testDetails, true);
    return;
  }

  // 3. Option Force Warming
  if (args.includes('--force-warming')) {
    console.log('[MAIN] Lancement forcé du warming...');
    if (!fs.existsSync(configPath)) {
      console.error('[MAIN] [ERROR] Fichier booking-config.json introuvable.');
      return;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.bookings.length === 0) {
      console.error('[MAIN] [ERROR] Aucun créneau configuré dans booking-config.json pour récupérer le compte associé.');
      return;
    }
    await performSessionCheckAndWarming(config.bookings[0]);
    return;
  }

  // 4. Option Force Booking
  if (args.includes('--force-booking')) {
    console.log('[MAIN] Lancement forcé de la réservation active...');
    if (!fs.existsSync(configPath)) {
      console.error('[MAIN] [ERROR] Fichier booking-config.json introuvable.');
      return;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.bookings.length === 0) {
      console.error('[MAIN] [ERROR] Aucun créneau configuré dans booking-config.json.');
      return;
    }
    const targetSlot = config.bookings[0];
    console.log(`[MAIN] Réservation forcée sur le premier créneau trouvé : ${targetSlot.day} à ${targetSlot.start_hour}h`);
    await performBooking(targetSlot);
    return;
  }

  // 5. Comportement standard (Automatique / Déclenchement par systemd)
  
  // Charger la configuration
  if (!fs.existsSync(configPath)) {
    logEvent('MAIN', 'ERROR', 'Fichier booking-config.json manquant. Arrêt du script.');
    return;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  const now = new Date();
  const minutes = now.getMinutes();

  if (args.includes('--warming') || minutes === 59) {
    // Phase de Warming (exécutée à hh:59:00)
    // On vérifie s'il y a une tâche planifiée à l'heure suivante (hh + 1)
    const nextSlot = getMatchingSlot(config, 1); // Décalage de +1 min pour tomber sur l'heure suivante
    
    if (nextSlot) {
      logEvent('MAIN', 'INFO', `Créneau cible détecté dans 1 min : ${nextSlot.day} à ${nextSlot.start_hour}h. Exécution du warming.`);
      await performSessionCheckAndWarming(nextSlot);
    } else {
      logEvent('MAIN', 'INFO', 'Aucun créneau planifié à l\'heure suivante. Fin du warming.');
    }
    return;
  }

  if (args.includes('--booking') || minutes === 0) {
    // Phase de Booking active (exécutée à hh:00:00)
    const activeSlot = getMatchingSlot(config, 0);
    
    if (activeSlot) {
      logEvent('MAIN', 'INFO', `Créneau cible actif détecté : ${activeSlot.day} à ${activeSlot.start_hour}h. Lancement de la réservation J-7.`);
      await performBooking(activeSlot);
    } else {
      logEvent('MAIN', 'INFO', 'Aucun créneau planifié à l\'heure actuelle. Fin du booking.');
    }
    return;
  }

  // Si déclenché sans arguments en dehors de la minute 59 ou 00
  console.log('[MAIN] [INFO] Déclenché manuellement sans arguments ou en dehors des minutes de planification (:59 ou :00).');
  printHelp();
}

main().catch(err => {
  console.error('[MAIN] [FATAL] Une erreur inattendue est survenue :', err);
});
