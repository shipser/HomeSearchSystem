// Check if opened via file:// protocol directly
if (window.location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#b91c1c;color:#fff;padding:14px 20px;text-align:center;font-weight:bold;z-index:999999;box-shadow:0 4px 10px rgba(0,0,0,0.3);direction:rtl;font-size:15px;';
    banner.innerHTML = '⚠️ <strong>שים לב:</strong> פתחת את הטופס ישירות כקובץ מקומי. כדי להשתמש במסד הנתונים ולסנכרן בין מספר מכשירים (מחשב וטלפון), יש להפעיל את הקובץ <code>start.bat</code> או להריץ <code>npm start</code>, ואז לגלוש אל: <a href="http://localhost:3000" style="color:#fef08a;text-decoration:underline;margin-right:6px;">http://localhost:3000</a>';
    document.body.prepend(banner);
  });
}

// Unique client identifier to differentiate devices in SSE broadcasts
const CLIENT_ID = 'client_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

// State
let currentFormId = null;
let currentFormData = {};
let allFormsSummaries = [];
let isOnline = false;
let isSaving = false;
let saveDebounceTimer = null;
let sseEventSource = null;
let pendingExternalUpdate = null;

// DOM Elements
const formElement = document.getElementById('apartment_form');
const formIdInput = document.getElementById('form_id');
const activeAptTitle = document.getElementById('active_apt_title');
const activeAptMeta = document.getElementById('active_apt_meta');
const aptQuickSelect = document.getElementById('apt_quick_select');
const syncStatusBadge = document.getElementById('sync_status_badge');
const syncStatusText = document.getElementById('sync_status_text');
const migrationBanner = document.getElementById('migration_banner');
const externalUpdateBanner = document.getElementById('external_update_banner');
const qrDialog = document.getElementById('qr_modal');
const formsDialog = document.getElementById('forms_modal');
const formsCardsContainer = document.getElementById('forms_cards_container');
const formsSearchInput = document.getElementById('forms_search_input');

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  initSSE();
  initEventListeners();
  initPhoneMasks();
  
  // Load forms from server
  await loadFormsList();
  
  // Check for local storage legacy forms to import
  checkLegacyLocalStorage();
  
  // Preload network info for QR modal
  preloadNetworkInfo();
});

/* ==========================================================================
   SSE & Real-Time Synchronization
   ========================================================================== */

function initSSE() {
  if (sseEventSource) {
    sseEventSource.close();
  }

  sseEventSource = new EventSource(`/api/events?clientId=${encodeURIComponent(CLIENT_ID)}`);

  sseEventSource.onopen = () => {
    setSyncStatus('synced', 'מחובר ומסונכרן');
    isOnline = true;
    checkPendingOfflineSaves();
  };

  sseEventSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleRealtimeEvent(msg);
    } catch (e) {
      console.error('Failed to parse SSE event:', e);
    }
  };

  sseEventSource.onerror = () => {
    setSyncStatus('offline', 'לא מחובר לשרת (שמירה מקומית)');
    isOnline = false;
  };
}

function handleRealtimeEvent(msg) {
  const { type, payload, senderClientId } = msg;

  if (type === 'CONNECTED') {
    return;
  }

  // If another device created or deleted a form, refresh the list
  if (type === 'FORM_CREATED' || type === 'FORM_DELETED' || type === 'FORMS_BULK_IMPORTED') {
    loadFormsList(false);
    
    // If active form was deleted remotely, switch to another form
    if (type === 'FORM_DELETED' && payload.id === currentFormId) {
      showToast('הטופס הפעיל נמחק ממכשיר אחר', 'warning');
      loadFormsList(true);
    }
  }

  // If another device updated a form
  if (type === 'FORM_UPDATED') {
    loadFormsList(false);

    // If another device updated the form currently open on this screen
    if (payload.id === currentFormId && senderClientId !== CLIENT_ID) {
      pendingExternalUpdate = payload;
      showExternalUpdateBanner(payload);
    }
  }
}

function showExternalUpdateBanner(updateInfo) {
  if (!externalUpdateBanner) return;
  const timeStr = new Date(updateInfo.updated_at || Date.now()).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  const textSpan = document.getElementById('external_update_text');
  if (textSpan) {
    textSpan.innerText = `טופס זה עודכן זה עתה ממכשיר אחר (${timeStr}).`;
  }
  externalUpdateBanner.classList.remove('hidden');
}

function reloadFromExternalUpdate() {
  if (currentFormId) {
    loadFormById(currentFormId);
    externalUpdateBanner.classList.add('hidden');
    pendingExternalUpdate = null;
    showToast('הנתונים סונכרנו בהצלחה', 'success');
  }
}

function dismissExternalUpdate() {
  if (externalUpdateBanner) {
    externalUpdateBanner.classList.add('hidden');
    pendingExternalUpdate = null;
  }
}

/* ==========================================================================
   Sync Status UI
   ========================================================================== */

function setSyncStatus(state, message) {
  if (!syncStatusBadge || !syncStatusText) return;
  syncStatusBadge.className = 'sync-badge ' + state;
  syncStatusText.innerText = message;
}

