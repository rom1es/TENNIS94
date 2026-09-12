#!/bin/bash

# ==============================================================================
# Script de Gestion Unifié : Keycloak & Serveur TENNIS94
# ==============================================================================
# Usage :
#   ./manage-services.sh [start|stop|restart|status] [all|keycloak|tennis94] [--mode=local|remote]
#   ./manage-services.sh logs [keycloak|tennis94]
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOGS_DIR"

# ------------------------------------------------------------------------------
# 1. Chargement de l'environnement (.env)
# ------------------------------------------------------------------------------
if [ -f "$SCRIPT_DIR/.env" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "${line// }" ]] && continue
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            _k="${BASH_REMATCH[1]}"
            _v="${BASH_REMATCH[2]}"
            _v="${_v%\"}"
            _v="${_v#\"}"
            _v="${_v%\'}"
            _v="${_v#\'}"
            if [ -z "${!_k+x}" ]; then
                export "$_k"="$_v"
            fi
        fi
    done < "$SCRIPT_DIR/.env"
fi

KEYCLOAK_PID_FILE="$LOGS_DIR/keycloak.pid"
TENNIS94_PID_FILE="$LOGS_DIR/tennis94.pid"

KEYCLOAK_CONTAINER="tennis94-keycloak"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.keycloak.yml"
KC_IMAGE="quay.io/keycloak/keycloak:26.5.6"
KEYCLOAK_LOG="$LOGS_DIR/keycloak.log"
TENNIS94_LOG="$LOGS_DIR/tennis94.log"

KC_PORT="${KC_PORT:-8080}"
KC_HOST="${KC_HOST:-0.0.0.0}"
TENNIS94_PORT="${PORT:-3000}"
KC_DISCOVERY_URL="${KC_DISCOVERY_URL:-http://localhost:8080/realms/tennis94/.well-known/openid-configuration}"

# ------------------------------------------------------------------------------
# 2. Analyse des drapeaux CLI & Détection du Mode Keycloak (Dev/Local vs Prod/Distant)
# ------------------------------------------------------------------------------
CLI_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --mode=local|--local|--dev)
            KEYCLOAK_MODE="local"
            ;;
        --mode=remote|--remote|--prod)
            KEYCLOAK_MODE="remote"
            ;;
        *)
            CLI_ARGS+=("$arg")
            ;;
    esac
done

# Détection intelligente du mode :
# 1. Si KEYCLOAK_MODE est défini explicitement ('local' ou 'remote')
# 2. Sinon si NODE_ENV == "production" -> 'remote'
# 3. Sinon si KC_DISCOVERY_URL ne pointe pas vers localhost/127.0.0.1 -> 'remote'
# 4. Par défaut en dev -> 'local' (Docker)
if [ -n "$KEYCLOAK_MODE" ]; then
    KC_MODE="$KEYCLOAK_MODE"
elif [ "$NODE_ENV" = "production" ]; then
    KC_MODE="remote"
elif [ -n "$KC_DISCOVERY_URL" ] && ! echo "$KC_DISCOVERY_URL" | grep -qE "localhost|127\.0\.0\.1"; then
    KC_MODE="remote"
else
    KC_MODE="local"
fi

# Couleurs pour le terminal
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ------------------------------------------------------------------------------
# Fonctions Utilitaires
# ------------------------------------------------------------------------------

