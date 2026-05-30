import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { sendBookingEmail } from './smtp.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const accountsPath = path.join(rootDir, 'accounts.json');
const configPath = path.join(rootDir, 'booking-config.json');

// Mappage des IDs de terrain vers leurs noms
const courtNames = {
  22: 'Padel A (22)',
  23: 'Padel B (23)',
  24: 'Padel C (24)',
  25: 'Padel D (25)'
};

/**
 * Calcule les dates et formats pour J+7
 * @param {string} targetDayName Nom du jour cible en anglais (ex : Saturday)
 */
function getJ7DateDetails(targetDayName) {
  const dayWeights = {
    'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
    'thursday': 4, 'friday': 5, 'saturday': 6
  };
  const targetDayNum = dayWeights[targetDayName.toLowerCase()];
  if (targetDayNum === undefined) {
    throw new Error(`Jour cible invalide : ${targetDayName}`);
  }
  
  const today = new Date();
  const todayNum = today.getDay();
  
  // Nombre de jours à ajouter pour atteindre le prochain jour cible de la semaine
  let daysAhead = (targetDayNum - todayNum + 7) % 7;
  
  // Si le jour cible est aujourd'hui, on cible J+7 (l'ouverture de la semaine prochaine)
  if (daysAhead === 0) {
    daysAhead = 7;
  }
  
  const targetDate = new Date();
  targetDate.setDate(today.getDate() + daysAhead);
  
  const daysFr = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const monthsFr = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  
  const dayNameFr = daysFr[targetDate.getDay()];
  const dayOfMonth = targetDate.getDate();
  const monthNameFr = monthsFr[targetDate.getMonth()];
  const year = targetDate.getFullYear();
  
  const isoDate = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD
  const frenchDate = `${String(dayOfMonth).padStart(2, '0')}/${String(targetDate.getMonth() + 1).padStart(2, '0')}/${year}`; // DD/MM/YYYY
  const longDateFr = `${dayNameFr} ${dayOfMonth} ${monthNameFr}`; // e.g. samedi 6 juin
  
  return {
    isoDate,
    frenchDate,
    longDateFr,
    dayOfMonth,
    dayNameFr,
    year,
    monthNameFr
  };
}

/**
 * Charge les identifiants d'un compte à partir d'accounts.json
 */
function getAccountCredentials(email) {
  if (!fs.existsSync(accountsPath)) {
    return null;
  }
  try {
    const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    return accounts.find(acc => acc.email.toLowerCase() === email.toLowerCase());
  } catch (err) {
    console.error('[SCRAPER] [ERROR] Impossible de lire accounts.json :', err.message);
    return null;
  }
}

/**
 * Formate le chemin du fichier de session isolé pour un email
 */
function getSessionPath(email) {
  const formattedEmail = email.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(rootDir, `session-${formattedEmail}.json`);
}

/**
 * Configure l'interception réseau pour bloquer les ressources lourdes
 * afin de maximiser la vitesse d'exécution.
 */
async function optimizePageLoad(page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url = route.request().url();
    
    if (
      type === 'image' || 
      type === 'font' || 
      url.includes('google-analytics') || 
      url.includes('doubleclick') || 
      url.includes('facebook') ||
      url.includes('analytics')
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });
}

/**
 * Log formaté standardisé
 */
function logEvent(component, status, message) {
  const isoString = new Date().toISOString();
  console.log(`[${isoString}] [${component}] [${status}] ${message}`);
}

/**
 * Ajoute une entrée dans l'historique des réservations (bookings-history.json)
 */
function appendToHistory(entry) {
  const historyPath = path.join(rootDir, 'bookings-history.json');
  try {
    let history = [];
    if (fs.existsSync(historyPath)) {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    }
    history.push({
      timestamp: new Date().toISOString(),
      ...entry
    });
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
    fs.chmodSync(historyPath, 0o600); // chmod 600
  } catch (err) {
    logEvent('SCRAPER', 'ERROR', `Impossible de consigner l'historique : ${err.message}`);
  }
}

/**
 * Tâche 1 : Pré-authentification et Warming (déclenchement à 8h59:00)
 * @param {Object} slot Créneau cible complet contenant l'e-mail du compte
 */