/* ==========================================================================
   Form Data & REST API Calls
   ========================================================================== */

async function loadFormsList(autoSelectFirstIfNone = true) {
  try {
    const res = await fetch('/api/forms');
    const data = await res.json();
    if (data.success) {
      allFormsSummaries = data.forms;
      updateQuickSelect();
      renderFormsListModal();

      if (allFormsSummaries.length === 0) {
        // No forms yet, create one
        await createNewForm();
      } else if (!currentFormId && autoSelectFirstIfNone) {
        // Select first form
        await loadFormById(allFormsSummaries[0].id);
      } else if (currentFormId) {
        // Update header of current form
        const currentMeta = allFormsSummaries.find(f => f.id === currentFormId);
        if (currentMeta) {
          updateHeaderInfo(currentMeta);
        }
      }
    }
  } catch (error) {
    console.error('Failed to load forms list:', error);
    // Offline fallback from localStorage
    const localForms = getLocalFallbackForms();
    const ids = Object.keys(localForms);
    if (ids.length > 0 && !currentFormId) {
      loadLocalForm(ids[0]);
    }
  }
}

async function loadFormById(id) {
  try {
    setSyncStatus('saving', 'טוען נתונים...');
    const res = await fetch(`/api/forms/${id}`);
    const resData = await res.json();
    
    if (resData.success && resData.form) {
      const form = resData.form;
      currentFormId = form.id;
      currentFormData = form.data || {};
      formIdInput.value = form.id;

      populateFormWithData(currentFormData);
      updateHeaderInfo(form);
      updateQuickSelect();
      renderFormsListModal();
      
      setSyncStatus('synced', 'מסונכרן עם השרת');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  } catch (error) {
    console.error('Failed to load form by id:', error);
    setSyncStatus('offline', 'שגיאת טעינה - מנסה ממכשיר מקומי');
    loadLocalForm(id);
  }
}

function updateHeaderInfo(formMeta) {
  const address = formMeta.address || formMeta.title || 'דירה ללא כתובת';
  if (activeAptTitle) {
    activeAptTitle.innerText = address;
  }
  if (activeAptMeta) {
    const updated = formMeta.updated_at ? new Date(formMeta.updated_at).toLocaleString('he-IL') : '';
    activeAptMeta.innerText = `מזהה טופס: ${formMeta.id} | עודכן: ${updated}`;
  }
  const isRelevant = formMeta.is_relevant !== undefined 
    ? (formMeta.is_relevant === 1 || formMeta.is_relevant === true || formMeta.is_relevant === '1')
    : (currentFormData['רלוונטיות'] !== 'לא רלוונטי');
  updateRelevanceBadge(isRelevant ? 'רלוונטי' : 'לא רלוונטי');
}

function handleRelevanceToggle(value, triggerSave = true) {
  const isRelevant = value === 'רלוונטי';
  const radioRelevant = document.getElementById('radio_relevant');
  const radioNotRelevant = document.getElementById('radio_not_relevant');
  if (radioRelevant && radioNotRelevant) {
    if (isRelevant) {
      radioRelevant.checked = true;
      radioNotRelevant.checked = false;
    } else {
      radioRelevant.checked = false;
      radioNotRelevant.checked = true;
    }
  }

  const card = document.querySelector('.relevance-toggle-card');
  if (card) {
    if (isRelevant) {
      card.classList.remove('status-not-relevant');
    } else {
      card.classList.add('status-not-relevant');
    }
  }

  updateRelevanceBadge(value);

  // Optimistically update current form in summaries
  if (currentFormId) {
    const summary = allFormsSummaries.find(f => f.id === currentFormId);
    if (summary) {
      summary.is_relevant = isRelevant ? 1 : 0;
      updateQuickSelect();
    }
  }

  if (triggerSave) {
    triggerAutoSave();
  }
}

function updateRelevanceBadge(value) {
  const badge = document.getElementById('active_apt_relevance_badge');
  if (!badge) return;
  if (value === 'לא רלוונטי') {
    badge.className = 'relevance-badge badge-not-relevant';
    badge.innerText = '✖ לא רלוונטי';
  } else {
    badge.className = 'relevance-badge badge-relevant';
    badge.innerText = '✔ רלוונטי';
  }
}

let quickSelectFilter = localStorage.getItem('apt_quick_filter_preference') || 'relevant';

function toggleQuickSelectFilter() {
  quickSelectFilter = (quickSelectFilter === 'relevant') ? 'all' : 'relevant';
  localStorage.setItem('apt_quick_filter_preference', quickSelectFilter);
  updateQuickSelectFilterBtn();
  updateQuickSelect();
  showToast(quickSelectFilter === 'relevant' ? 'מעבר מהיר: מציג דירות רלוונטיות בלבד' : 'מעבר מהיר: מציג את כל הדירות', 'info');
}

function updateQuickSelectFilterBtn() {
  const btn = document.getElementById('quick_select_filter_btn');
  const icon = document.getElementById('quick_filter_icon');
  const label = document.getElementById('quick_filter_label');
  if (!btn) return;

  if (quickSelectFilter === 'relevant') {
    btn.classList.add('active');
    btn.title = "מסנן: רלוונטי בלבד (לחץ להצגת כל הדירות)";
    if (icon) icon.innerText = '🎯';
    if (label) label.innerText = 'רלוונטי בלבד';
  } else {
    btn.classList.remove('active');
    btn.title = "מסנן: כל הדירות (לחץ לסינון רלוונטי בלבד)";
    if (icon) icon.innerText = '📋';
    if (label) label.innerText = 'כל הדירות';
  }
}

function createQuickSelectOption(form, isNotRelevant = false) {
  const opt = document.createElement('option');
  opt.value = form.id;
  const title = form.address || form.title || 'דירה ללא כתובת';
  const price = form.price_display ? ` (${form.price_display})` : '';
  const prefix = isNotRelevant ? '❌ ' : '';
  opt.innerText = `${prefix}${title}${price}`;
  if (form.id === currentFormId) {
    opt.selected = true;
  }
  return opt;
}

function updateQuickSelect() {
  if (!aptQuickSelect) return;
  aptQuickSelect.innerHTML = '';
  updateQuickSelectFilterBtn();

  if (allFormsSummaries.length === 0) {
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.innerText = 'אין דירות שמורות';
    aptQuickSelect.appendChild(emptyOpt);
    return;
  }

  const isRelevantForm = (form) => (form.is_relevant === undefined || form.is_relevant === 1 || form.is_relevant === '1' || form.is_relevant === true);

  const relevantForms = allFormsSummaries.filter(isRelevantForm);
  const notRelevantForms = allFormsSummaries.filter(f => !isRelevantForm(f));

  if (quickSelectFilter === 'relevant') {
    // Show relevant forms
    if (relevantForms.length === 0) {
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.innerText = 'אין דירות רלוונטיות (לחץ "רלוונטי בלבד" לצפיה בכל)';
      aptQuickSelect.appendChild(noneOpt);
    } else {
      relevantForms.forEach(form => {
        aptQuickSelect.appendChild(createQuickSelectOption(form, false));
      });
    }

    // If current active form is marked not relevant, show it in a dedicated optgroup so user does not lose view
    if (currentFormId && notRelevantForms.some(f => f.id === currentFormId)) {
      const currentNotRel = notRelevantForms.find(f => f.id === currentFormId);
      if (currentNotRel) {
        const curGroup = document.createElement('optgroup');
        curGroup.label = '⚠️ דירה פתוחה כעת (לא רלוונטית)';
        curGroup.appendChild(createQuickSelectOption(currentNotRel, true));
        aptQuickSelect.appendChild(curGroup);
      }
    }
  } else {
    // Show all forms organized by relevance
    if (relevantForms.length > 0) {
      const relGroup = document.createElement('optgroup');
      relGroup.label = `✅ דירות רלוונטיות (${relevantForms.length})`;
      relevantForms.forEach(form => {
        relGroup.appendChild(createQuickSelectOption(form, false));
      });
      aptQuickSelect.appendChild(relGroup);
    }

    if (notRelevantForms.length > 0) {
      const notRelGroup = document.createElement('optgroup');
      notRelGroup.label = `❌ לא רלוונטיות (${notRelevantForms.length})`;
      notRelevantForms.forEach(form => {
        notRelGroup.appendChild(createQuickSelectOption(form, true));
      });
      aptQuickSelect.appendChild(notRelGroup);
    }
  }

  // Action option to toggle filter directly from select dropdown
  const filterActionGroup = document.createElement('optgroup');
  filterActionGroup.label = '⚙️ אפשרויות סינון';
  const filterActionOpt = document.createElement('option');
  filterActionOpt.value = '__TOGGLE_FILTER__';
  filterActionOpt.innerText = quickSelectFilter === 'relevant' ? '📋 הצג את כל הדירות במעבר המהיר...' : '🎯 הצג רלוונטי בלבד במעבר המהיר...';
  filterActionGroup.appendChild(filterActionOpt);
  aptQuickSelect.appendChild(filterActionGroup);

  if (currentFormId) {
    aptQuickSelect.value = currentFormId;
  }
}

function onQuickSelectChange(event) {
  const selectedId = event.target.value;
  if (selectedId === '__TOGGLE_FILTER__') {
    toggleQuickSelectFilter();
    return;
  }
  if (selectedId && selectedId !== currentFormId) {
    loadFormById(selectedId);
  }
}

async function createNewForm() {
  try {
    setSyncStatus('saving', 'יוצר טופס חדש...');
    const res = await fetch('/api/forms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: CLIENT_ID,
        title: 'דירה חדשה',
        initialData: {}
      })
    });
    const resData = await res.json();
    if (resData.success && resData.form) {
      await loadFormsList(false);
      await loadFormById(resData.form.id);
      showToast('נוצר טופס בדיקה חדש', 'success');
      closeFormsModal();
    }
  } catch (error) {
    console.error('Failed to create form:', error);
    showToast('שגיאה ביצירת טופס', 'error');
  }
}