print_usage() {
    echo -e "${BOLD}Gestionnaire de Services - TENNIS94 & Keycloak${NC}"
    echo "Usage : $0 {start|stop|restart|status|logs} [all|keycloak|tennis94] [--mode=local|remote]"
    echo ""
    echo "Commandes disponibles :"
    echo -e "  ${CYAN}start [cible]${NC}    : Démarre le(s) service(s) (par défaut : all)"
    echo -e "  ${CYAN}stop [cible]${NC}     : Arrête le(s) service(s) (par défaut : all)"
    echo -e "  ${CYAN}restart [cible]${NC}  : Redémarre le(s) service(s) (par défaut : all)"
    echo -e "  ${CYAN}status [cible]${NC}   : Affiche l'état en temps réel (par défaut : all)"
    echo -e "  ${CYAN}logs [cible]${NC}     : Suit les logs en temps réel (keycloak ou tennis94)"
    echo ""
    echo "Cibles possibles : all, keycloak, tennis94"
    echo ""
    echo "Modes d'exécution Keycloak :"
    echo -e "  ${BOLD}local${NC}  (Dev)  : Keycloak conteneurisé Docker (${KEYCLOAK_CONTAINER}) + PostgreSQL local"
    echo -e "  ${BOLD}remote${NC} (Prod) : Serveur Keycloak distant (${KC_DISCOVERY_URL})"
    echo "                 (Aucun conteneur ni base locale démarrés sur ce serveur)"
    echo ""
    echo -e "Mode actuel : ${CYAN}${KC_MODE}${NC} (Configuré via KEYCLOAK_MODE ou détecté automatiquement)"
    exit 1
}

check_port_listening() {
    local port=$1
    if ss -tulpn 2>/dev/null | grep -q ":${port} "; then
        return 0
    else
        return 1
    fi
}

get_pid_listening_port() {
    local port=$1
    ss -tulpn 2>/dev/null | grep ":${port} " | awk '{print $NF}' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -n 1
}

# ------------------------------------------------------------------------------
# GESTION POSTGRESQL (Dépendance requise uniquement en mode local)
# ------------------------------------------------------------------------------

check_postgres() {
    if [ "$KC_MODE" = "remote" ]; then
        return 0
    fi
    if pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
        return 0
    elif check_port_listening 5432; then
        return 0
    elif systemctl is-active --quiet postgresql 2>/dev/null; then
        return 0
    elif [ "$(docker inspect -f '{{.State.Running}}' "$KEYCLOAK_CONTAINER" 2>/dev/null)" = "true" ]; then
        return 0
    elif docker run --rm --net=host postgres:alpine pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
        return 0
    else
        return 1
    fi
}

ensure_postgres() {
    if [ "$KC_MODE" = "remote" ]; then
        return 0
    fi
    if ! check_postgres; then
        echo -e "${YELLOW}[WARN] PostgreSQL n'est pas actif sur le port 5432.${NC}"
        echo -e "${BLUE}[INFO] Tentative de démarrage de PostgreSQL...${NC}"
        sudo systemctl start postgresql 2>/dev/null || true
        sleep 2
        if check_postgres; then
            echo -e "${GREEN}[OK] PostgreSQL démarré avec succès.${NC}"
        else
            echo -e "${RED}[ERROR] Impossible de démarrer PostgreSQL. Keycloak risque d'échouer.${NC}"
        fi
    fi
}

# ------------------------------------------------------------------------------
# GESTION KEYCLOAK (Support Hybride : Docker Local DEV / Serveur Distant PROD)
# ------------------------------------------------------------------------------

is_keycloak_running() {
    if [ "$KC_MODE" = "remote" ]; then
        if curl -s -f -m 3 -o /dev/null "$KC_DISCOVERY_URL" 2>/dev/null; then
            return 0
        fi
        return 1
    fi

    # Mode local Docker
    if [ "$(docker inspect -f '{{.State.Running}}' "$KEYCLOAK_CONTAINER" 2>/dev/null)" = "true" ]; then
        return 0
    fi
    if check_port_listening "$KC_PORT"; then
        return 0
    fi
    return 1
}

