import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Issuer } from 'openid-client';
import session from 'express-session';
import { performBooking } from './scraper.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration de session Express
app.set('trust proxy', 1); // Fait confiance au reverse proxy pour le cookie Secure en HTTPS

app.use(session({
  secret: process.env.SESSION_SECRET || 'un_secret_par_defaut_pour_le_padel',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true', // Configurable via COOKIE_SECURE (évite les blocages sur localhost HTTP)
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 heures
  }
}));

app.use(express.json());

// Découverte OIDC dynamique
let oidcClient = null;
if (process.env.ENABLE_KEYCLOAK === 'true') {
  try {
    console.log('[OIDC] Découverte de l\'émetteur Keycloak via :', process.env.KC_DISCOVERY_URL);
    const keycloakIssuer = await Issuer.discover(process.env.KC_DISCOVERY_URL);
    oidcClient = new keycloakIssuer.Client({
      client_id: process.env.KC_CLIENT_ID,
      client_secret: process.env.KC_CLIENT_SECRET,
      redirect_uris: [process.env.KC_REDIRECT_URI],
      response_types: ['code'],
    });
    console.log('[OIDC] [SUCCESS] Client Keycloak initialisé.');
  } catch (err) {
    console.error('[OIDC] [FATAL] Impossible d\'initialiser Keycloak :', err.message);
    process.exit(1);
  }
}

// Middleware de vérification d'authentification
function requireAuth(req, res, next) {
  if (process.env.ENABLE_KEYCLOAK !== 'true') {
    return next();
  }
  if (req.session && req.session.userInfo) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  res.redirect('/login');
}

// Routes d'authentification ouvertes (avant requireAuth)
app.get('/login', (req, res) => {
  if (process.env.ENABLE_KEYCLOAK !== 'true') {
    return res.redirect('/');
  }
  const authorizationUrl = oidcClient.authorizationUrl({
    scope: 'openid profile email',
  });
  res.redirect(authorizationUrl);
});

app.get('/auth/callback', async (req, res) => {
  if (process.env.ENABLE_KEYCLOAK !== 'true') {
    return res.redirect('/');
  }
  try {
    const params = oidcClient.callbackParams(req);
    const tokenSet = await oidcClient.callback(process.env.KC_REDIRECT_URI, params);
    const claims = tokenSet.claims();
    
    // Récupérer et valider le rôle padel-admin (supporte ID Token et Access Token)
    let roles = [];
    if (claims.realm_access && Array.isArray(claims.realm_access.roles)) {
      roles = claims.realm_access.roles;
    }
    // Fallback : dans Keycloak par défaut, realm_access est dans l'Access Token
    if (!roles.includes('padel-admin') && tokenSet.access_token) {
      try {
        const parts = tokenSet.access_token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
          if (payload.realm_access && Array.isArray(payload.realm_access.roles)) {
            roles = Array.from(new Set([...roles, ...payload.realm_access.roles]));
          }
        }
      } catch (err) {
        console.warn('[OIDC] Erreur lors de l\'inspection de l\'access_token :', err.message);
      }
    }
    
    if (!roles.includes('padel-admin')) {
      console.warn(`[OIDC] [WARN] Accès interdit pour ${claims.preferred_username} (rôle padel-admin manquant, rôles reçus: ${roles.join(', ')})`);
      return res.status(403).send(`
        <html>
        <head>
          <meta charset="utf-8">
          <title>Accès Refusé</title>
        </head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #f7fafc; color: #2d3748;">
          <div style="max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
            <h1 style="color: #e53e3e; font-size: 40px; margin-top: 0;">❌ Accès Refusé</h1>
            <p style="font-size: 16px;">Vous êtes authentifié sur Keycloak, mais vous ne possédez pas le rôle requis (<strong>padel-admin</strong>) pour gérer cet automate.</p>
            <p style="font-size: 14px; color: #718096; margin-bottom: 30px;">Veuillez contacter votre administrateur système.</p>
            <a href="/logout" style="display: inline-block; padding: 12px 24px; background-color: #3182ce; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Se déconnecter</a>
          </div>
        </body>
        </html>
      `);
    }

    req.session.idToken = tokenSet.id_token;
    req.session.userInfo = {
      username: claims.preferred_username,
      email: claims.email,
      firstName: claims.given_name || '',
      lastName: claims.family_name || '',
      fullName: claims.name || claims.preferred_username
    };
    
    console.log(`[OIDC] [SUCCESS] Connexion autorisée pour l'utilisateur : ${claims.preferred_username}`);
    res.redirect('/');
  } catch (err) {
    console.error('[OIDC] [ERROR] Échec du callback OIDC Keycloak :', err.message);
    res.status(500).send('Erreur d\'authentification.');
  }
});

app.get('/logout', (req, res) => {
  const idToken = req.session ? req.session.idToken : null;
  req.session.destroy((err) => {
    if (err) {
      console.error('[SESSION] [ERROR] Impossible de détruire la session :', err.message);
    }
    if (process.env.ENABLE_KEYCLOAK === 'true') {
      const baseLogoutUrl = `${process.env.KC_DISCOVERY_URL.replace('/.well-known/openid-configuration', '')}/protocol/openid-connect/logout`;
      if (idToken) {
        // Redirection OIDC RP-Initiated conforme avec id_token_hint
        const logoutUrl = `${baseLogoutUrl}`
          + `?post_logout_redirect_uri=${encodeURIComponent(process.env.KC_REDIRECT_URI.replace('/auth/callback', ''))}`
          + `&id_token_hint=${idToken}`;
        return res.redirect(logoutUrl);
      } else {
        // Évite le crash "Missing id_token_hint" en omettant la redirection post-déconnexion
        return res.redirect(baseLogoutUrl);
      }
    }
    res.redirect('/');
  });
});

app.get('/api/user-info', (req, res) => {
  if (process.env.ENABLE_KEYCLOAK !== 'true') {
    return res.json({ enabled: false });
  }
  res.json({
    enabled: true,
    user: req.session.userInfo
  });
});

// Protection de tous les accès statiques et APIs qui suivent
app.use(requireAuth);

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