async function duplicateCurrentForm() {
  if (!currentFormId) return;
  try {
    setSyncStatus('saving', 'משכפל טופס...');
    const res = await fetch(`/api/forms/${currentFormId}/duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID })
    });
    const resData = await res.json();
    if (resData.success && resData.form) {
      await loadFormsList(false);
      await loadFormById(resData.form.id);
      showToast('הטופס שוכפל בהצלחה', 'success');
    }
  } catch (error) {
    console.error('Failed to duplicate form:', error);
    showToast('שגיאה בשכפול הטופס', 'error');
  }
}

async function deleteCurrentForm() {
  if (!currentFormId) return;
  if (!confirm('האם אתה בטוח שברצונך למחוק את טופס הבדיקה הזה לצמיתות?')) return;

  try {
    setSyncStatus('saving', 'מוחק...');
    const res = await fetch(`/api/forms/${currentFormId}?clientId=${encodeURIComponent(CLIENT_ID)}`, {
      method: 'DELETE'
    });
    const resData = await res.json();
    if (resData.success) {
      showToast('הטופס נמחק', 'success');
      currentFormId = null;
      await loadFormsList(true);
    }
  } catch (error) {
    console.error('Failed to delete form:', error);
    showToast('שגיאה במחיקת הטופס', 'error');
  }
}

async function deleteSpecificForm(id, event) {
  if (event) event.stopPropagation();
  if (!confirm('האם אתה בטוח שברצונך למחוק טופס זה?')) return;

  try {
    const res = await fetch(`/api/forms/${id}?clientId=${encodeURIComponent(CLIENT_ID)}`, {
      method: 'DELETE'
    });
    const resData = await res.json();
    if (resData.success) {
      showToast('הטופס נמחק', 'success');
      if (id === currentFormId) {
        currentFormId = null;
        await loadFormsList(true);
      } else {
        await loadFormsList(false);
      }
    }
  } catch (error) {
    console.error('Failed to delete form:', error);
  }
}

/* ==========================================================================
   Auto-Save & Form Collection Logic
   ========================================================================== */

function initEventListeners() {
  // Capture inputs and changes on form
  formElement.addEventListener('input', triggerAutoSave);
  formElement.addEventListener('change', triggerAutoSave);

  // Prevent default Formspree redirect and do dynamic save
  formElement.addEventListener('submit', (e) => {
    e.preventDefault();
    saveFormImmediately(true);
  });

  if (aptQuickSelect) {
    aptQuickSelect.addEventListener('change', onQuickSelectChange);
  }
}

function triggerAutoSave() {
  setSyncStatus('saving', 'שומר שינויים...');
  
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }

  saveDebounceTimer = setTimeout(() => {
    saveFormImmediately(false);
  }, 450);
}

function collectFormData() {
  const formData = {};
  const elements = formElement.elements;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el.name || el.name === 'form_id') continue;

    if (el.type === 'checkbox') {
      if (!formData[el.name]) formData[el.name] = [];
      if (el.checked) formData[el.name].push(el.value);
    } else if (el.type === 'radio') {
      if (el.checked) formData[el.name] = el.value;
    } else {
      formData[el.name] = el.value;
    }
  }

  // Display fields formatted
  const priceDisplay = document.getElementById('price_display');
  const arnonaDisplay = document.getElementById('arnona_display');
  const vaadDisplay = document.getElementById('vaad_display');
  const gasDisplay = document.getElementById('gas_display');

  if (priceDisplay) formData['מחיר_מבוקש_display'] = priceDisplay.value;
  if (arnonaDisplay) formData['עלות_ארנונה_display'] = arnonaDisplay.value;
  if (vaadDisplay) formData['עלות_ועד_בית_display'] = vaadDisplay.value;
  if (gasDisplay) formData['עלות_גז_display'] = gasDisplay.value;

  return formData;
}

async function saveFormImmediately(showSuccessToast = false) {
  if (!currentFormId) return;

  const data = collectFormData();
  currentFormData = data; // Keep in memory for dynamic balcony fields
  const address = (data['כתובת'] || '').trim();
  const title = address || 'דירה חדשה (ללא כתובת)';

  // Update quick select and header title instantly (optimistic UI)
  if (activeAptTitle) activeAptTitle.innerText = title;
  const currentOption = aptQuickSelect.querySelector(`option[value="${currentFormId}"]`);
  if (currentOption) {
    const price = data['מחיר_מבוקש_display'] ? ` (${data['מחיר_מבוקש_display']})` : '';
    currentOption.innerText = `${title}${price}`;
  }

  try {
    const res = await fetch(`/api/forms/${currentFormId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: CLIENT_ID,
        title,
        data
      })
    });

    const resData = await res.json();
    if (resData.success) {
      setSyncStatus('synced', 'כל השינויים נשמרו');
      isOnline = true;
      if (showSuccessToast) {
        showToast('הטופס נשמר בהצלחה במסד הנתונים', 'success');
      }
    } else {
      throw new Error(resData.error || 'Server error');
    }
  } catch (error) {
    console.warn('Network save failed, saving to local fallback storage:', error);
    saveLocalFallback(currentFormId, title, data);
    setSyncStatus('offline', 'שמירה מקומית (ממתין לחיבור)');
    isOnline = false;
    if (showSuccessToast) {
      showToast('נשמר מקומית במכשיר (אין חיבור לרשת)', 'warning');
    }
  }
}

