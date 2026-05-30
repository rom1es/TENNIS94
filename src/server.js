import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { performBooking } from './scraper.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Servir les fichiers statiques de l'interface utilisateur
app.use(express.static(path.join(rootDir, 'public')));

const configPath = path.join(rootDir, 'booking-config.json');
const sportsPath = path.join(rootDir, 'sports-config.json');
const historyPath = path.join(rootDir, 'bookings-history.json');
const accountsPath = path.join(rootDir, 'accounts.json');
const manageScriptPath = path.join(rootDir, 'systemd', 'manage.sh');

/**
 * Lit la liste des comptes depuis accounts.json
 */
function readAccounts() {
  if (!fs.existsSync(accountsPath)) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  } catch (err) {
    console.error('[SERVER] [ERROR] Erreur lecture accounts.json :', err.message);
    return [];
  }
}

/**
 * Écrit la liste des comptes dans accounts.json et applique chmod 600
 */
function writeAccounts(accounts) {
  try {
    fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2), 'utf8');
    fs.chmodSync(accountsPath, 0o600); // chmod 600
  } catch (err) {
    console.error('[SERVER] [ERROR] Erreur écriture accounts.json :', err.message);
  }
}

/**
 * Route GET /api/accounts
 * Renvoie la liste des e-mails enregistrés (sans les mots de passe pour des raisons de sécurité).
 */
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = readAccounts();
    const emails = accounts.map(acc => acc.email);
    res.json(emails);
  } catch (error) {
    res.status(500).json({ error: "Impossible de charger les comptes." });
  }
});

/**
 * Route POST /api/accounts
 * Enregistre ou met à jour un compte avec son e-mail et mot de passe.
 */
app.post('/api/accounts', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "L'adresse e-mail et le mot de passe sont obligatoires." });
    }

    const accounts = readAccounts();
    const existingIdx = accounts.findIndex(acc => acc.email.toLowerCase() === email.toLowerCase());

    if (existingIdx >= 0) {
      accounts[existingIdx].password = password;
      console.log(`[SERVER] [SUCCESS] Mot de passe mis à jour pour le compte : ${email}`);
    } else {
      accounts.push({ email, password });
      console.log(`[SERVER] [SUCCESS] Nouveau compte enregistré : ${email}`);
    }

    writeAccounts(accounts);
    res.json({ message: "Compte enregistré avec succès." });
  } catch (error) {
    res.status(500).json({ error: "Impossible d'enregistrer le compte." });
  }
});

/**
 * Route DELETE /api/accounts/:email
 * Supprime un compte enregistré et supprime également son fichier de session lié.
 */
app.delete('/api/accounts/:email', (req, res) => {
  try {
    const emailToDelete = req.params.email;
    if (!emailToDelete) {
      return res.status(400).json({ error: "L'adresse e-mail est requise." });
    }

    const accounts = readAccounts();
    const filtered = accounts.filter(acc => acc.email.toLowerCase() !== emailToDelete.toLowerCase());

    if (accounts.length === filtered.length) {
      return res.status(404).json({ error: "Compte introuvable." });
    }

    writeAccounts(filtered);

    // Supprimer également le fichier de session correspondant s'il existe
    const formattedEmail = emailToDelete.replace(/[^a-zA-Z0-9]/g, '_');
    const userSessionPath = path.join(rootDir, `session-${formattedEmail}.json`);
    if (fs.existsSync(userSessionPath)) {
      try {
        fs.unlinkSync(userSessionPath);
        console.log(`[SERVER] [SUCCESS] Fichier de session supprimé pour : ${emailToDelete}`);
      } catch (e) {
        console.error(`[SERVER] [ERROR] Impossible de supprimer le fichier de session : ${e.message}`);
      }
    }

    console.log(`[SERVER] [SUCCESS] Compte supprimé : ${emailToDelete}`);
    res.json({ message: "Compte supprimé avec succès." });
  } catch (error) {
    res.status(500).json({ error: "Impossible de supprimer le compte." });
  }
});

/**
 * Route GET /api/config
 * Lit et fusionne le fichier du planificateur (booking-config.json) et des terrains (sports-config.json) pour l'UI.
 */
app.get('/api/config', (req, res) => {
  try {
    const bookingsData = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : { bookings: [] };
    const sportsData = fs.existsSync(sportsPath) ? JSON.parse(fs.readFileSync(sportsPath, 'utf8')) : {};
    
    // Renvoyer l'objet unifié attendu par l'interface SPA
    res.json({
      sports: sportsData,
      bookings: bookingsData.bookings || []
    });
  } catch (error) {
    console.error('[SERVER] [ERROR] Lecture config fusionnée :', error.message);
    res.status(500).json({ error: "Impossible de lire la configuration." });
  }
});

/**
 * Route POST /api/config
 * Reçoit et met à jour uniquement la configuration du planificateur (bookings).
 */
