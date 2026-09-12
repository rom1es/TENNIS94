#!/bin/bash

# ==============================================================================
# SCRIPT D'INITIALISATION KEYCLOAK - AUTOMATE PADEL TENNIS94
# ==============================================================================
# Ce script configure automatiquement Keycloak pour l'authentification :
# 1. Création du Realm 'tennis94'
# 2. Création du rôle de Realm 'padel-admin'
# 3. Création du client confidentiel 'padel-dashboard' (Standard Code Flow)
# 4. Récupération et affichage du Secret Client
# 5. Création d'un premier utilisateur de test avec le rôle padel-admin
# ==============================================================================

# --- Configuration par défaut ---
KC_PATH="/opt/keycloak"
KC_URL="http://localhost:8080"
KC_ADMIN_USER="admin"
KC_ADMIN_PASS="admin123" # Remplacer par le mot de passe admin de votre master realm

# Couleurs pour l'affichage
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== INITIALISATION DE KEYCLOAK POUR TENNIS94 ===${NC}\n"

# 1. Vérification de la présence de kcadm.sh (Hôte ou Conteneur Docker)
if [ -f "${KC_PATH}/bin/kcadm.sh" ]; then
    KCADM="${KC_PATH}/bin/kcadm.sh"
elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^tennis94-keycloak$"; then
    KCADM="docker exec tennis94-keycloak /opt/keycloak/bin/kcadm.sh"
else
    echo -e "${RED}[ERROR] L'outil kcadm.sh est introuvable à : ${KC_PATH}/bin/kcadm.sh et aucun conteneur Docker actif 'tennis94-keycloak' détecté.${NC}"
    echo -e "${YELLOW}Veuillez ajuster la variable KC_PATH dans ce script ou démarrer le conteneur Keycloak.${NC}"
    exit 1
fi

# Demander les identifiants si besoin d'interactivité
read -p "Adresse URL de Keycloak [${KC_URL}]: " input_url
KC_URL="${input_url:-$KC_URL}"

read -p "Identifiant Admin Master [${KC_ADMIN_USER}]: " input_user
KC_ADMIN_USER="${input_user:-$KC_ADMIN_USER}"

read -s -p "Mot de passe Admin Master [${KC_ADMIN_PASS}]: " input_pass
KC_ADMIN_PASS="${input_pass:-$KC_ADMIN_PASS}"
echo ""

# 2. Connexion / Authentification à l'API Admin de Keycloak
echo -e "\n${BLUE}[1/5] Connexion à l'instance Keycloak en tant qu'administrateur...${NC}"
$KCADM config credentials --server "$KC_URL" --realm master --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASS" 2>/dev/null

if [ $? -ne 0 ]; then
    echo -e "${RED}[ERROR] Impossible de s'authentifier auprès de Keycloak. Vérifiez l'URL et vos identifiants admin.${NC}"
    exit 1
fi
echo -e "${GREEN}[SUCCESS] Authentifié auprès de Keycloak avec succès.${NC}"

# 3. Création du Realm 'tennis94'
echo -e "\n${BLUE}[2/5] Création du Realm 'tennis94' dans Keycloak...${NC}"
# Vérifier si le realm existe déjà
REALM_EXISTS=$($KCADM get realms/tennis94 2>/dev/null)
if [ -n "$REALM_EXISTS" ]; then
    echo -e "${YELLOW}[INFO] Le Realm 'tennis94' existe déjà. Passage à l'étape suivante.${NC}"
else
    $KCADM create realms -s realm=tennis94 -s enabled=true
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[SUCCESS] Realm 'tennis94' créé avec succès.${NC}"
    else
        echo -e "${RED}[ERROR] Impossible de créer le Realm 'tennis94'.${NC}"
        exit 1
    fi
fi

# 4. Création du rôle 'padel-admin'
echo -e "\n${BLUE}[3/5] Création du rôle de Realm 'padel-admin'...${NC}"
ROLE_EXISTS=$($KCADM get roles/padel-admin -r tennis94 2>/dev/null)
if [ -n "$ROLE_EXISTS" ]; then
    echo -e "${YELLOW}[INFO] Le rôle 'padel-admin' existe déjà. Passage à l'étape suivante.${NC}"
else
    $KCADM create roles -r tennis94 -s name=padel-admin -s description="Administrateurs autorisés à gérer le tableau de bord Padel"
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[SUCCESS] Rôle 'padel-admin' créé avec succès.${NC}"
    else
        echo -e "${RED}[ERROR] Impossible de créer le rôle 'padel-admin'.${NC}"
        exit 1
    fi
fi

# 5. Création du Client Confidentiel 'padel-dashboard'
echo -e "\n${BLUE}[4/5] Création du Client 'padel-dashboard' (OAuth2)...${NC}"
CLIENT_EXISTS=$($KCADM get clients?clientId=padel-dashboard -r tennis94 | grep id | head -n 1)

if [ -n "$CLIENT_EXISTS" ]; then
    echo -e "${YELLOW}[INFO] Le client 'padel-dashboard' existe déjà. Récupération des informations existantes...${NC}"
    CLIENT_ID=$(echo "$CLIENT_EXISTS" | awk -F'"' '{print $4}')