/* ==========================================================================
   Form Population & Dynamic UI Controls
   ========================================================================== */

function populateFormWithData(formData) {
  formElement.reset();
  formIdInput.value = currentFormId;

  // First pass: text, selects, numbers, dates
  for (const key in formData) {
    const value = formData[key];

    if (key === 'מחיר_מבוקש_display') {
      const el = document.getElementById('price_display');
      if (el) el.value = value;
      continue;
    }
    if (key === 'עלות_ארנונה_display') {
      const el = document.getElementById('arnona_display');
      if (el) el.value = value;
      continue;
    }
    if (key === 'עלות_ועד_בית_display') {
      const el = document.getElementById('vaad_display');
      if (el) el.value = value;
      continue;
    }
    if (key === 'עלות_גז_display') {
      const el = document.getElementById('gas_display');
      if (el) el.value = value;
      continue;
    }

    const elements = document.querySelectorAll(`[name="${key}"], [name="${key}[]"]`);
    if (elements.length > 0) {
      if (elements[0].type === 'checkbox') {
        elements.forEach(el => {
          if (Array.isArray(value) && value.includes(el.value)) {
            el.checked = true;
          }
        });
      } else if (elements[0].type === 'radio') {
        elements.forEach(el => {
          if (el.value === value) {
            el.checked = true;
          }
        });
      } else {
        elements[0].value = value;
      }
    }
  }

  // Handle relevance toggle state
  const relevanceVal = formData['רלוונטיות'] || 'רלוונטי';
  handleRelevanceToggle(relevanceVal, false);

  // Handle conditional sections display
  triggerConditionalDisplays();
  updateDynamicLink();
}