start_keycloak() {
    if [ "$KC_MODE" = "remote" ]; then
        echo -e "\n${BOLD}=== Statut Keycloak (Mode Distant / Production) ===${NC}"
        echo -e "${BLUE}[INFO] En production, Keycloak est hébergé sur un serveur distant.${NC}"
        echo -e "  → URL OIDC Découverte : ${CYAN}${KC_DISCOVERY_URL}${NC}"
        echo -e "${BLUE}[INFO] Aucun conteneur Keycloak ne sera démarré sur ce serveur TENNIS94.${NC}"
        echo -n "[INFO] Vérification de l'accessibilité du serveur Keycloak distant"
        local count=0
        local max=5
        while [ $count -lt $max ]; do
            if curl -s -f -m 3 -o /dev/null "$KC_DISCOVERY_URL" 2>/dev/null; then
                echo -e " ${GREEN}[OK]${NC}"
                echo -e "${GREEN}[SUCCESS] Le serveur Keycloak distant répond et est opérationnel !${NC}"
                return 0
            fi
            echo -n "."
            sleep 1
            count=$((count + 1))
        done
        echo -e " ${YELLOW}[ATTENTION]${NC}"
        echo -e "${YELLOW}[WARN] Le serveur distant n'a pas répondu dans les délais (${KC_DISCOVERY_URL}).${NC}"
        echo -e "${YELLOW}[WARN] Assurez-vous que l'URL OIDC est accessible depuis ce serveur.${NC}"
        return 0
    fi

    echo -e "\n${BOLD}=== Démarrage de Keycloak (Docker Local / Développement) ===${NC}"
    if is_keycloak_running; then
        echo -e "${YELLOW}[INFO] Keycloak est déjà en cours d'exécution dans le conteneur '${KEYCLOAK_CONTAINER}' (Port $KC_PORT).${NC}"
        return 0
    fi

    ensure_postgres

    echo -e "${BLUE}[INFO] Lancement du conteneur Keycloak '${KEYCLOAK_CONTAINER}'...${NC}"

    # Vérifier si le conteneur existe déjà (arrêté)
    if docker ps -a --format '{{.Names}}' | grep -q "^${KEYCLOAK_CONTAINER}$"; then
        docker start "$KEYCLOAK_CONTAINER" >/dev/null
    else
        if [ -f "$COMPOSE_FILE" ]; then
            docker compose -f "$COMPOSE_FILE" up -d >/dev/null
        else
            docker run -d \
              --name "$KEYCLOAK_CONTAINER" \
              --restart unless-stopped \
              --net=host \
              -e KC_DB=postgres \
              -e KC_DB_URL=jdbc:postgresql://localhost:5432/kcdb \
              -e KC_DB_USERNAME=keycloak \
              -e KC_DB_PASSWORD=kc123AIN \
              -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
              -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin123 \
              -e KC_HOSTNAME_STRICT=false \
              -e KC_HTTP_ENABLED=true \
              "$KC_IMAGE" \
              start-dev --http-port="$KC_PORT" --http-host=0.0.0.0 >/dev/null
        fi
    fi

    echo -n "[INFO] Attente de la disponibilité du serveur Keycloak"
    local count=0
    local max=35
    while [ $count -lt $max ]; do
        if curl -s -f -o /dev/null "$KC_DISCOVERY_URL" 2>/dev/null || docker logs --tail 25 "$KEYCLOAK_CONTAINER" 2>&1 | grep -q "Keycloak.*started in"; then
            echo -e " ${GREEN}[OK]${NC}"
            echo -e "${GREEN}[SUCCESS] Keycloak Docker est opérationnel !${NC}"
            echo -e "  → Conteneur      : ${CYAN}${KEYCLOAK_CONTAINER}${NC}"
            echo -e "  → URL OIDC Realm : ${CYAN}http://localhost:${KC_PORT}/realms/tennis94${NC}"
            echo -e "  → Console Admin  : ${CYAN}http://localhost:${KC_PORT}/admin/${NC}"
            return 0
        fi
        echo -n "."
        sleep 1
        count=$((count + 1))
    done

    # Si port 8080 écoute quand même
    if check_port_listening "$KC_PORT"; then
        echo -e " ${GREEN}[OK]${NC}"
        echo -e "${GREEN}[SUCCESS] Keycloak écoute sur le port $KC_PORT (initialisation en cours).${NC}"
        return 0
    fi

    echo -e " ${RED}[TIMEOUT]${NC}"
    echo -e "${RED}[ERROR] Keycloak a mis trop de temps à démarrer. Consultez les logs : docker logs ${KEYCLOAK_CONTAINER}${NC}"
    return 1
}

