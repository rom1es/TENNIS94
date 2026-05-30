# Automate de Réservation de Padel - Sport94 🎾

Bienvenue dans l'automate de réservation automatique J-7 et tableau de bord de contrôle pour le site `sport94.fr` (spécifiquement pour les terrains de padel du **Parc du Tremblay**).

Ce projet a été conçu selon une architecture ultra-légère et robuste pour maximiser la vitesse d'exécution lors de la "course aux millisecondes" à l'ouverture des créneaux de réservation.

---

## 🚀 Fonctionnalités Clés

1. **Réservation Automatique J-7** : Soumet instantanément la réservation à la seconde d'ouverture (ex: le samedi précédent à 9h00:00.000 pour le samedi cible à 9h00).
2. **Algorithme de Repli Linéaire** : Tente séquentiellement de réserver le terrain **Padel A (ID: 22)** en priorité, puis se replie automatiquement sur le **Padel B (23)**, **Padel C (24)** ou **Padel D (25)** en cas d'indisponibilité.
3. **Pré-Authentification & Warming (8h59:00)** : S'exécute 60 secondes avant l'ouverture pour vérifier que la session stockée dans `session.json` est active. Si expirée, il se connecte et régénère les cookies, éliminant toute latence de connexion à 9h00:00.000.
4. **Détection de Verrouillage Concurrent (Fail-Fast)** : Si un concurrent bloque le terrain à la même milliseconde, le bouton de validation finale est absent de la page de confirmation. L'automate détecte ce cas critique instantanément, annule l'action, retourne aux disponibilités et passe au terrain de repli suivant sans perdre un instant.
5. **Notification SMTP Réactive** : Envoie un e-mail HTML soigné à la liste des joueurs dès que l'action est tentée, avec une alerte claire invitant à cliquer sur le lien officiel de confirmation envoyé par Sport94 sur l'e-mail du compte.
6. **Tableau de Bord Web Premium (SPA)** : Une interface web moderne et réactive à effet de verre dépoli (Glassmorphism & Dark Mode) permettant de :
   - Consulter l'historique complet des réservations effectuées (`bookings-history.json`).
   - Activer ou désactiver le planificateur système en un clic.
   - Éditer et sauvegarder de manière interactive la liste des créneaux cibles hebdomadaires (`booking-config.json`).
7. **Déploiement Propre (systemd-timers)** : Intégration complète via les timers systemd au niveau utilisateur Linux (`systemctl --user`), garantissant la précision à la seconde et centralisant les logs dans `journald` sans privilèges root.

---

## 📂 Structure du Répertoire du Projet

```
TENNIS94/
├── package.json              # Dépendances et scripts de l'application
├── .gitignore                # Exclusion des dépendances, secrets et états de session
├── .env                      # Variables d'environnement secrètes (exclues de Git)
├── .env.example              # Gabarit pour créer votre fichier .env
├── booking-config.json       # Liste des créneaux cibles configurés
├── bookings-history.json     # Historique des exécutions (consigné hors systemd)
├── session.json              # Fichier de persistance des cookies Playwright
├── README.md                 # Ce guide
├── systemd/
│   ├── padel-booking.service # Unité de service systemd (exécute node src/main.js)
│   ├── padel-booking.timer   # Planificateur horaire systemd (exécute à :59:00 et :00:00)
│   └── manage.sh             # Script utilitaire d'installation et de toggling systemd
├── public/                   # Frontend de l'interface SPA (HTML, CSS Premium, JS)
└── src/
    ├── main.js               # Orchestrateur CLI principal
    ├── scraper.js            # Moteur Playwright (Automatisation, replis, warming)
    ├── smtp.js               # Client d'envoi d'e-mails (Nodemailer)
    └── server.js             # API REST Express pour l'interface de contrôle
```

---

## 🛠️ Installation et Prérequis

Ce projet s'exécute de manière optimale sur un conteneur **Linux LXC** sous Node.js (v20+).

### 1. Cloner et installer les dépendances
Déplacez-vous dans votre dossier de projet et lancez l'installation :
```bash
npm install
```

### 2. Installer Chromium et les dépendances du système (Conteneur LXC headless)
Pour que Playwright puisse exécuter Chromium en mode sans tête (headless) dans un conteneur Linux LXC, installez le navigateur et les bibliothèques système partagées nécessaires :
```bash
# Télécharge les binaires Chromium locaux
npx playwright install chromium

# Installe les dépendances système Linux requises (polices, libnss, libgbm, etc.)
npx playwright install-deps
```