function triggerConditionalDisplays() {
  const elevatorRadios = document.querySelectorAll('input[name="מעלית"]');
  elevatorRadios.forEach(r => {
    if (r.checked) toggleElevatorFields(r.value === 'יש');
  });

  const balconyRadios = document.querySelectorAll('input[name="מרפסת_קיומה"]');
  balconyRadios.forEach(r => {
    if (r.checked) {
      toggleBalconySection(r.value === 'יש');
      if (r.value === 'יש') updateBalconyFields();
    }
  });

  const agentRadios = document.querySelectorAll('input[name="תיווך"]');
  agentRadios.forEach(r => {
    if (r.checked) toggleAgentField(r.value === 'כן');
  });

  const gasRadios = document.querySelectorAll('input[name="גז_קיום"]');
  gasRadios.forEach(r => {
    if (r.checked) toggleGasCompanyField(r.value === 'יש');
  });

  const shuttersRadios = document.querySelectorAll('input[name="תריסים_קיומם"]');
  shuttersRadios.forEach(r => {
    if (r.checked) toggleShuttersTypeField(r.value === 'יש');
  });

  const houseStairsRadios = document.querySelectorAll('input[name="מדרגות_לבית_קיום"]');
  houseStairsRadios.forEach(r => {
    if (r.checked) toggleHouseStairsField(r.value === 'יש');
  });

  const buildingStairsRadios = document.querySelectorAll('input[name="מדרגות_לבניין_קיום"]');
  buildingStairsRadios.forEach(r => {
    if (r.checked) toggleBuildingStairsField(r.value === 'יש');
  });

  const roomsSelect = document.getElementById('rooms_select');
  if (roomsSelect) {
    toggleOtherRoomsField(roomsSelect.value);
  }

  const upperCabinetsRadios = document.querySelectorAll('input[name="גובה_ארונות_עליון"]');
  upperCabinetsRadios.forEach(r => {
    if (r.checked) toggleUpperCabinetsHeight(r.value === 'מותאם');
  });
}

function handleFlexibleEvacuationDate(checkbox) {
  const dateInput = document.getElementById('field_תאריך_פינוי');
  if (checkbox && checkbox.checked && dateInput) {
    dateInput.value = '';
  }
  triggerAutoSave();
}

function handleEvacuationDateInput(dateInput) {
  if (dateInput && dateInput.value) {
    const flexibleCheckbox = document.getElementById('field_תאריך_פינוי_גמיש');
    if (flexibleCheckbox && flexibleCheckbox.checked) {
      flexibleCheckbox.checked = false;
    }
  }
  triggerAutoSave();
}

function updateDynamicLink() {
  const input = document.getElementById('field_קישור_למודעה');
  const linkBtn = document.getElementById('dynamic_ad_link');
  if (!input || !linkBtn) return;

  const val = input.value.trim();
  if (val !== '') {
    linkBtn.href = val;
    linkBtn.classList.remove('disabled');
  } else {
    linkBtn.href = '#';
    linkBtn.classList.add('disabled');
  }
}

function clearLinkField() {
  const input = document.getElementById('field_קישור_למודעה');
  if (input) {
    input.value = '';
    updateDynamicLink();
    triggerAutoSave();
  }
}