stop_keycloak() {
    if [ "$KC_MODE" = "remote" ]; then
        echo -e "\n${BOLD}=== Arrêt de Keycloak (Mode Distant / Production) ===${NC}"
        echo -e "${BLUE}[INFO] Keycloak est hébergé sur un serveur distant (${KC_DISCOVERY_URL}).${NC}"
        echo -e "${BLUE}[INFO] Aucun arrêt local à effectuer.${NC}"
        return 0
    fi

    echo -e "\n${BOLD}=== Arrêt de Keycloak (Docker Local) ===${NC}"
    if ! is_keycloak_running; then
        echo -e "${YELLOW}[INFO] Keycloak est déjà arrêté.${NC}"
        return 0
    fi

    echo -e "${BLUE}[INFO] Arrêt du conteneur '${KEYCLOAK_CONTAINER}'...${NC}"
    if docker ps --format '{{.Names}}' | grep -q "^${KEYCLOAK_CONTAINER}$"; then
        docker stop "$KEYCLOAK_CONTAINER" >/dev/null
    fi

    # Arrêt de sécurité au cas où un process local hors docker tourne
    local port_pid
    port_pid=$(get_pid_listening_port "$KC_PORT")
    if [ -n "$port_pid" ]; then
        kill -15 "$port_pid" 2>/dev/null || true
    fi

    echo -e "${GREEN}[SUCCESS] Keycloak arrêté.${NC}"
}

status_keycloak() {
    if [ "$KC_MODE" = "remote" ]; then
        echo -e "${BOLD}--- Keycloak (Serveur Distant / Production) ---${NC}"
        echo -e "  Mode        : ${CYAN}Distant (Keycloak externe)${NC}"
        echo -e "  Endpoint    : ${CYAN}${KC_DISCOVERY_URL}${NC}"
        if curl -s -f -m 3 -o /dev/null "$KC_DISCOVERY_URL" 2>/dev/null; then
            echo -e "  Statut      : ${GREEN}● EN LIGNE (Accessible / 200 OK)${NC}"
        else
            echo -e "  Statut      : ${RED}○ INACCESSIBLE (Ne répond pas)${NC}"
        fi
        return 0
    fi

    echo -e "${BOLD}--- Keycloak (Docker Local : $KEYCLOAK_CONTAINER) ---${NC}"
    local is_running
    is_running=$(docker inspect -f '{{.State.Running}}' "$KEYCLOAK_CONTAINER" 2>/dev/null || echo "false")
    
    if [ "$is_running" = "true" ]; then
        local container_id
        container_id=$(docker inspect -f '{{slice .Id 0 12}}' "$KEYCLOAK_CONTAINER" 2>/dev/null)
        local image_name
        image_name=$(docker inspect -f '{{.Config.Image}}' "$KEYCLOAK_CONTAINER" 2>/dev/null)
        
        echo -e "  Statut      : ${GREEN}● EN LIGNE (Conteneur actif)${NC}"
        echo -e "  Conteneur   : ${KEYCLOAK_CONTAINER} (ID: ${container_id:-N/A})"
        echo -e "  Image       : ${image_name:-$KC_IMAGE}"
        echo -e "  Port écoute : $KC_PORT"
        
        # Test HTTP & état Quarkus
        if curl -s -f -o /dev/null "$KC_DISCOVERY_URL" 2>/dev/null || docker logs --tail 25 "$KEYCLOAK_CONTAINER" 2>&1 | grep -q "started in"; then
            echo -e "  Realm OIDC  : ${GREEN}tennis94 [Prêt / 200 OK]${NC}"
        else
            echo -e "  Realm OIDC  : ${YELLOW}En cours de chargement...${NC}"
        fi
        echo -e "  Console     : http://localhost:${KC_PORT}/admin/"
    elif is_keycloak_running; then
        echo -e "  Statut      : ${GREEN}● EN LIGNE (Processus local / Port $KC_PORT)${NC}"
    else
        echo -e "  Statut      : ${RED}○ ARRÊTÉ${NC}"
    fi
}

