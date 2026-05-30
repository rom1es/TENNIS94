document.addEventListener('DOMContentLoaded', () => {
  // Sélection des éléments du DOM
  const timerToggle = document.getElementById('timer-toggle');
  const timerStatusBadge = document.getElementById('timer-status-badge');
  const nextExecutionSpan = document.getElementById('next-execution');
  
  const bookingListContainer = document.getElementById('booking-list-container');
  const openPlanningModalBtn = document.getElementById('open-planning-modal-btn');
  const saveConfigBtn = document.getElementById('save-config-btn');
  
  // Modale Comptes
  const openAccountsBtn = document.getElementById('open-accounts-btn');
  const closeAccountsBtn = document.getElementById('close-accounts-btn');
  const accountsModal = document.getElementById('accounts-modal');
  
  const accountsListContainer = document.getElementById('accounts-list-container');
  const addAccountForm = document.getElementById('add-account-form');
  const newAccountEmailInput = document.getElementById('new-account-email');
  const newAccountPasswordInput = document.getElementById('new-account-password');
  
  // Modale Planification
  const planningModal = document.getElementById('planning-modal');
  const closePlanningModalBtn = document.getElementById('close-planning-modal-btn');
  const planningModalTitle = document.getElementById('planning-modal-title');
  const newSlotDaySelect = document.getElementById('new-slot-day');
  const newSlotHourSelect = document.getElementById('new-slot-hour');
  const newSlotSportSelect = document.getElementById('new-slot-sport'); // NEW
  const newSlotAccountSelect = document.getElementById('new-slot-account');
  const submitSlotBtn = document.getElementById('submit-slot-btn');
  
  const refreshHistoryBtn = document.getElementById('refresh-history-btn');
  const historyTbody = document.getElementById('history-tbody');
  const systemTimeDiv = document.getElementById('system-time').querySelector('span');
  
  const newSlotDaySelectElem = document.getElementById('new-slot-day');
  const newSlotHourSelectElem = document.getElementById('new-slot-hour');
  
  // État local de la configuration, des sports, des comptes et du suivi des changements
  let localConfig = { sports: {}, bookings: [] };
  let savedConfig = { sports: {}, bookings: [] }; // Copie de ce qui est sauvegardé côté backend
  let registeredAccounts = []; // Liste des emails uniquement
  let editingSlotIndex = -1; // Index du créneau en cours de modification (-1 = Création)

  // Traduction des jours
  const dayTranslations = {
    'Monday': 'Lundi',
    'Tuesday': 'Mardi',
    'Wednesday': 'Mercredi',
    'Thursday': 'Jeudi',
    'Friday': 'Vendredi',
    'Saturday': 'Samedi',
    'Sunday': 'Dimanche'
  };

  // --- 1. HORLOGE SYSTEME ---
  function updateTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    systemTimeDiv.innerHTML = `${hours}:${minutes}:${seconds}`;
  }
  setInterval(updateTime, 1000);
  updateTime();

  // --- 2. NOTIFICATIONS (TOAST) ---
  function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.className = `toast ${type}`;
    toast.innerHTML = message;
    toast.classList.remove('hidden');
    
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 4000);
  }

  // --- 3. GESTION DES MODALES ---
  
  // Modale Comptes
  openAccountsBtn.addEventListener('click', () => {
    accountsModal.classList.remove('hidden');
  });
  closeAccountsBtn.addEventListener('click', () => {
    accountsModal.classList.add('hidden');
  });
  accountsModal.addEventListener('click', (e) => {
    if (e.target === accountsModal) {
      accountsModal.classList.add('hidden');
    }
  });

  // Modale Planification
  openPlanningModalBtn.addEventListener('click', () => {
    editingSlotIndex = -1;
    planningModalTitle.innerText = "Ajouter un créneau";
    submitSlotBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Ajouter au planning';
    
    // Valeurs par défaut
    newSlotDaySelect.value = "Saturday";
    newSlotHourSelect.value = "9";
    
    // Positionner le premier sport disponible
    const sportsKeys = Object.keys(localConfig.sports || {});
    if (sportsKeys.length > 0) {
      newSlotSportSelect.value = sportsKeys[0];
    } else {
      newSlotSportSelect.value = "";
    }
    
    // Positionner le premier compte disponible
    if (registeredAccounts.length > 0) {
      newSlotAccountSelect.value = registeredAccounts[0];
    } else {
      newSlotAccountSelect.value = "";
    }
    
    planningModal.classList.remove('hidden');
  });
  
  closePlanningModalBtn.addEventListener('click', () => {
    planningModal.classList.add('hidden');
  });
  
  planningModal.addEventListener('click', (e) => {
    if (e.target === planningModal) {
      planningModal.classList.add('hidden');
    }
  });

  // --- 4. GESTION DU BOUTON ENREGISTRER ---
  function checkUnsavedChanges() {
    const localStr = JSON.stringify(localConfig.bookings);
    const savedStr = JSON.stringify(savedConfig.bookings);
    
    if (localStr !== savedStr) {
      saveConfigBtn.disabled = false;
      saveConfigBtn.className = 'btn btn-save-active btn-sm';
    } else {
      saveConfigBtn.disabled = true;
      saveConfigBtn.className = 'btn btn-save-inactive btn-sm';
    }
  }

  // --- 5. CHARGEMENT DES COMPTES ---
  async function fetchAccounts() {
    try {
      accountsListContainer.innerHTML = '<div class="loading-placeholder">Chargement...</div>';
      const response = await fetch('/api/accounts');
      if (!response.ok) throw new Error("Erreur de récupération");
      
      registeredAccounts = await response.json();
      renderAccounts();
      populateAccountSelect();
    } catch (err) {
      console.error(err);
      accountsListContainer.innerHTML = '<div class="loading-placeholder" style="color: #ef4444;">Impossible de charger les comptes.</div>';
    }
  }

  function renderAccounts() {
    if (registeredAccounts.length === 0) {
      accountsListContainer.innerHTML = '<div class="loading-placeholder">Aucun compte Sport94 enregistré.</div>';
      return;
    }

    accountsListContainer.innerHTML = '';
    registeredAccounts.forEach(email => {
      const item = document.createElement('div');
      item.className = 'account-item';
      item.innerHTML = `
        <span class="account-email">${email}</span>
        <button class="btn btn-danger btn-icon btn-sm delete-account-btn" data-email="${email}">
          <i class="fa-regular fa-trash-can"></i>
        </button>
      `;
      accountsListContainer.appendChild(item);
    });

    // Écouteurs de suppression de compte
    document.querySelectorAll('.delete-account-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const email = e.currentTarget.getAttribute('data-email');
        if (confirm(`Voulez-vous vraiment supprimer le compte ${email} ? Ses sessions et tâches associées devront être reconfigurées.`)) {
          await deleteAccount(email);
        }
      });
    });
  }

  async function deleteAccount(email) {
    try {
      const response = await fetch(`/api/accounts/${encodeURIComponent(email)}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error("Erreur lors de la suppression");
      
      showToast("Compte supprimé avec succès.");
      await fetchAccounts();
      await fetchConfig();
    } catch (err) {
      showToast("Échec de la suppression du compte.", "error");
    }
  }

  function populateAccountSelect() {
    newSlotAccountSelect.innerHTML = '<option value="" disabled selected>Choisir un compte...</option>';
    
    registeredAccounts.forEach(email => {
      const option = document.createElement('option');
      option.value = email;
      option.innerText = email;
      newSlotAccountSelect.appendChild(option);
    });
  }

  // --- 6. ALIMENTER LE SELECTEUR DE SPORT ---
  function populateSportSelect() {
    newSlotSportSelect.innerHTML = '<option value="" disabled selected>Choisir un sport...</option>';
    const sports = localConfig.sports || {};
    
    Object.keys(sports).forEach(key => {
      const option = document.createElement('option');
      option.value = key;
      option.innerText = sports[key].name || key;
      newSlotSportSelect.appendChild(option);
    });
  }

  // --- 7. CHARGEMENT CONFIGURATION ---
  async function fetchConfig() {
    try {
      bookingListContainer.innerHTML = '<div class="loading-placeholder">Chargement...</div>';
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error("Erreur de récupération");
      
      const data = await response.json();
      localConfig = data;
      // Faire une copie profonde pour le suivi des changements
      savedConfig = JSON.parse(JSON.stringify(data));
      
      populateSportSelect();
      renderBookingList();
      checkUnsavedChanges();
    } catch (err) {
      console.error(err);
      bookingListContainer.innerHTML = '<div class="loading-placeholder" style="color: #ef4444;">Impossible de charger le planning.</div>';
    }
  }

  function renderBookingList() {
    const bookings = localConfig.bookings || [];
    
    if (bookings.length === 0) {
      bookingListContainer.innerHTML = '<div class="loading-placeholder">Aucun créneau configuré. Cliquez sur "Ajouter" pour commencer.</div>';
      return;
    }

    bookingListContainer.innerHTML = '';
    bookings.forEach((slot, index) => {
      const dayFr = dayTranslations[slot.day] || slot.day;
      const endHour = slot.start_hour + 1;
      
      // Badge spécifique par sport pour un effet esthétique vibrant
      const sportColor = slot.sport === 'Padel' ? '#f59e0b' : '#10b981';
      const sportBg = slot.sport === 'Padel' ? 'rgba(245,158,11,0.1)' : 'rgba(16,185,129,0.1)';
      const sportBorder = slot.sport === 'Padel' ? 'rgba(245,158,11,0.25)' : 'rgba(16,185,129,0.25)';
      const sportBadge = `<span class="day-badge" style="background: ${sportBg}; color: ${sportColor}; border-color: ${sportBorder}; margin-right: 6px;">${slot.sport}</span>`;
      
      const accountWarning = registeredAccounts.includes(slot.account)
        ? `<span class="booking-account-badge"><i class="fa-solid fa-user-check"></i> ${slot.account}</span>`
        : `<span class="booking-account-badge" style="color: #ef4444; border-color: rgba(239,68,68,0.25); background: rgba(239,68,68,0.05);"><i class="fa-solid fa-triangle-exclamation"></i> Compte manquant : ${slot.account}</span>`;

      const item = document.createElement('div');
      item.className = 'booking-item';
      item.innerHTML = `
        <div class="item-info">
          <div>
            ${sportBadge}
            <span class="day-badge">${dayFr}</span>
            <span class="time-text">${String(slot.start_hour).padStart(2, '0')}:00 - ${String(endHour).padStart(2, '0')}:00</span>
            <br>
            ${accountWarning}
          </div>
        </div>
        <div class="item-actions" style="display: flex; gap: 8px;">
          <button class="btn btn-warning btn-icon btn-sm book-now-btn" data-index="${index}" title="Réserver immédiatement (sans attendre)">
            <i class="fa-solid fa-bolt"></i>
          </button>
          <button class="btn btn-danger btn-icon btn-sm delete-slot-btn" data-index="${index}" title="Supprimer ce créneau">
            <i class="fa-regular fa-trash-can"></i>
          </button>
        </div>
      `;
      
      // Écouteur de clic sur le corps du créneau (Modification / Pré-population)
      item.addEventListener('click', (e) => {
        if (e.target.closest('.delete-slot-btn') || e.target.closest('.fa-trash-can') || e.target.closest('.book-now-btn') || e.target.closest('.fa-bolt')) {
          return;
        }
        
        editingSlotIndex = index;
        planningModalTitle.innerText = "Modifier le créneau";
        submitSlotBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Valider les modifications';
        
        newSlotDaySelect.value = slot.day;
        newSlotHourSelect.value = String(slot.start_hour);
        newSlotSportSelect.value = slot.sport || "Padel";
        newSlotAccountSelect.value = slot.account;
        
        planningModal.classList.remove('hidden');
      });

      bookingListContainer.appendChild(item);
    });

    // Écouteurs de suppression de créneau
    document.querySelectorAll('.delete-slot-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        localConfig.bookings.splice(index, 1);
        renderBookingList();
        checkUnsavedChanges();
      });
    });

    // Écouteurs de réservation immédiate
    document.querySelectorAll('.book-now-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); // Évite tout clic parasite
        const index = parseInt(e.currentTarget.getAttribute('data-index'), 10);
        const slot = localConfig.bookings[index];
        const dayFr = dayTranslations[slot.day] || slot.day;
        
        if (!confirm(`Voulez-vous vraiment lancer IMMEDIATEMENT la réservation J-7 pour le créneau : ${dayFr} à ${slot.start_hour}h (${slot.sport}) avec le compte ${slot.account} ?\n\n(Cette action utilise Playwright en arrière-plan et peut prendre environ 10 secondes)`)) {
          return;
        }
        
        const originalBtn = e.currentTarget;
        const icon = originalBtn.querySelector('i');
        
        // Mettre en chargement
        originalBtn.disabled = true;
        originalBtn.style.opacity = '0.6';
        icon.className = 'fa-solid fa-spinner fa-spin';
        
        showToast("Tentative de réservation immédiate lancée...", "info");
        
        try {
          const response = await fetch('/api/book-now', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(slot)
          });
          
          const result = await response.json();
          
          if (!response.ok) {
            throw new Error(result.error || "Une erreur inconnue est survenue.");
          }
          
          showToast(`🎉 Succès ! ${result.message}`);
          await fetchHistory(); // Mettre à jour la table de logs en direct
        } catch (err) {
          console.error(err);
          showToast(`❌ Échec de la réservation : ${err.message}`, "error");
          await fetchHistory(); // Même en échec, des logs ont été écrits
        } finally {
          // Rétablir le bouton
          originalBtn.disabled = false;
          originalBtn.style.opacity = '1';
          icon.className = 'fa-solid fa-bolt';
        }
      });
    });
  }

  // --- 8. CONFIGURATION SYSTEMD ---
  async function fetchSystemdStatus() {
    try {
      const response = await fetch('/api/systemd/status');
      if (!response.ok) throw new Error();
      const status = await response.json();
      
      const isEnabled = status.enabled === 'enabled';
      timerToggle.checked = isEnabled;
      timerToggle.disabled = false;
      
      if (status.active === 'active') {
        timerStatusBadge.className = 'status-badge active';
        timerStatusBadge.innerText = 'Actif';
      } else {
        timerStatusBadge.className = 'status-badge inactive';
        timerStatusBadge.innerText = 'Inactif';
      }
      
      nextExecutionSpan.innerText = isEnabled ? status.next : 'Désactivé (Timer éteint)';
    } catch (err) {
      console.error(err);
      timerStatusBadge.className = 'status-badge inactive';
      timerStatusBadge.innerText = 'Erreur système';
      nextExecutionSpan.innerText = 'Indisponible';
    }
  }

  // --- 9. CHARGEMENT HISTORIQUE ---
  async function fetchHistory() {
    try {
      historyTbody.innerHTML = '<tr><td colspan="5" class="table-loading">Chargement...</td></tr>';
      const response = await fetch('/api/history');
      if (!response.ok) throw new Error();
      const history = await response.json();
      
      if (history.length === 0) {
        historyTbody.innerHTML = '<tr><td colspan="5" class="table-empty">Aucun historique de réservation pour le moment.</td></tr>';
        return;
      }
      
      historyTbody.innerHTML = '';
      history.forEach(run => {
        const dateExec = new Date(run.timestamp).toLocaleString('fr-FR');
        const dayFr = dayTranslations[run.target_day] || run.target_day;
        const statusPill = run.status === 'SUCCESS' 
          ? '<span class="status-pill success"><i class="fa-solid fa-check"></i> Succès</span>'
          : '<span class="status-pill failure"><i class="fa-solid fa-xmark"></i> Échec</span>';
        
        const row = document.createElement('tr');
        row.innerHTML = `
          <td class="time-val">${dateExec}</td>
          <td><strong>${dayFr} à ${run.target_hour}h</strong></td>
          <td>${statusPill}</td>
          <td><span class="court-badge">${run.court_booked || 'N/A'}</span></td>
          <td style="font-size: 11px; font-family: monospace; color: var(--text-muted);">${run.account}</td>
        `;
        historyTbody.appendChild(row);
      });
    } catch (err) {
      console.error(err);
      historyTbody.innerHTML = '<tr><td colspan="5" class="table-loading" style="color: #ef4444;">Impossible de charger l\'historique.</td></tr>';
    }
  }

  // --- 10. EVENEMENTS & INTERACTIONS ---
  
  // Soumission de l'enregistrement de compte
  addAccountForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = newAccountEmailInput.value.trim();
    const password = newAccountPasswordInput.value;

    try {
      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (!response.ok) throw new Error();
      
      showToast(`Compte ${email} enregistré/mis à jour avec succès.`);
      newAccountEmailInput.value = '';
      newAccountPasswordInput.value = '';
      
      await fetchAccounts();
      await fetchConfig();
    } catch (err) {
      showToast("Impossible d'enregistrer le compte.", "error");
    }
  });

  // Soumission de créneau (Ajout ou Modification)
  submitSlotBtn.addEventListener('click', () => {
    const day = newSlotDaySelect.value;
    const hour = parseInt(newSlotHourSelect.value, 10);
    const sport = newSlotSportSelect.value;
    const account = newSlotAccountSelect.value;

    if (!sport) {
      showToast("Veuillez sélectionner un type de sport !", "error");
      return;
    }

    if (!account) {
      showToast("Veuillez sélectionner un compte pour ce créneau !", "error");
      return;
    }
    
    // Éviter les doublons (pour les créneaux autres que celui modifié)
    const duplicate = localConfig.bookings.some((slot, idx) => {
      if (editingSlotIndex === idx) return false;
      return slot.day === day && slot.start_hour === hour;
    });
    
    if (duplicate) {
      showToast("Un créneau identique pour le même jour et la même heure existe déjà !", "error");
      return;
    }
    
    if (editingSlotIndex === -1) {
      // Mode Création
      localConfig.bookings.push({ day, start_hour: hour, sport, account });
      showToast("Créneau ajouté au planning local.");
    } else {
      // Mode Modification
      localConfig.bookings[editingSlotIndex] = { day, start_hour: hour, sport, account };
      showToast("Créneau mis à jour dans le planning local.");
    }
    
    // Réordonner le tableau local
    const dayWeights = { 'Monday':1, 'Tuesday':2, 'Wednesday':3, 'Thursday':4, 'Friday':5, 'Saturday':6, 'Sunday':7 };
    localConfig.bookings.sort((a, b) => {
      if (dayWeights[a.day] !== dayWeights[b.day]) {
        return dayWeights[a.day] - dayWeights[b.day];
      }
      return a.start_hour - b.start_hour;
    });
    
    planningModal.classList.add('hidden');
    renderBookingList();
    checkUnsavedChanges();
  });

  // Enregistrer le planning vers le backend
  saveConfigBtn.addEventListener('click', async () => {
    try {
      saveConfigBtn.disabled = true;
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookings: localConfig.bookings }) // Ne post que bookings, server préserve sports
      });
      
      if (!response.ok) {
        const res = await response.json();
        throw new Error(res.error || "Erreur de validation");
      }
      
      // Mettre à jour l'état sauvegardé
      savedConfig = JSON.parse(JSON.stringify(localConfig));
      
      showToast("Le planning de réservation a été enregistré et appliqué !");
      checkUnsavedChanges();
    } catch (err) {
      showToast(err.message || "Échec de la sauvegarde du planning.", "error");
    } finally {
      saveConfigBtn.disabled = false;
    }
  });

  // Basculer l'activation du timer systemd
  timerToggle.addEventListener('change', async () => {
    const action = timerToggle.checked ? 'enable' : 'disable';
    try {
      timerToggle.disabled = true;
      const response = await fetch('/api/systemd/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      
      if (!response.ok) throw new Error();
      const res = await response.json();
      
      showToast(res.message);
      
      const status = res.status;
      if (status) {
        if (status.active === 'active') {
          timerStatusBadge.className = 'status-badge active';
          timerStatusBadge.innerText = 'Actif';
        } else {
          timerStatusBadge.className = 'status-badge inactive';
          timerStatusBadge.innerText = 'Inactif';
        }
        nextExecutionSpan.innerText = timerToggle.checked ? status.next : 'Désactivé (Timer éteint)';
      }
    } catch (err) {
      showToast("Impossible de changer l'état système.", "error");
      timerToggle.checked = !timerToggle.checked;
    } finally {
      timerToggle.disabled = false;
    }
  });

  // Rafraîchir l'historique
  refreshHistoryBtn.addEventListener('click', () => {
    fetchHistory();
    showToast("Historique mis à jour.");
  });

  // --- 11. INITIALISATION GLOBALE ---
  fetchAccounts().then(() => {
    fetchConfig();
    fetchSystemdStatus();
    fetchHistory();
  });
});