function formatCurrency(input, realValueId) {
  const rawValue = input.value.replace(/\D/g, '');
  const realValueInput = document.getElementById(realValueId);
  if (realValueInput) realValueInput.value = rawValue;

  if (rawValue === '') {
    input.value = '';
    triggerAutoSave();
    return;
  }

  const formatted = Number(rawValue).toLocaleString('he-IL');
  input.value = formatted + ' ₪';
  triggerAutoSave();
}

function initPhoneMasks() {
  const phoneInputs = document.querySelectorAll('input[type="tel"]');
  phoneInputs.forEach(input => {
    input.addEventListener('input', function() {
      let val = this.value.replace(/\D/g, '');
      if (val.length > 3) {
        val = val.substring(0, 3) + '-' + val.substring(3, 10);
      }
      this.value = val;
    });
  });
}

function toggleOtherRoomsField(selectedValue) {
  const otherRoomsInput = document.getElementById('other_rooms_input');
  if (!otherRoomsInput) return;
  if (selectedValue === 'אחר') {
    otherRoomsInput.classList.remove('hidden');
  } else {
    otherRoomsInput.classList.add('hidden');
    otherRoomsInput.value = '';
  }
}

function toggleElevatorFields(hasElevator) {
  const container = document.getElementById('elevator_details_container');
  const select = document.getElementById('elevator_count');
  if (!container) return;
  if (hasElevator) {
    container.classList.remove('hidden');
  } else {
    container.classList.add('hidden');
    if (select) select.value = '';
  }
}

function toggleBalconySection(hasBalcony) {
  const countContainer = document.getElementById('balcony_count_container');
  const select = document.getElementById('balcony_count');
  if (!countContainer) return;
  
  if (hasBalcony) {
    countContainer.classList.remove('hidden');
  } else {
    countContainer.classList.add('hidden');
    if (select) select.value = '';
    updateBalconyFields();
  }
}

function updateBalconyFields() {
  const container = document.getElementById('balconies_container');
  const select = document.getElementById('balcony_count');
  if (!container || !select) return;

  container.innerHTML = '';
  if (!select.value) return;

  const count = parseInt(select.value, 10);
  const savedData = currentFormData || {};

  for (let i = 1; i <= count; i++) {
    const titleText = (i === 1) ? 'גודל מרפסת ראשית (מ"ר):' : `גודל מרפסת ${i} (מ"ר):`;
    const savedSize = savedData[`גודל_מרפסת_${i}`] || '';
    const savedDirections = savedData[`כיוון_מרפסת_${i}[]`] || [];

    const isChecked = (dir) => (Array.isArray(savedDirections) && savedDirections.includes(dir)) ? 'checked' : '';

    const balconyHTML = `
      <div class="balcony-card">
        <div class="grid-2">
          <div class="form-group">
            <label>${titleText}</label>
            <input type="number" step="0.1" name="גודל_מרפסת_${i}" value="${savedSize}" oninput="triggerAutoSave()">
          </div>
          <div class="form-group">
            <label>פונה לכיוון (מרפסת ${i}):</label>
            <div class="checkbox-group">
              <label><input type="checkbox" name="כיוון_מרפסת_${i}[]" value="צפון" ${isChecked('צפון')} onchange="triggerAutoSave()"> צפון</label>
              <label><input type="checkbox" name="כיוון_מרפסת_${i}[]" value="דרום" ${isChecked('דרום')} onchange="triggerAutoSave()"> דרום</label>
              <label><input type="checkbox" name="כיוון_מרפסת_${i}[]" value="מזרח" ${isChecked('מזרח')} onchange="triggerAutoSave()"> מזרח</label>
              <label><input type="checkbox" name="כיוון_מרפסת_${i}[]" value="מערב" ${isChecked('מערב')} onchange="triggerAutoSave()"> מערב</label>
            </div>
          </div>
        </div>
      </div>
    `;
    container.insertAdjacentHTML('beforeend', balconyHTML);
  }
}

function toggleAgentField(hasAgent) {
  const agentInput = document.getElementById('agent_name_input');
  if (!agentInput) return;
  if (hasAgent) {
    agentInput.classList.remove('hidden');
  } else {
    agentInput.classList.add('hidden');
    agentInput.value = '';
  }
}

function toggleUpperCabinetsHeight(isCustom) {
  const cmInput = document.getElementById('upper_cabinets_cm');
  if (!cmInput) return;
  if (isCustom) {
    cmInput.classList.remove('hidden');
  } else {
    cmInput.classList.add('hidden');
    cmInput.value = '';
  }
}

function toggleRoomsAirconField(checkbox) {
  const airconInput = document.getElementById('rooms_aircon_input');
  if (!airconInput) return;
  if (checkbox.checked) {
    airconInput.classList.remove('hidden');
  } else {
    airconInput.classList.add('hidden');
    airconInput.value = '';
  }
}

function toggleGasCompanyField(hasGas) {
  const gasCompanyInput = document.getElementById('gas_company_input');
  if (gasCompanyInput) {
    if (hasGas) {
      gasCompanyInput.classList.remove('hidden');
    } else {
      gasCompanyInput.classList.add('hidden');
      gasCompanyInput.value = '';
    }
  }

  const gasInfraContainer = document.getElementById('gas_infrastructure_container');
  if (gasInfraContainer) {
    if (hasGas) {
      gasInfraContainer.classList.remove('hidden');
    } else {
      gasInfraContainer.classList.add('hidden');
    }
  }
}