else
    # Créer le client confidentiel avec redirection standard et accès aux rôles
    CLIENT_ID=$($KCADM create clients -r tennis94 -b '{
        "clientId": "padel-dashboard",
        "enabled": true,
        "publicClient": false,
        "redirectUris": ["http://localhost:3000/auth/callback", "https://*/auth/callback"],
        "webOrigins": ["+"],
        "standardFlowEnabled": true
    }' -i)
    
    if [ $? -eq 0 ] && [ -n "$CLIENT_ID" ]; then
        echo -e "${GREEN}[SUCCESS] Client 'padel-dashboard' créé avec succès. (ID: $CLIENT_ID)${NC}"
    else
        echo -e "${RED}[ERROR] Échec de la création du client 'padel-dashboard'.${NC}"
        exit 1
    fi
fi

# Récupérer le Secret Client généré automatiquement par Keycloak
CLIENT_SECRET=$($KCADM get clients/$CLIENT_ID/client-secret -r tennis94 --fields value | grep value | awk -F'"' '{print $4}')

if [ -n "$CLIENT_SECRET" ]; then
    echo -e "${GREEN}[SUCCESS] Secret Client récupéré : ${YELLOW}$CLIENT_SECRET${NC}"
else
    echo -e "${RED}[ERROR] Impossible de récupérer le Secret Client.${NC}"
fi

# 6. Création d'un premier utilisateur de test
echo -e "\n${BLUE}[5/5] Création d'un utilisateur administrateur de test...${NC}"
read -p "Nom d'utilisateur souhaité [romain]: " input_user_test
USER_TEST="${input_user_test:-romain}"

read -s -p "Mot de passe pour cet utilisateur: " USER_PASS
echo ""

USER_EXISTS=$($KCADM get users?username=$USER_TEST -r tennis94 | grep id | head -n 1)
if [ -n "$USER_EXISTS" ]; then
    echo -e "${YELLOW}[INFO] L'utilisateur '$USER_TEST' existe déjà.${NC}"
    # S'assurer que le rôle est attribué même s'il existait déjà
    $KCADM add-roles -r tennis94 --uusername "$USER_TEST" --rolename padel-admin 2>/dev/null
    echo -e "${GREEN}[SUCCESS] Rôle 'padel-admin' vérifié pour '$USER_TEST'.${NC}"
else
    # Création du compte local dans la DB Keycloak
    $KCADM create users -r tennis94 -s username="$USER_TEST" -s enabled=true -s firstName="Romain" -s lastName="Esnault" -s email="romain.esnault@gmail.com"
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[SUCCESS] Utilisateur '$USER_TEST' créé.${NC}"
        
        # Attribution du mot de passe
        $KCADM set-password -r tennis94 --username "$USER_TEST" --new-password "$USER_PASS" 2>/dev/null
        echo -e "${GREEN}[SUCCESS] Mot de passe configuré.${NC}"
        
        # Attribution du rôle padel-admin (--rolename pour les rôles de realm)
        $KCADM add-roles -r tennis94 --uusername "$USER_TEST" --rolename padel-admin
        echo -e "${GREEN}[SUCCESS] Rôle 'padel-admin' attribué à l'utilisateur '$USER_TEST'.${NC}"
    else
        echo -e "${RED}[ERROR] Impossible de créer l'utilisateur.${NC}"
    fi
fi

# Configuration du scope 'roles' pour propager les rôles dans l'ID Token ET l'Access Token
ROLES_SCOPE_ID=$($KCADM get client-scopes -r tennis94 2>/dev/null | grep -B 2 '"name" : "roles"' | grep id | awk -F'"' '{print $4}' | head -n 1)
if [ -n "$ROLES_SCOPE_ID" ]; then
    REALM_MAPPER_ID=$($KCADM get client-scopes/$ROLES_SCOPE_ID/protocol-mappers/models -r tennis94 2>/dev/null | grep -B 2 '"name" : "realm roles"' | grep id | awk -F'"' '{print $4}' | head -n 1)
    if [ -n "$REALM_MAPPER_ID" ]; then
        $KCADM update client-scopes/$ROLES_SCOPE_ID/protocol-mappers/models/$REALM_MAPPER_ID -r tennis94 -s 'config."id.token.claim"="true"' 2>/dev/null || true
    fi
fi

# ==============================================================================
# RÉCAPITULATIF DE CONFIGURATION
# ==============================================================================
echo -e "\n=============================================================================="
echo -e "${GREEN}KEYCLOAK INITIALISÉ ET CONFIGURÉ AVEC SUCCÈS !${NC}"
echo -e "=============================================================================="
echo -e "Vous pouvez maintenant coller la configuration suivante dans votre fichier ${YELLOW}.env${NC} :"
echo ""
echo -e "ENABLE_KEYCLOAK=true"
echo -e "KC_DISCOVERY_URL=${KC_URL}/realms/tennis94/.well-known/openid-configuration"
echo -e "KC_CLIENT_ID=padel-dashboard"
echo -e "KC_CLIENT_SECRET=${YELLOW}${CLIENT_SECRET}${NC}"
echo -e "KC_REDIRECT_URI=http://localhost:3000/auth/callback" # Remplacer par votre domaine externe si nécessaire
echo -e "SESSION_SECRET=$(openssl rand -hex 24 2>/dev/null || echo "un_secret_tres_aleatoire_et_long_12345")"
echo -e "=============================================================================="
echo -e "Utilisateur Keycloak créé : ${YELLOW}${USER_TEST}${NC}"
echo -e "=============================================================================="