### 3. Configurer les variables d'environnement
Créez votre fichier `.env` à partir du modèle fourni :
```bash
cp .env.example .env
```
Éditez le fichier `.env` pour y renseigner vos informations de connexion Sport94 et vos identifiants de messagerie SMTP (voir section [Configuration SMTP](#-configuration-smtp) ci-dessous).

**Sécurisez vos fichiers de configuration locaux** :
Appliquez des droits stricts sur votre fichier `.env` pour restreindre sa lecture au seul utilisateur exécutant l'automate :
```bash
chmod 600 .env
```
*(L'automate appliquera automatiquement les droits `chmod 600` sur `session.json` et `bookings-history.json` lors de leur création).*

---

## 🕒 Planification et Intégration Système (systemd-timers)

Afin d'obtenir une précision à la seconde sans privilèges administrateur (root), le projet utilise un **timer systemd au niveau utilisateur** (`systemctl --user`).

### 1. Installation automatique des services
Le script `systemd/manage.sh` configure dynamiquement les chemins absolus vers votre dossier projet et votre binaire Node.js. Exécutez l'installation :
```bash
./systemd/manage.sh install
```
Cette commande copie les unités de service dans `~/.config/systemd/user/`, recharge le démon systemd et démarre le timer automatique.

### 2. Fonctionnement du Planificateur
Le timer systemd est configuré pour se réveiller **toutes les heures à la minute 59:00 et 00:00**.
- À la **minute 59:00** (`--warming`) : L'orchestrateur vérifie si un créneau cible est configuré à l'heure suivante (ex: 9h00). Si oui, il vérifie et pré-connecte la session.
- À la **minute 00:00** (`--booking`) : L'orchestrateur s'exécute et initie la réservation à la milliseconde près.

Ce choix d'architecture découple totalement systemd de votre planning : vous pouvez éditer vos créneaux librement sur le site web sans jamais avoir à réécrire ou réinstaller les fichiers timers systemd !

### 3. Commandes manuelles système utiles

*   **Vérifier le statut du timer systemd** :
    ```bash
    systemctl --user list-timers --all | grep padel-booking
    ```
*   **Consulter les logs temps réel du robot** (via journald) :
    ```bash
    journalctl --user -u padel-booking.service -f
    ```
*   **Désactiver temporairement le timer** :
    ```bash
    ./systemd/manage.sh disable
    ```

---

## 💻 Utilisation du Tableau de Bord Web

Démarrez le serveur web de contrôle :
```bash
npm run server
```
Par défaut, le serveur écoute sur le port `3000`. Ouvrez votre navigateur sur :
👉 **`http://localhost:3000`**

### Fonctionnalités de l'Interface :
- **Planning interactif** : Sélectionnez un jour (ex: samedi) et une tranche horaire (ex: 9h-10h), cliquez sur **Ajouter un créneau**. Supprimez des créneaux à l'aide de l'icône de corbeille, puis cliquez sur **Enregistrer** en haut à droite pour appliquer la configuration instantanément.
- **Planificateur Système** : Utilisez le switch d'activation pour démarrer ou stopper le timer systemd directement depuis la page.
- **Historique** : Consultez la table des dernières réservations enregistrées dans `bookings-history.json`, avec affichage du terrain réservé, de l'état (Succès/Échec) et du compte utilisé.

---

## 📧 Configuration SMTP

L'envoi des notifications s'appuie sur une messagerie SMTP classique à configurer dans `.env`.

*   **Orange & Free.fr (Simples)** : Ne requièrent généralement aucune sécurité renforcée particulière. Renseignez l'hôte (`smtp.orange.fr` ou `smtp.free.fr`), le port standard `465` (SSL) ou `587` (TLS), vos identifiants et le destinataire.
*   **Gmail (Hautement recommandé pour la délivrabilité)** :
    Google impose la validation en deux étapes pour autoriser les connexions SMTP tierces.
    1. Activez la **Validation en deux étapes** sur votre compte Google.
    2. Allez dans les paramètres de sécurité de votre compte Google, recherchez la section **Mots de passe d'application**.
    3. Générez un mot de passe unique pour une application personnalisée (ex: "Robot Padel").
    4. Renseignez ce mot de passe de 16 caractères dans la clé `SMTP_PASS` du fichier `.env`.

### Tester vos e-mails de notification :
Vous pouvez exécuter un test d'envoi d'e-mail blanc pour valider votre configuration SMTP :
```bash
node src/main.js --test-email
```

---

## 🛠️ Diagnostics et Résolution de Problèmes (Troubleshooting)

### Erreurs de dépendances système Chromium dans LXC
Si Playwright plante au démarrage avec une erreur indiquant qu'une bibliothèque partagée (.so) est introuvable :
```bash
# Exécutez l'installation des dépendances Chromium au niveau système (requiert sudo dans le LXC)
sudo npx playwright install-deps
```

### Problème de permission systemd
Si vous rencontrez des erreurs de communication ou d'autorisation avec `systemctl --user` sous LXC :
Assurez-vous que votre session de terminal utilisateur a bien initialisé le bus utilisateur systemd. Exécutez cette commande ou ajoutez-la à votre profil bash (`~/.bashrc`) :
```bash
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
```
Vous pouvez également vérifier que le gestionnaire utilisateur systemd tourne bien en arrière-plan :
```bash
systemctl --user status
```

---

## 📄 Licence
Ce projet est à usage privé et sportif. Développé avec soin par Romain et Antigravity.