function toggleShuttersTypeField(hasShutters) {
  const shuttersTypeContainer = document.getElementById('shutters_type_container');
  if (!shuttersTypeContainer) return;
  if (hasShutters) {
    shuttersTypeContainer.classList.remove('hidden');
  } else {
    shuttersTypeContainer.classList.add('hidden');
  }
}

function toggleHouseStairsField(hasStairs) {
  const input = document.getElementById('field_כמות_מדרגות_לבית');
  if (!input) return;
  if (hasStairs) {
    input.classList.remove('hidden');
  } else {
    input.classList.add('hidden');
    input.value = '';
  }
}

function toggleBuildingStairsField(hasStairs) {
  const input = document.getElementById('field_כמות_מדרגות_לבניין');
  if (!input) return;
  if (hasStairs) {
    input.classList.remove('hidden');
  } else {
    input.classList.add('hidden');
    input.value = '';
  }
}

/* ==========================================================================
   Modals Management (QR & Forms List)
   ========================================================================== */

let networkInfoCache = null;

async function preloadNetworkInfo() {
  try {
    const res = await fetch('/api/network-info');
    const data = await res.json();
    if (data.success) {
      networkInfoCache = data;
    }
  } catch (e) {
    console.error('Failed to preload network info:', e);
  }
}

async function openQrModal() {
  if (!qrDialog) return;
  
  await preloadNetworkInfo();

  if (networkInfoCache) {
    const qrImg = document.getElementById('qr_code_img');
    const qrUrl = document.getElementById('qr_url_text');
    if (qrImg) qrImg.src = networkInfoCache.qrDataUrl;
    if (qrUrl) qrUrl.innerText = networkInfoCache.primaryUrl;
  }

  qrDialog.showModal();
}

function closeQrModal() {
  if (qrDialog) qrDialog.close();
}

function copyQrUrl() {
  const qrUrl = document.getElementById('qr_url_text');
  if (!qrUrl) return;
  
  navigator.clipboard.writeText(qrUrl.innerText).then(() => {
    showToast('הקישור הועתק ללוח!', 'success');
  }).catch(() => {
    showToast('שגיאה בהעתקה', 'error');
  });
}

function openFormsModal() {
  if (!formsDialog) return;
  renderFormsListModal();
  formsDialog.showModal();
}

function closeFormsModal() {
  if (formsDialog) formsDialog.close();
}

let currentRelevanceFilter = 'all';

function setFormsRelevanceFilter(filter) {
  currentRelevanceFilter = filter;
  const tabs = ['all', 'relevant', 'not_relevant'];
  tabs.forEach(f => {
    const tabEl = document.getElementById(`tab_filter_${f}`);
    if (tabEl) {
      if (f === filter) tabEl.classList.add('active');
      else tabEl.classList.remove('active');
    }
  });
  renderFormsListModal();
}

