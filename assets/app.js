(function () {
  'use strict';

  const STORAGE_KEY = 'waflow.state.v1';
  const MAX_SELECTION = 200;
  const MAX_MESSAGE = 4096;
  const MAX_HISTORY = 6;

  const VIEW_META = {
    dashboard: { title: 'Dashboard', subtitle: 'Your broadcast command centre.' },
    contacts: { title: 'Contacts', subtitle: 'Import, organize, and manage recipient consent.' },
    compose: { title: 'Compose', subtitle: 'Craft one message for a personal audience.' },
    queue: { title: 'Send queue', subtitle: 'Open, confirm, and track each chat manually.' },
    settings: { title: 'Settings & guide', subtitle: 'Control your local data and sending preferences.' }
  };

  const EMOJIS = [
    '😀', '😃', '😄', '😁', '😆', '😊', '🙂', '🙃',
    '😉', '😍', '🥰', '😘', '😎', '🤩', '🥳', '🤗',
    '👋', '👍', '🙏', '👏', '💪', '🤝', '✨', '🎉',
    '❤️', '💚', '💛', '🔥', '💯', '⭐', '✅', '📣',
    '🛍️', '🛒', '📦', '🚚', '📅', '⏰', '📍', '📞',
    '💬', '📢', '🎁', '☕', '🌿', '🌟', '🙌', '😌'
  ];

  const TEMPLATES = [
    {
      label: 'Warm hello',
      text: 'Hello {name} 👋\n\nHope you are doing well. I have a quick update I would love to share with you.'
    },
    {
      label: 'Order update',
      text: 'Hi {name}, your order is on its way 📦\n\nThank you for your patience. Reply here if you need anything.'
    },
    {
      label: 'Event reminder',
      text: 'Hello {name} 🗓️\n\nA friendly reminder about our upcoming event. We would love to see you there!'
    }
  ];

  const AVATAR_PALETTES = [
    { bg: 'linear-gradient(145deg, #a5f7bd, #2acb68)', ink: '#041e0e' },
    { bg: 'linear-gradient(145deg, #b6dcff, #4f9ee8)', ink: '#071c2c' },
    { bg: 'linear-gradient(145deg, #f5d6a8, #dd9b45)', ink: '#2a1604' },
    { bg: 'linear-gradient(145deg, #d9cbff, #8b68e8)', ink: '#170d31' },
    { bg: 'linear-gradient(145deg, #ffc9bf, #e67a62)', ink: '#2c0d07' },
    { bg: 'linear-gradient(145deg, #bff0e5, #40b79d)', ink: '#03231d' },
    { bg: 'linear-gradient(145deg, #f5c8e3, #d767a6)', ink: '#2a0b1d' },
    { bg: 'linear-gradient(145deg, #d8eaa6, #90b83b)', ink: '#172207' }
  ];

  const SOURCE_LABELS = {
    manual: 'Added manually',
    device: 'Device contacts',
    csv: 'CSV import',
    vcf: 'VCF import',
    paste: 'Pasted list'
  };

  const ACTIVITY_META = {
    import: { icon: 'users', tone: 'green' },
    prepared: { icon: 'edit', tone: 'purple' },
    sent: { icon: 'send', tone: 'green' },
    failed: { icon: 'alert', tone: 'red' },
    skipped: { icon: 'list', tone: 'amber' },
    connection: { icon: 'link', tone: 'blue' },
    consent: { icon: 'shield', tone: 'blue' },
    completed: { icon: 'check-circle', tone: 'green' },
    delete: { icon: 'trash', tone: 'red' }
  };

  const ui = {
    view: 'dashboard',
    search: '',
    filter: 'all',
    previewContactId: null,
    emojiOpen: false,
    importTab: 'file',
    pendingConfirm: null,
    deferredPrompt: null,
    saveTimer: null,
    quotaWarned: false
  };

  let state = null;
  let dialog = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    dialog = document.getElementById('appDialog');
    state = loadState();
    ui.view = getViewFromHash();
    bindEvents();
    if (!location.hash) {
      history.replaceState(null, '', '#dashboard');
    }
    updateChrome();
    renderView();
    registerServiceWorker();
    setupInstallPrompt();
    if (window.matchMedia('(display-mode: standalone)').matches) {
      document.body.classList.add('is-standalone');
    }
  }

  function defaultState() {
    return {
      contacts: [],
      selected: [],
      draft: '',
      connection: {
        confirmed: false,
        confirmedAt: null
      },
      settings: {
        countryCode: '94',
        sendMode: 'auto'
      },
      stats: {
        prepared: 0,
        sent: 0,
        failed: 0
      },
      activeQueue: null,
      history: [],
      activity: []
    };
  }

  function loadState() {
    const base = defaultState();
    let raw;
    try {
      raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (error) {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') return base;

    const countryCode = String(raw.settings && raw.settings.countryCode ? raw.settings.countryCode : '94')
      .replace(/\D/g, '')
      .slice(0, 4) || '94';
    const sendMode = ['auto', 'web', 'app'].includes(raw.settings && raw.settings.sendMode)
      ? raw.settings.sendMode
      : 'auto';

    const seenPhones = new Set();
    const contacts = [];
    if (Array.isArray(raw.contacts)) {
      raw.contacts.forEach(function (contact) {
        if (!contact || typeof contact !== 'object') return;
        const phone = String(contact.phone || '').replace(/\D/g, '');
        if (!/^\d{8,15}$/.test(phone) || seenPhones.has(phone)) return;
        seenPhones.add(phone);
        const name = cleanName(contact.name) || prettyPhone(phone, countryCode);
        contacts.push({
          id: String(contact.id || uid('contact')),
          name: name,
          phone: phone,
          consent: contact.consent === true,
          source: SOURCE_LABELS[contact.source] ? contact.source : 'manual',
          createdAt: Number(contact.createdAt) || Date.now(),
          consentUpdatedAt: Number(contact.consentUpdatedAt) || null
        });
      });
    }

    const ids = new Set(contacts.map(function (contact) { return contact.id; }));
    const selected = Array.isArray(raw.selected)
      ? Array.from(new Set(raw.selected.map(String).filter(function (id) { return ids.has(id); }))).slice(0, MAX_SELECTION)
      : [];

    let activeQueue = normalizeQueue(raw.activeQueue, countryCode);

    const statsSource = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
    const stats = {
      prepared: Math.max(0, Number(statsSource.prepared) || 0),
      sent: Math.max(0, Number(statsSource.sent) || 0),
      failed: Math.max(0, Number(statsSource.failed) || 0)
    };

    const activity = Array.isArray(raw.activity)
      ? raw.activity
        .filter(function (item) {
          return item && typeof item === 'object' && typeof item.text === 'string' && Number(item.at);
        })
        .slice(0, 40)
        .map(function (item) {
          return {
            type: ACTIVITY_META[item.type] ? item.type : 'import',
            text: item.text.slice(0, 400),
            at: Number(item.at)
          };
        })
      : [];

    const history = Array.isArray(raw.history)
      ? raw.history.slice(0, MAX_HISTORY).map(function (entry) {
        return {
          id: String(entry.id || uid('campaign')),
          createdAt: Number(entry.createdAt) || Date.now(),
          closedAt: Number(entry.closedAt) || Date.now(),
          prepared: Math.max(0, Number(entry.prepared) || 0),
          sent: Math.max(0, Number(entry.sent) || 0),
          skipped: Math.max(0, Number(entry.skipped) || 0),
          failed: Math.max(0, Number(entry.failed) || 0),
          status: entry.status === 'cancelled' ? 'cancelled' : 'completed'
        };
      })
      : [];

    return {
      contacts: contacts,
      selected: selected,
      draft: typeof raw.draft === 'string' ? raw.draft.slice(0, MAX_MESSAGE) : '',
      connection: {
        confirmed: Boolean(raw.connection && raw.connection.confirmed),
        confirmedAt: Number(raw.connection && raw.connection.confirmedAt) || null
      },
      settings: { countryCode: countryCode, sendMode: sendMode },
      stats: stats,
      activeQueue: activeQueue,
      history: history,
      activity: activity
    };
  }

  function normalizeQueue(rawQueue, countryCode) {
    if (!rawQueue || typeof rawQueue !== 'object' || !Array.isArray(rawQueue.items)) return null;
    const items = rawQueue.items
      .filter(function (item) {
        return item && typeof item === 'object' && /^\d{8,15}$/.test(String(item.phone || '').replace(/\D/g, ''));
      })
      .slice(0, 2000)
      .map(function (item) {
        const status = ['pending', 'opened', 'sent', 'skipped', 'failed'].includes(item.status)
          ? item.status
          : 'pending';
        return {
          id: String(item.id || uid('item')),
          contactId: String(item.contactId || ''),
          name: cleanName(item.name) || prettyPhone(String(item.phone).replace(/\D/g, ''), countryCode),
          phone: String(item.phone).replace(/\D/g, ''),
          message: typeof item.message === 'string' ? item.message.slice(0, 65536) : '',
          status: status,
          openedAt: Number(item.openedAt) || null,
          resolvedAt: Number(item.resolvedAt) || null
        };
      });
    if (!items.length) return null;
    const unresolved = items.some(function (item) {
      return item.status === 'pending' || item.status === 'opened';
    });
    return {
      id: String(rawQueue.id || uid('queue')),
      createdAt: Number(rawQueue.createdAt) || Date.now(),
      completedAt: Number(rawQueue.completedAt) || null,
      status: rawQueue.status === 'completed' || !unresolved ? 'completed' : 'active',
      mode: ['web', 'app'].includes(rawQueue.mode) ? rawQueue.mode : 'web',
      messageTemplate: typeof rawQueue.messageTemplate === 'string' ? rawQueue.messageTemplate.slice(0, MAX_MESSAGE) : '',
      items: items
    };
  }

  function saveNow() {
    if (ui.saveTimer) {
      clearTimeout(ui.saveTimer);
      ui.saveTimer = null;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      ui.quotaWarned = false;
    } catch (error) {
      if (!ui.quotaWarned) {
        ui.quotaWarned = true;
        toast('Could not save locally', 'Browser storage may be full or blocked. Export important contacts if needed.', 'error', 7000);
      }
    }
  }

  function scheduleSave() {
    if (ui.saveTimer) clearTimeout(ui.saveTimer);
    ui.saveTimer = setTimeout(function () {
      ui.saveTimer = null;
      saveNow();
    }, 180);
  }

  function bindEvents() {
    document.addEventListener('click', handleClick);
    document.addEventListener('input', handleInput);
    document.addEventListener('change', handleChange);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);
    document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', function () {
      ui.pendingConfirm = null;
    });
    window.addEventListener('hashchange', function () {
      flushSave();
      ui.view = getViewFromHash();
      closeSidebar();
      updateChrome();
      renderView();
      window.scrollTo(0, 0);
    });
    window.addEventListener('beforeunload', saveNow);
    window.addEventListener('resize', function () {
      if (window.innerWidth > 900) closeSidebar();
    });
    window.addEventListener('online', function () {
      toast('Back online', 'WhatsApp chat links are ready to open again.', 'info', 3000);
    });
    window.addEventListener('offline', function () {
      toast('You are offline', 'Your local contacts and drafts are safe. Opening WhatsApp needs internet.', 'warning', 5000);
    });
  }

  function setupInstallPrompt() {
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      ui.deferredPrompt = event;
      const button = document.getElementById('installButton');
      if (button) button.hidden = false;
    });
    window.addEventListener('appinstalled', function () {
      ui.deferredPrompt = null;
      const button = document.getElementById('installButton');
      if (button) button.hidden = true;
      toast('WaFlow installed', 'Open it any time from your home screen or app launcher.', 'success');
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(function () {
        /* Offline support is optional; the local app still works. */
      });
    });
  }

  /* -----------------------------------------------------------------------
     Click handling
     ----------------------------------------------------------------------- */

  function handleClick(event) {
    const navLink = event.target.closest('[data-nav]');
    if (navLink) closeSidebar();

    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const id = actionEl.dataset.id;
    const tab = actionEl.dataset.tab;

    switch (action) {
      case 'toggle-sidebar':
        toggleSidebar();
        break;
      case 'close-sidebar':
        closeSidebar();
        break;
      case 'close-dialog':
        closeDialog();
        break;
      case 'confirm-pending':
        runPendingConfirm();
        break;
      case 'open-connect':
        openConnectDialog();
        break;
      case 'open-help':
        openHelpDialog();
        break;
      case 'install-app':
        installApp();
        break;
      case 'open-settings':
        closeDialog();
        goTo('settings');
        break;
      case 'open-import':
        openImportDialog();
        break;
      case 'open-add-contact':
        openContactDialog();
        break;
      case 'set-import-tab':
        ui.importTab = ['device', 'file', 'paste'].includes(tab) ? tab : 'file';
        renderImportDialog();
        break;
      case 'pick-device-contacts':
        pickDeviceContacts();
        break;
      case 'import-paste':
        importPastedContacts();
        break;
      case 'review-imported':
        closeDialog();
        ui.filter = 'all';
        ui.search = '';
        goTo('contacts');
        break;
      case 'set-filter':
        ui.filter = ['all', 'consented', 'needs'].includes(actionEl.dataset.filter) ? actionEl.dataset.filter : 'all';
        renderView();
        break;
      case 'clear-search':
        ui.search = '';
        renderView();
        break;
      case 'select-visible':
        selectVisibleContacts();
        break;
      case 'deselect-all':
        state.selected = [];
        persist();
        renderView();
        toast('Selection cleared', '', 'info', 2200);
        break;
      case 'select-needs-consent':
        selectContactsNeedingConsent();
        break;
      case 'toggle-select':
        toggleContactSelection(id);
        break;
      case 'toggle-consent':
        toggleContactConsent(id);
        break;
      case 'grant-consent-selected':
        confirmSelectedConsent(true);
        break;
      case 'revoke-consent-selected':
        confirmSelectedConsent(false);
        break;
      case 'delete-selected':
        confirmDeleteSelected();
        break;
      case 'edit-contact':
        openContactDialog(id);
        break;
      case 'delete-contact':
        confirmDeleteContact(id);
        break;
      case 'compose-selected':
        goTo('compose');
        break;
      case 'toggle-emoji':
        toggleEmojiPicker();
        break;
      case 'insert-emoji': {
        const index = Number(actionEl.dataset.emojiIndex);
        if (Number.isInteger(index) && EMOJIS[index]) insertIntoDraft(EMOJIS[index]);
        break;
      }
      case 'insert-name':
        insertIntoDraft('{name}');
        break;
      case 'apply-template': {
        const index = Number(actionEl.dataset.templateIndex);
        if (TEMPLATES[index]) setDraftValue(TEMPLATES[index].text);
        break;
      }
      case 'open-review':
        openReviewDialog();
        break;
      case 'review-manage-consent':
        closeDialog();
        ui.filter = 'needs';
        goTo('contacts');
        break;
      case 'prepare-queue':
        prepareQueue();
        break;
      case 'open-chat':
        openQueueChat(id);
        break;
      case 'mark-opened':
        markQueueItemOpened(id);
        break;
      case 'mark-sent':
        markQueueItemSent(id);
        break;
      case 'skip-contact':
        skipQueueItem(id);
        break;
      case 'mark-failed':
        markQueueItemFailed(id);
        break;
      case 'copy-message':
        copyQueueMessage(id);
        break;
      case 'archive-queue':
        requestArchiveQueue(false);
        break;
      case 'discard-queue':
        requestArchiveQueue(true);
        break;
      case 'new-campaign':
        startNewCampaign();
        break;
      case 'confirm-connection':
        confirmConnection();
        break;
      case 'reset-connection':
        resetConnection();
        break;
      case 'clear-data':
        confirmClearData();
        break;
      default:
        break;
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (target.id === 'contactSearch') {
      const caret = target.selectionStart;
      ui.search = target.value;
      renderView();
      const next = document.getElementById('contactSearch');
      if (next) {
        next.focus();
        const position = Math.min(caret == null ? next.value.length : caret, next.value.length);
        try { next.setSelectionRange(position, position); } catch (error) { /* noop */ }
      }
      return;
    }
    if (target.id === 'messageEditor') {
      state.draft = target.value.slice(0, MAX_MESSAGE);
      scheduleSave();
      updateComposerMetrics();
    }
  }

  function handleChange(event) {
    const target = event.target;
    if (target.id === 'contactFileInput') {
      const file = target.files && target.files[0];
      target.value = '';
      if (file) importFile(file);
      return;
    }
    if (target.id === 'previewContactSelect') {
      ui.previewContactId = target.value || null;
      renderView();
      return;
    }
    if (target.name === 'sendMode') {
      const mode = target.value;
      if (!['auto', 'web', 'app'].includes(mode)) return;
      state.settings.sendMode = mode;
      persist();
      updateChrome();
      renderView();
      toast('Sending method updated', methodLabel(), 'success', 3000);
    }
  }

  function handleSubmit(event) {
    if (event.target.id === 'contactForm') {
      event.preventDefault();
      saveContactForm(event.target);
      return;
    }
    if (event.target.id === 'countryForm') {
      event.preventDefault();
      saveCountryCode(event.target);
    }
  }

  function handleKeydown(event) {
    if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) {
      closeSidebar();
    }
  }

  function handleDragOver(event) {
    const zone = event.target.closest('.dropzone');
    if (!zone) return;
    event.preventDefault();
    zone.classList.add('is-dragging');
  }

  function handleDragLeave(event) {
    const zone = event.target.closest('.dropzone');
    if (!zone) return;
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-dragging');
  }

  function handleDrop(event) {
    const zone = event.target.closest('.dropzone');
    if (!zone) return;
    event.preventDefault();
    zone.classList.remove('is-dragging');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) importFile(file);
  }

  /* -----------------------------------------------------------------------
     Routing and shared chrome
     ----------------------------------------------------------------------- */

  function getViewFromHash() {
    const view = (location.hash || '').replace(/^#/, '');
    return VIEW_META[view] ? view : 'dashboard';
  }

  function goTo(view) {
    if (!VIEW_META[view]) return;
    flushSave();
    closeSidebar();
    if (getViewFromHash() === view) {
      ui.view = view;
      updateChrome();
      renderView();
      window.scrollTo(0, 0);
    } else {
      location.hash = view;
    }
  }

  function updateChrome() {
    const meta = VIEW_META[ui.view] || VIEW_META.dashboard;
    const pageTitle = document.getElementById('pageTitle');
    const pageSubtitle = document.getElementById('pageSubtitle');
    if (pageTitle) pageTitle.textContent = meta.title;
    if (pageSubtitle) pageSubtitle.textContent = meta.subtitle;
    document.title = meta.title + ' · WaFlow';

    document.querySelectorAll('[data-nav]').forEach(function (link) {
      const active = link.dataset.nav === ui.view;
      link.classList.toggle('active', active);
      if (active) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    const contactCount = document.getElementById('navContactCount');
    if (contactCount) contactCount.textContent = state.contacts.length.toLocaleString();
    const queueCount = document.getElementById('navQueueCount');
    const unresolvedCount = state.activeQueue
      ? state.activeQueue.items.filter(function (item) { return item.status === 'pending' || item.status === 'opened'; }).length
      : 0;
    if (queueCount) {
      queueCount.textContent = unresolvedCount > 99 ? '99+' : String(unresolvedCount);
      queueCount.hidden = unresolvedCount === 0;
    }

    const confirmed = state.connection.confirmed;
    const topText = document.getElementById('topConnectionText');
    if (topText) topText.textContent = confirmed ? 'Ready (manual)' : 'Connect WhatsApp';
    const topPill = document.getElementById('topConnectionPill');
    if (topPill) {
      topPill.classList.toggle('is-connected', confirmed);
      topPill.title = confirmed
        ? 'WhatsApp readiness confirmed by you. WaFlow cannot verify or control your WhatsApp session.'
        : 'Connect your existing WhatsApp through official WhatsApp Web or the WhatsApp app.';
      topPill.setAttribute('aria-label', confirmed ? 'WhatsApp ready in manual mode' : 'Connect WhatsApp');
    }
    const sideText = document.getElementById('sidebarConnectionText');
    if (sideText) sideText.textContent = confirmed ? 'Ready (manual)' : 'Not confirmed';
    const sideButton = document.getElementById('sidebarConnection');
    if (sideButton) {
      sideButton.classList.toggle('is-connected', confirmed);
      sideButton.title = confirmed ? 'Local readiness confirmed' : 'Connect WhatsApp';
    }

    const workspaceCode = document.getElementById('workspaceCode');
    if (workspaceCode) workspaceCode.textContent = '+' + state.settings.countryCode;
    const workspaceCountry = document.getElementById('workspaceCountry');
    if (workspaceCountry) {
      workspaceCountry.textContent = state.settings.countryCode === '94'
        ? 'Sri Lanka'
        : 'Country +' + state.settings.countryCode;
    }
  }

  function renderView() {
    flushSave();
    updateChrome();
    const main = document.getElementById('mainContent');
    if (!main) return;
    ui.emojiOpen = false;
    switch (ui.view) {
      case 'contacts':
        main.innerHTML = renderContactsView();
        break;
      case 'compose':
        main.innerHTML = renderComposeView();
        break;
      case 'queue':
        main.innerHTML = renderQueueView();
        break;
      case 'settings':
        main.innerHTML = renderSettingsView();
        break;
      case 'dashboard':
      default:
        main.innerHTML = renderDashboardView();
        break;
    }
  }

  function persist() {
    saveNow();
    updateChrome();
  }

  function toggleSidebar(force) {
    const open = typeof force === 'boolean' ? force : !document.body.classList.contains('drawer-open');
    document.body.classList.toggle('drawer-open', open);
    const button = document.querySelector('[data-action="toggle-sidebar"]');
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeSidebar() {
    document.body.classList.remove('drawer-open');
    const button = document.querySelector('[data-action="toggle-sidebar"]');
    if (button) button.setAttribute('aria-expanded', 'false');
  }

  /* -----------------------------------------------------------------------
     Dashboard
     ----------------------------------------------------------------------- */

  function renderDashboardView() {
    const totalContacts = state.contacts.length;
    const consented = state.contacts.filter(function (contact) { return contact.consent; }).length;
    const selected = state.selected.length;
    const selectedConsented = getSelectedContacts().filter(function (contact) { return contact.consent; }).length;
    const prepared = state.stats.prepared;
    const sent = state.stats.sent;
    const failed = state.stats.failed;
    const confirmed = state.connection.confirmed;
    const hasQueue = Boolean(state.activeQueue);
    const queueUnresolved = hasQueue
      ? state.activeQueue.items.filter(function (item) { return item.status === 'pending' || item.status === 'opened'; }).length
      : 0;
    const hasDraft = state.draft.trim().length > 0;
    const steps = [
      {
        done: totalContacts > 0,
        label: 'Build your contact library',
        action: totalContacts ? '' : '<button type="button" data-action="open-import">Import</button>'
      },
      {
        done: consented > 0,
        label: 'Record recipient opt-in',
        action: totalContacts && consented < totalContacts
          ? '<button type="button" data-action="select-needs-consent">Review</button>'
          : ''
      },
      {
        done: hasDraft,
        label: 'Draft your broadcast',
        action: !hasDraft ? '<a href="#compose" data-nav="compose">Compose</a>' : ''
      },
      {
        done: confirmed,
        label: 'Confirm WhatsApp readiness',
        action: !confirmed ? '<button type="button" data-action="open-connect">Set up</button>' : ''
      },
      {
        done: hasQueue || prepared > 0,
        label: 'Prepare a send queue',
        action: !hasQueue && hasDraft && selectedConsented
          ? '<a href="#compose" data-nav="compose">Review</a>'
          : ''
      }
    ];
    const doneCount = steps.filter(function (step) { return step.done; }).length;
    const progress = Math.round((doneCount / steps.length) * 100);
    const nextRemaining = steps.length - doneCount;

    let heroPrimary;
    if (!totalContacts) {
      heroPrimary = '<button class="btn btn-primary btn-lg" type="button" data-action="open-import">'
        + icon('upload') + 'Import contacts</button>';
    } else if (selected && hasDraft) {
      heroPrimary = '<a class="btn btn-primary btn-lg" href="#compose" data-nav="compose">'
        + icon('edit') + 'Compose message</a>';
    } else if (selected) {
      heroPrimary = '<a class="btn btn-primary btn-lg" href="#contacts" data-nav="contacts">'
        + icon('users') + 'Finish choosing recipients</a>';
    } else {
      heroPrimary = '<a class="btn btn-primary btn-lg" href="#contacts" data-nav="contacts">'
        + icon('users') + 'Choose recipients</a>';
    }

    return ''
      + '<div class="view dashboard-view">'
      +   '<section class="hero">'
      +     '<div class="hero-copy">'
      +       '<span class="eyebrow"><span class="live-dot"></span>Consent-first broadcasting</span>'
      +       '<h2>One message.<br><span class="accent">A personal audience.</span></h2>'
      +       '<p>Import up to your whole customer list, choose up to 200 people, and send one thoughtful message from your own WhatsApp Business account. No API key. No shortcuts.</p>'
      +       '<div class="hero-actions">' + heroPrimary
      +         '<button class="btn btn-lg" type="button" data-action="open-help">' + icon('info') + 'How sending works</button>'
      +       '</div>'
      +       '<div class="hero-note">' + icon('shield')
      +         '<span>No passwords or OTPs · Contacts saved in this browser · Each chat opened with your confirmation</span>'
      +       '</div>'
      +     '</div>'
      +     '<div class="hero-art" aria-hidden="true">'
      +       '<div class="hero-phone">'
      +         '<div class="phone-top">'
      +           '<span class="phone-avatar">W</span>'
      +           '<span class="phone-contact"><strong>Broadcast preview</strong><small>Personalized for each contact</small></span>'
      +           '<span class="phone-menu">•••</span>'
      +         '</div>'
      +         '<div class="phone-chat">'
      +           '<div class="mini-bubble incoming">Hi Amara, a little update for you.<span class="mini-lines"><span></span><span></span></span><time>09:40</time></div>'
      +           '<div class="mini-bubble">Hello {name}, how are you? 👋<span class="mini-lines"><span></span><span></span></span><time>09:41 <span class="mini-check">✓✓</span></time></div>'
      +         '</div>'
      +         '<div class="phone-foot"><span>Message preview</span><i>›</i></div>'
      +       '</div>'
      +       '<span class="hero-chip hero-chip-one">' + icon('users') + 'Up to 200 contacts</span>'
      +       '<span class="hero-chip hero-chip-two">' + icon('shield') + 'Consent checked</span>'
      +     '</div>'
      +   '</section>'
      +   '<section class="stat-grid" aria-label="Broadcast overview">'
      +     statCard('users', 'green', totalContacts.toLocaleString(), 'Imported', totalContacts === 1 ? '1 contact saved' : 'Contacts saved locally')
      +     statCard('check-circle', 'blue', selected.toLocaleString(), 'Selected', selectedConsented + ' opted in · max 200')
      +     statCard('edit', 'purple', prepared.toLocaleString(), 'Prepared', prepared === 1 ? '1 message prepared' : 'Messages queued so far')
      +     statCard('send', 'green', sent.toLocaleString(), 'Sent', 'Confirmed manually')
      +     statCard('alert', 'red', failed.toLocaleString(), 'Failed', failed ? 'Review queue notes' : 'No reported failures')
      +     '<button type="button" class="stat-card stat-' + (confirmed ? 'green' : 'amber') + '" data-action="open-connect" title="Manage WhatsApp readiness">'
      +       '<span class="stat-top"><span class="stat-icon">' + icon('link') + '</span><span class="stat-label">WhatsApp</span></span>'
      +       '<span class="stat-value">' + (confirmed ? 'Ready' : 'Connect') + '</span>'
      +       '<span class="stat-meta"><span class="status-dot"></span>' + (confirmed ? 'Manual mode · you confirmed' : 'No API key needed') + '</span>'
      +     '</button>'
      +   '</section>'
      +   '<div class="dashboard-grid">'
      +     '<section class="panel activity-panel">'
      +       '<div class="panel-head">'
      +         '<div><h3>Recent activity</h3><p>A local record of imports, queue changes, and confirmed sends.</p></div>'
      +         (hasQueue ? '<a class="text-link" href="#queue" data-nav="queue">Open queue ' + icon('arrow-right') + '</a>' : '')
      +       '</div>'
      +       renderActivityList()
      +     '</section>'
      +     '<section class="panel readiness-panel">'
      +       '<div class="readiness-top">'
      +         '<div class="progress-ring" style="--progress:' + progress + '%"><strong>' + progress + '%</strong><small>Ready</small></div>'
      +         '<div class="readiness-copy"><h3>' + (doneCount === steps.length ? 'Broadcast ready' : 'Build your broadcast') + '</h3>'
      +           '<p>' + (doneCount === steps.length
      ? 'Your local setup is complete. Prepare a queue and send with confirmation.'
      : nextRemaining + ' step' + (nextRemaining === 1 ? '' : 's') + ' left before you are broadcast-ready.') + '</p>'
      +         '</div>'
      +       '</div>'
      +       '<div class="readiness-list">'
      +         steps.map(function (step) {
      return '<div class="readiness-item ' + (step.done ? 'is-done' : '') + '">'
      + '<span class="readiness-check">' + (step.done ? icon('check') : '') + '</span>'
      + '<span>' + esc(step.label) + '</span>' + step.action
      + '</div>';
      }).join('')
      +       '</div>'
      +       '<div class="readiness-footer">'
      +         (queueUnresolved
      ? '<a class="btn btn-primary btn-block" href="#queue" data-nav="queue">' + icon('send') + 'Continue sending · ' + queueUnresolved + ' left</a>'
      : '<a class="btn btn-soft btn-block" href="#compose" data-nav="compose">' + icon('edit') + 'Start a broadcast</a>')
      +       '</div>'
      +     '</section>'
      +   '</div>'
      + '</div>';
  }

  function statCard(iconName, tone, value, label, meta) {
    return '<div class="stat-card stat-' + tone + '">'
      + '<div class="stat-top"><span class="stat-icon">' + icon(iconName) + '</span><span class="stat-label">' + esc(label) + '</span></div>'
      + '<span class="stat-value">' + esc(String(value)) + '</span>'
      + '<span class="stat-meta">' + esc(meta) + '</span>'
      + '</div>';
  }

  function renderActivityList() {
    if (!state.activity.length) {
      return '<div class="activity-empty">'
        + '<div class="empty-illustration">' + icon('clock') + '</div>'
        + '<h4>Your activity starts here</h4>'
        + '<p>Imports, consent changes, queue events, and confirmed sends will appear in this local log.</p>'
        + '</div>';
    }
    return '<div class="activity-list">' + state.activity.slice(0, 7).map(function (item) {
      const meta = ACTIVITY_META[item.type] || ACTIVITY_META.import;
      return '<div class="activity-item">'
        + '<div class="activity-icon activity-' + meta.tone + '">' + icon(meta.icon) + '</div>'
        + '<div class="activity-copy"><p>' + esc(item.text) + '</p><time datetime="' + new Date(item.at).toISOString() + '">' + esc(relativeTime(item.at)) + '</time></div>'
        + '</div>';
    }).join('') + '</div>';
  }

  /* -----------------------------------------------------------------------
     Contacts
     ----------------------------------------------------------------------- */

  function renderContactsView() {
    const total = state.contacts.length;
    const consented = state.contacts.filter(function (contact) { return contact.consent; }).length;
    const needsConsent = total - consented;
    const filtered = getFilteredContacts();
    const selectedCount = state.selected.length;
    const atCap = selectedCount >= MAX_SELECTION;
    const filterCounts = { all: total, consented: consented, needs: needsConsent };

    let listHtml;
    if (!total) {
      listHtml = '<div class="empty-state">'
        + '<div class="empty-illustration">' + icon('users') + '</div>'
        + '<h3>Your audience starts here</h3>'
        + '<p>Import a CSV or VCF, use your device contact picker where supported, or add a contact manually. Every new contact starts as “needs opt-in” until you record consent.</p>'
        + '<div class="empty-actions">'
        + '<button class="btn btn-primary" type="button" data-action="open-import">' + icon('upload') + 'Import contacts</button>'
        + '<button class="btn" type="button" data-action="open-add-contact">' + icon('plus') + 'Add one contact</button>'
        + '</div></div>';
    } else if (!filtered.length) {
      listHtml = '<div class="contacts-empty-filter"><h4>No contacts match</h4>'
        + '<p>Try another search or switch the consent filter.</p>'
        + '<button class="btn btn-sm" type="button" data-action="clear-search" style="margin-top:12px">Clear search</button></div>';
    } else {
      listHtml = '<div class="contact-grid">' + filtered.map(function (contact) {
        return renderContactCard(contact, atCap);
      }).join('') + '</div>';
    }

    return ''
      + '<div class="view contacts-view">'
      +   '<div class="view-head">'
      +     '<div><span class="eyebrow">Audience library</span><h2>People you can reach.</h2>'
      +       '<p>All contacts stay on this device. Phone numbers are normalized to international format, duplicates are skipped, and selection is capped at 200.</p>'
      +     '</div>'
      +     '<div class="view-head-actions">'
      +       '<button class="btn" type="button" data-action="open-add-contact">' + icon('plus') + 'Add contact</button>'
      +       '<button class="btn btn-primary" type="button" data-action="open-import">' + icon('upload') + 'Import contacts</button>'
      +     '</div>'
      +   '</div>'
      +   (needsConsent && total
        ? '<div class="consent-banner">' + icon('shield')
          + '<div class="consent-banner-copy"><strong>' + needsConsent + ' contact' + (needsConsent === 1 ? '' : 's') + ' still need opt-in</strong>'
          + '<p>Only contacts marked as opted in can enter a send queue. Confirm consent before enabling anyone.</p></div>'
          + '<button class="btn btn-sm" type="button" data-action="select-needs-consent">Select these</button>'
          + '</div>'
        : '')
      +   '<section class="contacts-panel panel">'
      +     '<div class="contacts-toolbar">'
      +       '<div class="search-field">' + icon('search')
      +         '<input id="contactSearch" type="search" autocomplete="off" placeholder="Search by name or number…" aria-label="Search contacts" value="' + esc(ui.search) + '">'
      +         (ui.search ? '<button class="search-clear" type="button" data-action="clear-search" aria-label="Clear search">' + icon('x') + '</button>' : '')
      +       '</div>'
      +       '<div class="filter-pills" role="group" aria-label="Filter contacts">'
      +         filterPill('all', 'All ' + filterCounts.all, ui.filter === 'all')
      +         filterPill('consented', 'Opted in ' + filterCounts.consented, ui.filter === 'consented')
      +         filterPill('needs', 'Needs opt-in ' + filterCounts.needs, ui.filter === 'needs')
      +       '</div>'
      +       '<div class="contacts-toolbar-right">'
      +         '<button class="btn btn-sm btn-ghost" type="button" data-action="select-visible" ' + ((!filtered.length || atCap) ? 'disabled' : '') + '>' + icon('check') + ((ui.search || ui.filter !== 'all') ? 'Select visible' : 'Select all') + '</button>'
      +         '<button class="btn btn-sm btn-ghost" type="button" data-action="deselect-all" ' + (selectedCount ? '' : 'disabled') + '>Deselect all</button>'
      +       '</div>'
      +     '</div>'
      +     (selectedCount ? renderSelectionStrip() : '')
      +     listHtml
      +     '<div class="contacts-footer">'
      +       (total
      ? '<span>Showing <strong>' + filtered.length + '</strong> of <strong>' + total + '</strong> contacts</span><span><strong>' + selectedCount + '</strong> / 200 selected</span>'
      : '<span>No contacts imported yet</span><span>Stored locally in your browser</span>')
      +     '</div>'
      +   '</section>'
      + '</div>';
  }

  function filterPill(filter, label, active) {
    return '<button type="button" class="filter-pill ' + (active ? 'active' : '') + '" data-action="set-filter" data-filter="' + filter + '" aria-pressed="' + active + '">' + esc(label) + '</button>';
  }

  function renderSelectionStrip() {
    const disabled = state.selected.length ? '' : ' disabled';
    return '<div class="selection-strip">'
      + '<div class="selection-strip-main">' + icon('check-circle')
      + '<strong>' + state.selected.length + ' selected</strong><small>maximum 200</small></div>'
      + '<div class="selection-strip-actions">'
      + '<button class="btn btn-sm btn-ghost" type="button" data-action="revoke-consent-selected"' + disabled + '>Remove opt-in</button>'
      + '<button class="btn btn-sm btn-soft" type="button" data-action="grant-consent-selected"' + disabled + '>Mark opted in</button>'
      + '<button class="btn btn-sm btn-primary" type="button" data-action="compose-selected">' + icon('edit') + 'Compose</button>'
      + '<button class="icon-button-small is-danger" type="button" data-action="delete-selected" aria-label="Delete selected contacts" title="Delete selected"' + disabled + '>' + icon('trash') + '</button>'
      + '</div></div>';
  }

  function renderContactCard(contact, atCap) {
    const selected = state.selected.includes(contact.id);
    const selectDisabled = !selected && atCap;
    const source = SOURCE_LABELS[contact.source] || 'Local contact';
    return '<article class="contact-card ' + (selected ? 'is-selected ' : '') + (selectDisabled ? 'is-at-cap' : '') + '">'
      + '<div class="contact-head">' + avatar(contact.name)
      + '<div class="contact-identity"><h3 title="' + esc(contact.name) + '">' + esc(contact.name) + '</h3>'
      + '<p class="contact-phone">' + esc(prettyPhone(contact.phone)) + '</p></div>'
      + '<button type="button" class="contact-select" data-action="toggle-select" data-id="' + esc(contact.id) + '" aria-pressed="' + selected + '" aria-label="' + (selected ? 'Deselect ' : 'Select ') + esc(contact.name) + '" title="' + (selectDisabled ? 'Selection limit reached' : (selected ? 'Deselect contact' : 'Select contact')) + '">' + icon('check') + '</button>'
      + '</div>'
      + '<div class="contact-foot">'
      + '<button type="button" class="consent-pill ' + (contact.consent ? 'is-on' : '') + '" data-action="toggle-consent" data-id="' + esc(contact.id) + '" title="' + (contact.consent ? 'Remove this opt-in' : 'Only mark opted in if this person agreed to receive messages') + '">'
      + '<span class="consent-dot"></span>' + (contact.consent ? 'Opted in' : 'Needs opt-in') + '</button>'
      + '<span class="contact-source">' + esc(source) + '</span>'
      + '<span class="contact-card-actions">'
      + '<button type="button" class="icon-button-small" data-action="edit-contact" data-id="' + esc(contact.id) + '" aria-label="Edit ' + esc(contact.name) + '" title="Edit contact">' + icon('edit') + '</button>'
      + '<button type="button" class="icon-button-small is-danger" data-action="delete-contact" data-id="' + esc(contact.id) + '" aria-label="Delete ' + esc(contact.name) + '" title="Delete contact">' + icon('trash') + '</button>'
      + '</span></div></article>';
  }

  function getFilteredContacts() {
    const query = ui.search.trim().toLowerCase();
    const queryDigits = query.replace(/\D/g, '');
    return state.contacts
      .filter(function (contact) {
        if (ui.filter === 'consented' && !contact.consent) return false;
        if (ui.filter === 'needs' && contact.consent) return false;
        if (!query) return true;
        return contact.name.toLowerCase().includes(query)
          || (queryDigits && contact.phone.includes(queryDigits))
          || prettyPhone(contact.phone).toLowerCase().includes(query);
      })
      .slice()
      .sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
  }

  function getSelectedContacts() {
    const byId = new Map(state.contacts.map(function (contact) { return [contact.id, contact]; }));
    return state.selected.map(function (id) { return byId.get(id); }).filter(Boolean);
  }

  function getContactById(id) {
    return state.contacts.find(function (contact) { return contact.id === id; }) || null;
  }

  function toggleContactSelection(id) {
    const contact = getContactById(id);
    if (!contact) return;
    const index = state.selected.indexOf(id);
    if (index >= 0) {
      state.selected.splice(index, 1);
    } else {
      if (state.selected.length >= MAX_SELECTION) {
        toast('Selection limit reached', 'You can select up to 200 contacts per broadcast.', 'warning');
        return;
      }
      state.selected.push(id);
    }
    persist();
    renderView();
  }

  function selectVisibleContacts() {
    const visible = getFilteredContacts();
    if (!visible.length) {
      toast('Nothing to select', 'Adjust your search or consent filter first.', 'warning');
      return;
    }
    const result = addIdsToSelection(visible.map(function (contact) { return contact.id; }));
    persist();
    renderView();
    if (result.capped) {
      toast('Selected ' + result.added + ' contacts', 'The 200-contact selection limit was reached.', 'warning');
    } else if (result.added) {
      toast('Selected ' + result.added + ' contact' + (result.added === 1 ? '' : 's'), '', 'success', 2200);
    } else {
      toast('Already selected', 'All visible contacts are already in your selection.', 'info', 2200);
    }
  }

  function selectContactsNeedingConsent() {
    const needing = state.contacts.filter(function (contact) { return !contact.consent; });
    if (!needing.length) {
      toast('Everyone is opted in', 'There are no contacts waiting for consent.', 'success');
      return;
    }
    ui.filter = 'needs';
    ui.search = '';
    const result = addIdsToSelection(needing.map(function (contact) { return contact.id; }));
    persist();
    renderView();
    toast('Selected ' + result.added + ' contact' + (result.added === 1 ? '' : 's') + ' needing opt-in',
      'Record consent only after each person has agreed.', result.capped ? 'warning' : 'info', 4300);
  }

  function addIdsToSelection(ids) {
    let added = 0;
    let capped = false;
    ids.forEach(function (id) {
      if (state.selected.length >= MAX_SELECTION) {
        capped = true;
        return;
      }
      if (!state.selected.includes(id) && getContactById(id)) {
        state.selected.push(id);
        added += 1;
      }
    });
    return { added: added, capped: capped };
  }

  function toggleContactConsent(id) {
    const contact = getContactById(id);
    if (!contact) return;
    contact.consent = !contact.consent;
    contact.consentUpdatedAt = Date.now();
    persist();
    renderView();
    toast(contact.consent ? 'Opt-in recorded' : 'Opt-in removed',
      contact.consent ? contact.name + ' can now be added to send queues.' : contact.name + ' will be excluded from new send queues.',
      contact.consent ? 'success' : 'info', 3200);
  }

  function confirmSelectedConsent(grant) {
    if (!state.selected.length) {
      toast('No contacts selected', 'Select contacts first.', 'warning');
      return;
    }
    if (!grant) {
      const updated = applyConsentToSelection(false);
      toast('Opt-in removed', 'Updated ' + updated + ' selected contact' + (updated === 1 ? '' : 's') + '.', 'info');
      return;
    }
    confirmAction({
      kicker: 'Consent check',
      title: 'Confirm recipient consent',
      message: 'Only continue if every selected contact has agreed to receive WhatsApp messages from you. WaFlow records this opt-in locally, but cannot verify it with WhatsApp.\n\nYou are about to mark ' + state.selected.length + ' selected contact' + (state.selected.length === 1 ? '' : 's') + ' as opted in.',
      confirmText: 'I confirm consent',
      tone: 'primary',
      onConfirm: function () {
        const updated = applyConsentToSelection(true);
        toast('Opt-in recorded', 'Updated ' + updated + ' selected contact' + (updated === 1 ? '' : 's') + '.', 'success');
      }
    });
  }

  function applyConsentToSelection(grant) {
    let changed = 0;
    const now = Date.now();
    state.selected.forEach(function (id) {
      const contact = getContactById(id);
      if (!contact || contact.consent === grant) return;
      contact.consent = grant;
      contact.consentUpdatedAt = now;
      changed += 1;
    });
    if (changed) {
      state.activity.unshift({
        type: 'consent',
        text: grant
          ? 'Recorded opt-in for ' + changed + ' selected contact' + (changed === 1 ? '' : 's') + '.'
          : 'Removed opt-in from ' + changed + ' selected contact' + (changed === 1 ? '' : 's') + '.',
        at: now
      });
      state.activity = state.activity.slice(0, 40);
    }
    persist();
    renderView();
    return changed;
  }

  function confirmDeleteSelected() {
    if (!state.selected.length) return;
    const count = state.selected.length;
    confirmAction({
      kicker: 'Remove contacts',
      title: 'Delete ' + count + ' selected contact' + (count === 1 ? '' : 's') + '?',
      message: 'This removes them from your local contact library and clears your current selection. Messages already prepared in a send queue keep their own snapshot.',
      confirmText: 'Delete contacts',
      tone: 'danger',
      onConfirm: function () {
        const ids = new Set(state.selected);
        state.contacts = state.contacts.filter(function (contact) { return !ids.has(contact.id); });
        state.selected = [];
        addActivity('delete', 'Removed ' + count + ' contact' + (count === 1 ? '' : 's') + ' from the contact library.');
        persist();
        renderView();
        toast('Contacts deleted', count + ' contact' + (count === 1 ? '' : 's') + ' removed from this browser.', 'success');
      }
    });
  }

  function confirmDeleteContact(id) {
    const contact = getContactById(id);
    if (!contact) return;
    confirmAction({
      kicker: 'Remove contact',
      title: 'Delete ' + contact.name + '?',
      message: 'This removes ' + prettyPhone(contact.phone) + ' from your local contact library. Any message already prepared in a queue keeps its snapshot.',
      confirmText: 'Delete contact',
      tone: 'danger',
      onConfirm: function () {
        state.contacts = state.contacts.filter(function (item) { return item.id !== id; });
        state.selected = state.selected.filter(function (itemId) { return itemId !== id; });
        addActivity('delete', 'Removed ' + contact.name + ' from the contact library.');
        persist();
        renderView();
        toast('Contact deleted', contact.name + ' was removed from this browser.', 'success');
      }
    });
  }

  /* -----------------------------------------------------------------------
     Compose
     ----------------------------------------------------------------------- */

  function renderComposeView() {
    const selectedContacts = getSelectedContacts();
    const eligible = selectedContacts.filter(function (contact) { return contact.consent; });
    const needsConsent = selectedContacts.length - eligible.length;
    let previewContact = selectedContacts.find(function (contact) { return contact.id === ui.previewContactId; });
    if (!previewContact) previewContact = selectedContacts[0] || null;
    if (previewContact) ui.previewContactId = previewContact.id;

    const rendered = renderPersonalizedMessage(state.draft, previewContact);
    const empty = !state.draft.trim();
    const overLimit = state.draft.length > MAX_MESSAGE;
    const canReview = selectedContacts.length > 0 && !empty && !overLimit;
    const countText = state.draft.length.toLocaleString() + ' / ' + MAX_MESSAGE.toLocaleString();
    const previewName = previewContact ? previewContact.name : 'Recipient preview';

    return ''
      + '<div class="view compose-view">'
      +   '<div class="view-head">'
      +     '<div><span class="eyebrow">Message studio</span><h2>Make it feel personal.</h2>'
      +       '<p>Write once, personalize with <strong>{name}</strong>, and preview the exact chat you will open. Messages are never sent in the background.</p>'
      +     '</div>'
      +     '<div class="view-head-actions">'
      +       '<a class="btn" href="#contacts" data-nav="contacts">' + icon('users') + 'Manage audience</a>'
      +     '</div>'
      +   '</div>'
      +   '<div class="compose-layout">'
      +     '<section class="panel composer-panel">'
      +       '<div class="composer-panel-head">'
      +         '<div><h3>Your message</h3><p>Plain text, emojis, and one personalization tag.</p></div>'
      +         '<span class="badge badge-green">' + (selectedContacts.length ? eligible.length + ' ready' : 'No recipients') + '</span>'
      +       '</div>'
      +       '<div class="recipient-summary">'
      +         '<div class="recipient-avatars">' + selectedContacts.slice(0, 3).map(function (contact) { return avatar(contact.name, 'avatar-sm'); }).join('') + '</div>'
      +         '<div class="recipient-summary-copy"><strong>' + selectedContacts.length + ' recipient' + (selectedContacts.length === 1 ? '' : 's') + ' selected</strong>'
      +           '<p>' + (selectedContacts.length
      ? eligible.length + ' opted in · ' + needsConsent + ' need opt-in'
      : 'Choose contacts to unlock your audience preview') + '</p></div>'
      +         '<a class="text-link" href="#contacts" data-nav="contacts">' + (selectedContacts.length ? 'Change' : 'Choose') + ' ' + icon('arrow-right') + '</a>'
      +       '</div>'
      +       (selectedContacts.length
      ? ''
      : '<div class="callout callout-amber" style="margin-bottom:12px">' + icon('users')
      + '<p>No recipients selected yet. <a class="help-link" href="#contacts" data-nav="contacts">Choose up to 200 contacts</a> before preparing the queue.</p></div>')
      +       '<div class="editor-shell">'
      +         '<textarea class="message-editor" id="messageEditor" maxlength="' + MAX_MESSAGE + '" placeholder="Hello {name}, how are you? 👋&#10;&#10;Write something worth opening…" aria-label="Message text">' + esc(state.draft) + '</textarea>'
      +         '<div class="emoji-popover ' + (ui.emojiOpen ? 'is-open' : '') + '" id="emojiPopover" aria-label="Emoji picker">'
      +           EMOJIS.map(function (emoji, index) {
      return '<button type="button" class="emoji-choice" data-action="insert-emoji" data-emoji-index="' + index + '" aria-label="Insert ' + esc(emoji) + '">' + emoji + '</button>';
      }).join('')
      +         '</div>'
      +         '<div class="editor-toolbar">'
      +           '<button type="button" class="tool-btn ' + (ui.emojiOpen ? 'active' : '') + '" data-action="toggle-emoji" aria-expanded="' + ui.emojiOpen + '">' + icon('smile') + 'Emoji</button>'
      +           '<button type="button" class="tool-btn" data-action="insert-name" title="Insert personalization tag">' + icon('sparkles') + '<code>{name}</code></button>'
      +           '<span class="char-meter' + (overLimit ? ' is-over' : (state.draft.length > 3600 ? ' is-high' : '')) + '" id="charMeter">' + countText + '</span>'
      +         '</div>'
      +       '</div>'
      +       '<div class="template-row"><span class="template-label">Start with</span>'
      +         TEMPLATES.map(function (template, index) {
      return '<button type="button" class="template-chip" data-action="apply-template" data-template-index="' + index + '">' + esc(template.label) + '</button>';
      }).join('')
      +       '</div>'
      +       '<div class="compose-actions">'
      +         '<div class="compose-actions-note">' + icon('shield')
      +           '<span>Only opted-in recipients enter the queue. WaFlow cannot send silently or verify delivery.</span>'
      +         '</div>'
      +         '<button class="btn btn-primary btn-lg" type="button" data-action="open-review" id="reviewSendButton" ' + (canReview ? '' : 'disabled') + '>'
      +           icon('send') + 'Review &amp; send' + (eligible.length ? ' · ' + eligible.length : '') + '</button>'
      +       '</div>'
      +     '</section>'
      +     '<aside class="preview-column">'
      +       '<section class="panel preview-panel">'
      +         '<div class="preview-head"><h3>Recipient preview</h3>'
      +           '<select class="preview-contact-select" id="previewContactSelect" aria-label="Preview recipient" ' + (selectedContacts.length ? '' : 'disabled') + '>'
      +             (selectedContacts.length
      ? selectedContacts.map(function (contact) {
      return '<option value="' + esc(contact.id) + '" ' + (previewContact && previewContact.id === contact.id ? 'selected' : '') + '>' + esc(contact.name) + '</option>';
      }).join('')
      : '<option>No contact selected</option>')
      +           '</select>'
      +         '</div>'
      +         '<div class="whatsapp-preview">'
      +           '<div class="wa-preview-head"><span class="wa-back">‹</span>'
      + avatar(previewName, 'avatar-sm')
      + '<div class="wa-contact"><strong>' + esc(previewName) + '</strong><small>' + (previewContact ? esc(prettyPhone(previewContact.phone)) : 'Personalization preview') + '</small></div>'
      + '<span class="wa-icons">⋮</span></div>'
      +           '<div class="wa-chat-body"><span class="wa-date">MESSAGE PREVIEW</span>'
      +             '<div class="wa-bubble ' + (empty ? 'is-placeholder' : '') + '" id="previewBubble">'
      +               '<span id="previewBubbleText">' + esc(empty ? 'Your message preview will appear here.' : rendered) + '</span>'
      +               '<span class="wa-time">09:41 <span class="wa-ticks">✓✓</span></span>'
      +             '</div>'
      +             '<div class="wa-input"><span>Message</span><span class="wa-send">' + icon('send') + '</span></div>'
      +           '</div>'
      +         '</div>'
      +         '<p class="preview-note">' + icon('info') + '<span>Style preview only. The chat is opened from your own WhatsApp account in the send queue.</span></p>'
      +       '</section>'
      +       '<section class="panel audience-panel">'
      +         '<div class="panel-head"><div><h3>Audience</h3><p>Selection is capped at 200.</p></div>'
      +           '<a class="text-link" href="#contacts" data-nav="contacts">Edit ' + icon('arrow-right') + '</a></div>'
      +         '<div class="audience-metrics">'
      +           '<div class="audience-metric"><strong>' + selectedContacts.length + '</strong><small>Selected</small></div>'
      +           '<div class="audience-metric is-green"><strong>' + eligible.length + '</strong><small>Opted in</small></div>'
      +           '<div class="audience-metric is-amber"><strong>' + needsConsent + '</strong><small>Skipped</small></div>'
      +         '</div>'
      +         '<div class="audience-chips">'
      +           (selectedContacts.length
      ? selectedContacts.slice(0, 7).map(function (contact) {
      return '<span class="audience-chip ' + (contact.consent ? '' : 'is-pending') + '" title="' + (contact.consent ? 'Opted in' : 'Needs opt-in — excluded from queue') + '"><i></i><span>' + esc(contact.name) + '</span></span>';
      }).join('') + (selectedContacts.length > 7 ? '<span class="audience-chip"><span>+' + (selectedContacts.length - 7) + ' more</span></span>' : '')
      : '<span class="contact-source">No recipients selected.</span>')
      +         '</div>'
      +         '<div class="audience-footer"><span class="badge ' + (needsConsent ? 'badge-amber' : 'badge-green') + '">' + (needsConsent ? needsConsent + ' will be skipped' : selectedContacts.length ? 'All selected are opted in' : 'Awaiting selection') + '</span>'
      +           '<span class="contact-source">' + Math.min(selectedContacts.length, MAX_SELECTION) + '/200</span></div>'
      +       '</section>'
      +     '</aside>'
      +   '</div>'
      + '</div>';
  }

  function updateComposerMetrics() {
    const meter = document.getElementById('charMeter');
    if (meter) {
      const length = state.draft.length;
      meter.textContent = length.toLocaleString() + ' / ' + MAX_MESSAGE.toLocaleString();
      meter.classList.toggle('is-over', length > MAX_MESSAGE);
      meter.classList.toggle('is-high', length > 3600 && length <= MAX_MESSAGE);
    }
    const bubble = document.getElementById('previewBubble');
    const bubbleText = document.getElementById('previewBubbleText');
    const previewContact = getSelectedContacts().find(function (contact) { return contact.id === ui.previewContactId; })
      || getSelectedContacts()[0]
      || null;
    if (previewContact) ui.previewContactId = previewContact.id;
    if (bubbleText) {
      const empty = !state.draft.trim();
      bubbleText.textContent = empty ? 'Your message preview will appear here.' : renderPersonalizedMessage(state.draft, previewContact);
      if (bubble) bubble.classList.toggle('is-placeholder', empty);
    }
    const sendButton = document.getElementById('reviewSendButton');
    if (sendButton) {
      const selected = getSelectedContacts();
      sendButton.disabled = !selected.length || !state.draft.trim() || state.draft.length > MAX_MESSAGE;
    }
  }

  function insertIntoDraft(text) {
    const editor = document.getElementById('messageEditor');
    if (!editor) return;
    const start = typeof editor.selectionStart === 'number' ? editor.selectionStart : state.draft.length;
    const end = typeof editor.selectionEnd === 'number' ? editor.selectionEnd : state.draft.length;
    const next = (state.draft.slice(0, start) + text + state.draft.slice(end)).slice(0, MAX_MESSAGE);
    setDraftValue(next, start + text.length);
    if (text.length > 1 && /[^\u0000-\u007F]/.test(text) && !text.includes('{name}')) {
      ui.emojiOpen = false;
      const popover = document.getElementById('emojiPopover');
      if (popover) popover.classList.remove('is-open');
      const emojiButton = document.querySelector('[data-action="toggle-emoji"]');
      if (emojiButton) {
        emojiButton.classList.remove('active');
        emojiButton.setAttribute('aria-expanded', 'false');
      }
    }
  }

  function setDraftValue(value, caret) {
    state.draft = String(value).slice(0, MAX_MESSAGE);
    const editor = document.getElementById('messageEditor');
    if (editor) {
      editor.value = state.draft;
      editor.focus();
      const position = typeof caret === 'number' ? Math.min(caret, state.draft.length) : state.draft.length;
      try { editor.setSelectionRange(position, position); } catch (error) { /* noop */ }
    }
    scheduleSave();
    updateComposerMetrics();
  }

  function toggleEmojiPicker() {
    ui.emojiOpen = !ui.emojiOpen;
    const popover = document.getElementById('emojiPopover');
    if (popover) popover.classList.toggle('is-open', ui.emojiOpen);
    const button = document.querySelector('[data-action="toggle-emoji"]');
    if (button) {
      button.classList.toggle('active', ui.emojiOpen);
      button.setAttribute('aria-expanded', ui.emojiOpen ? 'true' : 'false');
    }
  }

  function renderPersonalizedMessage(template, contact) {
    const name = contact && contact.name ? contact.name : 'there';
    return String(template || '').replace(/\{name\}/gi, name);
  }

  /* -----------------------------------------------------------------------
     Review and send queue
     ----------------------------------------------------------------------- */

  function openReviewDialog() {
    const selectedContacts = getSelectedContacts();
    const eligible = selectedContacts.filter(function (contact) { return contact.consent; });
    const needsConsent = selectedContacts.length - eligible.length;
    const message = state.draft.trim();
    if (!selectedContacts.length) {
      toast('No recipients selected', 'Choose contacts before preparing your queue.', 'warning');
      return;
    }
    if (!message) {
      toast('Your message is empty', 'Write a message before reviewing the broadcast.', 'warning');
      return;
    }
    if (state.draft.length > MAX_MESSAGE) {
      toast('Message is too long', 'Keep the message under ' + MAX_MESSAGE.toLocaleString() + ' characters.', 'error');
      return;
    }
    const activeUnresolved = state.activeQueue
      ? state.activeQueue.items.filter(function (item) { return item.status === 'pending' || item.status === 'opened'; }).length
      : 0;

    const recipientPreview = eligible.slice(0, 6).map(function (contact) {
      return '<div class="review-recipient">' + avatar(contact.name, 'avatar-sm')
        + '<div class="review-recipient-copy"><strong>' + esc(contact.name) + '</strong><small>' + esc(prettyPhone(contact.phone)) + '</small></div>'
        + '<span class="badge badge-green">Opted in</span></div>';
    }).join('');

    const body = ''
      + '<p class="dialog-intro">You are preparing <strong>' + eligible.length + ' personalized WhatsApp chat' + (eligible.length === 1 ? '' : 's') + '</strong>. The send queue opens each prefilled chat for your review; you press Send inside WhatsApp.</p>'
      + '<div class="review-summary" style="margin-top:14px">'
      +   '<div class="review-summary-card"><small>Selected</small><strong>' + selectedContacts.length + '</strong><span>Recipients chosen</span></div>'
      +   '<div class="review-summary-card"><small>Opted in</small><strong>' + eligible.length + '</strong><span>Eligible for queue</span></div>'
      +   '<div class="review-summary-card"><small>Send method</small><strong style="font-size:12px;line-height:1.4">' + esc(shortMethodLabel()) + '</strong><span>Manual handoff</span></div>'
      +   '<div class="review-summary-card"><small>Message length</small><strong>' + state.draft.length.toLocaleString() + '</strong><span>characters</span></div>'
      + '</div>'
      + (needsConsent
        ? '<div class="callout callout-amber" style="margin-top:12px">' + icon('shield')
          + '<p><strong>' + needsConsent + ' selected contact' + (needsConsent === 1 ? '' : 's') + ' will be skipped</strong> because opt-in is not recorded. No message will be prepared for them.</p></div>'
        : '')
      + (activeUnresolved
        ? '<div class="callout callout-amber" style="margin-top:12px">' + icon('alert')
          + '<p><strong>An active queue still has ' + activeUnresolved + ' unhandled chat' + (activeUnresolved === 1 ? '' : 's') + '.</strong> Preparing this queue will archive the old one. Its confirmed sent count is kept.</p></div>'
        : '')
      + (!state.connection.confirmed
        ? '<div class="callout" style="margin-top:12px">' + icon('info')
          + '<p>WhatsApp readiness is not confirmed. You can prepare the queue, but make sure you are signed in to WhatsApp Web or have WhatsApp available on this device before opening chats.</p></div>'
        : '')
      + '<div class="dialog-section"><div class="dialog-section-title">' + icon('users') + 'Queue preview</div>'
      + '<div class="review-list">' + recipientPreview
      + (eligible.length > 6 ? '<div class="review-more">+ ' + (eligible.length - 6) + ' more opted-in recipient' + (eligible.length - 6 === 1 ? '' : 's') + '</div>' : '')
      + '</div></div>'
      + '<div class="dialog-section"><div class="dialog-section-title">' + icon('shield') + 'What happens next</div>'
      + '<div class="guide-steps">'
      +   '<div class="guide-step"><span class="guide-step-number">1</span><div class="guide-step-copy"><strong>WaFlow prepares ' + eligible.length + ' prefilled links</strong><p>Each link contains the recipient number and your personalized message. Nothing is sent automatically.</p></div></div>'
      +   '<div class="guide-step"><span class="guide-step-number">2</span><div class="guide-step-copy"><strong>You open each chat and press Send</strong><p>WhatsApp remains in control. Review the recipient and content before sending.</p></div></div>'
      +   '<div class="guide-step"><span class="guide-step-number">3</span><div class="guide-step-copy"><strong>Mark each chat as sent</strong><p>Your dashboard counts only sends you explicitly confirm; delivery cannot be verified by this app.</p></div></div>'
      + '</div></div>';

    const footer = eligible.length
      ? '<span class="dialog-footer-note">No API key · no automatic send</span>'
        + '<button class="btn" type="button" data-action="close-dialog">Cancel</button>'
        + '<button class="btn btn-primary" type="button" data-action="prepare-queue">' + icon('send') + 'Prepare queue · ' + eligible.length + '</button>'
      : '<button class="btn" type="button" data-action="close-dialog">Close</button>'
        + '<button class="btn btn-primary" type="button" data-action="review-manage-consent">' + icon('shield') + 'Review consent</button>';

    openDialog({
      kicker: 'Final review',
      title: 'Ready to prepare the queue?',
      body: body,
      footer: footer,
      size: 'dialog-wide'
    });
  }

  function prepareQueue() {
    const eligible = getSelectedContacts().filter(function (contact) { return contact.consent; });
    const message = state.draft.trim();
    if (!eligible.length) {
      toast('No opted-in recipients', 'Record consent before preparing a queue.', 'warning');
      return;
    }
    if (!message) {
      toast('Your message is empty', 'Write a message first.', 'warning');
      return;
    }
    if (state.draft.length > MAX_MESSAGE) {
      toast('Message is too long', 'Keep it under ' + MAX_MESSAGE.toLocaleString() + ' characters.', 'error');
      return;
    }

    if (state.activeQueue) archiveCurrentQueue('cancelled', false);

    const items = eligible.map(function (contact) {
      return {
        id: uid('item'),
        contactId: contact.id,
        name: contact.name,
        phone: contact.phone,
        message: renderPersonalizedMessage(state.draft, contact),
        status: 'pending',
        openedAt: null,
        resolvedAt: null
      };
    });

    const now = Date.now();
    state.activeQueue = {
      id: uid('queue'),
      createdAt: now,
      completedAt: null,
      status: 'active',
      mode: effectiveSendMode(),
      messageTemplate: state.draft,
      items: items
    };
    state.stats.prepared += items.length;
    addActivity('prepared', 'Prepared ' + items.length + ' personalized chat' + (items.length === 1 ? '' : 's') + ' for the send queue.');
    persist();
    closeDialog();
    goTo('queue');
    toast('Queue prepared', items.length + ' chat' + (items.length === 1 ? '' : 's') + ' ready. Open each one and confirm in WhatsApp.', 'success', 5200);
  }

  function renderQueueView() {
    const queue = state.activeQueue;
    if (!queue) return renderEmptyQueueView();

    const counts = queueCounts(queue);
    const total = queue.items.length;
    const handled = counts.sent + counts.skipped + counts.failed;
    const progress = total ? Math.round((handled / total) * 100) : 100;
    const current = queue.items.find(function (item) { return item.status === 'pending' || item.status === 'opened'; }) || null;
    const complete = queue.status === 'completed' || !current;

    return ''
      + '<div class="view queue-view">'
      +   '<div class="view-head">'
      +     '<div><span class="eyebrow">Manual send centre</span><h2>' + (complete ? 'Queue complete.' : 'Ready, one chat at a time.') + '</h2>'
      +       '<p>' + (complete
      ? 'You have handled every recipient in this queue. Sent counts reflect only the chats you explicitly confirmed.'
      : 'Open each prefilled WhatsApp chat, press Send yourself, then return here and mark it as sent. Nothing is sent in the background.') + '</p>'
      +     '</div>'
      +     '<div class="view-head-actions"><button class="btn" type="button" data-action="open-help">' + icon('info') + 'Sending guide</button></div>'
      +   '</div>'
      +   '<section class="queue-hero">'
      +     '<div class="queue-hero-copy">'
      +       '<span class="eyebrow"><span class="live-dot"></span>' + (complete ? 'Campaign finished' : 'Queue in progress') + '</span>'
      +       '<h2>' + (complete ? 'Every recipient has been handled.' : esc(firstNameOrPhone(current.name)) + ' is next in your queue.') + '</h2>'
      +       '<p>Prepared ' + formatDateTime(queue.createdAt) + ' with ' + esc(shortMethodLabel(queue.mode)) + '. You remain in control of every message.</p>'
      +       '<div class="queue-meta">'
      +         '<span class="badge badge-purple">' + icon('edit') + total + ' prepared</span>'
      +         '<span class="badge badge-green">' + icon('check-circle') + counts.sent + ' confirmed</span>'
      +         (counts.skipped ? '<span class="badge">' + icon('list') + counts.skipped + ' skipped</span>' : '')
      +         (counts.failed ? '<span class="badge badge-red">' + icon('alert') + counts.failed + ' failed</span>' : '')
      +       '</div>'
      +     '</div>'
      +     '<div class="queue-progress-wrap">'
      +       '<div class="queue-progress-ring" style="--progress:' + progress + '%"><strong>' + progress + '%</strong></div>'
      +       '<div class="queue-progress-copy"><strong>' + handled + ' of ' + total + ' handled</strong><small>' + (complete ? 'Queue archived whenever you are ready' : (total - handled) + ' recipient' + ((total - handled) === 1 ? '' : 's') + ' remaining') + '</small></div>'
      +     '</div>'
      +   '</section>'
      +   '<div class="queue-metrics">'
      +     queueMetric('clock', 'amber', counts.pending, 'To open')
      +     queueMetric('external', 'blue', counts.opened, 'Chats opened')
      +     queueMetric('check-circle', 'green', counts.sent, 'Confirmed sent')
      +     queueMetric('alert', 'red', counts.failed, 'Failed')
      +   '</div>'
      +   '<div class="queue-help">' + icon('info')
      +     '<span><strong>Manual confirmation only.</strong> WaFlow opens a prefilled chat in WhatsApp. It cannot press Send, verify delivery, read receipts, or bypass spam controls. Mark a chat as sent only after you have sent it yourself.</span>'
      +   '</div>'
      +   (!state.connection.confirmed
      ? '<div class="callout callout-amber" style="margin-top:10px">' + icon('link')
        + '<p><strong>WhatsApp readiness is not confirmed.</strong> You can still use the queue, but make sure you are signed in before opening chats. <button class="help-link" type="button" data-action="open-connect">Connect WhatsApp ' + icon('arrow-right') + '</button></p></div>'
      : '')
      +   '<div class="queue-grid">'
      +     '<section class="panel next-card">' + (complete ? renderQueueCompleteCard(queue, counts) : renderNextRecipientCard(queue, current))
      +     '</section>'
      +     '<section class="panel queue-list-panel">'
      +       '<div class="queue-list-head"><h3>All recipients</h3><span class="badge">' + total + ' total</span></div>'
      +       '<div class="queue-list">' + queue.items.map(function (item) {
      return renderQueueRow(item, current ? current.id : null);
      }).join('') + '</div>'
      +       '<div class="queue-end-actions"><p>Local queue · saved in this browser</p>'
      +         '<button class="btn btn-sm btn-ghost" type="button" data-action="' + (complete ? 'archive-queue' : 'discard-queue') + '">' + (complete ? 'Archive queue' : 'Discard queue') + '</button></div>'
      +     '</section>'
      +   '</div>'
      + '</div>';
  }

  function renderEmptyQueueView() {
    const history = state.history.length
      ? '<section class="panel queue-history"><div class="panel-head"><div><h3>Recent campaigns</h3><p>Summaries kept locally after a queue is archived.</p></div></div>'
        + '<div class="queue-history-list">' + state.history.map(function (entry) {
          return '<div class="queue-history-item"><span class="queue-history-icon">' + icon('send') + '</span>'
            + '<div class="queue-history-copy"><strong>' + entry.prepared + ' prepared · ' + entry.sent + ' confirmed sent</strong>'
            + '<small>' + formatDateTime(entry.createdAt) + ' · ' + (entry.status === 'cancelled' ? 'Discarded' : 'Completed') + (entry.failed ? ' · ' + entry.failed + ' failed' : '') + '</small></div>'
            + '<span class="queue-history-stat">' + entry.prepared + ' chats</span></div>';
        }).join('') + '</div></section>'
      : '';

    return ''
      + '<div class="view queue-view">'
      +   '<div class="view-head"><div><span class="eyebrow">Send queue</span><h2>No chats waiting.</h2>'
      +     '<p>Your queue is where prefilled WhatsApp chats are reviewed one by one. Prepare one from the compose screen when your message and audience are ready.</p>'
      +   '</div><div class="view-head-actions"><a class="btn btn-primary" href="#compose" data-nav="compose">' + icon('edit') + 'Compose a broadcast</a></div></div>'
      +   '<section class="panel queue-empty-panel">'
      +     '<div class="empty-state">'
      +       '<div class="empty-illustration">' + icon('list') + '</div>'
      +       '<h3>Your send queue is clear</h3>'
      +       '<p>WaFlow never sends silently. A prepared queue lets you open each official WhatsApp chat with the message pre-filled, then confirm your sends as you go.</p>'
      +       '<div class="empty-actions"><a class="btn btn-primary" href="#compose" data-nav="compose">' + icon('edit') + 'Compose a message</a>'
      +         '<button class="btn" type="button" data-action="open-help">' + icon('info') + 'See the sending steps</button></div>'
      +     '</div>'
      +   '</section>'
      +   history
      + '</div>';
  }

  function renderNextRecipientCard(queue, item) {
    const opened = Boolean(item.openedAt);
    const disabledSent = opened ? '' : ' disabled';
    return ''
      + '<div class="next-card-head"><div><span class="section-label">Next recipient</span><h3>Review before you open</h3></div>'
      + '<span class="status-pill is-' + item.status + '"><span class="status-dot"></span>' + statusLabel(item.status) + '</span></div>'
      + '<div class="next-person">' + avatar(item.name, 'avatar-lg')
      +   '<div class="next-person-copy"><h4>' + esc(item.name) + '</h4><p>' + esc(prettyPhone(item.phone)) + '</p></div>'
      + '</div>'
      + '<div class="next-message">' + esc(item.message) + '</div>'
      + '<div class="next-card-actions">'
      +   '<button class="btn btn-primary btn-lg btn-block" type="button" data-action="open-chat" data-id="' + esc(item.id) + '">'
      +     icon('external') + (opened ? 'Reopen WhatsApp chat' : 'Open WhatsApp chat') + '</button>'
      +   '<button class="btn btn-soft btn-block" type="button" data-action="mark-sent" data-id="' + esc(item.id) + '"' + disabledSent + ' title="' + (opened ? 'Mark this chat as sent after you press Send in WhatsApp' : 'Open the WhatsApp chat first') + '">'
      +     icon('check') + 'Mark as sent</button>'
      +   '<div class="next-secondary-actions">'
      +     '<button class="btn btn-ghost btn-sm" type="button" data-action="skip-contact" data-id="' + esc(item.id) + '">' + icon('chevron-right') + 'Skip</button>'
      +     '<button class="btn btn-ghost btn-sm" type="button" data-action="copy-message" data-id="' + esc(item.id) + '">' + icon('copy') + 'Copy message</button>'
      +   '</div>'
      +   '<div class="next-tiny-actions"><button type="button" class="is-danger" data-action="mark-failed" data-id="' + esc(item.id) + '">Couldn’t send this one?</button></div>'
      + '</div>'
      + '<p class="preview-note" style="margin-top:14px">' + icon('info')
      +   '<span>' + (opened ? 'Chat opened. After pressing Send in WhatsApp, return here and confirm.' : 'Opening marks the chat as viewed in WaFlow. It does not count as sent.') + '</span></p>';
  }

  function renderQueueCompleteCard(queue, counts) {
    return ''
      + '<div class="queue-complete">'
      +   '<div class="empty-illustration">' + icon('check-circle') + '</div>'
      +   '<h3>Campaign handled</h3>'
      +   '<p>' + counts.sent + ' confirmed sent · ' + counts.skipped + ' skipped · ' + counts.failed + ' failed. Start a fresh broadcast or archive this local queue.</p>'
      +   '<div class="empty-actions">'
      +     '<button class="btn btn-primary" type="button" data-action="new-campaign">' + icon('edit') + 'Start new broadcast</button>'
      +     '<button class="btn" type="button" data-action="archive-queue">' + icon('check') + 'Archive queue</button>'
      +   '</div>'
      + '</div>';
  }

  function renderQueueRow(item, currentId) {
    const unresolved = item.status === 'pending' || item.status === 'opened';
    const current = item.id === currentId;
    const canMark = item.status === 'opened';
    return '<div class="queue-row ' + (current ? 'is-current' : '') + '">'
      + avatar(item.name, 'avatar-sm')
      + '<div class="queue-row-copy"><strong>' + esc(item.name) + '</strong><small>' + esc(prettyPhone(item.phone)) + '</small></div>'
      + '<span class="status-pill is-' + item.status + '"><span class="status-dot"></span>' + statusLabel(item.status) + '</span>'
      + '<div class="queue-row-actions">'
      +   (unresolved
        ? '<button class="icon-button-small open-chat" type="button" data-action="open-chat" data-id="' + esc(item.id) + '" title="Open WhatsApp chat" aria-label="Open WhatsApp chat for ' + esc(item.name) + '">' + icon('external') + '</button>'
          + '<button class="icon-button-small mark-sent" type="button" data-action="mark-sent" data-id="' + esc(item.id) + '"' + (canMark ? '' : ' disabled') + ' title="' + (canMark ? 'Mark as sent' : 'Open the chat first') + '" aria-label="Mark chat with ' + esc(item.name) + ' as sent">' + icon('check') + '</button>'
          + '<button class="icon-button-small" type="button" data-action="skip-contact" data-id="' + esc(item.id) + '" title="Skip contact" aria-label="Skip ' + esc(item.name) + '">' + icon('x') + '</button>'
        : '<button class="icon-button-small" type="button" data-action="copy-message" data-id="' + esc(item.id) + '" title="Copy personalized message" aria-label="Copy message for ' + esc(item.name) + '">' + icon('copy') + '</button>')
      + '</div></div>';
  }

  function queueCounts(queue) {
    const counts = { pending: 0, opened: 0, sent: 0, skipped: 0, failed: 0 };
    queue.items.forEach(function (item) {
      if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
    });
    return counts;
  }

  function queueMetric(iconName, tone, value, label) {
    const colors = {
      green: ['var(--green-bright)', 'var(--green-soft)'],
      amber: ['var(--amber)', 'var(--amber-soft)'],
      blue: ['var(--blue)', 'var(--blue-soft)'],
      red: ['var(--red)', 'var(--red-soft)']
    };
    const pair = colors[tone] || colors.green;
    return '<div class="queue-metric"><span class="queue-metric-icon" style="--metric-color:' + pair[0] + ';--metric-bg:' + pair[1] + '">' + icon(iconName) + '</span>'
      + '<div><strong>' + value + '</strong><small>' + esc(label) + '</small></div></div>';
  }

  function statusLabel(status) {
    return { pending: 'To open', opened: 'Chat opened', sent: 'Sent', skipped: 'Skipped', failed: 'Failed' }[status] || 'Pending';
  }

  function openQueueChat(id) {
    const item = findQueueItem(id);
    if (!item) return;
    if (item.status !== 'pending' && item.status !== 'opened') {
      toast('This chat is already handled', 'Marked sent, skipped, or failed.', 'info', 2800);
      return;
    }
    const url = buildSendUrl(item.phone, item.message, state.activeQueue ? state.activeQueue.mode : null);
    let popup = null;
    try {
      popup = window.open(url, '_blank');
    } catch (error) {
      popup = null;
    }
    if (popup) {
      try { popup.opener = null; } catch (error) { /* noop */ }
      if (item.status === 'pending') {
        item.status = 'opened';
        item.openedAt = Date.now();
        saveNow();
        updateChrome();
        renderView();
      }
      toast('WhatsApp chat opened', 'Press Send inside WhatsApp, then return here and mark the chat as sent.', 'info', 5600);
    } else {
      openChatFallback(item, url);
    }
  }

  function openChatFallback(item, url) {
    openDialog({
      kicker: 'Browser blocked the tab',
      title: 'Open your WhatsApp chat',
      body: '<p class="dialog-intro">Your browser blocked the automatic tab. Use this direct link instead. WaFlow still cannot send or verify the message.</p>'
        + '<div class="callout callout-amber" style="margin-top:14px">' + icon('external')
        + '<p>' + esc(item.name) + ' · ' + esc(prettyPhone(item.phone)) + '</p></div>'
        + '<a class="btn btn-primary btn-block btn-lg" style="margin-top:14px" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">'
        + icon('external') + 'Open in WhatsApp</a>'
        + '<p class="form-hint" style="text-align:center">After the chat opens, return and mark it opened so you can confirm the send.</p>',
      footer: '<button class="btn" type="button" data-action="close-dialog">Close</button>'
        + '<button class="btn btn-soft" type="button" data-action="mark-opened" data-id="' + esc(item.id) + '">' + icon('check') + 'I opened it</button>',
      size: 'dialog-narrow'
    });
  }

  function markQueueItemOpened(id) {
    const item = findQueueItem(id);
    if (!item) return;
    if (!item.openedAt) {
      item.openedAt = Date.now();
      if (item.status === 'pending') item.status = 'opened';
      saveNow();
      updateChrome();
    }
    closeDialog();
    renderView();
    toast('Chat marked as opened', 'Send it in WhatsApp, then return to mark it as sent.', 'info', 4200);
  }

  function markQueueItemSent(id) {
    const item = findQueueItem(id);
    if (!item) return;
    if (item.status === 'sent') return;
    if (item.status === 'failed' || item.status === 'skipped') {
      toast('This recipient is already handled', 'Start a new queue if you need to send again.', 'info', 3400);
      return;
    }
    if (!item.openedAt) {
      toast('Open the chat first', 'Use the WhatsApp chat button, then confirm after sending.', 'warning', 4000);
      return;
    }
    item.status = 'sent';
    item.resolvedAt = Date.now();
    state.stats.sent += 1;
    addActivity('sent', 'Confirmed sending a message to ' + item.name + '.');
    const completed = maybeCompleteQueue();
    persist();
    renderView();
    toast(completed ? 'Queue complete' : 'Marked as sent',
      completed ? 'Every recipient in this queue has been handled.' : 'Confirmed by you. Delivery is not verified by WaFlow.',
      'success', 4600);
  }

  function skipQueueItem(id) {
    const item = findQueueItem(id);
    if (!item) return;
    if (item.status !== 'pending' && item.status !== 'opened') return;
    item.status = 'skipped';
    item.resolvedAt = Date.now();
    const completed = maybeCompleteQueue();
    persist();
    renderView();
    toast(completed ? 'Queue complete' : 'Recipient skipped', completed ? 'Every recipient has been handled.' : item.name + ' was skipped for this campaign.', 'info', 3400);
  }

  function markQueueItemFailed(id) {
    const item = findQueueItem(id);
    if (!item) return;
    if (item.status !== 'pending' && item.status !== 'opened') return;
    item.status = 'failed';
    item.resolvedAt = Date.now();
    state.stats.failed += 1;
    addActivity('failed', 'A message to ' + item.name + ' was marked as failed.');
    const completed = maybeCompleteQueue();
    persist();
    renderView();
    toast(completed ? 'Queue complete' : 'Failure recorded', completed ? 'Every recipient has been handled.' : 'Review the queue and try again in a new campaign if needed.', 'warning', 4000);
  }

  function maybeCompleteQueue() {
    const queue = state.activeQueue;
    if (!queue || queue.status === 'completed') return false;
    const unresolved = queue.items.some(function (item) { return item.status === 'pending' || item.status === 'opened'; });
    if (unresolved) return false;
    queue.status = 'completed';
    queue.completedAt = Date.now();
    const counts = queueCounts(queue);
    addActivity('completed', 'Send queue completed: ' + counts.sent + ' confirmed sent, ' + counts.skipped + ' skipped, ' + counts.failed + ' failed.');
    return true;
  }

  function findQueueItem(id) {
    if (!state.activeQueue) return null;
    return state.activeQueue.items.find(function (item) { return item.id === id; }) || null;
  }

  function copyQueueMessage(id) {
    const item = findQueueItem(id);
    if (!item) return;
    copyText(item.message).then(function () {
      toast('Message copied', 'Personalized text for ' + item.name + ' is on your clipboard.', 'success', 2800);
    }).catch(function () {
      toast('Copy failed', 'Your browser blocked clipboard access.', 'error');
    });
  }

  function requestArchiveQueue(discard) {
    const queue = state.activeQueue;
    if (!queue) return;
    const unresolved = queue.items.filter(function (item) { return item.status === 'pending' || item.status === 'opened'; }).length;
    if (!discard && !unresolved && queue.status === 'completed') {
      archiveCurrentQueue('completed', true);
      return;
    }
    confirmAction({
      kicker: discard ? 'Discard queue' : 'Archive queue',
      title: unresolved ? 'Discard ' + unresolved + ' unhandled chat' + (unresolved === 1 ? '' : 's') + '?' : 'Archive this queue?',
      message: unresolved
        ? 'The queue will be removed from your workspace. Messages you already confirmed as sent stay in your dashboard total and activity log.'
        : 'This moves the queue summary into recent campaigns. Your confirmed sent totals stay in the dashboard.',
      confirmText: unresolved ? 'Discard queue' : 'Archive queue',
      tone: unresolved ? 'danger' : 'primary',
      onConfirm: function () {
        archiveCurrentQueue(unresolved ? 'cancelled' : 'completed', true);
      }
    });
  }

  function archiveCurrentQueue(status, announce) {
    const queue = state.activeQueue;
    if (!queue) return;
    const counts = queueCounts(queue);
    state.history.unshift({
      id: queue.id,
      createdAt: queue.createdAt,
      closedAt: Date.now(),
      prepared: queue.items.length,
      sent: counts.sent,
      skipped: counts.skipped,
      failed: counts.failed,
      status: status === 'cancelled' ? 'cancelled' : 'completed'
    });
    state.history = state.history.slice(0, MAX_HISTORY);
    state.activeQueue = null;
    saveNow();
    updateChrome();
    if (announce) {
      renderView();
      toast(status === 'cancelled' ? 'Queue discarded' : 'Queue archived', 'The summary is saved under recent campaigns.', 'success', 3200);
    }
  }

  function startNewCampaign() {
    if (state.activeQueue) archiveCurrentQueue('completed', false);
    goTo('compose');
    toast('New broadcast started', 'Choose recipients and craft your next message.', 'info', 2800);
  }

  function buildSendUrl(phone, message, modeOverride) {
    const encoded = encodeURIComponent(message || '');
    const mode = modeOverride === 'web' || modeOverride === 'app' ? modeOverride : effectiveSendMode();
    return mode === 'app'
      ? 'https://wa.me/' + phone + '?text=' + encoded
      : 'https://web.whatsapp.com/send?phone=' + phone + '&text=' + encoded;
  }

  /* -----------------------------------------------------------------------
     Settings, connection, and help
     ----------------------------------------------------------------------- */

  function renderSettingsView() {
    const confirmed = state.connection.confirmed;
    const mode = state.settings.sendMode;
    return ''
      + '<div class="view settings-view">'
      +   '<div class="view-head"><div><span class="eyebrow">Control room</span><h2>Settings &amp; guide.</h2>'
      +     '<p>Everything in WaFlow is local. There are no accounts, API keys, passwords, or OTP requests.</p></div>'
      +   '</div>'
      +   '<div class="settings-grid">'
      +     '<section class="panel settings-card">'
      +       '<div class="settings-card-head"><span class="settings-icon">' + icon('link') + '</span>'
      +         '<div><h3>WhatsApp connection</h3><p>Use your existing WhatsApp Business account through official handoff links.</p></div></div>'
      +       '<div class="settings-connection-status ' + (confirmed ? 'is-connected' : '') + '">'
      +         '<span class="status-orb"><span class="status-dot"></span></span>'
      +         '<div class="settings-connection-copy"><strong>' + (confirmed ? 'Ready for manual sending' : 'Readiness not confirmed') + '</strong>'
      +           '<small>' + (confirmed
      ? 'Confirmed by you · WaFlow cannot inspect or verify your WhatsApp session'
      : 'Link WhatsApp Web through its official QR flow, or use WhatsApp on this device') + '</small></div>'
      +       '</div>'
      +       '<div class="connection-details">'
      +         '<div class="connection-detail"><span>Send method</span><strong>' + esc(shortMethodLabel()) + '</strong></div>'
      +         '<div class="connection-detail"><span>Local status</span><strong>' + (confirmed ? 'Confirmed ' + formatDateShort(state.connection.confirmedAt) : 'Not confirmed') + '</strong></div>'
      +         '<div class="connection-detail"><span>Verification</span><code>USER ATTESTATION</code></div>'
      +       '</div>'
      +       '<div style="display:flex;gap:7px;margin-top:13px;flex-wrap:wrap">'
      +         '<button class="btn btn-primary btn-sm" type="button" data-action="open-connect">' + icon('qr') + (confirmed ? 'Manage connection' : 'Connect WhatsApp') + '</button>'
      +         '<a class="btn btn-sm" href="https://web.whatsapp.com" target="_blank" rel="noopener noreferrer">' + icon('external') + 'Open WhatsApp Web</a>'
      +       '</div>'
      +     '</section>'
      +     '<section class="panel settings-card">'
      +       '<div class="settings-card-head"><span class="settings-icon">' + icon('smartphone') + '</span>'
      +         '<div><h3>Link &amp; number handling</h3><p>Choose where chat links should open and which country code is used for local numbers.</p></div></div>'
      +       '<div class="method-options" role="radiogroup" aria-label="Sending method">'
      +         methodOption('auto', 'Auto-detect', 'WhatsApp Web on desktop, wa.me app links on mobile', mode === 'auto')
      +         methodOption('web', 'WhatsApp Web', 'Desktop browser · requires a linked WhatsApp Web session', mode === 'web')
      +         methodOption('app', 'WhatsApp app', 'Phone or tablet · opens wa.me app links', mode === 'app')
      +       '</div>'
      +       '<form id="countryForm" style="margin-top:15px">'
      +         '<div class="settings-field"><label for="countryCodeInput">Default country code for imports</label>'
      +           '<div class="country-field"><span>+</span><input id="countryCodeInput" name="countryCode" inputmode="numeric" maxlength="4" value="' + esc(state.settings.countryCode) + '" aria-describedby="countryHint"></div>'
      +           '<p class="settings-hint" id="countryHint">Local numbers starting with 0 are converted automatically. Existing saved contacts are unchanged.</p>'
      +         '</div>'
      +         '<button class="btn btn-sm" type="submit" style="margin-top:9px">Save default code</button>'
      +       '</form>'
      +     '</section>'
      +     '<section class="panel settings-card">'
      +       '<div class="settings-card-head"><span class="settings-icon">' + icon('send') + '</span>'
      +         '<div><h3>How a broadcast works</h3><p>Four deliberate steps. No hidden automation.</p></div></div>'
      +       '<div class="guide-steps">'
      +         guideStep('1', 'Build and opt in your audience', 'Import contacts, deduplicate numbers, and only record consent after each person agrees.')
      +         guideStep('2', 'Compose once, personalize automatically', 'Use {name} in the message. WaFlow creates a separate personalized snapshot for every recipient.')
      +         guideStep('3', 'Open each official WhatsApp chat', 'The queue opens a prefilled chat through WhatsApp Web or the WhatsApp app. You press Send.')
      +         guideStep('4', 'Confirm, skip, or record a failure', 'Dashboard sent counts are based only on your explicit confirmation. Delivery is not verified.')
      +       '</div>'
      +     '</section>'
      +     '<section class="panel settings-card">'
      +       '<div class="settings-card-head"><span class="settings-icon">' + icon('alert') + '</span>'
      +         '<div><h3>Honest limitations</h3><p>What a browser can and cannot do.</p></div></div>'
      +       '<div class="limit-list">'
      +         limitItem('Contact access depends on your browser and device. The Contact Picker API is not available everywhere; CSV and VCF always work.')
      +         limitItem('A website cannot link to WhatsApp silently, display your personal WhatsApp QR code, or verify that WhatsApp Web is linked.')
      +         limitItem('WaFlow cannot send messages in the background or bypass WhatsApp rate limits and anti-spam protections.')
      +         limitItem('For fully automated sending, delivery tracking, and scale, use the official WhatsApp Business Platform with Meta API credentials.')
      +       '</div>'
      +     '</section>'
      +     '<section class="panel settings-card">'
      +       '<div class="settings-card-head"><span class="settings-icon">' + icon('shield') + '</span>'
      +         '<div><h3>Privacy &amp; local data</h3><p>Contacts, consent flags, drafts, and queue state are stored in this browser only.</p></div></div>'
      +       '<div class="callout callout-green">' + icon('shield')
      +         '<p>No server receives your data. No WhatsApp password, QR token, or OTP is requested or stored. Clearing browser storage removes your local workspace.</p></div>'
      +       '<div style="display:flex;gap:7px;margin-top:13px;flex-wrap:wrap">'
      +         '<button class="btn btn-sm" type="button" data-action="install-app">' + icon('install') + 'Install app</button>'
      +         '<button class="btn btn-sm btn-danger" type="button" data-action="clear-data">' + icon('trash') + 'Clear local data</button>'
      +       '</div>'
      +     '</section>'
      +   '</div>'
      +   '<div class="app-meta"><span>' + icon('shield') + 'WaFlow · local-first broadcast workspace</span><span>No API key · no credentials · no simulated delivery</span></div>'
      + '</div>';
  }

  function methodOption(value, title, detail, checked) {
    return '<label class="method-option"><input type="radio" name="sendMode" value="' + value + '" ' + (checked ? 'checked' : '') + '>'
      + '<span class="radio-dot"></span><span class="method-option-copy"><strong>' + esc(title) + '</strong><small>' + esc(detail) + '</small></span>'
      + (value === 'auto' ? '<span class="badge badge-green">Recommended</span>' : '') + '</label>';
  }

  function guideStep(number, title, detail) {
    return '<div class="guide-step"><span class="guide-step-number">' + number + '</span>'
      + '<div class="guide-step-copy"><strong>' + esc(title) + '</strong><p>' + esc(detail) + '</p></div></div>';
  }

  function limitItem(text) {
    return '<div class="limit-item">' + icon('info') + '<span>' + esc(text) + '</span></div>';
  }

  function openConnectDialog() {
    const confirmed = state.connection.confirmed;
    if (confirmed) {
      const body = ''
        + '<div class="callout callout-green">' + icon('check-circle')
        + '<p><strong>Manual sending is ready.</strong> You confirmed that WhatsApp Web is linked or WhatsApp is available on this device. WaFlow stores only this local readiness flag.</p></div>'
        + '<div class="connection-details" style="margin-top:14px">'
        +   '<div class="connection-detail"><span>Status</span><strong>Ready (manual)</strong></div>'
        +   '<div class="connection-detail"><span>Send method</span><strong>' + esc(shortMethodLabel()) + '</strong></div>'
        +   '<div class="connection-detail"><span>Confirmed</span><strong>' + formatDateTime(state.connection.confirmedAt) + '</strong></div>'
        +   '<div class="connection-detail"><span>Verification</span><code>LOCAL ATTESTATION ONLY</code></div>'
        + '</div>'
        + '<div class="callout" style="margin-top:13px">' + icon('info')
        + '<p>WaFlow cannot inspect your WhatsApp session, detect whether WhatsApp Web is still linked, or verify message delivery. Opening a chat may still require you to sign in or rescan a QR code in WhatsApp.</p></div>';
      openDialog({
        kicker: 'WhatsApp readiness',
        title: 'Ready for manual sending',
        body: body,
        footer: '<button class="btn btn-ghost" type="button" data-action="reset-connection">Reset local status</button>'
          + '<a class="btn" href="https://web.whatsapp.com" target="_blank" rel="noopener noreferrer">' + icon('external') + 'Open WhatsApp Web</a>'
          + '<button class="btn btn-primary" type="button" data-action="close-dialog">Done</button>'
      });
      return;
    }

    const confirmText = effectiveSendMode() === 'app' ? 'WhatsApp is ready on this device' : 'I’ve linked WhatsApp Web';
    const body = ''
      + '<p class="dialog-intro">Use your existing WhatsApp Business account without a Meta API key. WhatsApp does not allow this website to link directly to your account; the official link happens inside <strong>WhatsApp Web</strong>.</p>'
      + '<div class="connect-steps">'
      +   '<div class="connect-step"><span class="connect-step-number">1</span><div class="connect-step-copy"><strong>Open WhatsApp Web</strong><p>Use a desktop browser. On your phone, open WhatsApp and go to Settings → Linked devices → Link a device.</p></div></div>'
      +   '<div class="connect-step"><span class="connect-step-number">2</span><div class="connect-step-copy"><strong>Scan the official QR code</strong><p>WhatsApp Web displays a session-specific QR code. WaFlow does not generate, read, or store it.</p></div></div>'
      +   '<div class="connect-step"><span class="connect-step-number">3</span><div class="connect-step-copy"><strong>Return and confirm readiness</strong><p>Once your chat list appears, come back and confirm. This is a local readiness note, not a verified API connection.</p></div></div>'
      + '</div>'
      + '<div class="connect-qr"><span class="connect-qr-icon">' + icon('qr') + '</span>'
      +   '<div class="connect-qr-copy"><strong>Your QR stays inside WhatsApp</strong><p>No password, OTP, QR token, or session cookie is requested by WaFlow. Never share those with any third-party app.</p></div></div>'
      + '<div class="callout callout-amber" style="margin-top:13px">' + icon('shield')
      + '<p><strong>What “connect” means here:</strong> WhatsApp opens through its own official interface. WaFlow prepares links and tracks your confirmations; it cannot send, verify, or automate messages.</p></div>';
    openDialog({
      kicker: 'Official handoff',
      title: 'Connect your WhatsApp',
      body: body,
      footer: '<button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button>'
        + '<a class="btn" href="https://web.whatsapp.com" target="_blank" rel="noopener noreferrer">' + icon('external') + 'Open WhatsApp Web</a>'
        + '<button class="btn btn-primary" type="button" data-action="confirm-connection">' + icon('check') + esc(confirmText) + '</button>',
      size: 'dialog-wide'
    });
  }

  function confirmConnection() {
    if (!state.connection.confirmed) {
      state.connection.confirmed = true;
      state.connection.confirmedAt = Date.now();
      addActivity('connection', 'Confirmed local WhatsApp readiness for manual sending.');
    }
    closeDialog();
    persist();
    renderView();
    toast('Manual sending ready', 'WaFlow still cannot verify or control your WhatsApp session.', 'success', 5500);
  }

  function resetConnection() {
    state.connection.confirmed = false;
    state.connection.confirmedAt = null;
    addActivity('connection', 'Reset local WhatsApp readiness status.');
    closeDialog();
    persist();
    renderView();
    toast('Local status reset', 'This does not log you out of WhatsApp or unlink a device.', 'info', 4200);
  }

  function openHelpDialog() {
    const body = ''
      + '<p class="dialog-intro">WaFlow is built around a manual handoff instead of fake automation. Here is the exact workflow.</p>'
      + '<div class="guide-steps" style="margin-top:16px">'
      +   guideStep('01', 'Import and opt in', 'Bring in contacts through CSV, VCF, a supported device picker, or manual entry. Numbers are normalized and duplicates are skipped. Every import starts without consent.')
      +   guideStep('02', 'Write and preview', 'Compose plain text with emojis and {name} personalization. Review the styled preview and select up to 200 recipients.')
      +   guideStep('03', 'Open each WhatsApp chat', 'The queue opens the official WhatsApp Web or wa.me link with that recipient’s number and message pre-filled.')
      +   guideStep('04', 'Send in WhatsApp, then confirm', 'Press Send inside WhatsApp. Return to WaFlow and mark that chat as sent. Confirmed sends update the dashboard; delivery is not verified.')
      + '</div>'
      + '<div class="dialog-section"><div class="dialog-section-title">' + icon('alert') + 'Hard limits</div>'
      +   '<div class="limit-list">'
      +   limitItem('WhatsApp does not provide a no-API way for a website to send silently on your behalf.')
      +   limitItem('WaFlow cannot access your full phone contact list without browser permission, and that permission is not available on every browser.')
      +   limitItem('Sending many identical messages without consent can violate WhatsApp policies. WaFlow excludes every contact without recorded opt-in.')
      +   limitItem('For automation, delivery receipts, template messages, and higher volume, use the official WhatsApp Business Platform.')
      +   '</div></div>'
      + '<div class="callout callout-green" style="margin-top:14px">' + icon('shield')
      +   '<p>Never enter your WhatsApp password or OTP into WaFlow. This app has no field for them and never asks.</p></div>';
    openDialog({
      kicker: 'Sending guide',
      title: 'How WaFlow sends messages',
      body: body,
      footer: '<button class="btn" type="button" data-action="close-dialog">Close</button>'
        + '<button class="btn btn-primary" type="button" data-action="open-settings">' + icon('settings') + 'Open settings</button>',
      size: 'dialog-wide'
    });
  }

  async function installApp() {
    if (window.matchMedia('(display-mode: standalone)').matches) {
      toast('Already installed', 'WaFlow is already running as an installed app.', 'info', 3000);
      return;
    }
    if (ui.deferredPrompt) {
      const prompt = ui.deferredPrompt;
      ui.deferredPrompt = null;
      prompt.prompt();
      try {
        await prompt.userChoice;
      } catch (error) { /* noop */ }
      return;
    }
    openDialog({
      kicker: 'Install WaFlow',
      title: 'Keep it one tap away',
      body: '<p class="dialog-intro">WaFlow is a PWA and can run in its own window. If the install prompt is not available in this browser, use the browser menu:</p>'
        + '<div class="guide-steps" style="margin-top:15px">'
        +   guideStep('1', 'Chrome or Edge', 'Open the browser menu and choose “Install app” or “Add to Home Screen”.')
        +   guideStep('2', 'iPhone or iPad', 'Open Share and choose “Add to Home Screen”. Use Safari for the best support.')
        +   guideStep('3', 'Use HTTPS or localhost', 'Contact Picker and reliable offline support require a secure context.')
        + '</div>',
      footer: '<button class="btn btn-primary" type="button" data-action="close-dialog">Got it</button>',
      size: 'dialog-narrow'
    });
  }

  function confirmClearData() {
    confirmAction({
      kicker: 'Local data',
      title: 'Clear everything in this browser?',
      message: 'This permanently removes all imported contacts, consent flags, drafts, queues, history, and activity from this browser. It does not affect your WhatsApp account or messages already sent.',
      confirmText: 'Clear all data',
      tone: 'danger',
      onConfirm: function () {
        try { localStorage.removeItem(STORAGE_KEY); } catch (error) { /* noop */ }
        state = defaultState();
        ui.search = '';
        ui.filter = 'all';
        ui.previewContactId = null;
        ui.emojiOpen = false;
        closeDialog();
        updateChrome();
        goTo('dashboard');
        renderView();
        toast('Local data cleared', 'Your WaFlow workspace has been reset.', 'success');
      }
    });
  }

  function saveCountryCode(form) {
    const input = form.elements.countryCode;
    const digits = String(input.value || '').replace(/\D/g, '');
    if (digits.length < 1 || digits.length > 4 || digits.startsWith('0')) {
      toast('Invalid country code', 'Use 1–4 digits without the leading plus, for example 94.', 'error');
      input.focus();
      return;
    }
    state.settings.countryCode = digits;
    persist();
    renderView();
    toast('Country code saved', 'New local numbers will use +' + digits + '.', 'success');
  }

  /* -----------------------------------------------------------------------
     Contact form
     ----------------------------------------------------------------------- */

  function openContactDialog(id) {
    const editing = id ? getContactById(id) : null;
    if (id && !editing) return;
    const phoneValue = editing ? '+' + editing.phone : '';
    const body = ''
      + '<form class="contact-form" id="contactForm" novalidate>'
      +   '<input type="hidden" name="contactId" value="' + (editing ? esc(editing.id) : '') + '">'
      +   '<div class="form-field"><label for="contactNameInput">Name <span>Required</span></label>'
      +     '<input class="form-input" id="contactNameInput" name="name" type="text" maxlength="80" autocomplete="off" autofocus value="' + (editing ? esc(editing.name) : '') + '" placeholder="e.g. Amara Perera">'
      +   '</div>'
      +   '<div class="form-field"><label for="contactPhoneInput">WhatsApp number <span>International format recommended</span></label>'
      +     '<input class="form-input" id="contactPhoneInput" name="phone" type="tel" inputmode="tel" maxlength="25" autocomplete="off" value="' + esc(phoneValue) + '" placeholder="+94 76 123 4567">'
      +     '<p class="form-hint">Local numbers are normalized with your default +' + esc(state.settings.countryCode) + ' code. Duplicate numbers are rejected.</p>'
      +   '</div>'
      +   '<label class="check-row"><input type="checkbox" name="consent" ' + (editing && editing.consent ? 'checked' : '') + '>'
      +     '<span>This person has agreed to receive WhatsApp messages from me. Record consent only when it has genuinely been given.</span></label>'
      +   '<p class="form-error" id="contactFormError" role="alert"></p>'
      + '</form>';
    openDialog({
      kicker: editing ? 'Edit contact' : 'New contact',
      title: editing ? 'Update ' + editing.name : 'Add a contact',
      body: body,
      footer: '<button class="btn" type="button" data-action="close-dialog">Cancel</button>'
        + '<button class="btn btn-primary" type="submit" form="contactForm">' + icon('check') + (editing ? 'Save changes' : 'Add contact') + '</button>',
      size: 'dialog-narrow'
    });
  }

  function saveContactForm(form) {
    const data = new FormData(form);
    const id = String(data.get('contactId') || '');
    const name = cleanName(data.get('name'));
    const rawPhone = String(data.get('phone') || '');
    const phone = normalizePhone(rawPhone);
    const consent = data.get('consent') === 'on';
    const errorEl = document.getElementById('contactFormError');
    const nameInput = document.getElementById('contactNameInput');
    const phoneInput = document.getElementById('contactPhoneInput');

    if (!name) {
      if (errorEl) errorEl.textContent = 'Enter a name for this contact.';
      if (nameInput) { nameInput.classList.add('is-error'); nameInput.focus(); }
      return;
    }
    if (!phone) {
      if (errorEl) errorEl.textContent = 'Enter a valid phone number with 8–15 international digits.';
      if (phoneInput) { phoneInput.classList.add('is-error'); phoneInput.focus(); }
      return;
    }
    const duplicate = state.contacts.find(function (contact) {
      return contact.phone === phone && contact.id !== id;
    });
    if (duplicate) {
      if (errorEl) errorEl.textContent = 'That number already belongs to ' + duplicate.name + '.';
      if (phoneInput) { phoneInput.classList.add('is-error'); phoneInput.focus(); }
      return;
    }

    if (id) {
      const contact = getContactById(id);
      if (!contact) return;
      contact.name = name;
      contact.phone = phone;
      if (contact.consent !== consent) contact.consentUpdatedAt = Date.now();
      contact.consent = consent;
      toast('Contact updated', name + ' was saved locally.', 'success');
    } else {
      state.contacts.push({
        id: uid('contact'),
        name: name,
        phone: phone,
        consent: consent,
        source: 'manual',
        createdAt: Date.now(),
        consentUpdatedAt: consent ? Date.now() : null
      });
      addActivity('import', 'Added ' + name + ' to the contact library.');
      toast('Contact added', name + ' is stored in this browser.', 'success');
    }
    closeDialog();
    persist();
    renderView();
  }

  /* -----------------------------------------------------------------------
     Import flow
     ----------------------------------------------------------------------- */

  function openImportDialog(tab) {
    if (tab && ['device', 'file', 'paste'].includes(tab)) {
      ui.importTab = tab;
    } else {
      ui.importTab = contactsPickerSupported() && isMobileDevice() ? 'device' : 'file';
    }
    renderImportDialog();
  }

  function contactsPickerSupported() {
    return window.isSecureContext
      && 'contacts' in navigator
      && navigator.contacts
      && typeof navigator.contacts.select === 'function';
  }

  function renderImportDialog() {
    const tab = ui.importTab;
    const pickerSupported = contactsPickerSupported();
    const tabs = ''
      + '<div class="dialog-tabs" role="tablist" aria-label="Import source">'
      +   importTabButton('device', 'Device', tab === 'device')
      +   importTabButton('file', 'CSV / VCF', tab === 'file')
      +   importTabButton('paste', 'Paste list', tab === 'paste')
      + '</div>';

    let pane = '';
    let footer = '<button class="btn" type="button" data-action="close-dialog">Cancel</button>';

    if (tab === 'device') {
      pane = '<div class="import-pane">'
        + '<p>Choose contacts through the browser’s official contact picker. Your browser or device will ask for permission, and you decide which contacts to share.</p>'
        + (pickerSupported
          ? '<div class="callout callout-green" style="margin-top:13px">' + icon('shield')
            + '<p>Contact Picker is available in this browser. WaFlow receives only the contacts you select. It cannot read your address book in the background.</p></div>'
            + '<button class="btn btn-primary btn-block btn-lg" type="button" data-action="pick-device-contacts" style="margin-top:14px">' + icon('users') + 'Choose device contacts</button>'
            + '<p class="form-hint" style="text-align:center">Contacts are imported without opt-in. Review consent before sending.</p>'
          : '<div class="callout callout-amber" style="margin-top:13px">' + icon('alert')
            + '<p><strong>Contact Picker is not available here.</strong> It requires a compatible browser (mainly Chrome on Android) and a secure HTTPS or localhost context. Use CSV, VCF, or paste instead.</p></div>'
            + '<button class="btn btn-soft btn-block" type="button" data-action="set-import-tab" data-tab="file" style="margin-top:12px">' + icon('file') + 'Import a file instead</button>'
            + '<div class="connect-qr" style="margin-top:12px"><span class="connect-qr-icon">' + icon('smartphone') + '</span><div class="connect-qr-copy"><strong>Browser permission required</strong><p>No website can access your entire phone contact list silently. This is a platform security boundary.</p></div></div>')
        + '</div>';
      if (pickerSupported) {
        footer = '<button class="btn" type="button" data-action="close-dialog">Cancel</button>'
          + '<button class="btn btn-primary" type="button" data-action="pick-device-contacts">' + icon('users') + 'Choose contacts</button>';
      }
    } else if (tab === 'file') {
      pane = '<div class="import-pane">'
        + '<label class="dropzone" for="contactFileInput">'
        +   '<span class="dropzone-icon">' + icon('upload') + '</span>'
        +   '<strong>Drop a contact file here</strong>'
        +   '<p>or click to browse · CSV, VCF, vCard · up to 5 MB</p>'
        +   '<span class="badge">Names + phone numbers</span>'
        +   '<input type="file" id="contactFileInput" accept=".csv,.vcf,.vcard,.txt,text/csv,text/vcard,text/plain,application/vcard">'
        + '</label>'
        + '<div class="callout" style="margin-top:12px">' + icon('info')
        +   '<p><strong>CSV:</strong> use columns such as <code>Name, Phone</code>. <strong>VCF:</strong> export a vCard file from your phone or address book. Numbers without a country code use +' + esc(state.settings.countryCode) + '.</p></div>'
        + '<div class="import-consent">' + icon('shield')
        +   '<p><strong>Consent is not assumed.</strong> Every imported contact starts at “Needs opt-in” and is excluded from sending until you record consent.</p></div>'
        + '</div>';
    } else {
      pane = '<div class="import-pane">'
        + '<p>Paste one contact per line. CSV-style lines, tabs, or plain number lists are accepted.</p>'
        + '<textarea class="paste-field" id="pasteContactsInput" placeholder="Amara Perera, +94 76 123 4567&#10;Nimal, 077 234 5678&#10;+94 71 555 0199" aria-label="Contacts to paste"></textarea>'
        + '<div class="callout" style="margin-top:11px">' + icon('info')
        +   '<p>Example: <code>Name, Phone</code> per line. A header row is skipped automatically. Local numbers starting with 0 use +' + esc(state.settings.countryCode) + '.</p></div>'
        + '<div class="import-consent">' + icon('shield')
        +   '<p><strong>Consent is not assumed.</strong> Pasted contacts start without opt-in.</p></div>'
        + '</div>';
      footer = '<button class="btn" type="button" data-action="close-dialog">Cancel</button>'
        + '<button class="btn btn-primary" type="button" data-action="import-paste">' + icon('upload') + 'Import contacts</button>';
    }

    openDialog({
      kicker: 'Add audience',
      title: 'Import contacts',
      body: tabs + pane,
      footer: footer,
      size: 'dialog-wide'
    });
  }

  function importTabButton(tab, label, active) {
    return '<button type="button" class="dialog-tab ' + (active ? 'active' : '') + '" data-action="set-import-tab" data-tab="' + tab + '" role="tab" aria-selected="' + active + '">' + esc(label) + '</button>';
  }

  async function pickDeviceContacts() {
    if (!contactsPickerSupported()) {
      toast('Contact Picker unavailable', 'Use CSV, VCF, or paste instead. The device picker needs a supported browser and a secure context.', 'warning', 5600);
      return;
    }
    try {
      const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
      if (!picked || !picked.length) return;
      const entries = [];
      picked.forEach(function (entry) {
        const names = Array.isArray(entry.name) ? entry.name : [entry.name];
        const name = names.filter(Boolean).join(' ').trim();
        const phones = Array.isArray(entry.tel) ? entry.tel : [entry.tel];
        phones.filter(Boolean).forEach(function (phone) {
          entries.push({ name: name, phone: phone });
        });
      });
      if (!entries.length) {
        showImportResult({ added: 0, duplicates: 0, invalid: 0, source: 'device' });
        return;
      }
      const result = importRawEntries(entries, 'device');
      showImportResult(result);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      const message = error && error.name === 'NotAllowedError'
        ? 'Contact access was denied. You can allow it in the browser prompt or use CSV/VCF import.'
        : 'The contact picker could not open in this browser. Use CSV, VCF, or paste instead.';
      toast('Device import unavailable', message, 'error', 6200);
    }
  }

  function importPastedContacts() {
    const field = document.getElementById('pasteContactsInput');
    if (!field) return;
    const text = field.value.trim();
    if (!text) {
      toast('Nothing to import', 'Paste at least one contact first.', 'warning');
      field.focus();
      return;
    }
    const entries = parsePastedText(text);
    if (!entries.length) {
      toast('No contacts found', 'Use “Name, Phone” per line or one phone number per line.', 'warning', 4500);
      return;
    }
    showImportResult(importRawEntries(entries, 'paste'));
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('File is too large', 'Keep contact files under 5 MB.', 'error');
      return;
    }
    try {
      const text = await readFileText(file);
      if (!text.trim()) {
        toast('File is empty', 'Choose a CSV or VCF file that contains contacts.', 'warning');
        return;
      }
      const isVcf = /\.(vcf|vcard)$/i.test(file.name) || /BEGIN:VCARD/i.test(text);
      const entries = isVcf ? parseVcf(text) : parseCsv(text);
      const source = isVcf ? 'vcf' : 'csv';
      if (!entries.length) {
        toast('No contacts found', 'Check that the file has names and phone numbers.', 'warning', 5000);
        showImportResult({ added: 0, duplicates: 0, invalid: 0, source: source });
        return;
      }
      showImportResult(importRawEntries(entries, source));
    } catch (error) {
      toast('Could not read file', 'Use a plain CSV or vCard text export and try again.', 'error', 5000);
    }
  }

  function importRawEntries(entries, source) {
    const existing = new Set(state.contacts.map(function (contact) { return contact.phone; }));
    const result = { added: 0, duplicates: 0, invalid: 0, source: source };
    const now = Date.now();
    entries.forEach(function (entry, index) {
      const phone = normalizePhone(entry && entry.phone);
      if (!phone) {
        result.invalid += 1;
        return;
      }
      if (existing.has(phone)) {
        result.duplicates += 1;
        return;
      }
      existing.add(phone);
      const name = cleanName(entry.name) || prettyPhone(phone);
      state.contacts.push({
        id: uid('contact'),
        name: name,
        phone: phone,
        consent: false,
        source: SOURCE_LABELS[source] ? source : 'manual',
        createdAt: now + index,
        consentUpdatedAt: null
      });
      result.added += 1;
    });

    if (result.added) {
      addActivity('import', 'Imported ' + result.added + ' contact' + (result.added === 1 ? '' : 's') + ' from ' + (SOURCE_LABELS[source] || 'a local source') + '.');
      saveNow();
      updateChrome();
      renderView();
    }
    return result;
  }

  function showImportResult(result) {
    const added = result.added;
    const title = added ? 'Import complete' : 'Nothing new imported';
    const detail = added
      ? 'The new contacts are now in your local library and start with “Needs opt-in”.'
      : 'No new numbers were added. Existing contacts and invalid numbers were left untouched.';
    const body = ''
      + '<div class="empty-illustration" style="margin:0 auto 16px;width:58px;height:58px">' + icon(added ? 'check-circle' : 'info') + '</div>'
      + '<p class="dialog-intro" style="text-align:center">' + esc(detail) + '</p>'
      + '<div class="import-result">'
      +   '<div><strong style="color:var(--green-bright)">' + added + '</strong><small>Added</small></div>'
      +   '<div><strong>' + result.duplicates + '</strong><small>Duplicates skipped</small></div>'
      +   '<div><strong style="color:' + (result.invalid ? 'var(--amber)' : 'var(--text)') + '">' + result.invalid + '</strong><small>Invalid numbers</small></div>'
      + '</div>'
      + (added
        ? '<div class="import-consent" style="margin-top:13px">' + icon('shield')
          + '<p><strong>Next step:</strong> confirm only the people who genuinely agreed. Select the new contacts, then use “Mark opted in”.</p></div>'
        : '')
      + '<p class="form-hint" style="margin-top:12px">Source: ' + esc(SOURCE_LABELS[result.source] || 'Local import') + ' · Saved in this browser only.</p>';
    openDialog({
      kicker: 'Local import',
      title: title,
      body: body,
      footer: added
        ? '<button class="btn" type="button" data-action="close-dialog">Close</button>'
          + '<button class="btn btn-primary" type="button" data-action="review-imported">' + icon('users') + 'Review contacts</button>'
        : '<button class="btn" type="button" data-action="set-import-tab" data-tab="file">Try another file</button>'
          + '<button class="btn btn-primary" type="button" data-action="close-dialog">Close</button>',
      size: 'dialog-narrow'
    });
  }

  function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('File read failed')); };
      reader.readAsText(file);
    });
  }

  function parseCsv(text) {
    const rows = parseDelimitedRows(String(text || '').replace(/^\uFEFF/, ''));
    if (!rows.length) return [];
    const header = rows[0].map(normalizeHeader);
    const headerAliases = [
      'name', 'full name', 'display name', 'first name', 'last name', 'contact name',
      'phone', 'phone number', 'mobile', 'mobile number', 'whatsapp', 'whatsapp number',
      'telephone', 'tel', 'number', 'contact'
    ];
    const hasHeader = header.some(function (cell) { return headerAliases.includes(cell); });
    const findIndex = function (patterns) {
      return header.findIndex(function (cell) {
        return patterns.some(function (pattern) { return pattern.test(cell); });
      });
    };

    let nameIndex = findIndex([/^(full name|display name|contact name|name)$/]);
    let firstIndex = findIndex([/^first name$/]);
    let lastIndex = findIndex([/^last name$/]);
    let phoneIndex = findIndex([/(phone|mobile|whatsapp|telephone|tel|number)/]);
    let start = hasHeader ? 1 : 0;

    if (phoneIndex >= 0 && nameIndex < 0 && firstIndex < 0 && lastIndex < 0) {
      const fallbackName = header.findIndex(function (cell) {
        return cell.includes('name') && !cell.includes('user');
      });
      if (fallbackName >= 0 && fallbackName !== phoneIndex) nameIndex = fallbackName;
    }
    if (!hasHeader) {
      if ((rows[0] || []).length >= 2) {
        nameIndex = 0;
        phoneIndex = 1;
      } else {
        nameIndex = -1;
        phoneIndex = 0;
      }
      start = 0;
    } else if (phoneIndex < 0) {
      return [];
    }

    const entries = [];
    for (let i = start; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row || !row.some(function (cell) { return String(cell).trim(); })) continue;
      let name = '';
      if (nameIndex >= 0) name = row[nameIndex] || '';
      if (!name && firstIndex >= 0 && lastIndex >= 0) {
        name = [row[firstIndex], row[lastIndex]].filter(Boolean).join(' ');
      } else if (!name && firstIndex >= 0) {
        name = row[firstIndex] || '';
      } else if (!name && lastIndex >= 0) {
        name = row[lastIndex] || '';
      }
      entries.push({
        name: collapseSpaces(String(name || '')),
        phone: String(row[phoneIndex] || '').trim()
      });
    }
    return entries.filter(function (entry) { return entry.phone || entry.name; });
  }

  function parseDelimitedRows(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        row.push(field);
        field = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i += 1;
        row.push(field);
        if (row.some(function (cell) { return String(cell).trim() !== ''; })) rows.push(row);
        row = [];
        field = '';
      } else {
        field += char;
      }
    }
    row.push(field);
    if (row.some(function (cell) { return String(cell).trim() !== ''; })) rows.push(row);
    return rows;
  }

  function normalizeHeader(value) {
    return String(value || '').trim().toLowerCase().replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ');
  }

  function parseVcf(text) {
    const cards = String(text || '').split(/BEGIN:VCARD/i).slice(1);
    const entries = [];
    cards.forEach(function (rawCard) {
      const card = rawCard.split(/END:VCARD/i)[0].replace(/\r/g, '').replace(/\n[ \t]/g, '');
      const lines = card.split('\n');
      let fullName = '';
      let structuredName = '';
      const phones = [];
      lines.forEach(function (line) {
        const colon = line.indexOf(':');
        if (colon < 0) return;
        const rawKey = line.slice(0, colon).toUpperCase();
        const value = line.slice(colon + 1).trim();
        if (rawKey === 'FN' || rawKey.endsWith('.FN')) {
          fullName = decodeVCardValue(value);
        } else if ((rawKey === 'N' || rawKey.endsWith('.N')) && !structuredName) {
          const parts = value.split(';').map(decodeVCardValue);
          const family = parts[0] || '';
          const given = parts[1] || '';
          structuredName = collapseSpaces((given + ' ' + family).trim());
        } else if (rawKey === 'TEL' || rawKey.startsWith('TEL;') || rawKey.endsWith('.TEL') || rawKey.includes('.TEL;')) {
          const phone = decodeVCardValue(value).replace(/^tel:/i, '');
          if (phone) phones.push(phone);
        }
      });
      const name = collapseSpaces(fullName) || structuredName;
      phones.forEach(function (phone) {
        entries.push({ name: name, phone: phone });
      });
    });
    return entries;
  }

  function decodeVCardValue(value) {
    return String(value || '')
      .replace(/\\n/gi, ' ')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  function parsePastedText(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const entries = [];
    lines.forEach(function (line, index) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      if (index === 0 && /name/i.test(trimmed) && /(phone|mobile|number|whatsapp)/i.test(trimmed) && !/\d{5,}/.test(trimmed)) return;

      let parts;
      if (trimmed.includes('\t')) {
        parts = trimmed.split('\t').map(function (part) { return part.trim(); });
      } else if (trimmed.includes(',')) {
        const parsed = parseDelimitedRows(trimmed);
        parts = (parsed[0] || []).map(function (part) { return part.trim(); });
      } else if (trimmed.includes(';')) {
        parts = trimmed.split(';').map(function (part) { return part.trim(); });
      } else {
        const match = trimmed.match(/(\+?\d[\d\s().-]{6,}\d)/);
        if (match) {
          entries.push({ name: collapseSpaces(trimmed.replace(match[0], '').replace(/[,;]+$/, '').trim()), phone: match[1] });
        }
        return;
      }

      parts = parts.filter(function (part, partIndex) { return partIndex < 2 || part; });
      if (!parts.length) return;
      if (parts.length === 1) {
        entries.push({ name: '', phone: parts[0] });
        return;
      }
      let name = parts[0];
      let phone = parts[1];
      if (looksLikePhone(name) && !looksLikePhone(phone)) {
        const swap = name;
        name = phone;
        phone = swap;
      }
      entries.push({ name: collapseSpaces(name), phone: phone });
    });
    return entries;
  }

  function looksLikePhone(value) {
    return String(value || '').replace(/\D/g, '').length >= 7;
  }

  /* -----------------------------------------------------------------------
     Dialog, toast, and shared utilities
     ----------------------------------------------------------------------- */

  function openDialog(config) {
    if (!dialog) dialog = document.getElementById('appDialog');
    const title = document.getElementById('dialogTitle');
    const kicker = document.getElementById('dialogKicker');
    const body = document.getElementById('dialogBody');
    const footer = document.getElementById('dialogFooter');
    if (!dialog || !title || !kicker || !body || !footer) return;

    title.textContent = config.title || 'WaFlow';
    kicker.textContent = config.kicker || 'WaFlow';
    body.innerHTML = config.body || '';
    body.scrollTop = 0;
    footer.innerHTML = config.footer || '';
    footer.hidden = !config.footer;
    dialog.classList.remove('dialog-wide', 'dialog-narrow');
    if (config.size === 'dialog-wide') dialog.classList.add('dialog-wide');
    if (config.size === 'dialog-narrow') dialog.classList.add('dialog-narrow');
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog() {
    if (dialog && dialog.open) dialog.close();
  }

  function confirmAction(options) {
    const tone = options.tone === 'danger' ? 'danger' : 'primary';
    const body = '<p class="dialog-intro">' + esc(options.message).replace(/\n/g, '<br>') + '</p>';
    ui.pendingConfirm = typeof options.onConfirm === 'function' ? options.onConfirm : null;
    openDialog({
      kicker: options.kicker || 'Please confirm',
      title: options.title || 'Are you sure?',
      body: body,
      footer: '<button class="btn" type="button" data-action="close-dialog">Cancel</button>'
        + '<button class="btn btn-' + tone + '" type="button" data-action="confirm-pending">' + esc(options.confirmText || 'Continue') + '</button>',
      size: 'dialog-narrow'
    });
  }

  function runPendingConfirm() {
    const callback = ui.pendingConfirm;
    ui.pendingConfirm = null;
    closeDialog();
    if (callback) {
      window.setTimeout(callback, 50);
    }
  }

  function toast(title, message, type, duration) {
    const container = document.getElementById('toasts');
    if (!container) return;
    const variant = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'success';
    const iconName = variant === 'error' ? 'alert'
      : variant === 'warning' ? 'alert'
        : variant === 'info' ? 'info'
          : 'check-circle';
    while (container.children.length >= 3) container.removeChild(container.firstElementChild);
    const node = document.createElement('div');
    node.className = 'toast is-' + variant;
    node.innerHTML = '<span class="toast-icon">' + icon(iconName) + '</span>'
      + '<div class="toast-copy"><strong></strong><p></p></div>'
      + '<button class="toast-close" type="button" aria-label="Dismiss">' + icon('x') + '</button>';
    node.querySelector('strong').textContent = title || '';
    const paragraph = node.querySelector('p');
    if (message) {
      paragraph.textContent = message;
    } else {
      paragraph.remove();
    }
    const close = function () {
      if (!node.isConnected || node.classList.contains('is-leaving')) return;
      node.classList.add('is-leaving');
      window.setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 190);
    };
    node.querySelector('.toast-close').addEventListener('click', close);
    container.appendChild(node);
    window.setTimeout(close, Math.max(2200, Number(duration) || 3800));
  }

  function addActivity(type, text) {
    state.activity.unshift({
      type: ACTIVITY_META[type] ? type : 'import',
      text: String(text || '').slice(0, 400),
      at: Date.now()
    });
    state.activity = state.activity.slice(0, 40);
  }

  function flushSave() {
    if (!ui.saveTimer) return;
    clearTimeout(ui.saveTimer);
    ui.saveTimer = null;
    saveNow();
  }

  function icon(name) {
    return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }

  function avatar(name, extraClass) {
    const key = String(name || '?');
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    const palette = AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
    return '<div class="avatar ' + (extraClass || '') + '" style="--avatar-bg:' + palette.bg + ';--avatar-ink:' + palette.ink + '" aria-hidden="true">' + esc(initials(key)) + '</div>';
  }

  function firstNameOrPhone(name) {
    const value = String(name || '').trim();
    const first = value.split(/\s+/)[0] || '';
    return /\p{L}/u.test(first) ? first : (value || 'The next contact');
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const words = parts
      .map(function (part) { return Array.from(part).filter(function (character) { return /\p{L}/u.test(character); }).join(''); })
      .filter(Boolean);
    if (!words.length) {
      const digits = String(name).replace(/\D/g, '');
      return digits.slice(-2) || '#';
    }
    const first = Array.from(words[0])[0] || '';
    const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] || '') : '';
    return (first + last).toUpperCase();
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function cleanName(value) {
    return collapseSpaces(String(value == null ? '' : value)
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim())
      .slice(0, 80);
  }

  function collapseSpaces(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizePhone(raw, countryOverride) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) return null;
    const explicitPlus = /^\s*\+/.test(value);
    let digits = value.replace(/\D/g, '');
    if (!digits) return null;
    const countryCode = String(countryOverride || (state && state.settings.countryCode) || '94').replace(/\D/g, '') || '94';

    if (!explicitPlus) {
      if (digits.startsWith('00')) {
        digits = digits.slice(2);
      } else if (digits.startsWith('0')) {
        digits = countryCode + digits.replace(/^0+/, '');
      } else if (!digits.startsWith(countryCode) && digits.length <= 10) {
        digits = countryCode + digits;
      }
    }

    if (digits.startsWith('0')) return null;
    if (digits.length < 8 || digits.length > 15) return null;
    return digits;
  }

  function prettyPhone(phone, countryOverride) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    const countryCode = String(countryOverride || (state && state.settings.countryCode) || '94').replace(/\D/g, '') || '94';
    if (digits.startsWith(countryCode) && digits.length > countryCode.length) {
      const rest = digits.slice(countryCode.length);
      if (countryCode === '94' && rest.length === 9) {
        return '+94 ' + rest.slice(0, 2) + ' ' + rest.slice(2, 5) + ' ' + rest.slice(5);
      }
      return '+' + countryCode + ' ' + rest.replace(/(\d{3})(?=\d)/g, '$1 ').trim();
    }
    return '+' + digits;
  }

  function effectiveSendMode() {
    if (!state) return 'web';
    if (state.settings.sendMode === 'web' || state.settings.sendMode === 'app') return state.settings.sendMode;
    return isMobileDevice() ? 'app' : 'web';
  }

  function isMobileDevice() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  }

  function methodLabel() {
    if (state.settings.sendMode === 'web') return 'Chat links will open in WhatsApp Web.';
    if (state.settings.sendMode === 'app') return 'Chat links will open through the WhatsApp app.';
    return 'Auto mode: WhatsApp Web on desktop, WhatsApp app on mobile.';
  }

  function shortMethodLabel(modeOverride) {
    const mode = modeOverride === 'web' || modeOverride === 'app' ? modeOverride : effectiveSendMode();
    return mode === 'app' ? 'WhatsApp app (wa.me)' : 'WhatsApp Web';
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return 'Not recorded';
    try {
      return new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(timestamp));
    } catch (error) {
      return new Date(timestamp).toLocaleString();
    }
  }

  function formatDateShort(timestamp) {
    if (!timestamp) return '—';
    try {
      return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(new Date(timestamp));
    } catch (error) {
      return new Date(timestamp).toLocaleDateString();
    }
  }

  function relativeTime(timestamp) {
    const diff = Math.max(0, Date.now() - Number(timestamp));
    if (diff < 60000) return 'Just now';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return formatDateShort(timestamp);
  }

  function uid(prefix) {
    const random = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return prefix + '_' + random.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36);
  }

  function copyText(text) {
    const value = String(text || '');
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value);
    }
    return new Promise(function (resolve, reject) {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (error) { ok = false; }
      document.body.removeChild(area);
      if (ok) resolve();
      else reject(new Error('Copy unavailable'));
    });
  }

  /* End of WaFlow application */
}());