# ------------------------------------------------------------------------------
# GESTION SERVEUR TENNIS94
# ------------------------------------------------------------------------------

is_tennis94_running() {
    # 1. Vérifier si le port 3000 écoute
    if check_port_listening "$TENNIS94_PORT"; then
        return 0
    fi
    # 2. Vérifier via systemd user
    if systemctl --user is-active --quiet padel-server.service 2>/dev/null; then
        return 0
    fi
    # 3. Vérifier via PID file
    if [ -f "$TENNIS94_PID_FILE" ]; then
        local pid
        pid=$(cat "$TENNIS94_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

start_tennis94() {
    echo -e "\n${BOLD}=== Démarrage du Serveur TENNIS94 ===${NC}"
    if is_tennis94_running; then
        local pid
        pid=$(get_pid_listening_port "$TENNIS94_PORT")
        echo -e "${YELLOW}[INFO] Le serveur TENNIS94 est déjà actif (Port $TENNIS94_PORT, PID : ${pid:-inconnu}).${NC}"
        return 0
    fi

    # Option A : Si le service systemd utilisateur existe et est configuré
    if [ -f "$HOME/.config/systemd/user/padel-server.service" ]; then
        echo -e "${BLUE}[INFO] Démarrage via le service systemd utilisateur (padel-server.service)...${NC}"
        systemctl --user start padel-server.service
        sleep 1
        if is_tennis94_running; then
            echo -e "${GREEN}[SUCCESS] Serveur TENNIS94 démarré avec succès via systemd !${NC}"
            echo -e "  → URL Dashboard : ${CYAN}http://localhost:${TENNIS94_PORT}${NC}"
            return 0
        fi
    fi

    # Option B : Démarrage direct Node.js en arrière-plan
    echo -e "${BLUE}[INFO] Lancement direct via Node.js en arrière-plan...${NC}"
    cd "$SCRIPT_DIR" || exit 1
    nohup node src/main.js --server > "$TENNIS94_LOG" 2>&1 &
    local new_pid=$!
    disown "$new_pid" 2>/dev/null || true
    echo "$new_pid" > "$TENNIS94_PID_FILE"

    sleep 2
    if is_tennis94_running; then
        echo -e "${GREEN}[SUCCESS] Serveur TENNIS94 démarré avec succès (PID : $new_pid) !${NC}"
        echo -e "  → URL Dashboard : ${CYAN}http://localhost:${TENNIS94_PORT}${NC}"
        echo -e "  → Fichier de log: ${TENNIS94_LOG}"
        return 0
    else
        echo -e "${RED}[ERROR] Échec du démarrage du serveur TENNIS94. Consultez les logs : ${TENNIS94_LOG}${NC}"
        return 1
    fi
}

stop_tennis94() {
    echo -e "\n${BOLD}=== Arrêt du Serveur TENNIS94 ===${NC}"
    if ! is_tennis94_running; then
        echo -e "${YELLOW}[INFO] Le serveur TENNIS94 est déjà arrêté.${NC}"
        rm -f "$TENNIS94_PID_FILE"
        return 0
    fi

    # 1. Arrêter via systemd si actif
    if systemctl --user is-active --quiet padel-server.service 2>/dev/null; then
        echo -e "${BLUE}[INFO] Arrêt via systemd (padel-server.service)...${NC}"
        systemctl --user stop padel-server.service 2>/dev/null || true
    fi

    # 2. Arrêter via PID file
    if [ -f "$TENNIS94_PID_FILE" ]; then
        local pid
        pid=$(cat "$TENNIS94_PID_FILE")
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill -15 "$pid" 2>/dev/null || true
        fi
    fi

    # 3. Arrêter via port si encore actif
    local port_pid
    port_pid=$(get_pid_listening_port "$TENNIS94_PORT")
    if [ -n "$port_pid" ]; then
        kill -15 "$port_pid" 2>/dev/null || true
    fi

    sleep 1
    if is_tennis94_running; then
        echo -e "${YELLOW}[WARN] Forçage de l'arrêt (SIGKILL)...${NC}"
        local remaining_pid
        remaining_pid=$(get_pid_listening_port "$TENNIS94_PORT")
        [ -n "$remaining_pid" ] && kill -9 "$remaining_pid" 2>/dev/null || true
    fi

    rm -f "$TENNIS94_PID_FILE"
    echo -e "${GREEN}[SUCCESS] Serveur TENNIS94 arrêté.${NC}"
}

status_tennis94() {
    echo -e "${BOLD}--- Serveur TENNIS94 (Port $TENNIS94_PORT) ---${NC}"
    if is_tennis94_running; then
        local pid
        pid=$(get_pid_listening_port "$TENNIS94_PORT")
        if [ -z "$pid" ] && [ -f "$TENNIS94_PID_FILE" ]; then
            pid=$(cat "$TENNIS94_PID_FILE")
        fi
        echo -e "  Statut      : ${GREEN}● EN LIGNE (Actif)${NC}"
        echo -e "  PID         : ${pid:-Détecté via port}"
        echo -e "  Port écoute : $TENNIS94_PORT"
        echo -e "  Dashboard   : http://localhost:$TENNIS94_PORT"
        
        # Statut systemd si applicable
        if systemctl --user is-active --quiet padel-server.service 2>/dev/null; then
            echo -e "  Mode        : ${CYAN}Géré par systemd utilisateur${NC}"
        else
            echo -e "  Mode        : ${CYAN}Processus d'arrière-plan (logs: ${TENNIS94_LOG})${NC}"
        fi
    else
        echo -e "  Statut      : ${RED}○ ARRÊTÉ${NC}"
    fi
}

# ------------------------------------------------------------------------------
# LOGS
# ------------------------------------------------------------------------------

view_logs() {
    local target=$1
    case "$target" in
        keycloak|kc)
            if [ "$KC_MODE" = "remote" ]; then
                echo -e "${BLUE}[INFO] Keycloak est hébergé sur un serveur distant (${KC_DISCOVERY_URL}).${NC}"
                echo -e "${BLUE}[INFO] Les journaux doivent être consultés directement sur le serveur Keycloak distant.${NC}"
                return 0
            fi
            if docker ps -a --format '{{.Names}}' | grep -q "^${KEYCLOAK_CONTAINER}$"; then
                echo -e "${BLUE}=== Suivi des logs Keycloak Docker (${KEYCLOAK_CONTAINER}) - Ctrl+C pour quitter ===${NC}"
                docker logs -f --tail 50 "$KEYCLOAK_CONTAINER"
            elif [ -f "$KEYCLOAK_LOG" ]; then
                echo -e "${BLUE}=== Suivi des logs Keycloak (${KEYCLOAK_LOG}) - Ctrl+C pour quitter ===${NC}"
                tail -n 50 -f "$KEYCLOAK_LOG"
            else
                echo -e "${RED}[ERROR] Conteneur Keycloak introuvable ($KEYCLOAK_CONTAINER).${NC}"
            fi
            ;;
        tennis94|padel)
            if systemctl --user is-active --quiet padel-server.service 2>/dev/null; then
                echo -e "${BLUE}=== Suivi des logs TENNIS94 via journald - Ctrl+C pour quitter ===${NC}"
                journalctl --user -u padel-server.service -f
            elif [ -f "$TENNIS94_LOG" ]; then
                echo -e "${BLUE}=== Suivi des logs TENNIS94 (${TENNIS94_LOG}) - Ctrl+C pour quitter ===${NC}"
                tail -n 50 -f "$TENNIS94_LOG"
            else
                echo -e "${RED}[ERROR] Fichier de log TENNIS94 introuvable ($TENNIS94_LOG).${NC}"
            fi
            ;;
        *)
            echo "Usage: $0 logs {keycloak|tennis94}"
            exit 1
            ;;
    esac
}

