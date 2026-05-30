#!/bin/bash

# Script de gestion de l'automate de réservation Padel (niveau utilisateur)
# Ce script permet d'installer, activer, désactiver et interroger le statut du timer systemd.

USER_SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="padel-booking.service"
TIMER_NAME="padel-booking.timer"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Détecter le chemin du binaire Node.js
NODE_PATH="$(which node)"

function print_usage() {
  echo "Usage: $0 {install|enable|disable|status}"
  exit 1
}

# Fonction isolée d'installation des unités systemd
function install_units() {
  # Créer le dossier s'il n'existe pas
  mkdir -p "$USER_SYSTEMD_DIR"
  
  if [ -z "$NODE_PATH" ]; then
    echo "[SYSTEMD] [ERROR] Node.js n'a pas été trouvé dans le PATH."
    exit 1
  fi
  
  echo "[SYSTEMD] Node trouvé : $NODE_PATH"
  echo "[SYSTEMD] Répertoire de travail : $PROJECT_DIR"
  
  # Remplacer les variables de gabarit et copier le fichier de service
  sed -e "s|__WORKDIR__|$PROJECT_DIR|g" -e "s|__NODE__|$NODE_PATH|g" "$SCRIPT_DIR/$SERVICE_NAME" > "$USER_SYSTEMD_DIR/$SERVICE_NAME"
  
  # Copier le timer
  cp "$SCRIPT_DIR/$TIMER_NAME" "$USER_SYSTEMD_DIR/$TIMER_NAME"
  
  # Recharger le démon systemd utilisateur
  systemctl --user daemon-reload
}

if [ -z "$1" ]; then
  print_usage
fi

case "$1" in
  install)
    echo "[SYSTEMD] Installation des unités systemd en mode utilisateur..."
    install_units
    
    # Activer et démarrer le timer
    systemctl --user enable "$TIMER_NAME" 2>/dev/null
    systemctl --user start "$TIMER_NAME" 2>/dev/null
    
    echo "[SYSTEMD] [SUCCESS] Installation réussie. Le timer a été activé et démarré."
    ;;
    
  enable)
    # Vérifier si le timer est installé, sinon l'installer automatiquement
    if [ ! -f "$USER_SYSTEMD_DIR/$TIMER_NAME" ]; then
      echo "[SYSTEMD] [INFO] Timer non installé. Lancement de l'installation automatique..."
      install_units
    fi
    
    echo "[SYSTEMD] Activation et démarrage du timer..."
    systemctl --user enable "$TIMER_NAME" 2>/dev/null
    systemctl --user start "$TIMER_NAME" 2>/dev/null
    
    # Valider le bon déroulement
    IS_ENABLED=$(systemctl --user is-enabled "$TIMER_NAME" 2>/dev/null)
    if [ "$IS_ENABLED" == "enabled" ]; then
      echo "[SYSTEMD] [SUCCESS] Timer activé."
    else
      echo "[SYSTEMD] [ERROR] Impossible d'activer le timer systemd. Vérifiez vos permissions ou l'environnement LXC."
    fi
    ;;
    
  disable)
    echo "[SYSTEMD] Désactivation et arrêt du timer..."
    systemctl --user stop "$TIMER_NAME" 2>/dev/null
    systemctl --user disable "$TIMER_NAME" 2>/dev/null
    echo "[SYSTEMD] [SUCCESS] Timer désactivé."
    ;;
    
  status)
    # Vérifier l'état et renvoyer une réponse JSON
    IS_ENABLED=$(systemctl --user is-enabled "$TIMER_NAME" 2>/dev/null | head -n 1)
    if [ -z "$IS_ENABLED" ]; then
      IS_ENABLED="disabled"
    fi
    
    IS_ACTIVE=$(systemctl --user is-active "$TIMER_NAME" 2>/dev/null | head -n 1)
    if [ -z "$IS_ACTIVE" ]; then
      IS_ACTIVE="inactive"
    fi
    
    # Détecter la prochaine date d'exécution (next trigger)
    NEXT_TRIGGER=$(systemctl --user list-timers --all 2>/dev/null | grep "$TIMER_NAME" | awk '{print $1" "$2" "$3}' | head -n 1)
    if [ -z "$NEXT_TRIGGER" ]; then
      NEXT_TRIGGER="N/A"
    fi
    
    echo "{\"enabled\": \"$IS_ENABLED\", \"active\": \"$IS_ACTIVE\", \"next\": \"$NEXT_TRIGGER\"}"
    ;;
    
  *)
    print_usage
    ;;
esac