function renderFormsListModal(filterQuery = '') {
  if (!formsCardsContainer) return;
  
  const query = (filterQuery || (formsSearchInput ? formsSearchInput.value : '')).trim().toLowerCase();
  formsCardsContainer.innerHTML = '';

  // Calculate counters
  let countAll = allFormsSummaries.length;
  let countRelevant = 0;
  let countNotRelevant = 0;

  allFormsSummaries.forEach(form => {
    const isRel = (form.is_relevant === undefined || form.is_relevant === 1 || form.is_relevant === '1' || form.is_relevant === true);
    if (isRel) countRelevant++;
    else countNotRelevant++;
  });

  const countAllEl = document.getElementById('count_all');
  const countRelEl = document.getElementById('count_relevant');
  const countNotRelEl = document.getElementById('count_not_relevant');
  if (countAllEl) countAllEl.innerText = countAll;
  if (countRelEl) countRelEl.innerText = countRelevant;
  if (countNotRelEl) countNotRelEl.innerText = countNotRelevant;

  const filtered = allFormsSummaries.filter(form => {
    const isRel = (form.is_relevant === undefined || form.is_relevant === 1 || form.is_relevant === '1' || form.is_relevant === true);
    if (currentRelevanceFilter === 'relevant' && !isRel) return false;
    if (currentRelevanceFilter === 'not_relevant' && isRel) return false;

    if (!query) return true;
    const title = (form.title || '').toLowerCase();
    const address = (form.address || '').toLowerCase();
    const rooms = (form.rooms || '').toLowerCase();
    const price = (form.price_display || '').toLowerCase();
    return title.includes(query) || address.includes(query) || rooms.includes(query) || price.includes(query);
  });

  if (filtered.length === 0) {
    formsCardsContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 30px;">
        לא נמצאו טפסים תואמים
      </div>
    `;
    return;
  }

  filtered.forEach(form => {
    const isCurrent = form.id === currentFormId;
    const isRel = (form.is_relevant === undefined || form.is_relevant === 1 || form.is_relevant === '1' || form.is_relevant === true);
    const address = form.address || form.title || 'דירה חדשה (ללא כתובת)';
    const dateFormatted = form.updated_at ? new Date(form.updated_at).toLocaleDateString('he-IL') : '';

    const relevanceTag = isRel 
      ? `<span class="apt-tag tag-relevant">✔ רלוונטי</span>`
      : `<span class="apt-tag tag-not-relevant">✖ לא רלוונטי</span>`;

    const card = document.createElement('div');
    card.className = `apt-card ${isCurrent ? 'active' : ''} ${!isRel ? 'is-not-relevant' : ''}`;
    card.onclick = () => {
      loadFormById(form.id);
      closeFormsModal();
    };

    card.innerHTML = `
      <div class="apt-card-info">
        <div class="apt-card-title">${address} ${isCurrent ? ' <span style="color:#15803d; font-size:12px;">(פעיל כעת)</span>' : ''}</div>
        <div class="apt-card-tags">
          ${relevanceTag}
          ${form.price_display ? `<span class="apt-tag">💰 ${form.price_display}</span>` : ''}
          ${form.rooms ? `<span class="apt-tag">🛏️ ${form.rooms} חדרים</span>` : ''}
          ${form.floor ? `<span class="apt-tag">🏢 קומה ${form.floor}</span>` : ''}
          ${form.area ? `<span class="apt-tag">📐 ${form.area} מ"ר</span>` : ''}
          <span class="apt-tag">🕒 ${dateFormatted}</span>
        </div>
      </div>
      <div class="apt-card-actions">
        <button type="button" class="btn btn-secondary" onclick="event.stopPropagation(); loadFormById('${form.id}'); closeFormsModal();">פתח</button>
        <button type="button" class="btn btn-danger" onclick="deleteSpecificForm('${form.id}', event)">מחק</button>
      </div>
    `;

    formsCardsContainer.appendChild(card);
  });
}

if (formsSearchInput) {
  formsSearchInput.addEventListener('input', (e) => {
    renderFormsListModal(e.target.value);
  });
}

/* ==========================================================================
   Legacy Data Migration & Offline Fallback Storage
   ========================================================================== */

function checkLegacyLocalStorage() {
  const legacyData = localStorage.getItem('apartment_checklists');
  if (!legacyData) return;

  try {
    const parsed = JSON.parse(legacyData);
    const count = Object.keys(parsed).length;
    if (count > 0 && migrationBanner) {
      const countSpan = document.getElementById('migration_count');
      if (countSpan) countSpan.innerText = count;
      migrationBanner.classList.remove('hidden');
    }
  } catch (e) {
    // Invalid json
  }
}

async function runMigration() {
  const legacyData = localStorage.getItem('apartment_checklists');
  if (!legacyData) return;

  try {
    const parsed = JSON.parse(legacyData);
    const formsArray = Object.entries(parsed).map(([id, item]) => ({
      id,
      title: item.title || 'דירה שיובאה',
      data: item.data || {}
    }));

    const res = await fetch('/api/forms/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forms: formsArray, clientId: CLIENT_ID })
    });

    const resData = await res.json();
    if (resData.success) {
      showToast(`יובאו בהצלחה ${resData.count} טפסים למסד הנתונים!`, 'success');
      localStorage.removeItem('apartment_checklists');
      if (migrationBanner) migrationBanner.classList.add('hidden');
      await loadFormsList(true);
    }
  } catch (e) {
    console.error('Migration failed:', e);
    showToast('שגיאה בייבוא הנתונים', 'error');
  }
}

function dismissMigration() {
  if (migrationBanner) migrationBanner.classList.add('hidden');
}

// Local fallback storage
function getLocalFallbackForms() {
  const data = localStorage.getItem('offline_apartments_db');
  return data ? JSON.parse(data) : {};
}

function saveLocalFallback(id, title, data) {
  const stored = getLocalFallbackForms();
  stored[id] = { id, title, data, updated_at: new Date().toISOString() };
  localStorage.setItem('offline_apartments_db', JSON.stringify(stored));
}

function loadLocalForm(id) {
  const stored = getLocalFallbackForms();
  if (stored[id]) {
    currentFormId = id;
    currentFormData = stored[id].data;
    populateFormWithData(currentFormData);
    updateHeaderInfo(stored[id]);
  }
}

async function checkPendingOfflineSaves() {
  const stored = getLocalFallbackForms();
  const keys = Object.keys(stored);
  if (keys.length === 0) return;

  try {
    for (const id of keys) {
      const item = stored[id];
      await fetch(`/api/forms/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: CLIENT_ID,
          title: item.title,
          data: item.data
        })
      });
    }
    localStorage.removeItem('offline_apartments_db');
    await loadFormsList(false);
    showToast('כל הטפסים שנשמרו באופליין סונכרנו לשרת!', 'success');
  } catch (e) {
    console.warn('Sync pending failed, will retry later:', e);
  }
}

/* ==========================================================================
   Toasts Utility
   ========================================================================== */

function showToast(message, type = 'info') {
  let container = document.getElementById('toast_container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast_container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}