# ------------------------------------------------------------------------------
# LOGIQUE PRINCIPALE
# ------------------------------------------------------------------------------

ACTION="${CLI_ARGS[0]}"
TARGET="${CLI_ARGS[1]:-all}"

if [ -z "$ACTION" ]; then
    print_usage
fi

case "$ACTION" in
    start)
        case "$TARGET" in
            keycloak|kc)
                start_keycloak
                ;;
            tennis94|padel)
                start_tennis94
                ;;
            all)
                start_keycloak
                start_tennis94
                ;;
            *)
                print_usage
                ;;
        esac
        ;;
        
    stop)
        case "$TARGET" in
            keycloak|kc)
                stop_keycloak
                ;;
            tennis94|padel)
                stop_tennis94
                ;;
            all)
                stop_tennis94
                stop_keycloak
                ;;
            *)
                print_usage
                ;;
        esac
        ;;
        
    restart)
        case "$TARGET" in
            keycloak|kc)
                stop_keycloak
                sleep 1
                start_keycloak
                ;;
            tennis94|padel)
                stop_tennis94
                sleep 1
                start_tennis94
                ;;
            all)
                stop_tennis94
                stop_keycloak
                sleep 1
                start_keycloak
                start_tennis94
                ;;
            *)
                print_usage
                ;;
        esac
        ;;
        
    status)
        echo -e "\n=================================================="
        echo -e "       ${BOLD}ÉTAT DES SERVICES TENNIS94 & AUTH${NC}"
        echo -e "       Mode Keycloak : ${BOLD}${CYAN}${KC_MODE^^}${NC}"
        echo -e "=================================================="
        
        # Base de données PostgreSQL
        if [ "$KC_MODE" = "remote" ]; then
            echo -e "${BOLD}--- Base de Données PostgreSQL ---${NC}"
            echo -e "  Statut      : ${CYAN}Distant (Gérée sur le serveur Keycloak externe)${NC}\n"
        else
            echo -e "${BOLD}--- Base de Données PostgreSQL (Port 5432) ---${NC}"
            if check_postgres; then
                echo -e "  Statut      : ${GREEN}● EN LIGNE (Port 5432)${NC}\n"
            else
                echo -e "  Statut      : ${RED}○ ARRÊTÉ${NC}\n"
            fi
        fi
        
        case "$TARGET" in
            keycloak|kc)
                status_keycloak
                ;;
            tennis94|padel)
                status_tennis94
                ;;
            all)
                status_keycloak
                echo ""
                status_tennis94
                ;;
            *)
                print_usage
                ;;
        esac
        
        # Informations sur le timer systemd
        echo ""
        echo -e "${BOLD}--- Timer Réservation J-7 (padel-booking.timer) ---${NC}"
        timer_status=$(systemctl --user is-active padel-booking.timer 2>/dev/null || echo "inconnu")
        if [ "$timer_status" = "active" ]; then
            next_trigger=$(systemctl --user list-timers --all 2>/dev/null | grep "padel-booking.timer" | awk '{print $1" "$2" "$3}' | head -n 1)
            echo -e "  Statut      : ${GREEN}● ACTIF${NC} (Prochain : ${next_trigger:-N/A})"
        else
            echo -e "  Statut      : ${YELLOW}○ INACTIF / NON INSTALLÉ${NC}"
        fi
        echo -e "==================================================\n"
        ;;
        
    logs)
        view_logs "$TARGET"
        ;;
        
    *)
        print_usage
        ;;
esac