app.post('/api/config', (req, res) => {
  try {
    const { bookings } = req.body;
    
    // Validation basique de structure
    if (!bookings || !Array.isArray(bookings)) {
      return res.status(400).json({ error: "La configuration doit contenir une liste de réservations." });
    }

    // Charger les terrains depuis leur propre fichier sports-config.json
    const sports = fs.existsSync(sportsPath) ? JSON.parse(fs.readFileSync(sportsPath, 'utf8')) : {};

    for (const b of bookings) {
      if (!b.day || typeof b.start_hour !== 'number' || !b.account || !b.sport) {
        return res.status(400).json({ error: "Chaque réservation doit comporter un jour ('day'), une heure ('start_hour'), un compte ('account') et un sport ('sport')." });
      }
      
      // Valider que le sport est configuré
      if (!sports[b.sport]) {
        return res.status(400).json({ error: `Le sport '${b.sport}' n'est pas configuré dans sports-config.json.` });
      }
      
      // Valider que le jour est valide
      const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      if (!validDays.includes(b.day)) {
        return res.status(400).json({ error: `Le jour '${b.day}' n'est pas valide. Doit être en anglais (ex: Saturday).` });
      }
      if (b.start_hour < 0 || b.start_hour > 23) {
        return res.status(400).json({ error: "L'heure de début doit être comprise entre 0 et 23." });
      }

      // Valider que le compte existe dans accounts.json
      const accounts = readAccounts();
      const accountExists = accounts.some(acc => acc.email.toLowerCase() === b.account.toLowerCase());
      if (!accountExists) {
        return res.status(400).json({ error: `Le compte '${b.account}' n'est pas enregistré. Enregistrez-le d'abord dans l'onglet des comptes.` });
      }
    }

    // Sauvegarder uniquement bookings dans booking-config.json
    fs.writeFileSync(configPath, JSON.stringify({ bookings }, null, 2), 'utf8');
    console.log('[SERVER] [SUCCESS] Planificateur de réservations mis à jour avec succès.');
    res.json({ message: "Configuration enregistrée avec succès.", bookings });
  } catch (error) {
    console.error('[SERVER] [ERROR] Écriture config planificateur :');
    res.status(500).json({ error: "Impossible d'écrire la configuration." });
  }
});

/**
 * Route POST /api/book-now
 * Lance immédiatement une réservation Playwright J-7 pour un créneau spécifique.
 */
app.post('/api/book-now', async (req, res) => {
  try {
    const slot = req.body;
    if (!slot || !slot.day || typeof slot.start_hour !== 'number' || !slot.sport || !slot.account) {
      return res.status(400).json({ error: "Paramètres de créneau invalides." });
    }

    // Vérifier si le compte existe
    const accounts = readAccounts();
    const accountExists = accounts.some(acc => acc.email.toLowerCase() === slot.account.toLowerCase());
    if (!accountExists) {
      return res.status(400).json({ error: `Le compte '${slot.account}' n'est pas enregistré.` });
    }

    console.log(`[SERVER] Lancement immédiat de la réservation pour : ${slot.day} à ${slot.start_hour}h (${slot.sport})`);
    
    const result = await performBooking(slot);
    
    if (result && result.success) {
      res.json({ message: `Réservation réussie sur le terrain : ${result.courtName}`, result });
    } else {
      res.status(500).json({ error: result.error || "La tentative de réservation a échoué." });
    }
  } catch (error) {
    console.error('[SERVER] [ERROR] Réservation immédiate :', error.message);
    res.status(500).json({ error: `Erreur interne : ${error.message}` });
  }
});

/**
 * Route GET /api/history
 * Lit l'historique des réservations et le renvoie inversé (plus récent en premier).
 */
app.get('/api/history', (req, res) => {
  try {
    if (!fs.existsSync(historyPath)) {
      return res.json([]);
    }
    const historyData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    // Trier du plus récent au plus ancien
    const sorted = [...historyData].reverse();
    res.json(sorted);
  } catch (error) {
    console.error('[SERVER] [ERROR] Lecture historique :', error.message);
    res.status(500).json({ error: "Impossible de charger l'historique." });
  }
});

/**
 * Route GET /api/systemd/status
 * Interroge le statut du timer systemd en appelant le script de gestion.
 */
app.get('/api/systemd/status', (req, res) => {
  exec(`"${manageScriptPath}" status`, (error, stdout, stderr) => {
    if (error) {
      console.error('[SERVER] [ERROR] Échec statut systemd :', error.message);
      return res.status(500).json({ error: "Impossible d'interroger systemd." });
    }
    try {
      const status = JSON.parse(stdout.trim());
      res.json(status);
    } catch (parseError) {
      console.error('[SERVER] [ERROR] Erreur de parsing statut systemd :', stdout);
      res.status(500).json({ error: "Erreur de parsing de l'état système." });
    }
  });
});

/**
 * Route POST /api/systemd/toggle
 * Active ou désactive le timer systemd.
 */
app.post('/api/systemd/toggle', (req, res) => {
  const { action } = req.body;
  if (action !== 'enable' && action !== 'disable') {
    return res.status(400).json({ error: "Action invalide. Doit être 'enable' ou 'disable'." });
  }

  exec(`"${manageScriptPath}" ${action}`, (error, stdout, stderr) => {
    if (error) {
      console.error(`[SERVER] [ERROR] Échec action systemd (${action}) :`, error.message);
      return res.status(500).json({ error: `Impossible de changer l'état du timer (${action}).` });
    }

    // Réinterroger l'état après modification
    exec(`"${manageScriptPath}" status`, (statusError, statusStdout) => {
      if (statusError) {
        return res.json({ message: "Action effectuée, mais erreur de relecture du statut." });
      }
      try {
        const status = JSON.parse(statusStdout.trim());
        res.json({ message: `Timer ${action === 'enable' ? 'activé' : 'désactivé'} avec succès.`, status });
      } catch (e) {
        res.json({ message: `Action ${action} effectuée.` });
      }
    });
  });
});

/**
 * Démarre le serveur Express.
 */
export function startWebServer() {
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`[SERVER] [SUCCESS] Serveur web de contrôle démarré.`);
    console.log(`[SERVER] URL d'accès : http://localhost:${PORT}`);
    console.log(`==================================================`);
  });
}