export async function performSessionCheckAndWarming(slot) {
  const email = slot.account;
  logEvent('WARMING', 'START', `Début du Warming pour le compte : ${email}`);
  
  const credentials = getAccountCredentials(email);
  if (!credentials) {
    logEvent('WARMING', 'FAILED', `Compte ${email} introuvable dans accounts.json.`);
    return false;
  }
  const password = credentials.password;
  const userSessionPath = getSessionPath(email);

  const launchOptions = { headless: true };
  if (process.env.CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  
  // Charger la session isolée si elle existe
  let contextOptions = {};
  if (fs.existsSync(userSessionPath)) {
    logEvent('WARMING', 'INFO', `Session persistante trouvée pour ${email}. Restauration.`);
    contextOptions = { storageState: userSessionPath };
  } else {
    logEvent('WARMING', 'INFO', `Aucune session trouvée pour ${email}. Connexion requise.`);
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await optimizePageLoad(page);

  try {
    let loggedIn = false;
    
    if (fs.existsSync(userSessionPath)) {
      // Tester la validité des cookies sur l'espace Tremblay
      await page.goto('https://sport94.fr/?_site=TREM', { waitUntil: 'domcontentloaded', timeout: 8000 });
      
      const logoutLocator = page.locator('a[href*="logout"], a:has-text("Déconnexion"), a:has-text("Se déconnecter")');
      const count = await logoutLocator.count();
      if (count > 0) {
        logEvent('WARMING', 'SUCCESS', `Session active et valide pour : ${email}`);
        loggedIn = true;
      } else {
        logEvent('WARMING', 'INFO', `Session expirée pour : ${email}`);
      }
    }

    if (!loggedIn) {
      logEvent('WARMING', 'INFO', `Connexion en cours pour ${email}...`);
      await page.goto('https://sport94.fr/page/account/login', { waitUntil: 'domcontentloaded', timeout: 8000 });
      
      // Remplissage du login
      await page.fill('input[name="input_login"]', email);
      await page.fill('input[name="input_passwd"]', password);
      
      logEvent('WARMING', 'INFO', 'Soumission du formulaire...');
      await Promise.all([
        page.keyboard.press('Enter'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 })
      ]);
      
      const logoutLocator = page.locator('a[href*="logout"], a:has-text("Déconnexion")');
      const count = await logoutLocator.count();
      
      if (count > 0) {
        logEvent('WARMING', 'SUCCESS', `Connexion réussie pour : ${email}`);
        // Sauvegarde de l'état de session isolé
        await context.storageState({ path: userSessionPath });
        fs.chmodSync(userSessionPath, 0o600); // chmod 600
        logEvent('WARMING', 'SUCCESS', `Session enregistrée et sécurisée pour : ${email}`);
      } else {
        throw new Error('Identifiants incorrects ou formulaire invalide.');
      }
    }
    
    await browser.close();
    return true;
  } catch (err) {
    logEvent('WARMING', 'FAILED', `Échec du Warming pour ${email} : ${err.message}`);
    try { await browser.close(); } catch (e) {}
    return false;
  }
}

/**
 * Tâche 2 : Réservation active J-7 (déclenchement à 9h00:00)
 * @param {Object} slot Créneau cible (ex: { day: "Saturday", start_hour: 9, account: "user@mail.com" })
 */
export async function performBooking(slot) {
  const { day, start_hour, account, sport } = slot;
  const sportName = sport || 'Padel';
  logEvent('BOOKING', 'START', `Tâche active pour : ${day} à ${start_hour}h00 (${sportName}) avec le compte : ${account}`);
  
  const credentials = getAccountCredentials(account);
  if (!credentials) {
    logEvent('BOOKING', 'ERROR', `Compte ${account} introuvable dans accounts.json.`);
    return { success: false, error: 'Compte introuvable' };
  }
  const password = credentials.password;
  const userSessionPath = getSessionPath(account);

  if (!fs.existsSync(userSessionPath)) {
    logEvent('BOOKING', 'ERROR', `Fichier de session manquant pour ${account} ! Exécution du Warming forcé...`);
    const warmingSuccess = await performSessionCheckAndWarming(slot);
    if (!warmingSuccess) {
      return { success: false, error: 'Échec warming et authentification' };
    }
  }

  const dateDetails = getJ7DateDetails(day);
  logEvent('BOOKING', 'INFO', `Date cible J+7 : ${dateDetails.frenchDate} (${dateDetails.longDateFr})`);

  const launchOptions = { headless: true };
  if (process.env.CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ storageState: userSessionPath });
  const page = await context.newPage();
  
  let dialogMessage = null;
  page.on('dialog', async dialog => {
    dialogMessage = dialog.message();
    logEvent('BOOKING', 'INFO', `[DIALOG] Dialogue détecté : "${dialogMessage}"`);
    await dialog.accept();
  });
  
  await optimizePageLoad(page);

  try {
    // 1. Page d'accueil (Espace Tremblay)
    logEvent('BOOKING', 'INFO', 'Accès à sport94.fr (Espace Tremblay)...');
    await page.goto('https://sport94.fr/?_site=TREM', { waitUntil: 'domcontentloaded', timeout: 5000 });
    
    // Vérification en direct de la session active (logout/deconnexion présent)
    const logoutLocator = page.locator('a[href*="logout"], a:has-text("Déconnexion"), a:has-text("Se déconnecter")');
    if (await logoutLocator.count() === 0) {
      logEvent('BOOKING', 'WARNING', 'Session expirée ou non détectée. Tentative de connexion en direct...');
      await page.goto('https://sport94.fr/page/account/login', { waitUntil: 'domcontentloaded', timeout: 8000 });
      
      // Remplissage du login
      await page.fill('input[name="input_login"]', account);
      await page.fill('input[name="input_passwd"]', password);
      
      logEvent('BOOKING', 'INFO', 'Soumission du formulaire de connexion...');
      await Promise.all([
        page.keyboard.press('Enter'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 })
      ]);
      
      if (await page.locator('a[href*="logout"], a:has-text("Déconnexion"), a:has-text("Se déconnecter")').count() === 0) {
        throw new Error("L'authentification automatique en direct a échoué.");
      }
      
      logEvent('BOOKING', 'SUCCESS', 'Connexion en direct réussie. Sauvegarde de la nouvelle session.');
      await context.storageState({ path: userSessionPath });
      fs.chmodSync(userSessionPath, 0o600); // chmod 600
    }
    
    // 2. Navigation directe vers la page de disponibilité du jour cible (avec sélection forcée du site Tremblay)
    const targetDispoUrl = `https://sport94.fr/page/dispo/${dateDetails.isoDate}?_site=TREM`;
    logEvent('BOOKING', 'INFO', `Navigation directe vers le jour cible : ${dateDetails.longDateFr} (${targetDispoUrl})...`);
    await page.goto(targetDispoUrl, { waitUntil: 'domcontentloaded', timeout: 6000 });
    


    // Attendre le tableau
    logEvent('BOOKING', 'INFO', 'Attente de #tabledispo...');
    await page.waitForSelector('#tabledispo', { timeout: 4000 });

    // 3. Algorithme de Repli dynamique selon le sport
    let courtsToTry = [
      { id: 22, name: 'Padel A' },
      { id: 23, name: 'Padel B' },
      { id: 24, name: 'Padel C' },
      { id: 25, name: 'Padel D' }
    ]; // Repli par défaut

    const sportsConfigPath = path.join(rootDir, 'sports-config.json');
    if (fs.existsSync(sportsConfigPath)) {
      try {
        const sportsData = JSON.parse(fs.readFileSync(sportsConfigPath, 'utf8'));
        if (sportsData[sportName] && sportsData[sportName].courts) {
          courtsToTry = sportsData[sportName].courts;
          logEvent('BOOKING', 'INFO', `Chargement des terrains pour le sport ${sportName} depuis sports-config.json : ${JSON.stringify(courtsToTry)}`);
        }
      } catch (err) {
        logEvent('BOOKING', 'WARNING', `Erreur lors de la lecture des terrains de ${sportName} depuis sports-config.json : ${err.message}. Repli par défaut.`);
      }
    }

    let successfulCourtId = null;
    let successfulCourtName = null;

    for (const courtItem of courtsToTry) {
      const courtId = typeof courtItem === 'object' ? courtItem.id : courtItem;
      const courtName = typeof courtItem === 'object' ? courtItem.name : (courtNames[courtId] || `Terrain ${courtId}`);
      const buttonName = `btnreza_${courtId}_${start_hour}`;
      logEvent('BOOKING', 'INFO', `Essai terrain : ${courtName} (${buttonName})...`);

      const reservationBtn = page.locator(`button[name="${buttonName}"]`);
      if (await reservationBtn.count() === 0) {
        logEvent('BOOKING', 'WARNING', `Terrain ${courtName} indisponible.`);
        continue;
      }

      logEvent('BOOKING', 'INFO', `Terrain ${courtName} libre ! Réservation...`);
      await reservationBtn.first().click({ timeout: 2000 });

      // 4. Formulaire de Confirmation & Détection de Verrouillage Concurrent
      logEvent('BOOKING', 'INFO', 'Vérification du formulaire de confirmation...');
      await page.waitForLoadState('domcontentloaded');

      const submitBtn = page.locator('button[name="btnreservation"]');
      if (await submitBtn.count() === 0) {
        logEvent('BOOKING', 'WARNING', `💥 CONCURRENCE : Terrain ${courtName} verrouillé en parallèle ! Repli immédiat.`);
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#tabledispo', { timeout: 3000 });
        continue; // Terrain suivant
      }

      logEvent('BOOKING', 'INFO', 'Coche de capa77 et validation finale...');
      await page.locator('input[name="capa77"]').check({ timeout: 2000 });
      await submitBtn.click({ timeout: 2000 });
      
      logEvent('BOOKING', 'INFO', 'Attente de la validation (dialogue ou redirection)...');
      
      // Attendre un court instant que le dialogue s'affiche ou que la redirection s'opère (2500ms max)
      let waitTime = 0;
      while (waitTime < 2500 && !dialogMessage && !page.url().includes('/page/resa')) {
        await page.waitForTimeout(100);
        waitTime += 100;
      }
      
      logEvent('BOOKING', 'INFO', `Résultat d'attente : dialogue="${dialogMessage}", URL="${page.url()}"`);
      
      // Valider si l'alerte de confirmation a été reçue ou si l'URL indique un succès de réservation
      const isConfirmed = (dialogMessage && dialogMessage.includes('enregistrée')) || page.url().includes('/page/resa');
      if (!isConfirmed) {
        throw new Error(`La confirmation de réservation a échoué (Alerte : "${dialogMessage || 'Aucune'}", URL : "${page.url()}").`);
      }

      successfulCourtId = courtId;
      successfulCourtName = courtName;
      logEvent('BOOKING', 'SUCCESS', `🎉 Terrain réservé : ${courtName} !`);
      break;
    }

    if (successfulCourtId) {
      const details = {
        day: dateDetails.dayNameFr,
        startHour: start_hour,
        courtName: successfulCourtName,
        dateStr: dateDetails.frenchDate,
        account: account
      };

      // Notification email
      await sendBookingEmail(details, true);

      // Historique
      appendToHistory({
        type: 'booking',
        target_day: day,
        target_hour: start_hour,
        status: 'SUCCESS',
        court_booked: successfulCourtName,
        account: account,
        details: 'Réservation initiée avec succès, email envoyé.'
      });

      await browser.close();
      return { success: true, courtName: successfulCourtName };
    } else {
      throw new Error("Tous les terrains sont occupés ou indisponibles.");
    }

  } catch (err) {
    logEvent('BOOKING', 'FAILED', `Échec : ${err.message}`);
    
    const details = {
      day: dateDetails.dayNameFr,
      startHour: start_hour,
      courtName: null,
      dateStr: dateDetails.frenchDate,
      account: account
    };
    await sendBookingEmail(details, false, err.message);

    appendToHistory({
      type: 'booking',
      target_day: day,
      target_hour: start_hour,
      status: 'FAILED',
      court_booked: null,
      account: account,
      details: `Échec : ${err.message}`
    });

    try { await browser.close(); } catch (e) {}
    return { success: false, error: err.message };
  }
}
