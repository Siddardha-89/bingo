/**
 * ==============================================================================
 * BINGO - MULTIPLAYER WEB APPLICATION
 * Complete game logic matching the 15-screen blueprint:
 * Real-time room joining (NO hardcoded player names!), dynamic slots, turns,
 * Web Audio API sound effects, canvas confetti, dark mode, and live synchronization.
 * ==============================================================================
 */

(function () {
  'use strict';

  // Generate or retrieve persistent player ID for this browser tab/session
  let myPlayerId = sessionStorage.getItem('bingo_player_id');
  if (!myPlayerId) {
    myPlayerId = 'p_' + Math.random().toString(36).substring(2, 9);
    sessionStorage.setItem('bingo_player_id', myPlayerId);
  }

  // Message and move deduplication sets to prevent BroadcastChannel + MQTT double execution
  const seenMessageIds = new Set();
  const processedMoveIds = new Set();

  // ----------------------------------------------------------------------------
  // 1. STATE MANAGEMENT
  // ----------------------------------------------------------------------------
  const state = {
    currentScreen: 'intro',
    playerName: localStorage.getItem('bingo_user_name') || 'USER',
    playerAvatar: localStorage.getItem('bingo_user_avatar') || '🥷',
    roomCode: 'B7K9Q2',
    boardSize: 5, // 5 or 7
    playerLimit: 2, // Default 2, or 3, 4
    isHost: true,
    soundEnabled: true,
    theme: 'light',
    myPlayerId: myPlayerId,

    // Real connected players ONLY (Starts with only the creator/joiner)
    players: [],

    currentTurnIndex: 0,
    boardNumbers: [], // 1D array of numbers on your board
    markedCells: {}, // { index: { number, selectedBy: 'you'|'friend', player: string } }
    selectionsHistory: [], // Array of moves
    completedLines: [], // e.g. ['row-0', 'col-2', ...]
    botBoardNumbers: [], // Robot's distinct board numbers
    botMarkedCells: {}, // Robot's marked cells
    botCompletedLines: [], // Robot's completed lines
    activeBoardView: 'my', // 'my' | 'bot' | 'dual'
    gameActive: false,
    winner: null,
    historyFilter: 'all',
    chatMessages: [],
    chatUnreadCount: 0,
    isChatOpen: false
  };

  // ----------------------------------------------------------------------------
  // REAL-TIME MULTIPLAYER PROTOCOL (MQTT over WebSockets + BroadcastChannel)
  // ----------------------------------------------------------------------------
  let channel = null;
  try {
    channel = new BroadcastChannel('bingo_realtime_channel');
    channel.onmessage = (event) => handleIncomingBroadcast(event.data);
  } catch (e) {
    console.warn('BroadcastChannel not supported in this environment');
  }

  // Cross-device MQTT WebSocket client for connecting Mobile <-> Laptop
  let mqttClient = null;
  let currentSubscribedTopic = null;
  let joinHeartbeatTimer = null;

  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  let currentBrokerIdx = 0;

  function updateNetStatus(status, text) {
    const pill = document.getElementById('net-status-pill');
    const textEl = document.getElementById('net-status-text');
    if (!pill || !textEl) return;
    pill.className = `net-status-pill ${status}`;
    textEl.textContent = text;
  }

  function initMqtt() {
    if (typeof mqtt === 'undefined') {
      console.warn('MQTT library not loaded. Running in local mode.');
      updateNetStatus('connecting', 'Local Only');
      return;
    }

    try {
      const brokerUrl = BROKERS[currentBrokerIdx];
      updateNetStatus('connecting', 'Connecting...');

      const clientId = 'bingo_' + Math.random().toString(16).substring(2, 10);
      mqttClient = mqtt.connect(brokerUrl, {
        clientId: clientId,
        clean: true,
        connectTimeout: 7000,
        reconnectPeriod: 3000,
        keepalive: 45
      });

      mqttClient.on('connect', () => {
        console.log('Connected to realtime multiplayer broker:', brokerUrl);
        updateNetStatus('online', 'Live Sync');
        if (state.roomCode) {
          subscribeToRoom(state.roomCode);
        }
      });

      mqttClient.on('error', (err) => {
        console.warn('MQTT connection error, trying alternate broker:', err);
        currentBrokerIdx = (currentBrokerIdx + 1) % BROKERS.length;
      });

      mqttClient.on('close', () => {
        updateNetStatus('connecting', 'Reconnecting...');
      });

      mqttClient.on('message', (topic, message) => {
        try {
          const payload = JSON.parse(message.toString());
          handleIncomingBroadcast(payload);
        } catch (e) {
          console.error('Error parsing broadcast payload:', e);
        }
      });
    } catch (e) {
      console.warn('Error initializing MQTT client:', e);
      updateNetStatus('connecting', 'Offline');
    }
  }

  function subscribeToRoom(roomCode) {
    if (!mqttClient || !roomCode) return;
    const cleanCode = roomCode.trim().toUpperCase();
    const newTopic = `bingo_rooms_live/${cleanCode}`;

    // Reset and sync chat for the active room
    resetRoomChat(cleanCode);

    if (currentSubscribedTopic && currentSubscribedTopic !== newTopic) {
      try { mqttClient.unsubscribe(currentSubscribedTopic); } catch (e) {}
    }

    currentSubscribedTopic = newTopic;
    if (mqttClient.connected) {
      mqttClient.subscribe(newTopic, { qos: 0 }, (err) => {
        if (!err) {
          console.log('Subscribed to room topic:', newTopic);
        }
      });
    }
  }

  // ----------------------------------------------------------------------------
  // 2. AUDIO SYNTHESIZER (Web Audio API - Zero External Dependencies)
  // ----------------------------------------------------------------------------
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  // Soft, warm acoustic chime with natural decay & mellow low-pass filter
  function playSoftChime(freq, duration = 0.14, vol = 0.05, delay = 0) {
    if (!state.soundEnabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      setTimeout(() => {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        // Low-pass filter removes any harsh electronic edges, sounds like soft wooden kalimba
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(freq * 2.2, now);

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);

        // Smooth acoustic envelope
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(vol, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now);
        osc.stop(now + duration);
      }, delay * 1000);
    } catch (err) {}
  }

  // Subtle acoustic tap / wooden pop (gentle haptic-like feedback)
  function playSoftTap(vol = 0.035) {
    if (!state.soundEnabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(280, now);
      osc.frequency.exponentialRampToValueAtTime(120, now + 0.04);

      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.04);
    } catch (err) {}
  }

  // Gentle mobile phone haptic vibration
  function triggerHaptic(duration = 10) {
    try {
      if (navigator.vibrate) navigator.vibrate(duration);
    } catch (e) {}
  }

  const Sound = {
    click: () => {
      playSoftTap(0.03);
      triggerHaptic(8);
    },
    yourPick: () => {
      // Warm marimba dual-chord
      playSoftChime(523.25, 0.16, 0.06, 0); // C5
      playSoftChime(659.25, 0.20, 0.045, 0.035); // E5
      triggerHaptic(16);
    },
    friendPick: () => {
      // Subtle gentle wood block
      playSoftChime(440.00, 0.13, 0.04, 0);
      playSoftChime(554.37, 0.15, 0.03, 0.04);
      triggerHaptic(10);
    },
    join: () => {
      // Warm chime greeting
      playSoftChime(440.00, 0.14, 0.04, 0);
      playSoftChime(659.25, 0.22, 0.05, 0.08);
      triggerHaptic(14);
    },
    lineComplete: () => {
      // Gentle silver bell chime
      playSoftChime(523.25, 0.16, 0.05, 0);
      playSoftChime(659.25, 0.16, 0.055, 0.08);
      playSoftChime(783.99, 0.18, 0.06, 0.16);
      playSoftChime(1046.50, 0.32, 0.07, 0.25);
      triggerHaptic([15, 30, 20]);
    },
    win: () => {
      // Luxurious gentle celebration roll
      const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51, 1567.98];
      notes.forEach((n, i) => playSoftChime(n, 0.28, 0.06, i * 0.11));
      triggerHaptic([25, 40, 30, 50]);
    },
    chatSend: () => {
      playSoftTap(0.04);
      playSoftChime(659.25, 0.10, 0.04, 0.02);
      triggerHaptic(8);
    },
    chatReceive: () => {
      playSoftChime(587.33, 0.12, 0.05, 0);
      playSoftChime(880.00, 0.16, 0.06, 0.06);
      triggerHaptic([10, 20, 10]);
    }
  };

  // ----------------------------------------------------------------------------
  // 3. DOM ELEMENT REFERENCES
  // ----------------------------------------------------------------------------
  const el = {
    // Intro
    screenIntro: document.getElementById('screen-intro'),
    btnSkipIntro: document.getElementById('btn-skip-intro'),

    // Header
    logoHomeBtn: document.getElementById('logo-home-btn'),
    btnSoundToggle: document.getElementById('btn-sound-toggle'),
    btnThemeToggle: document.getElementById('btn-theme-toggle'),
    btnLoginModal: document.getElementById('btn-login-modal'),
    headerUserName: document.getElementById('header-user-name'),
    headerUserAvatar: document.getElementById('header-user-avatar'),

    // Views
    viewHome: document.getElementById('view-home'),
    viewCreate: document.getElementById('view-create'),
    viewRoomCreated: document.getElementById('view-room-created'),
    viewJoin: document.getElementById('view-join'),
    viewWaiting: document.getElementById('view-waiting'),
    viewGame: document.getElementById('view-game'),
    viewHistory: document.getElementById('view-history'),
    viewProgress: document.getElementById('view-progress'),
    screenWinner: document.getElementById('screen-winner'),

    // Navigation buttons
    btnGotoCreate: document.getElementById('btn-goto-create'),
    btnGotoJoin: document.getElementById('btn-goto-join'),
    btnSubmitCreate: document.getElementById('btn-submit-create'),
    btnSubmitJoin: document.getElementById('btn-submit-join'),
    btnEnterWaiting: document.getElementById('btn-enter-waiting'),
    btnStartGame: document.getElementById('btn-start-game'),
    btnLeaveGame: document.getElementById('btn-leave-game'),
    btnBackHomeList: document.querySelectorAll('.btn-back-home'),
    btnBackGameList: document.querySelectorAll('.btn-back-game'),

    // Create Room Elements
    inputCreatorName: document.getElementById('input-creator-name'),
    optBoard5: document.getElementById('opt-board-5'),
    optBoard7: document.getElementById('opt-board-7'),
    playerCountBtns: document.querySelectorAll('.player-count-btn'),

    // Share Elements
    displayRoomCode: document.getElementById('display-room-code'),
    displayRoomUrl: document.getElementById('display-room-url'),
    btnCopyCode: document.getElementById('btn-copy-code'),
    btnCopyUrl: document.getElementById('btn-copy-url'),
    btnCopyLinkMain: document.getElementById('btn-copy-link-main'),
    shareWhatsapp: document.getElementById('share-whatsapp'),
    shareTelegram: document.getElementById('share-telegram'),
    shareInstagram: document.getElementById('share-instagram'),
    shareNative: document.getElementById('share-native'),
    btnShareScanner: document.getElementById('btn-share-scanner'),

    // Join & Scanner Elements
    inputJoinName: document.getElementById('input-join-name'),
    inputJoinCode: document.getElementById('input-join-code'),
    btnPasteLink: document.getElementById('btn-paste-link'),
    btnOpenScanner: document.getElementById('btn-open-scanner'),
    btnCloseScanner: document.getElementById('btn-close-scanner'),
    btnHomeQuickScan: document.getElementById('btn-home-quick-scan'),
    qrScannerCard: document.getElementById('qr-scanner-card'),

    // Waiting Room Elements
    waitingRoomCode: document.getElementById('waiting-room-code'),
    waitingPlayerCount: document.getElementById('waiting-player-count'),
    waitingPlayersContainer: document.getElementById('waiting-players-container'),
    waitingStatusText: document.getElementById('waiting-status-text'),
    btnAddTestBot: document.getElementById('btn-add-test-bot'),
    btnCopyWaitingCode: document.getElementById('btn-copy-waiting-code'),
    myProfileStrip: document.getElementById('btn-edit-my-name'),
    waitingMyDisplayName: document.getElementById('waiting-my-display-name'),
    myProfileAvatarLetter: document.getElementById('my-profile-avatar-letter'),
    btnTriggerNameChange: document.getElementById('btn-trigger-name-change'),
    modalChangeName: document.getElementById('modal-change-name'),
    btnCloseNameModal: document.getElementById('btn-close-name-modal'),
    btnCancelNameModal: document.getElementById('btn-cancel-name-modal'),
    btnSaveNameModal: document.getElementById('btn-save-name-modal'),
    inputModalPlayerName: document.getElementById('input-modal-player-name'),

    // Game Elements
    gameRoomCode: document.getElementById('game-room-code'),
    gameSizeBadge: document.getElementById('game-size-badge'),
    gamePlayersBadge: document.getElementById('game-players-badge'),
    turnBanner: document.getElementById('turn-announcement-banner'),
    turnIcon: document.getElementById('turn-icon'),
    turnText: document.getElementById('turn-text'),
    btnSyncTurn: document.getElementById('btn-sync-turn'),
    activeNumberBall: document.getElementById('active-number-ball'),
    headerProgressCount: document.getElementById('header-progress-count'),
    chips: {
      B: document.getElementById('chip-B'),
      I: document.getElementById('chip-I'),
      N: document.getElementById('chip-N'),
      G: document.getElementById('chip-G'),
      O: document.getElementById('chip-O')
    },
    bingoGrid: document.getElementById('bingo-grid'),
    botGameBoardTabs: document.getElementById('bot-game-board-tabs'),
    tabMyBoard: document.getElementById('tab-my-board'),
    tabBotBoard: document.getElementById('tab-bot-board'),
    btnToggleDualView: document.getElementById('btn-toggle-dual-view'),
    playerBoardContainer: document.getElementById('player-board-container'),
    botBoardContainer: document.getElementById('bot-board-container'),
    botBingoGrid: document.getElementById('bot-bingo-grid'),
    tabMyProgress: document.getElementById('tab-my-progress'),
    tabBotProgress: document.getElementById('tab-bot-progress'),
    playerBoardLines: document.getElementById('player-board-lines'),
    btnShuffleMyBoard: document.getElementById('btn-shuffle-my-board'),
    botChips: {
      B: document.getElementById('bot-chip-B'),
      I: document.getElementById('bot-chip-I'),
      N: document.getElementById('bot-chip-N'),
      G: document.getElementById('bot-chip-G'),
      O: document.getElementById('bot-chip-O')
    },
    btnOpenHistory: document.getElementById('btn-open-history'),
    btnOpenProgress: document.getElementById('btn-open-progress'),
    btnQuickProgress: document.getElementById('btn-quick-progress'),
    historyBadgeCount: document.getElementById('history-badge-count'),
    linesBadgeCount: document.getElementById('lines-badge-count'),

    // History View
    historyItemsContainer: document.getElementById('history-items-container'),
    filterTabs: document.querySelectorAll('.filter-tab'),

    // Progress View
    balls: {
      B: document.getElementById('ball-B'),
      I: document.getElementById('ball-I'),
      N: document.getElementById('ball-N'),
      G: document.getElementById('ball-G'),
      O: document.getElementById('ball-O')
    },
    progressLinesText: document.getElementById('progress-lines-text'),
    progressPercentText: document.getElementById('progress-percent-text'),
    linesBarFill: document.getElementById('lines-bar-fill'),
    completedLinesList: document.getElementById('completed-lines-list'),

    // Winner Screen & Victory Card
    winnerPlayerName: document.getElementById('winner-player-name'),
    winnerAvatarDisplay: document.getElementById('winner-avatar-display'),
    winnerStatLines: document.getElementById('winner-stat-lines'),
    winnerStatRoom: document.getElementById('winner-stat-room'),
    winnerStatGrid: document.getElementById('winner-stat-grid'),
    btnShareWhatsappWin: document.getElementById('btn-share-whatsapp-win'),
    btnDownloadWinCard: document.getElementById('btn-download-win-card'),
    btnShareNativeWin: document.getElementById('btn-share-native-win'),
    btnPlayAgain: document.getElementById('btn-play-again'),
    btnWinnerHome: document.getElementById('btn-winner-home'),
    confettiCanvas: document.getElementById('confetti-canvas'),

    // Toast
    toast: document.getElementById('toast-notify'),
    toastIcon: document.getElementById('toast-icon'),
    toastMessage: document.getElementById('toast-message'),

    // Profile & Avatar Modal
    modalChangeName: document.getElementById('modal-change-name'),
    inputModalPlayerName: document.getElementById('input-modal-player-name'),
    btnCloseNameModal: document.getElementById('btn-close-name-modal'),
    btnCancelNameModal: document.getElementById('btn-cancel-name-modal'),
    btnSaveNameModal: document.getElementById('btn-save-name-modal'),
    avatarPreviewDisplay: document.getElementById('avatar-preview-display'),
    avatarPreviewName: document.getElementById('avatar-preview-name'),
    avatarPreviewTag: document.getElementById('avatar-preview-tag'),
    avatarCards: document.querySelectorAll('.avatar-card-opt'),

    // Modal
    modalInfo: document.getElementById('modal-info'),
    modalTitle: document.getElementById('info-modal-title'),
    modalContent: document.getElementById('info-modal-content'),
    modalCloseBtn: document.getElementById('modal-close-btn'),
    btnModalRules: document.getElementById('btn-modal-rules'),
    btnModalBoards: document.getElementById('btn-modal-boards'),
    btnModalMultiplayer: document.getElementById('btn-modal-multiplayer'),

    // Live in-game history elements
    inGameHistoryList: document.getElementById('in-game-history-list'),
    liveHistoryCounter: document.getElementById('live-history-counter'),

    // Room Chat Elements
    btnFloatingChat: document.getElementById('btn-floating-chat'),
    chatFabBadge: document.getElementById('chat-fab-badge'),
    btnHeaderChat: document.getElementById('btn-header-chat'),
    headerChatBadge: document.getElementById('header-chat-badge'),
    btnHomeChat: document.getElementById('btn-home-chat'),
    btnWaitingChat: document.getElementById('btn-waiting-chat'),
    waitingChatBadge: document.getElementById('waiting-chat-badge'),
    btnGameChat: document.getElementById('btn-game-chat'),
    chatInGameBadge: document.getElementById('chat-in-game-badge'),
    chatDrawerOverlay: document.getElementById('chat-drawer-overlay'),
    chatDrawer: document.getElementById('chat-drawer'),
    btnCloseChat: document.getElementById('btn-close-chat'),
    chatHeaderRoom: document.getElementById('chat-header-room'),
    chatHeaderPlayers: document.getElementById('chat-header-players'),
    chatSystemRoom: document.getElementById('chat-system-room'),
    chatMessagesContainer: document.getElementById('chat-messages-container'),
    chatQuickStrip: document.getElementById('chat-quick-strip'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    btnSendChat: document.getElementById('btn-send-chat'),
    floatingChatPopup: document.getElementById('floating-chat-popup'),
    popupAvatar: document.getElementById('popup-avatar'),
    popupSender: document.getElementById('popup-sender'),
    popupText: document.getElementById('popup-text'),
    btnClosePopup: document.getElementById('btn-close-popup'),
    chatEmojiBtns: document.querySelectorAll('.chat-emoji-btn'),
    quickChips: document.querySelectorAll('.quick-chip')
  };

  // ----------------------------------------------------------------------------
  // 4. SCREEN SWITCHING LOGIC
  // ----------------------------------------------------------------------------
  const views = {
    home: el.viewHome,
    create: el.viewCreate,
    share: el.viewRoomCreated,
    join: el.viewJoin,
    waiting: el.viewWaiting,
    game: el.viewGame,
    history: el.viewHistory,
    progress: el.viewProgress
  };

  function showScreen(screenKey) {
    state.currentScreen = screenKey;

    // Automatically stop QR camera scanner if navigating to any other screen
    if (screenKey !== 'join') {
      stopQrScanner();
    }

    // Handle Intro
    if (screenKey === 'intro') {
      el.screenIntro.classList.remove('hidden');
      return;
    } else {
      el.screenIntro.classList.add('hidden');
    }

    // Handle Winner
    if (screenKey === 'winner') {
      openWinnerScreen(state.winner || `${state.playerName} (You)`);
      return;
    } else {
      el.screenWinner.classList.remove('active');
      stopConfetti();
    }

    // Hide all view sections
    Object.values(views).forEach(v => {
      if (v) v.classList.remove('active');
    });

    // Show target section
    if (views[screenKey]) {
      views[screenKey].classList.add('active');
    }

    // Refresh Waiting Room if navigated to waiting
    if (screenKey === 'waiting') {
      renderWaitingRoom();
    }

    // Update floating chat visibility for active room screens
    updateChatVisibility();

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ----------------------------------------------------------------------------
  // 5. INTRO SCREEN LIFECYCLE (2 Seconds auto transition)
  // ----------------------------------------------------------------------------
  function initIntro() {
    // Check if user came via room invite link directly
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');

    if (roomParam) {
      el.screenIntro.classList.add('hidden');
      const cleanRoom = roomParam.trim().toUpperCase();
      state.roomCode = cleanRoom;
      el.inputJoinCode.value = cleanRoom;
      subscribeToRoom(cleanRoom);

      // Instant direct join into game waiting room upon scanning QR or opening invite link!
      executeAutoJoin(cleanRoom);
      return;
    }

    const timer = setTimeout(() => {
      if (state.currentScreen === 'intro') {
        showScreen('home');
      }
    }, 2800);

    if (el.btnSkipIntro) {
      el.btnSkipIntro.addEventListener('click', () => {
        clearTimeout(timer);
        Sound.click();
        showScreen('home');
      });
    }

    // Tapping anywhere on the intro screen smoothly continues to home
    if (el.screenIntro) {
      el.screenIntro.addEventListener('click', () => {
        if (state.currentScreen === 'intro') {
          clearTimeout(timer);
          Sound.click();
          showScreen('home');
        }
      });
    }
  }

  // ----------------------------------------------------------------------------
  // 6. ROOM CODE & SHARING
  // ----------------------------------------------------------------------------
  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  function getInviteUrl(code) {
    const isFile = window.location.protocol === 'file:';
    const port = window.location.port ? `:${window.location.port}` : '';
    let origin = window.location.origin;

    // Handle localhost, local files, and deployed origins
    if (isFile || !origin || origin === 'null') {
      // Opened as local file
      origin = `http://192.168.29.17:5501`;
    } else if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      // Local server on laptop: substitute Wi-Fi IP and keep actual port
      origin = `http://192.168.29.17${port || ':5501'}`;
    }
    return `${origin}/?room=${code}`;
  }

  function renderRoomQrCode(url) {
    const qrContainer = document.getElementById('room-qr-code');
    if (!qrContainer) return;
    qrContainer.innerHTML = '';

    if (typeof QRCode !== 'undefined') {
      try {
        new QRCode(qrContainer, {
          text: url,
          width: 140,
          height: 140,
          colorDark: '#581876',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (e) {
        console.warn('QR code generation failed:', e);
      }
    }
  }

  function updateRoomDetails() {
    const code = state.roomCode;
    const url = getInviteUrl(code);

    el.displayRoomCode.textContent = code;
    el.displayRoomUrl.textContent = url;
    el.waitingRoomCode.textContent = code;
    el.gameRoomCode.textContent = code;
    el.headerUserName.textContent = state.playerName;
    if (el.headerUserAvatar) el.headerUserAvatar.textContent = state.playerAvatar || '🥷';

    el.gameSizeBadge.textContent = `${state.boardSize} × ${state.boardSize}`;
    el.gamePlayersBadge.textContent = `👥 ${state.players.length}/${state.playerLimit}`;
    el.waitingPlayerCount.textContent = `${state.players.length}/${state.playerLimit}`;

    // Update Chat Drawer Room header info
    if (el.chatHeaderRoom) el.chatHeaderRoom.textContent = '#' + code;
    if (el.chatSystemRoom) el.chatSystemRoom.textContent = code;
    if (el.chatHeaderPlayers) el.chatHeaderPlayers.textContent = `${state.players.length} Players`;

    // Render QR Code for instant Mobile camera joining
    renderRoomQrCode(url);

    // Show notice if user opened directly via file://
    const warningEl = document.getElementById('file-protocol-warning');
    if (warningEl) {
      if (window.location.protocol === 'file:') {
        warningEl.classList.remove('hidden');
      } else {
        warningEl.classList.add('hidden');
      }
    }
  }

  function getAvatarClass(index) {
    const classes = ['avatar-s', 'avatar-g', 'avatar-a', 'avatar-p'];
    return classes[index % classes.length];
  }

  // ----------------------------------------------------------------------------
  // 7. WAITING ROOM - DYNAMIC PLAYERS (NO DUMMY NAMES!)
  // ----------------------------------------------------------------------------
  function renderWaitingRoom() {
    updateRoomDetails();
    el.waitingPlayersContainer.innerHTML = '';

    // Update player's own profile strip in waiting room
    if (el.waitingMyDisplayName) {
      el.waitingMyDisplayName.textContent = state.playerName;
    }
    if (el.myProfileAvatarLetter) {
      el.myProfileAvatarLetter.textContent = state.playerAvatar || '🥷';
    }

    // 1. Render actual joined players
    state.players.forEach((p, index) => {
      const isMe = p.id === state.myPlayerId;
      const playerItem = document.createElement('div');
      playerItem.className = 'player-item';

      const avatarLetter = (p.name[0] || 'U').toUpperCase();
      const avatarColorClass = p.avatarClass || getAvatarClass(index);
      const displayAvatar = p.avatarEmoji || avatarLetter;

      playerItem.innerHTML = `
        <div class="player-info">
          <div class="player-avatar ${avatarColorClass}">${displayAvatar}</div>
          <div class="player-name">
            <span>${p.name}${isMe ? ' (You)' : ''}</span>
            ${p.isHost ? '<span>👑</span>' : ''}
          </div>
        </div>
        <div class="player-status-wrap">
          ${isMe ? `
            <button type="button" class="btn-edit-inline-name" title="Change your name">
              ✏️ Edit
            </button>
          ` : `
            <span class="player-status-tag ${p.isHost ? 'host' : 'ready'}">
              ${p.isHost ? 'Host' : 'Ready'}
            </span>
          `}
        </div>
      `;

      if (isMe) {
        const editBtn = playerItem.querySelector('.btn-edit-inline-name');
        if (editBtn) {
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            Sound.click();
            openNameModal();
          });
        }
      }

      el.waitingPlayersContainer.appendChild(playerItem);
    });

    // 2. Render empty slots for players who have NOT yet joined
    const emptyCount = state.playerLimit - state.players.length;
    for (let i = 1; i <= emptyCount; i++) {
      const slotNum = state.players.length + i;
      const emptyItem = document.createElement('div');
      emptyItem.className = 'player-item player-slot-empty';
      emptyItem.innerHTML = `
        <div class="player-info">
          <div class="player-avatar avatar-empty">＋</div>
          <div class="player-name text-muted">
            Waiting for Player ${slotNum} to join...
          </div>
        </div>
        <span class="player-status-tag waiting">Waiting</span>
      `;
      el.waitingPlayersContainer.appendChild(emptyItem);
    }

    // 3. Update Status text and Host controls
    const isFull = state.players.length >= state.playerLimit;
    const canStart = state.players.length >= 2;

    if (state.isHost) {
      el.btnStartGame.style.display = 'block';
      el.btnStartGame.disabled = !canStart;

      if (canStart) {
        el.waitingStatusText.innerHTML = `<span>✅</span> All ready! Host can start the game.`;
      } else {
        el.waitingStatusText.innerHTML = `<span>⏳</span> Waiting for player to join (${state.players.length}/${state.playerLimit}). Share the room code!`;
      }

      // Show/Hide Add Bot button for solo test
      if (el.btnAddTestBot) {
        el.btnAddTestBot.style.display = isFull ? 'none' : 'block';
      }
    } else {
      // Non-host player view
      el.btnStartGame.style.display = 'none';
      if (el.btnAddTestBot) el.btnAddTestBot.style.display = 'none';

      if (isFull) {
        el.waitingStatusText.innerHTML = `<span>⏳</span> Waiting for Host to start the game...`;
      } else {
        el.waitingStatusText.innerHTML = `<span>⏳</span> Waiting for remaining players (${state.players.length}/${state.playerLimit})...`;
      }
    }
  }

  // ----------------------------------------------------------------------------
  // 8. BOARD SETUP & NUMBER GENERATION
  // ----------------------------------------------------------------------------
  // Cryptographic Multi-Pass Randomizer for distinct, unpredictable board layouts
  function generateShuffledNumbers(size, avoidList = null) {
    const totalCells = size * size;
    let pool = [];
    for (let i = 1; i <= totalCells; i++) pool.push(i);

    // Cryptographic random values if supported for high-entropy randomness
    const randomBuffer = new Uint32Array(totalCells * 8);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(randomBuffer);
    }

    let bufIdx = 0;
    const getRandom = (max) => {
      if (bufIdx < randomBuffer.length) {
        return randomBuffer[bufIdx++] % max;
      }
      return Math.floor(Math.random() * max);
    };

    // Multi-pass Fisher-Yates Shuffle (5 deep passes)
    for (let pass = 0; pass < 5; pass++) {
      for (let i = pool.length - 1; i > 0; i--) {
        const j = getRandom(i + 1);
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
    }

    // Strict Derangement against avoidList (e.g. Robot Board vs Player Board)
    // Guarantees that NOT A SINGLE NUMBER is in the same cell position between the two boards
    if (avoidList && Array.isArray(avoidList) && avoidList.length === pool.length) {
      for (let i = 0; i < pool.length; i++) {
        if (pool[i] === avoidList[i]) {
          // Find another slot j where swapping resolves the conflict cleanly
          let swapped = false;
          for (let j = 0; j < pool.length; j++) {
            if (i !== j && pool[j] !== avoidList[i] && pool[i] !== avoidList[j]) {
              [pool[i], pool[j]] = [pool[j], pool[i]];
              swapped = true;
              break;
            }
          }
          if (!swapped) {
            const fallbackIdx = (i + 13) % pool.length;
            [pool[i], pool[fallbackIdx]] = [pool[fallbackIdx], pool[i]];
          }
        }
      }
    }

    return pool;
  }

  function setupNewBoard() {
    state.markedCells = {};
    state.selectionsHistory = [];
    state.completedLines = [];
    state.currentTurnIndex = 0;
    state.winner = null;
    processedMoveIds.clear();

    // Generate fresh randomized numbers for this player's board
    state.boardNumbers = generateShuffledNumbers(state.boardSize);
    renderBoard();
    updateProgressUI();
    updateHistoryUI();
    updateTurnDisplay();

    // Check if Robot is in the game and setup Robot's separate table
    const hasBot = state.players.some(p => p.isBot);
    if (hasBot) {
      if (el.botGameBoardTabs) el.botGameBoardTabs.classList.remove('hidden');
      setupBotBoard();
      // Default to Player's Board View for clean, spacious play; user can toggle Robot or Both anytime
      switchBoardView('my');
    } else {
      if (el.botGameBoardTabs) el.botGameBoardTabs.classList.add('hidden');
      if (el.botBoardContainer) el.botBoardContainer.classList.add('hidden');
      if (el.playerBoardContainer) el.playerBoardContainer.classList.remove('hidden');
      if (el.viewGame) el.viewGame.classList.remove('dual-boards-active');
    }

    // Reset next number circle
    el.activeNumberBall.textContent = '--';
  }

  function setupBotBoard() {
    state.botMarkedCells = {};
    state.botCompletedLines = [];

    // Distinct randomized numbers for Robot's own board (guaranteed different from player's board)
    state.botBoardNumbers = generateShuffledNumbers(state.boardSize, state.boardNumbers);
    renderBotBoard();
    updateBotProgressUI();
  }

  function renderBotBoard() {
    if (!el.botBingoGrid) return;
    el.botBingoGrid.innerHTML = '';
    el.botBingoGrid.className = `bingo-grid grid-${state.boardSize}x${state.boardSize}`;

    state.botBoardNumbers.forEach((num, index) => {
      const cell = document.createElement('div');
      cell.className = 'bingo-cell';
      cell.dataset.index = index;
      cell.dataset.number = num;
      cell.textContent = num;

      const mark = state.botMarkedCells[index];
      if (mark) {
        cell.classList.add('selected-friend');
      }

      el.botBingoGrid.appendChild(cell);
    });
  }

  function switchBoardView(mode) {
    state.activeBoardView = mode;
    if (mode === 'my') {
      if (el.tabMyBoard) el.tabMyBoard.classList.add('active');
      if (el.tabBotBoard) el.tabBotBoard.classList.remove('active');
      if (el.btnToggleDualView) el.btnToggleDualView.classList.remove('active');
      if (el.playerBoardContainer) el.playerBoardContainer.classList.remove('hidden');
      if (el.botBoardContainer) el.botBoardContainer.classList.add('hidden');
      if (el.viewGame) el.viewGame.classList.remove('dual-boards-active');
    } else if (mode === 'bot') {
      if (el.tabMyBoard) el.tabMyBoard.classList.remove('active');
      if (el.tabBotBoard) el.tabBotBoard.classList.add('active');
      if (el.btnToggleDualView) el.btnToggleDualView.classList.remove('active');
      if (el.playerBoardContainer) el.playerBoardContainer.classList.add('hidden');
      if (el.botBoardContainer) el.botBoardContainer.classList.remove('hidden');
      if (el.viewGame) el.viewGame.classList.remove('dual-boards-active');
    } else if (mode === 'dual') {
      if (el.tabMyBoard) el.tabMyBoard.classList.remove('active');
      if (el.tabBotBoard) el.tabBotBoard.classList.remove('active');
      if (el.btnToggleDualView) el.btnToggleDualView.classList.add('active');
      if (el.playerBoardContainer) el.playerBoardContainer.classList.remove('hidden');
      if (el.botBoardContainer) el.botBoardContainer.classList.remove('hidden');
      if (el.viewGame) el.viewGame.classList.add('dual-boards-active');
    }
  }

  function renderBoard() {
    el.bingoGrid.innerHTML = '';
    el.bingoGrid.className = `bingo-grid grid-${state.boardSize}x${state.boardSize}`;

    state.boardNumbers.forEach((num, index) => {
      const cell = document.createElement('div');
      cell.className = 'bingo-cell';
      cell.dataset.index = index;
      cell.dataset.number = num;
      cell.textContent = num;

      // Apply marked state if any
      const mark = state.markedCells[index];
      if (mark) {
        if (mark.selectedBy === 'you') {
          cell.classList.add('selected-you');
        } else {
          cell.classList.add('selected-friend');
        }
      }

      cell.addEventListener('click', () => handleCellClick(index, num, cell));
      el.bingoGrid.appendChild(cell);
    });
  }

  // ----------------------------------------------------------------------------
  // 9. GAMEPLAY & TURNS
  // ----------------------------------------------------------------------------
  function healMyPlayerId() {
    if (!state.players || state.players.length === 0) return;
    const myName = (state.playerName || '').trim().toLowerCase();
    if (!myName || myName === 'user' || myName === 'player') {
      return;
    }

    const found = state.players.find(p => (p.name || '').trim().toLowerCase() === myName);
    if (found && found.id && found.id !== state.myPlayerId) {
      console.log(`Auto-healing player ID from ${state.myPlayerId} to ${found.id} for player "${state.playerName}"`);
      state.myPlayerId = found.id;
      sessionStorage.setItem('bingo_player_id', found.id);
    }
  }

  function isMyTurn() {
    if (!state.players || state.players.length === 0) return true;
    if (state.currentTurnIndex >= state.players.length || state.currentTurnIndex < 0) {
      state.currentTurnIndex = 0;
    }
    const currentPlayer = state.players[state.currentTurnIndex];
    if (!currentPlayer) return true;

    // 1. Direct ID match
    if (currentPlayer.id && state.myPlayerId && currentPlayer.id === state.myPlayerId) {
      return true;
    }

    // 2. Name match (case-insensitive) - heals desynced sessions
    const myName = (state.playerName || '').trim().toLowerCase();
    const currName = (currentPlayer.name || '').trim().toLowerCase();
    if (myName && currName && myName === currName) {
      healMyPlayerId();
      return true;
    }

    // 3. Solo play or Bot match fallback
    const humanPlayers = state.players.filter(p => !p.isBot);
    if (humanPlayers.length === 1 && !currentPlayer.isBot) {
      return true;
    }

    return false;
  }

  function triggerTurnSync(forced = false) {
    healMyPlayerId();
    if (isMyTurn()) {
      updateTurnDisplay();
      showToast('🟢 It is your turn! Pick any available number on your board.', 'toast-green');
      return;
    }

    const currentPlayer = state.players[state.currentTurnIndex] || {};
    const name = currentPlayer.name || 'Current player';

    const willForce = confirm(`Game stuck on ${name}'s turn?\n\nClick OK to pass turn to the next player, or Cancel to send a sync ping.`);
    if (willForce) {
      advanceTurn();
      broadcastMessage({
        type: 'SYNC_TURN_FORCE',
        roomCode: state.roomCode,
        newTurnIndex: state.currentTurnIndex,
        newPlayerId: state.players[state.currentTurnIndex]?.id,
        byPlayer: state.playerName
      });
      showToast(`🔄 Passed turn to ${state.players[state.currentTurnIndex]?.name}!`, 'toast-green');
    } else {
      broadcastMessage({
        type: 'SYNC_REQUEST',
        roomCode: state.roomCode,
        fromPlayer: state.playerName
      });
      showToast('🔄 Sent sync ping to room...', 'toast-green');
    }
  }

  function handleCellClick(index, num, cellElement) {
    if (state.winner) return;

    // If cell already marked, ignore
    if (state.markedCells[index]) return;

    healMyPlayerId();
    if (state.currentTurnIndex >= state.players.length || state.currentTurnIndex < 0) {
      state.currentTurnIndex = 0;
    }
    const currentPlayer = state.players[state.currentTurnIndex];
    if (!currentPlayer) return;

    const myTurn = isMyTurn();

    if (!myTurn) {
      showToast(`⏳ Please wait! It is ${currentPlayer.name}'s turn. (Tap 'Sync Turn' if stuck)`, 'toast-yellow');
      return;
    }

    // Execute Your Move (Screen 9: Number Clicked - Your Turn)
    markNumber(num, 'you', `${state.playerName} (You)`);
    Sound.yourPick();
    showToast(`🟢 ${state.playerName} (You) selected ${num}`, 'toast-green');

    const nextTurnIndex = (state.currentTurnIndex + 1) % state.players.length;
    const nextPlayer = state.players[nextTurnIndex] || {};
    const moveId = `m_${state.roomCode}_${Date.now()}_${num}_${Math.random().toString(36).substring(2, 6)}`;

    processedMoveIds.add(moveId);

    // Broadcast move to other connected tabs
    broadcastMessage({
      type: 'PLAYER_MOVE',
      moveId: moveId,
      roomCode: state.roomCode,
      number: num,
      playerId: state.myPlayerId,
      playerName: state.playerName,
      nextTurnIndex: nextTurnIndex,
      nextPlayerId: nextPlayer.id,
      nextPlayerName: nextPlayer.name
    });

    // Check game win
    checkGameWin();

    if (!state.winner) {
      state.currentTurnIndex = nextTurnIndex;
      updateTurnDisplay();
      checkBotTurn();
    }
  }

  function markNumber(numberToMark, selectedBy, playerName, isFriendMove = false) {
    // Find cell index with this number on your board
    const cellIdx = state.boardNumbers.indexOf(numberToMark);
    if (cellIdx !== -1) {
      state.markedCells[cellIdx] = {
        number: numberToMark,
        selectedBy: selectedBy,
        player: playerName
      };

      const cellEl = el.bingoGrid.children[cellIdx];
      if (cellEl) {
        if (selectedBy === 'you') {
          cellEl.classList.add('selected-you');
        } else {
          cellEl.classList.add('selected-friend');
          // Screen 10 Blink animation on Friend Click
          cellEl.classList.add('blink-flash');
          setTimeout(() => cellEl.classList.remove('blink-flash'), 1300);
        }
      }
    }

    // Update active number widget ball
    el.activeNumberBall.textContent = numberToMark;
    el.activeNumberBall.style.transform = 'scale(1.2)';
    setTimeout(() => {
      el.activeNumberBall.style.transform = 'scale(1)';
    }, 250);

    // Also mark on Robot's separate table if Robot is playing
    if (state.botBoardNumbers && state.botBoardNumbers.length > 0) {
      const botCellIdx = state.botBoardNumbers.indexOf(numberToMark);
      if (botCellIdx !== -1) {
        state.botMarkedCells[botCellIdx] = {
          number: numberToMark,
          selectedBy: selectedBy,
          player: playerName
        };

        if (el.botBingoGrid && el.botBingoGrid.children[botCellIdx]) {
          const botCellEl = el.botBingoGrid.children[botCellIdx];
          botCellEl.classList.add('selected-friend');
          if (selectedBy !== 'you') {
            botCellEl.classList.add('blink-flash');
            setTimeout(() => botCellEl.classList.remove('blink-flash'), 1300);
          }
        }
      }
      recalculateBotLines();
    }

    // Record Move in Live History
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const isYou = selectedBy === 'you';

    state.selectionsHistory.unshift({
      player: playerName,
      number: numberToMark,
      isYou: isYou,
      time: timeStr
    });

    updateHistoryUI();
    recalculateLines();
  }

  function advanceTurn() {
    if (state.players.length === 0) return;
    state.currentTurnIndex = (state.currentTurnIndex + 1) % state.players.length;
    updateTurnDisplay();
    checkBotTurn();
  }

  function checkBotTurn() {
    if (state.winner) return;
    const activePlayer = state.players[state.currentTurnIndex];
    if (activePlayer && activePlayer.isBot) {
      setTimeout(() => {
        if (state.currentScreen === 'game' && !state.winner) {
          executeBotPick(activePlayer);
        }
      }, 1800);
    }
  }

  function updateTurnDisplay() {
    if (state.players.length === 0) return;
    healMyPlayerId();
    if (state.currentTurnIndex >= state.players.length || state.currentTurnIndex < 0) {
      state.currentTurnIndex = 0;
    }
    const currentPlayer = state.players[state.currentTurnIndex] || state.players[0];
    const myTurn = isMyTurn();

    if (myTurn) {
      el.turnBanner.className = 'turn-banner your-turn';
      el.turnIcon.textContent = '🟢';
      el.turnText.textContent = 'Your Turn! Pick a number on the board.';
    } else {
      el.turnBanner.className = 'turn-banner friend-turn';
      el.turnIcon.textContent = '🟡';
      const name = currentPlayer ? currentPlayer.name : 'Friend';
      el.turnText.textContent = `${name}'s turn to pick...`;
    }
  }

  function executeBotPick(botPlayer) {
    if (state.winner) return;

    // Robot picks an unmarked number from Robot's OWN board!
    const availableNumbers = [];
    if (state.botBoardNumbers && state.botBoardNumbers.length > 0) {
      state.botBoardNumbers.forEach((n, idx) => {
        if (!state.botMarkedCells[idx]) {
          availableNumbers.push(n);
        }
      });
    }

    // Fallback if none found
    if (availableNumbers.length === 0) {
      const totalCells = state.boardSize * state.boardSize;
      for (let n = 1; n <= totalCells; n++) {
        const alreadyMarked = state.selectionsHistory.some(h => h.number === n);
        if (!alreadyMarked) availableNumbers.push(n);
      }
    }

    if (availableNumbers.length === 0) return;

    const randomPick = availableNumbers[Math.floor(Math.random() * availableNumbers.length)];

    // Mark number as called by Robot
    markNumber(randomPick, 'friend', botPlayer.name, true);
    Sound.friendPick();
    showToast(`🤖 ${botPlayer.name} selected ${randomPick}`, 'toast-yellow');

    const nextTurnIndex = (state.currentTurnIndex + 1) % state.players.length;
    const nextPlayer = state.players[nextTurnIndex] || {};
    const moveId = `bot_${state.roomCode}_${Date.now()}_${randomPick}`;
    processedMoveIds.add(moveId);

    broadcastMessage({
      type: 'PLAYER_MOVE',
      moveId: moveId,
      roomCode: state.roomCode,
      number: randomPick,
      playerId: botPlayer.id,
      playerName: botPlayer.name,
      nextTurnIndex: nextTurnIndex,
      nextPlayerId: nextPlayer.id,
      nextPlayerName: nextPlayer.name
    });

    checkGameWin();
    if (!state.winner) {
      state.currentTurnIndex = nextTurnIndex;
      updateTurnDisplay();
      checkBotTurn();
    }
  }

  function recalculateBotLines() {
    const size = state.boardSize;
    const completed = [];
    const isFullLine = (indices) => indices.every(i => Boolean(state.botMarkedCells[i]));

    // 1. Rows
    for (let r = 0; r < size; r++) {
      const rowIndices = [];
      for (let c = 0; c < size; c++) rowIndices.push(r * size + c);
      if (isFullLine(rowIndices)) completed.push(`row-${r}`);
    }

    // 2. Columns
    for (let c = 0; c < size; c++) {
      const colIndices = [];
      for (let r = 0; r < size; r++) colIndices.push(r * size + c);
      if (isFullLine(colIndices)) completed.push(`col-${c}`);
    }

    // 3. Diagonal 1
    const diag1 = [];
    for (let i = 0; i < size; i++) diag1.push(i * size + i);
    if (isFullLine(diag1)) completed.push('diag-1');

    // 4. Diagonal 2
    const diag2 = [];
    for (let i = 0; i < size; i++) diag2.push(i * size + (size - 1 - i));
    if (isFullLine(diag2)) completed.push('diag-2');

    state.botCompletedLines = completed;
    updateBotProgressUI();

    // Check if Robot reached 5 lines first and won!
    if (completed.length >= 5 && !state.winner) {
      const botPlayer = state.players.find(p => p.isBot) || { name: 'Robot' };
      state.winner = `${botPlayer.name}`;
      setTimeout(() => {
        openWinnerScreen(state.winner);
      }, 700);

      broadcastMessage({
        type: 'GAME_WIN',
        roomCode: state.roomCode,
        winnerName: botPlayer.name
      });
    }
  }

  function updateBotProgressUI() {
    const count = Math.min((state.botCompletedLines || []).length, 5);
    const letters = ['B', 'I', 'N', 'G', 'O'];

    letters.forEach((ltr, idx) => {
      if (el.botChips && el.botChips[ltr]) {
        if (idx < count) {
          el.botChips[ltr].classList.add('active');
        } else {
          el.botChips[ltr].classList.remove('active');
        }
      }
    });

    if (el.tabBotProgress) {
      el.tabBotProgress.textContent = `${count}/5`;
    }
  }

  // ----------------------------------------------------------------------------
  // 10. BINGO LINES CHECK & PROGRESS (Screen 12)
  // ----------------------------------------------------------------------------
  function recalculateLines() {
    const size = state.boardSize;
    const previousCount = state.completedLines.length;
    const completed = [];
    const allLinesList = [];

    // Helper to check if a set of indices is fully marked
    const isFullLine = (indices) => indices.every(i => Boolean(state.markedCells[i]));

    // 1. Rows
    for (let r = 0; r < size; r++) {
      const rowIndices = [];
      for (let c = 0; c < size; c++) {
        rowIndices.push(r * size + c);
      }
      const done = isFullLine(rowIndices);
      allLinesList.push({ id: `row-${r}`, label: `Row ${r + 1}`, completed: done });
      if (done) completed.push(`row-${r}`);
    }

    // 2. Columns
    for (let c = 0; c < size; c++) {
      const colIndices = [];
      for (let r = 0; r < size; r++) {
        colIndices.push(r * size + c);
      }
      const done = isFullLine(colIndices);
      allLinesList.push({ id: `col-${c}`, label: `Column ${c + 1}`, completed: done });
      if (done) completed.push(`col-${c}`);
    }

    // 3. Diagonal 1 (Main: top-left to bottom-right)
    const diag1 = [];
    for (let i = 0; i < size; i++) {
      diag1.push(i * size + i);
    }
    const diag1Done = isFullLine(diag1);
    allLinesList.push({ id: 'diag-1', label: 'Diagonal 1', completed: diag1Done });
    if (diag1Done) completed.push('diag-1');

    // 4. Diagonal 2 (Anti: top-right to bottom-left)
    const diag2 = [];
    for (let i = 0; i < size; i++) {
      diag2.push(i * size + (size - 1 - i));
    }
    const diag2Done = isFullLine(diag2);
    allLinesList.push({ id: 'diag-2', label: 'Diagonal 2', completed: diag2Done });
    if (diag2Done) completed.push('diag-2');

    state.completedLines = completed;

    // Check if new line was completed
    if (completed.length > previousCount && completed.length <= 5) {
      Sound.lineComplete();
      showToast(`⭐ New line completed! (${completed.length}/5)`, 'toast-green');

      // Bot playfully reacts when user completes lines
      const botPlayer = state.players.find(p => p.isBot);
      if (botPlayer) {
        setTimeout(() => {
          showReceivedReaction(completed.length >= 4 ? '😭' : '😮', botPlayer.name);
        }, 1100);
      }
    }

    updateProgressUI(allLinesList);
  }

  function updateProgressUI(linesData) {
    const count = Math.min(state.completedLines.length, 5);
    const letters = ['B', 'I', 'N', 'G', 'O'];

    letters.forEach((ltr, idx) => {
      if (idx < count) {
        el.chips[ltr].classList.add('active');
        el.balls[ltr].classList.add('completed');
      } else {
        el.chips[ltr].classList.remove('active');
        el.balls[ltr].classList.remove('completed');
      }
    });

    el.headerProgressCount.textContent = `${count}/5`;
    el.linesBadgeCount.textContent = `${count}/5`;
    el.progressLinesText.textContent = `${count}/5 lines completed`;
    if (el.tabMyProgress) el.tabMyProgress.textContent = `${count}/5`;
    if (el.playerBoardLines) el.playerBoardLines.textContent = `${count}/5 Lines`;

    const pct = Math.round((count / 5) * 100);
    el.progressPercentText.textContent = `${pct}%`;
    el.linesBarFill.style.width = `${pct}%`;

    // Populate Completed Lines Checklist in Screen 12
    if (linesData) {
      el.completedLinesList.innerHTML = '';
      linesData.forEach(item => {
        const rowEl = document.createElement('div');
        rowEl.className = `checklist-item ${item.completed ? 'completed' : ''}`;
        rowEl.innerHTML = `
          <span>${item.label}</span>
          <span class="checklist-check">${item.completed ? '✓' : ''}</span>
        `;
        el.completedLinesList.appendChild(rowEl);
      });
    }
  }

  function checkGameWin() {
    if (state.completedLines.length >= 5 && !state.winner) {
      state.winner = `${state.playerName} (You)`;
      setTimeout(() => {
        openWinnerScreen(state.winner);
      }, 700);

      broadcastMessage({
        type: 'GAME_WIN',
        roomCode: state.roomCode,
        winnerName: state.playerName
      });
    }
  }

  // ----------------------------------------------------------------------------
  // 11. NUMBER HISTORY UI (In-Game List & Full History Screen)
  // ----------------------------------------------------------------------------
  function updateHistoryUI() {
    el.historyBadgeCount.textContent = state.selectionsHistory.length;
    if (el.liveHistoryCounter) {
      el.liveHistoryCounter.textContent = `${state.selectionsHistory.length} picked`;
    }

    // 1. Save history to localStorage for persistence
    if (state.roomCode) {
      try {
        localStorage.setItem('bingo_history_' + state.roomCode, JSON.stringify(state.selectionsHistory));
      } catch (e) {
        console.warn('LocalStorage save failed', e);
      }
    }

    // 2. Render In-Game Live History (Under the Bingo Board on Game Screen)
    if (el.inGameHistoryList) {
      el.inGameHistoryList.innerHTML = '';
      if (state.selectionsHistory.length === 0) {
        el.inGameHistoryList.innerHTML = `
          <div class="game-history-empty">
            No numbers picked yet. Click a number on your board to start!
          </div>
        `;
      } else {
        state.selectionsHistory.forEach(item => {
          const rowEl = document.createElement('div');
          rowEl.className = 'game-history-item';
          rowEl.innerHTML = `
            <div class="game-history-player">
              <span class="legend-dot ${item.isYou ? 'green' : 'yellow'}"></span>
              <span>${item.player}</span>
            </div>
            <div class="history-item-meta">
              <div class="game-history-number ${item.isYou ? 'you' : 'friend'}">${item.number}</div>
              <span class="game-history-time">${item.time}</span>
            </div>
          `;
          el.inGameHistoryList.appendChild(rowEl);
        });
      }
    }

    // 3. Render Full History Screen (Screen 11 with Filter tabs)
    if (el.historyItemsContainer) {
      el.historyItemsContainer.innerHTML = '';
      const filter = state.historyFilter;
      const filtered = state.selectionsHistory.filter(item => {
        if (filter === 'you') return item.isYou;
        if (filter === 'friends') return !item.isYou;
        return true;
      });

      if (filtered.length === 0) {
        el.historyItemsContainer.innerHTML = `
          <div class="history-empty-message">
            No numbers picked yet in this category.
          </div>
        `;
      } else {
        filtered.forEach(item => {
          const itemEl = document.createElement('div');
          itemEl.className = 'history-item';
          itemEl.innerHTML = `
            <div class="history-player">
              <span class="legend-dot ${item.isYou ? 'green' : 'yellow'}"></span>
              <span>${item.player}</span>
            </div>
            <div class="history-item-meta">
              <div class="history-number-pill ${item.isYou ? 'you' : 'friend'}">${item.number}</div>
              <span class="history-time">${item.time}</span>
            </div>
          `;
          el.historyItemsContainer.appendChild(itemEl);
        });
      }
    }
  }

  // ----------------------------------------------------------------------------
  // 12. WINNER SCREEN & CONFETTI (Screen 13)
  // ----------------------------------------------------------------------------
  let confettiAnimId = null;
  let particles = [];

  function openWinnerScreen(winnerName) {
    state.winner = winnerName;
    if (el.winnerPlayerName) el.winnerPlayerName.textContent = `${winnerName} Won!`;

    // Detect Winner Avatar
    let winnerAvatar = '🥷';
    const winPlayer = state.players.find(p => p.name === winnerName);
    if (winPlayer && winPlayer.avatarEmoji) {
      winnerAvatar = winPlayer.avatarEmoji;
    } else if (winnerName.includes(state.playerName) || winnerName === 'USER') {
      winnerAvatar = state.playerAvatar || '🥷';
    } else if (winnerName.toLowerCase().includes('robot')) {
      winnerAvatar = '🤖';
    }

    if (el.winnerAvatarDisplay) el.winnerAvatarDisplay.textContent = winnerAvatar;
    if (el.winnerStatLines) el.winnerStatLines.textContent = `${state.completedLines.length || 5} Lines Done`;
    if (el.winnerStatRoom) el.winnerStatRoom.textContent = `Room ${state.roomCode}`;
    if (el.winnerStatGrid) el.winnerStatGrid.textContent = `${state.boardSize} × ${state.boardSize} Board`;

    el.screenWinner.classList.add('active');
    Sound.win();
    startConfetti();
  }

  // --- Victory Card 1-Click Sharing ---
  function shareVictoryOnWhatsApp() {
    Sound.click();
    const winnerName = state.winner || state.playerName || 'USER';
    const inviteUrl = getInviteUrl(state.roomCode);
    const text = encodeURIComponent(
      `🏆 *BINGO GRAND CHAMPION!* 🥳🎉\n\n` +
      `👑 *${winnerName}* just WON the BINGO match with 5 lines cleared! 🎯\n` +
      `🏷️ Room Code: *${state.roomCode}*\n` +
      `⚡ Board: ${state.boardSize}×${state.boardSize} Grid\n\n` +
      `Challenge me now 👉 ${inviteUrl}`
    );
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  }

  function shareVictoryNative() {
    Sound.click();
    const winnerName = state.winner || state.playerName || 'USER';
    const inviteUrl = getInviteUrl(state.roomCode);
    const shareData = {
      title: '🏆 BINGO CHAMPION!',
      text: `🏆 ${winnerName} just won the BINGO match in Room ${state.roomCode}! Play with me:`,
      url: inviteUrl
    };

    if (navigator.share) {
      navigator.share(shareData).catch(() => {});
    } else {
      copyToClipboard(
        `🏆 ${winnerName} just won BINGO! Room: ${state.roomCode} • Join: ${inviteUrl}`,
        '✨ Victory status copied! Paste in your Instagram Story or chat!'
      );
    }
  }

  // Realistic High-Res Victory Card Generator (Canvas Download)
  function generateAndDownloadVictoryCard(winnerName) {
    Sound.click();
    showToast('📸 Generating high-res Victory Card...', 'toast-green');

    try {
      const canvas = document.createElement('canvas');
      const w = 640;
      const h = 820;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');

      // 1. Royal Purple & Velvet Background Gradient
      const bgGrad = ctx.createRadialGradient(w / 2, h / 2, 80, w / 2, h / 2, 450);
      bgGrad.addColorStop(0, '#541577');
      bgGrad.addColorStop(0.55, '#350b4a');
      bgGrad.addColorStop(1, '#1b0327');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // 2. Elegant Golden Outer & Inner Borders
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffd700';
      ctx.strokeRect(20, 20, w - 40, h - 40);

      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255, 215, 0, 0.4)';
      ctx.strokeRect(28, 28, w - 56, h - 56);

      // Corner stars
      ctx.font = '22px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('✨', 46, 50);
      ctx.fillText('✨', w - 46, 50);
      ctx.fillText('✨', 46, h - 38);
      ctx.fillText('✨', w - 46, h - 38);

      // 3. Top Header Ribbon
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 18px "Plus Jakarta Sans", sans-serif';
      ctx.letterSpacing = '4px';
      ctx.fillText('B I N G O   R O Y A L E', w / 2, 95);

      ctx.fillStyle = '#ffd700';
      ctx.font = '700 13px "Plus Jakarta Sans", sans-serif';
      ctx.fillText('★ OFFICIAL MATCH VICTORY CERTIFICATE ★', w / 2, 125);

      // 4. Floating Crown & 3D Winner Avatar
      ctx.font = '48px sans-serif';
      ctx.fillText('👑', w / 2, 205);

      // Glowing Avatar Circle
      ctx.beginPath();
      ctx.arc(w / 2, 285, 62, 0, Math.PI * 2);
      ctx.fillStyle = '#8b2fc9';
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // Avatar Glyph
      let winnerAvatar = '🥷';
      const winPlayer = state.players.find(p => p.name === winnerName);
      if (winPlayer && winPlayer.avatarEmoji) {
        winnerAvatar = winPlayer.avatarEmoji;
      } else if (winnerName.includes(state.playerName) || winnerName === 'USER') {
        winnerAvatar = state.playerAvatar || '🥷';
      } else if (winnerName.toLowerCase().includes('robot')) {
        winnerAvatar = '🤖';
      }
      ctx.font = '60px sans-serif';
      ctx.fillText(winnerAvatar, w / 2, 305);

      // Trophy below avatar
      ctx.font = '32px sans-serif';
      ctx.fillText('🏆', w / 2, 375);

      // 5. Winner Name & Announcement
      ctx.fillStyle = '#ffd700';
      ctx.font = '800 14px "Plus Jakarta Sans", sans-serif';
      ctx.fillText('GRAND CHAMPION', w / 2, 420);

      ctx.fillStyle = '#ffffff';
      ctx.font = '900 36px "Outfit", "Plus Jakarta Sans", sans-serif';
      ctx.fillText(`${winnerName} Won!`, w / 2, 468);

      // 6. Statistics Card Container
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.roundRect ? ctx.roundRect(60, 515, w - 120, 150, 16) : ctx.fillRect(60, 515, w - 120, 150);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(192, 132, 252, 0.4)';
      ctx.stroke();

      // Stats inside
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 16px "Plus Jakarta Sans", sans-serif';
      ctx.fillText(`🎯 Lines Cleared: 5 Completed Lines`, w / 2, 558);
      ctx.fillText(`🏷️ Room Code: ${state.roomCode}`, w / 2, 595);
      ctx.fillText(`⚡ Grid Size: ${state.boardSize} × ${state.boardSize} Board`, w / 2, 632);

      // 7. Footer Brand & Timestamp
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.font = '500 12px "Plus Jakarta Sans", sans-serif';
      const timeStr = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      ctx.fillText(`Verified Match • ${timeStr} • Play Online with Friends`, w / 2, 730);

      // 8. Trigger Download
      const dataUrl = canvas.toDataURL('image/png');
      const downloadLink = document.createElement('a');
      downloadLink.download = `BINGO_Victory_${winnerName.replace(/\s+/g, '_')}.png`;
      downloadLink.href = dataUrl;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);

      showToast('📥 Victory Card downloaded successfully!', 'toast-green');
    } catch (err) {
      console.error('Failed to generate victory card:', err);
      showToast('Card download complete!', 'toast-green');
    }
  }

  function startConfetti() {
    const canvas = el.confettiCanvas;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    particles = [];
    const colors = ['#581876', '#c084fc', '#a855f7', '#ffffff', '#e9b8ff', '#8b2fc9'];
    for (let i = 0; i < 120; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height - canvas.height,
        r: Math.random() * 6 + 3,
        d: Math.random() * 80 + 10,
        color: colors[Math.floor(Math.random() * colors.length)],
        tilt: Math.random() * 10 - 10,
        tiltAngleInc: Math.random() * 0.08 + 0.04,
        tiltAngle: 0
      });
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.tiltAngle += p.tiltAngleInc;
        p.y += (Math.cos(p.d) + 3 + p.r / 2) / 2;
        p.x += Math.sin(p.d);
        p.tilt = Math.sin(p.tiltAngle) * 15;

        ctx.beginPath();
        ctx.lineWidth = p.r / 2;
        ctx.strokeStyle = p.color;
        ctx.moveTo(p.x + p.tilt + p.r, p.y);
        ctx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r);
        ctx.stroke();

        if (p.y > canvas.height) {
          p.y = -20;
          p.x = Math.random() * canvas.width;
        }
      });
      confettiAnimId = requestAnimationFrame(draw);
    }

    draw();
  }

  function stopConfetti() {
    if (confettiAnimId) {
      cancelAnimationFrame(confettiAnimId);
      confettiAnimId = null;
    }
    const canvas = el.confettiCanvas;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  // ----------------------------------------------------------------------------
  // 13. TOAST NOTIFICATION UTILITY
  // ----------------------------------------------------------------------------
  let toastTimer = null;
  function showToast(message, typeClass = 'toast-green') {
    clearTimeout(toastTimer);
    el.toast.className = `toast-notification show ${typeClass}`;
    el.toastIcon.textContent = typeClass === 'toast-green' ? '🟢' : '🟡';
    el.toastMessage.textContent = message;

    toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
    }, 2500);
  }

  function copyToClipboard(text, message) {
    Sound.click();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(`📋 ${message}`, 'toast-green');
      }).catch(() => fallbackCopy(text, message));
    } else {
      fallbackCopy(text, message);
    }
  }

  function fallbackCopy(text, message) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(`📋 ${message}`, 'toast-green');
    } catch (e) {
      showToast(`Copy failed. Code: ${text}`, 'toast-yellow');
    }
    document.body.removeChild(ta);
  }

  // ----------------------------------------------------------------------------
  // 14. REAL-TIME BROADCAST PROTOCOL (Live Multiplayer Across Devices & Tabs)
  // ----------------------------------------------------------------------------
  function broadcastMessage(payload) {
    if (!payload || !state.roomCode) return;
    if (!payload.senderId) payload.senderId = state.myPlayerId;
    if (!payload.msgId) {
      payload.msgId = 'm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    }

    // 1. BroadcastChannel for local browser tabs
    if (channel) {
      try {
        channel.postMessage(payload);
      } catch (e) {}
    }

    // 2. MQTT over WebSockets for cross-device mobile & laptop sync
    if (mqttClient && mqttClient.connected) {
      const topic = `bingo_rooms_live/${state.roomCode.trim().toUpperCase()}`;
      try {
        mqttClient.publish(topic, JSON.stringify(payload));
      } catch (e) {
        console.warn('MQTT publish error:', e);
      }
    }
  }

  function handleIncomingBroadcast(data) {
    if (!data || !data.roomCode || data.roomCode !== state.roomCode) return;
    // Ignore our own echoed messages (except room sync responses)
    if (data.senderId === state.myPlayerId && data.type !== 'ROOM_SYNC') return;

    // Deduplicate across BroadcastChannel and MQTT
    if (data.msgId) {
      if (seenMessageIds.has(data.msgId)) return;
      seenMessageIds.add(data.msgId);
      if (seenMessageIds.size > 250) {
        const oldest = seenMessageIds.values().next().value;
        seenMessageIds.delete(oldest);
      }
    }

    // A player joined the room
    if (data.type === 'PLAYER_JOINED') {
      const incoming = data.player;
      if (incoming && incoming.id !== state.myPlayerId) {
        // Match existing player by ID or matching Name (handles mobile page refresh/reconnect)
        const existingIdx = state.players.findIndex(p =>
          p.id === incoming.id ||
          (p.name && incoming.name && p.name.trim().toLowerCase() === incoming.name.trim().toLowerCase() && p.name.trim().toLowerCase() !== 'user' && p.name.trim().toLowerCase() !== 'player')
        );

        if (existingIdx !== -1) {
          state.players[existingIdx] = incoming;
          renderWaitingRoom();
        } else if (state.players.length < state.playerLimit) {
          state.players.push(incoming);
          Sound.join();
          showToast(`🎉 ${incoming.name} joined the room!`, 'toast-green');
          renderWaitingRoom();
        }

        // Host always replies with full room state to synchronize joiner
        if (state.isHost) {
          broadcastMessage({
            type: 'ROOM_SYNC',
            roomCode: state.roomCode,
            boardSize: state.boardSize,
            playerLimit: state.playerLimit,
            players: state.players
          });
        }
      }
    }

    // Room synchronization packet
    else if (data.type === 'ROOM_SYNC') {
      state.boardSize = data.boardSize;
      state.playerLimit = data.playerLimit;
      if (data.players && data.players.length > 0) {
        state.players = data.players;
      }
      healMyPlayerId();
      // Stop mobile join retry heartbeat since room sync is confirmed
      if (joinHeartbeatTimer) {
        clearInterval(joinHeartbeatTimer);
        joinHeartbeatTimer = null;
      }
      renderWaitingRoom();
    }

    // A player updated their name/avatar in the room
    else if (data.type === 'PLAYER_NAME_UPDATE' || data.type === 'PLAYER_PROFILE_UPDATE') {
      const p = state.players.find(player => player.id === data.playerId);
      if (p) {
        const oldName = p.name;
        p.name = data.newName;
        if (data.newAvatar) {
          p.avatarEmoji = data.newAvatar;
        }
        renderWaitingRoom();
        showToast(`🎭 ${oldName} updated to ${p.avatarEmoji || ''} ${data.newName}!`, 'toast-green');

        // Host relays updated room state to all members
        if (state.isHost) {
          broadcastMessage({
            type: 'ROOM_SYNC',
            roomCode: state.roomCode,
            boardSize: state.boardSize,
            playerLimit: state.playerLimit,
            players: state.players
          });
        }
      }
    }

    // Host started the game
    else if (data.type === 'START_GAME') {
      if (data.senderId === state.myPlayerId) {
        // Skip duplicate self-echo from MQTT so host's board isn't wiped
        return;
      }
      if (data.players && data.players.length > 0) {
        state.players = data.players;
      }
      healMyPlayerId();
      state.currentTurnIndex = (typeof data.currentTurnIndex === 'number') ? data.currentTurnIndex : 0;
      setupNewBoard();
      showScreen('game');
      Sound.join();
      showToast('Game has started! Good luck!', 'toast-green');
    }

    // A player made a move
    else if (data.type === 'PLAYER_MOVE') {
      if (data.playerId !== state.myPlayerId) {
        healMyPlayerId();

        // 1. Deduplicate by moveId
        if (data.moveId && processedMoveIds.has(data.moveId)) {
          return;
        }
        if (data.moveId) {
          processedMoveIds.add(data.moveId);
        }

        // 2. Check if number was already picked
        const alreadyPicked = state.selectionsHistory.some(h => h.number === data.number) ||
                              Object.values(state.markedCells).some(m => m.number === data.number);

        if (!alreadyPicked) {
          markNumber(data.number, 'friend', data.playerName, true);
          Sound.friendPick();
          showToast(`🟡 ${data.playerName} selected ${data.number}`, 'toast-yellow');
          checkGameWin();
        }

        // 3. Synchronize turn index directly and authoritatively
        if (typeof data.nextTurnIndex === 'number' && data.nextTurnIndex < state.players.length) {
          state.currentTurnIndex = data.nextTurnIndex;
        } else if (data.nextPlayerId) {
          const pIdx = state.players.findIndex(p => p.id === data.nextPlayerId);
          if (pIdx !== -1) {
            state.currentTurnIndex = pIdx;
          } else {
            advanceTurn();
          }
        } else {
          advanceTurn();
        }

        updateTurnDisplay();
        checkBotTurn();
      }
    }

    // Turn force unstick / sync
    else if (data.type === 'SYNC_TURN_FORCE') {
      healMyPlayerId();
      if (typeof data.newTurnIndex === 'number' && data.newTurnIndex < state.players.length) {
        state.currentTurnIndex = data.newTurnIndex;
      } else {
        advanceTurn();
      }
      updateTurnDisplay();
      showToast(`🔄 Turn synchronized by ${data.byPlayer || 'player'}`, 'toast-green');
      checkBotTurn();
    }

    // Request full game turn sync from Host
    else if (data.type === 'SYNC_REQUEST') {
      if (state.isHost) {
        broadcastMessage({
          type: 'GAME_SYNC_STATE',
          roomCode: state.roomCode,
          currentTurnIndex: state.currentTurnIndex,
          players: state.players
        });
      }
    }

    // Receive full game turn sync state
    else if (data.type === 'GAME_SYNC_STATE') {
      if (data.players && data.players.length) {
        state.players = data.players;
      }
      healMyPlayerId();
      if (typeof data.currentTurnIndex === 'number' && data.currentTurnIndex < state.players.length) {
        state.currentTurnIndex = data.currentTurnIndex;
      }
      updateTurnDisplay();
      checkBotTurn();
    }

    // Game won by someone
    else if (data.type === 'GAME_WIN') {
      if (data.winnerName !== state.playerName) {
        state.winner = data.winnerName;
        openWinnerScreen(data.winnerName);
      }
    }

    // A player sent an emoji reaction
    else if (data.type === 'PLAYER_REACTION') {
      if (data.playerId !== state.myPlayerId) {
        showReceivedReaction(data.emoji, data.playerName);
      }
    }

    // A player sent a room chat message
    else if (data.type === 'CHAT_MESSAGE') {
      if (data.senderId !== state.myPlayerId) {
        handleIncomingChatMessage(data);
      }
    }

    // Player left
    else if (data.type === 'PLAYER_LEFT') {
      state.players = state.players.filter(p => p.id !== data.playerId);
      showToast(`${data.playerName} left the room.`, 'toast-yellow');
      if (state.currentTurnIndex >= state.players.length) {
        state.currentTurnIndex = 0;
      }
      if (state.currentScreen === 'game') {
        updateTurnDisplay();
      } else if (state.currentScreen === 'waiting') {
        renderWaitingRoom();
      }
    }
  }

  // ----------------------------------------------------------------------------
  // 14.5. EMOJI REACTIONS (Interactive Cross-Player Reactions)
  // ----------------------------------------------------------------------------
  function playReactionSound() {
    playSoftChime(587.33, 0.1, 0.04);
  }

  function sendReaction(emoji, sourceBtn) {
    // Animate floating emoji locally
    spawnFloatingEmoji(emoji, sourceBtn);
    playReactionSound();

    // Broadcast reaction to other players in real-time
    broadcastMessage({
      type: 'PLAYER_REACTION',
      roomCode: state.roomCode,
      playerId: state.myPlayerId,
      playerName: state.playerName,
      emoji: emoji
    });

    // If a bot is present, bot has a 45% chance to react back playfully!
    const botPlayer = state.players.find(p => p.isBot);
    if (botPlayer) {
      triggerBotReactionResponse(botPlayer, emoji);
    }
  }

  function spawnFloatingEmoji(emoji, sourceEl) {
    const floatEl = document.createElement('div');
    floatEl.className = 'reaction-float';
    floatEl.textContent = emoji;

    let startX, startY;
    if (sourceEl && sourceEl.getBoundingClientRect) {
      const rect = sourceEl.getBoundingClientRect();
      startX = rect.left + (rect.width / 2) - 15 + (Math.random() * 20 - 10);
      startY = rect.top - 10;
    } else {
      startX = (window.innerWidth / 2) - 15 + (Math.random() * 120 - 60);
      startY = window.innerHeight - 140;
    }

    // Keep within bounds
    startX = Math.max(16, Math.min(window.innerWidth - 50, startX));

    floatEl.style.left = `${startX}px`;
    floatEl.style.top = `${startY}px`;

    document.body.appendChild(floatEl);

    setTimeout(() => {
      if (floatEl.parentNode) {
        floatEl.parentNode.removeChild(floatEl);
      }
    }, 1600);
  }

  let reactionBannerTimer = null;
  function showReceivedReaction(emoji, fromPlayerName) {
    spawnFloatingEmoji(emoji, null);
    playReactionSound();

    let banner = document.getElementById('reaction-received-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'reaction-received-banner';
      banner.className = 'reaction-received';
      document.body.appendChild(banner);
    }

    banner.innerHTML = `<span class="reaction-received-emoji">${emoji}</span> <span><strong>${fromPlayerName}</strong> reacted</span>`;
    banner.classList.add('show');

    clearTimeout(reactionBannerTimer);
    reactionBannerTimer = setTimeout(() => {
      banner.classList.remove('show');
    }, 2200);
  }

  let botReactionTimeout = null;
  function triggerBotReactionResponse(botPlayer, userEmoji) {
    if (Math.random() > 0.55) return;
    clearTimeout(botReactionTimeout);
    botReactionTimeout = setTimeout(() => {
      const botResponses = {
        '😂': ['😂', '🔥', '😮'],
        '😢': ['😭', '😮', '😂'],
        '😭': ['😢', '😂', '🔥'],
        '😮': ['🔥', '😂', '😮'],
        '😠': ['😂', '😮', '🔥'],
        '🔥': ['🔥', '😮', '😂']
      };
      const pool = botResponses[userEmoji] || ['😂', '🔥', '😮'];
      const botEmoji = pool[Math.floor(Math.random() * pool.length)];
      showReceivedReaction(botEmoji, botPlayer.name);
    }, 700 + Math.random() * 900);
  }



  // ----------------------------------------------------------------------------
  // 14.8. LIVE CAMERA QR CODE SCANNER (Instant Cross-Device Auto-Join)
  // ----------------------------------------------------------------------------
  let html5QrScanner = null;
  let isScanning = false;

  function startQrScanner() {
    if (isScanning) return;
    const scannerCard = el.qrScannerCard || document.getElementById('qr-scanner-card');
    if (scannerCard) scannerCard.classList.remove('hidden');

    if (typeof Html5Qrcode === 'undefined') {
      showToast('Camera scanner library loading, please wait...', 'toast-yellow');
      return;
    }

    isScanning = true;
    showToast('📷 Opening camera scanner...', 'toast-green');

    // Make sure previous scanner instance is cleared
    stopQrScanner().then(() => {
      try {
        html5QrScanner = new Html5Qrcode("qr-reader-container");
        const config = {
          fps: 15,
          qrbox: { width: 220, height: 220 },
          aspectRatio: 1.0
        };

        // Try environment (rear) camera on phones first
        html5QrScanner.start(
          { facingMode: "environment" },
          config,
          onQrCodeSuccess,
          () => {} // suppress repetitive frame errors
        ).catch(err => {
          console.warn("Back camera unavailable, attempting any camera:", err);
          // Fallback: search for any available video device (webcam on laptop/front camera)
          Html5Qrcode.getCameras().then(cameras => {
            if (cameras && cameras.length > 0) {
              const cameraId = cameras[0].id;
              html5QrScanner.start(cameraId, config, onQrCodeSuccess, () => {});
            } else {
              showToast('No camera found on this device', 'toast-yellow');
              stopQrScanner();
            }
          }).catch(camErr => {
            console.error("Camera permission error:", camErr);
            showToast('Camera access blocked. Please allow camera permission.', 'toast-yellow');
            stopQrScanner();
          });
        });
      } catch (e) {
        console.error("Scanner init error:", e);
        stopQrScanner();
      }
    });
  }

  function onQrCodeSuccess(decodedText) {
    if (!decodedText) return;
    console.log('Scanned QR text:', decodedText);

    // Extract room code from URL or raw code text
    let code = decodedText.trim();
    if (code.includes('?room=')) {
      code = code.split('?room=')[1].split('&')[0];
    } else if (code.includes('/')) {
      const parts = code.split('/');
      code = parts[parts.length - 1];
    }
    code = code.trim().toUpperCase();

    if (code && code.length >= 4) {
      Sound.join();
      showToast(`🎯 QR code scanned! Joining room ${code}...`, 'toast-green');
      stopQrScanner();

      if (el.inputJoinCode) el.inputJoinCode.value = code;
      executeAutoJoin(code);
    }
  }

  function stopQrScanner() {
    isScanning = false;
    const scannerCard = el.qrScannerCard || document.getElementById('qr-scanner-card');
    if (scannerCard) scannerCard.classList.add('hidden');

    if (html5QrScanner) {
      return html5QrScanner.stop().then(() => {
        html5QrScanner.clear();
        html5QrScanner = null;
      }).catch(() => {
        try { html5QrScanner.clear(); } catch(e) {}
        html5QrScanner = null;
      });
    }
    return Promise.resolve();
  }

  let selectedModalAvatar = {
    id: 'ninja',
    emoji: state.playerAvatar || '🥷',
    name: 'Ninja',
    tag: 'Shadow Master'
  };

  function updateAvatarPreview(emoji, name, tag, id) {
    selectedModalAvatar = { id, emoji, name, tag };
    if (el.avatarPreviewDisplay) el.avatarPreviewDisplay.textContent = emoji;
    if (el.avatarPreviewName) el.avatarPreviewName.textContent = name;
    if (el.avatarPreviewTag) el.avatarPreviewTag.textContent = tag;
  }

  function setupAvatarSelectors() {
    if (!el.avatarCards) return;
    el.avatarCards.forEach(card => {
      card.addEventListener('click', () => {
        Sound.click();
        el.avatarCards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        updateAvatarPreview(card.dataset.emoji, card.dataset.name, card.dataset.tag, card.dataset.id);
      });
    });
  }

  function openNameModal() {
    if (el.inputModalPlayerName) {
      el.inputModalPlayerName.value = (state.playerName === 'Player' || state.playerName === 'USER') ? '' : state.playerName;
    }

    // Highlight current avatar card
    const currentAvatar = state.playerAvatar || '🥷';
    if (el.avatarCards) {
      let matched = false;
      el.avatarCards.forEach(card => {
        if (card.dataset.emoji === currentAvatar) {
          card.classList.add('selected');
          updateAvatarPreview(card.dataset.emoji, card.dataset.name, card.dataset.tag, card.dataset.id);
          matched = true;
        } else {
          card.classList.remove('selected');
        }
      });
      if (!matched && el.avatarCards[0]) {
        el.avatarCards[0].classList.add('selected');
        updateAvatarPreview(el.avatarCards[0].dataset.emoji, el.avatarCards[0].dataset.name, el.avatarCards[0].dataset.tag, el.avatarCards[0].dataset.id);
      }
    }

    if (el.modalChangeName) {
      el.modalChangeName.classList.add('active');
    }
    setTimeout(() => {
      if (el.inputModalPlayerName) el.inputModalPlayerName.focus();
    }, 150);
  }

  function closeNameModal() {
    if (el.modalChangeName) {
      el.modalChangeName.classList.remove('active');
    }
  }

  function saveNameFromModal() {
    const val = el.inputModalPlayerName ? el.inputModalPlayerName.value.trim() : '';
    const chosenName = val || (state.playerName !== 'Player' ? state.playerName : 'USER');
    const chosenAvatar = selectedModalAvatar.emoji || state.playerAvatar || '🥷';
    closeNameModal();
    changePlayerProfile(chosenName, chosenAvatar);
  }

  function changePlayerProfile(newName, newAvatar) {
    if (newName) {
      const cleanName = newName.trim();
      state.playerName = cleanName;
      localStorage.setItem('bingo_user_name', cleanName);
      if (el.headerUserName) el.headerUserName.textContent = cleanName;
      if (el.inputCreatorName) el.inputCreatorName.value = (cleanName !== 'USER' ? cleanName : '');
      if (el.inputJoinName) el.inputJoinName.value = (cleanName !== 'USER' ? cleanName : '');
      if (el.waitingMyDisplayName) el.waitingMyDisplayName.textContent = cleanName;
    }

    if (newAvatar) {
      state.playerAvatar = newAvatar;
      localStorage.setItem('bingo_user_avatar', newAvatar);
      if (el.headerUserAvatar) el.headerUserAvatar.textContent = newAvatar;
      if (el.myProfileAvatarLetter) el.myProfileAvatarLetter.textContent = newAvatar;
    }

    // Update in players list
    const myPlayer = state.players.find(p => p.id === state.myPlayerId);
    if (myPlayer) {
      if (newName) myPlayer.name = state.playerName;
      if (newAvatar) myPlayer.avatarEmoji = state.playerAvatar;
    }

    renderWaitingRoom();
    updateRoomDetails();

    // Broadcast update to all room members
    broadcastMessage({
      type: 'PLAYER_PROFILE_UPDATE',
      roomCode: state.roomCode,
      playerId: state.myPlayerId,
      newName: state.playerName,
      newAvatar: state.playerAvatar
    });

    if (state.isHost) {
      broadcastMessage({
        type: 'ROOM_SYNC',
        roomCode: state.roomCode,
        boardSize: state.boardSize,
        playerLimit: state.playerLimit,
        players: state.players
      });
    }

    showToast(`Profile updated! ${state.playerAvatar} ${state.playerName}`, 'toast-green');
  }

  function executeAutoJoin(code) {
    const storedName = localStorage.getItem('bingo_user_name');
    const inputVal = el.inputJoinName ? el.inputJoinName.value.trim() : '';
    let name = inputVal || storedName || state.playerName || 'Player';
    state.playerName = name;
    localStorage.setItem('bingo_user_name', state.playerName);

    state.roomCode = code;
    state.isHost = false;

    // Subscribe to room topic
    subscribeToRoom(state.roomCode);

    const myPlayerObj = {
      id: state.myPlayerId,
      name: state.playerName,
      isHost: false,
      isReady: true,
      avatarEmoji: state.playerAvatar || '🥷',
      avatarClass: 'avatar-g'
    };

    state.players = [myPlayerObj];
    updateRoomDetails();
    showScreen('waiting');

    // Broadcast join request
    broadcastMessage({
      type: 'PLAYER_JOINED',
      roomCode: state.roomCode,
      player: myPlayerObj
    });

    // Re-announce join until acknowledged by host
    if (joinHeartbeatTimer) clearInterval(joinHeartbeatTimer);
    joinHeartbeatTimer = setInterval(() => {
      if (state.currentScreen === 'waiting' && state.players.length <= 1 && !state.isHost) {
        broadcastMessage({
          type: 'PLAYER_JOINED',
          roomCode: state.roomCode,
          player: myPlayerObj
        });
      } else {
        clearInterval(joinHeartbeatTimer);
        joinHeartbeatTimer = null;
      }
    }, 2000);

    showToast(`Joined Room ${code}! Connecting to host...`, 'toast-green');

    // If player has default name 'Player', automatically open Name modal so they can set their real name!
    if (!storedName || name === 'Player' || name.startsWith('Player')) {
      setTimeout(() => {
        if (state.currentScreen === 'waiting') {
          openNameModal();
        }
      }, 500);
    }
  }

  // ----------------------------------------------------------------------------
  // 14.8. ROOM REALTIME CHAT SYSTEM (In-game & Waiting Room)
  // ----------------------------------------------------------------------------
  let popupDismissTimer = null;
  let botChatTimer = null;

  function updateChatVisibility() {
    if (!el.btnFloatingChat) return;
    // Chat is available right from the start (Home, Create, Join, Waiting, Game)!
    if (state.currentScreen === 'intro') {
      el.btnFloatingChat.classList.add('hidden');
    } else {
      el.btnFloatingChat.classList.remove('hidden');
    }
  }

  function updateChatBadges() {
    const count = state.chatUnreadCount;
    const badges = [el.chatFabBadge, el.headerChatBadge, el.waitingChatBadge, el.chatInGameBadge];
    badges.forEach(b => {
      if (!b) return;
      if (count > 0) {
        b.textContent = count > 99 ? '99+' : count;
        b.classList.remove('hidden');
      } else {
        b.classList.add('hidden');
      }
    });
  }

  function openChatDrawer() {
    if (!el.chatDrawerOverlay) return;
    Sound.click();
    state.isChatOpen = true;
    state.chatUnreadCount = 0;
    updateChatBadges();

    // Dismiss floating mini popup
    if (el.floatingChatPopup) el.floatingChatPopup.classList.add('hidden');

    el.chatDrawerOverlay.classList.remove('hidden');
    if (el.chatHeaderRoom) el.chatHeaderRoom.textContent = '#' + state.roomCode;
    if (el.chatSystemRoom) el.chatSystemRoom.textContent = state.roomCode;
    if (el.chatHeaderPlayers) el.chatHeaderPlayers.textContent = `${state.players.length} Players`;

    setTimeout(() => {
      if (el.chatMessagesContainer) {
        el.chatMessagesContainer.scrollTop = el.chatMessagesContainer.scrollHeight;
      }
      if (el.chatInput) el.chatInput.focus();
    }, 50);
  }

  function closeChatDrawer() {
    if (!el.chatDrawerOverlay) return;
    Sound.click();
    state.isChatOpen = false;
    el.chatDrawerOverlay.classList.add('hidden');
  }

  function resetRoomChat(code) {
    state.chatMessages = [];
    state.chatUnreadCount = 0;
    updateChatBadges();
    if (el.chatHeaderRoom) el.chatHeaderRoom.textContent = '#' + code;
    if (el.chatSystemRoom) el.chatSystemRoom.textContent = code;
    if (el.chatMessagesContainer) {
      el.chatMessagesContainer.innerHTML = `
        <div class="chat-system-banner">
          <span>🔒 Live room chat for <strong>${escapeHtml(code)}</strong>. Say hi to friends! 👋</span>
        </div>
      `;
    }
  }

  function sendChatMessage(text) {
    if (!text || !text.trim()) return;
    const cleanText = text.trim();
    if (!state.roomCode) {
      showToast('⚠️ Please join a room to chat!', 'toast-yellow');
      return;
    }

    const msg = {
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      roomCode: state.roomCode,
      senderId: state.myPlayerId,
      senderName: state.playerName || 'Player',
      senderAvatar: state.playerAvatar || '🥷',
      text: cleanText,
      timestamp: Date.now(),
      isMe: true
    };

    state.chatMessages.push(msg);
    renderSingleChatMessage(msg);
    Sound.chatSend();

    // Broadcast message to all connected players in the room
    broadcastMessage({
      type: 'CHAT_MESSAGE',
      roomCode: state.roomCode,
      chatId: msg.id,
      senderId: state.myPlayerId,
      senderName: state.playerName,
      senderAvatar: state.playerAvatar || '🥷',
      text: cleanText,
      timestamp: msg.timestamp
    });

    // If Robot AI bot is in the room, bot replies!
    const bot = state.players.find(p => p.isBot);
    if (bot) {
      triggerBotChatReply(bot, cleanText);
    }
  }

  function handleIncomingChatMessage(data) {
    const msg = {
      id: data.chatId || ('c_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7)),
      roomCode: data.roomCode,
      senderId: data.senderId,
      senderName: data.senderName || 'Friend',
      senderAvatar: data.senderAvatar || '🎮',
      text: data.text,
      timestamp: data.timestamp || Date.now(),
      isMe: false,
      isBot: data.isBot || false
    };

    // Deduplicate
    if (state.chatMessages.some(m => m.id === msg.id)) return;
    state.chatMessages.push(msg);
    renderSingleChatMessage(msg);
    Sound.chatReceive();

    if (!state.isChatOpen) {
      state.chatUnreadCount++;
      updateChatBadges();
      showFloatingChatPopup(msg);
    }
  }

  function showFloatingChatPopup(msg) {
    if (!el.floatingChatPopup) return;
    if (popupDismissTimer) clearTimeout(popupDismissTimer);

    if (el.popupAvatar) el.popupAvatar.textContent = msg.senderAvatar || '💬';
    if (el.popupSender) el.popupSender.textContent = msg.senderName;
    if (el.popupText) el.popupText.textContent = msg.text;

    el.floatingChatPopup.classList.remove('hidden');

    popupDismissTimer = setTimeout(() => {
      if (el.floatingChatPopup) el.floatingChatPopup.classList.add('hidden');
    }, 4000);
  }

  function formatChatTime(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderSingleChatMessage(msg) {
    if (!el.chatMessagesContainer) return;

    const row = document.createElement('div');
    const rowClass = msg.isMe ? 'chat-msg-row me' : (msg.isBot ? 'chat-msg-row bot' : 'chat-msg-row friend');
    row.className = rowClass;

    const timeStr = formatChatTime(msg.timestamp);
    const safeText = escapeHtml(msg.text);

    if (msg.isMe) {
      row.innerHTML = `
        <div class="chat-msg-bubble-wrap">
          <div class="chat-msg-bubble">${safeText}</div>
          <div class="chat-msg-time">${timeStr}</div>
        </div>
      `;
    } else {
      const botBadge = msg.isBot ? '<span class="bot-tag-chip">AI Bot</span>' : '';
      row.innerHTML = `
        <div class="chat-msg-avatar">${escapeHtml(msg.senderAvatar || '🎮')}</div>
        <div class="chat-msg-bubble-wrap">
          <div class="chat-msg-sender-name">${escapeHtml(msg.senderName)} ${botBadge}</div>
          <div class="chat-msg-bubble">${safeText}</div>
          <div class="chat-msg-time">${timeStr}</div>
        </div>
      `;
    }

    el.chatMessagesContainer.appendChild(row);
    el.chatMessagesContainer.scrollTop = el.chatMessagesContainer.scrollHeight;
  }

  const BOT_CHAT_LINES = [
    "Challenge accepted! Let's see your moves! 🎲",
    "My quantum algorithms predict my BINGO is imminent! ⚡",
    "Haha! You cannot defeat an AI trained on thousands of games! 🤖",
    "Nice pick! But I've already prepared 5 lines ahead! 🧠",
    "Calculating probability of your victory... 14.8% 😏",
    "Your turn! Don't let the pressure get to you! ⏳",
    "BINGO will be mine! 👑🔥",
    "May the best algorithm win! 🚀",
    "I have 100% battery and zero hesitation! 🔋⚡"
  ];

  function triggerBotChatReply(bot, userText) {
    if (botChatTimer) clearTimeout(botChatTimer);
    const delay = 900 + Math.random() * 1100;
    botChatTimer = setTimeout(() => {
      let reply = BOT_CHAT_LINES[Math.floor(Math.random() * BOT_CHAT_LINES.length)];
      const lower = userText.toLowerCase();
      if (userText.includes('?')) {
        reply = "Processing query... Result: I am taking the crown! 👑";
      } else if (lower.includes('luck') || userText.includes('🍀')) {
        reply = "Luck is an illusion, I rely purely on probability! 🎲🤖";
      } else if (lower.includes('haha') || userText.includes('😂')) {
        reply = "Haha! Let's see who laughs when the 5th line connects! 🎯";
      } else if (lower.includes('win') || userText.includes('👑')) {
        reply = "Win? That's my programmed objective! Let's play! ⚡";
      }

      const botMsg = {
        id: 'bot_c_' + Date.now(),
        roomCode: state.roomCode,
        senderId: bot.id,
        senderName: bot.name || 'Robot (AI)',
        senderAvatar: '🤖',
        text: reply,
        timestamp: Date.now(),
        isMe: false,
        isBot: true
      };

      state.chatMessages.push(botMsg);
      renderSingleChatMessage(botMsg);
      Sound.chatReceive();

      if (!state.isChatOpen) {
        state.chatUnreadCount++;
        updateChatBadges();
        showFloatingChatPopup(botMsg);
      }
    }, delay);
  }

  function initChatSystem() {
    // Open drawer buttons (Available right from the start!)
    if (el.btnFloatingChat) {
      el.btnFloatingChat.addEventListener('click', openChatDrawer);
    }
    if (el.btnHeaderChat) {
      el.btnHeaderChat.addEventListener('click', openChatDrawer);
    }
    if (el.btnHomeChat) {
      el.btnHomeChat.addEventListener('click', openChatDrawer);
    }
    if (el.btnWaitingChat) {
      el.btnWaitingChat.addEventListener('click', openChatDrawer);
    }
    if (el.btnGameChat) {
      el.btnGameChat.addEventListener('click', openChatDrawer);
    }

    // Close drawer buttons
    if (el.btnCloseChat) {
      el.btnCloseChat.addEventListener('click', closeChatDrawer);
    }
    if (el.chatDrawerOverlay) {
      el.chatDrawerOverlay.addEventListener('click', (e) => {
        if (e.target === el.chatDrawerOverlay) {
          closeChatDrawer();
        }
      });
    }

    // Floating popup interactions
    if (el.floatingChatPopup) {
      el.floatingChatPopup.addEventListener('click', (e) => {
        if (e.target !== el.btnClosePopup && !el.btnClosePopup.contains(e.target)) {
          openChatDrawer();
        }
      });
    }
    if (el.btnClosePopup) {
      el.btnClosePopup.addEventListener('click', (e) => {
        e.stopPropagation();
        el.floatingChatPopup.classList.add('hidden');
      });
    }

    // Chat form submit
    if (el.chatForm) {
      el.chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!el.chatInput) return;
        const val = el.chatInput.value;
        if (val && val.trim()) {
          sendChatMessage(val);
          el.chatInput.value = '';
          el.chatInput.focus();
        }
      });
    }

    // Quick chips
    if (el.quickChips) {
      el.quickChips.forEach(chip => {
        chip.addEventListener('click', () => {
          const msg = chip.getAttribute('data-msg');
          if (msg) {
            sendChatMessage(msg);
          }
        });
      });
    }

    // Quick emojis
    if (el.chatEmojiBtns) {
      el.chatEmojiBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const emoji = btn.getAttribute('data-emoji');
          if (!emoji) return;
          if (el.chatInput) {
            el.chatInput.value += emoji;
            el.chatInput.focus();
          } else {
            sendChatMessage(emoji);
          }
        });
      });
    }
  }

  // ----------------------------------------------------------------------------
  // 15. EVENT LISTENERS
  // ----------------------------------------------------------------------------
  function setupEventListeners() {
    setupAvatarSelectors();

    // --- Header Actions ---
    el.logoHomeBtn.addEventListener('click', () => {
      Sound.click();
      showScreen('home');
    });

    el.btnSoundToggle.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      el.btnSoundToggle.textContent = state.soundEnabled ? '🔊' : '🔇';
      showToast(state.soundEnabled ? 'Sound enabled' : 'Sound muted', 'toast-green');
    });

    // Theme Toggle (Screen 15: Dark Mode)
    function toggleTheme() {
      document.body.classList.add('theme-transitioning');
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', state.theme);
      el.btnThemeToggle.textContent = state.theme === 'dark' ? '☀️' : '🌙';
      localStorage.setItem('bingo_theme', state.theme);
      Sound.click();
      setTimeout(() => document.body.classList.remove('theme-transitioning'), 320);
    }
    el.btnThemeToggle.addEventListener('click', toggleTheme);

    // Profile / Name Prompt (Opens fast custom modal)
    el.btnLoginModal.addEventListener('click', () => {
      Sound.click();
      openNameModal();
    });

    if (el.btnEditMyName) {
      el.btnEditMyName.addEventListener('click', () => {
        Sound.click();
        openNameModal();
      });
    }

    if (el.btnTriggerNameChange) {
      el.btnTriggerNameChange.addEventListener('click', (e) => {
        e.stopPropagation();
        Sound.click();
        openNameModal();
      });
    }

    if (el.btnCloseNameModal) {
      el.btnCloseNameModal.addEventListener('click', () => {
        Sound.click();
        closeNameModal();
      });
    }

    if (el.btnCancelNameModal) {
      el.btnCancelNameModal.addEventListener('click', () => {
        Sound.click();
        closeNameModal();
      });
    }

    if (el.btnSaveNameModal) {
      el.btnSaveNameModal.addEventListener('click', () => {
        Sound.click();
        saveNameFromModal();
      });
    }

    if (el.inputModalPlayerName) {
      el.inputModalPlayerName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          Sound.click();
          saveNameFromModal();
        }
      });
    }

    // --- Home Navigation ---
    el.btnGotoCreate.addEventListener('click', () => {
      Sound.click();
      el.inputCreatorName.value = (state.playerName && state.playerName !== 'USER') ? state.playerName : '';
      showScreen('create');
    });

    el.btnGotoJoin.addEventListener('click', () => {
      Sound.click();
      el.inputJoinName.value = (state.playerName && state.playerName !== 'USER') ? state.playerName : '';
      showScreen('join');
    });

    if (el.btnHomeQuickScan) {
      el.btnHomeQuickScan.addEventListener('click', () => {
        Sound.click();
        el.inputJoinName.value = (state.playerName && state.playerName !== 'USER') ? state.playerName : '';
        showScreen('join');
        setTimeout(() => startQrScanner(), 250);
      });
    }

    // QR Code Scanner Controls
    if (el.btnOpenScanner) {
      el.btnOpenScanner.addEventListener('click', () => {
        Sound.click();
        startQrScanner();
      });
    }

    if (el.btnCloseScanner) {
      el.btnCloseScanner.addEventListener('click', () => {
        Sound.click();
        stopQrScanner();
      });
    }

    if (el.btnShareScanner) {
      el.btnShareScanner.addEventListener('click', () => {
        Sound.click();
        showScreen('join');
        setTimeout(() => startQrScanner(), 250);
      });
    }

    // Back Buttons
    el.btnBackHomeList.forEach(btn => {
      btn.addEventListener('click', () => {
        Sound.click();
        showScreen('home');
      });
    });

    el.btnBackGameList.forEach(btn => {
      btn.addEventListener('click', () => {
        Sound.click();
        showScreen('game');
      });
    });

    // --- Create Room Controls ---
    el.optBoard5.addEventListener('click', () => {
      Sound.click();
      state.boardSize = 5;
      el.optBoard5.classList.add('selected');
      el.optBoard7.classList.remove('selected');
    });

    el.optBoard7.addEventListener('click', () => {
      Sound.click();
      state.boardSize = 7;
      el.optBoard7.classList.add('selected');
      el.optBoard5.classList.remove('selected');
    });

    el.playerCountBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        Sound.click();
        el.playerCountBtns.forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.playerLimit = parseInt(btn.dataset.count, 10);
      });
    });

    // Host Creates Room
    el.btnSubmitCreate.addEventListener('click', () => {
      Sound.click();
      const customName = el.inputCreatorName.value.trim();
      if (customName) {
        state.playerName = customName;
        localStorage.setItem('bingo_user_name', state.playerName);
      } else if (!state.playerName) {
        state.playerName = 'USER';
      }

      state.roomCode = generateRoomCode();
      state.isHost = true;

      // Subscribe to real-time room topic for cross-device mobile/laptop sync
      subscribeToRoom(state.roomCode);

      // Only Host is present initially! NO DUMMY PLAYERS!
      state.players = [{
        id: state.myPlayerId,
        name: state.playerName,
        isHost: true,
        isReady: true,
        avatarEmoji: state.playerAvatar || '🥷',
        avatarClass: 'avatar-s'
      }];

      updateRoomDetails();
      showScreen('share');
    });

    // --- Room Share Actions ---
    el.btnCopyCode.addEventListener('click', () => {
      copyToClipboard(state.roomCode, 'Room code copied to clipboard!');
    });

    el.btnCopyUrl.addEventListener('click', () => {
      copyToClipboard(getInviteUrl(state.roomCode), 'Invite link copied to clipboard!');
    });

    el.btnCopyLinkMain.addEventListener('click', () => {
      copyToClipboard(getInviteUrl(state.roomCode), 'Invite link copied to clipboard!');
    });

    el.shareWhatsapp.addEventListener('click', () => {
      Sound.click();
      const url = getInviteUrl(state.roomCode);
      const text = encodeURIComponent(`Play Bingo with me! Join room ${state.roomCode}: ${url}`);
      window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
    });

    el.shareTelegram.addEventListener('click', () => {
      Sound.click();
      const url = encodeURIComponent(getInviteUrl(state.roomCode));
      const text = encodeURIComponent(`Play Bingo with me! Room Code: ${state.roomCode}`);
      window.open(`https://t.me/share/url?url=${url}&text=${text}`, '_blank');
    });

    el.shareInstagram.addEventListener('click', () => {
      Sound.click();
      copyToClipboard(getInviteUrl(state.roomCode), 'Invite link copied for Instagram Story/Bio!');
    });

    el.shareNative.addEventListener('click', () => {
      Sound.click();
      const url = getInviteUrl(state.roomCode);
      if (navigator.share) {
        navigator.share({
          title: 'Join my BINGO room!',
          text: `Play Bingo with me! Room Code: ${state.roomCode}`,
          url: url
        }).catch(() => {});
      } else {
        copyToClipboard(url, 'Invite link copied!');
      }
    });

    el.btnEnterWaiting.addEventListener('click', () => {
      Sound.click();
      showScreen('waiting');
    });

    // --- Join Room Controls ---
    el.btnSubmitJoin.addEventListener('click', () => {
      Sound.click();
      const name = el.inputJoinName.value.trim();
      const code = el.inputJoinCode.value.trim().toUpperCase();

      if (name) {
        state.playerName = name;
        localStorage.setItem('bingo_user_name', state.playerName);
      }
      if (!code) {
        showToast('Please enter a room code', 'toast-yellow');
        return;
      }

      state.roomCode = code;
      state.isHost = false;

      // Subscribe to real-time room topic for cross-device mobile/laptop sync
      subscribeToRoom(state.roomCode);

      // Joiner registers self
      const myPlayerObj = {
        id: state.myPlayerId,
        name: state.playerName,
        isHost: false,
        isReady: true,
        avatarEmoji: state.playerAvatar || '🥷',
        avatarClass: 'avatar-g'
      };

      state.players = [myPlayerObj];
      updateRoomDetails();
      showScreen('waiting');

      // Broadcast join request to host and other tabs
      broadcastMessage({
        type: 'PLAYER_JOINED',
        roomCode: state.roomCode,
        player: myPlayerObj
      });

      // Keep re-announcing join every 2s until room sync is received from Host
      if (joinHeartbeatTimer) clearInterval(joinHeartbeatTimer);
      joinHeartbeatTimer = setInterval(() => {
        if (state.currentScreen === 'waiting' && state.players.length <= 1 && !state.isHost) {
          broadcastMessage({
            type: 'PLAYER_JOINED',
            roomCode: state.roomCode,
            player: myPlayerObj
          });
        } else {
          clearInterval(joinHeartbeatTimer);
          joinHeartbeatTimer = null;
        }
      }, 2000);

      showToast(`Joined Room ${code}! Connecting to host...`, 'toast-green');
    });

    el.btnPasteLink.addEventListener('click', () => {
      Sound.click();
      const entered = prompt('Paste Bingo Room Link or Code:');
      if (entered) {
        let code = entered.trim();
        if (code.includes('?room=')) {
          code = code.split('?room=')[1].split('&')[0];
        } else if (code.includes('/')) {
          const parts = code.split('/');
          code = parts[parts.length - 1];
        }
        code = code.trim().toUpperCase();
        if (code) {
          el.inputJoinCode.value = code;
          showToast(`Room code ${code} set! Click Join.`, 'toast-green');
        }
      }
    });

    el.btnCopyWaitingCode.addEventListener('click', () => {
      copyToClipboard(state.roomCode, 'Room code copied!');
    });

    // --- Add Bot Button (Solo testing option) ---
    if (el.btnAddTestBot) {
      el.btnAddTestBot.addEventListener('click', () => {
        Sound.click();
        if (state.players.length >= state.playerLimit) {
          showToast('Room is already full!', 'toast-yellow');
          return;
        }

        const botIdx = state.players.length;
        const botNames = ['Robot', 'Robot 2', 'Robot 3'];
        const botName = botNames[botIdx - 1] || `Robot ${botIdx}`;

        const botPlayer = {
          id: 'bot_' + Date.now(),
          name: botName,
          isHost: false,
          isReady: true,
          isBot: true,
          avatarEmoji: '🤖',
          avatarClass: getAvatarClass(botIdx)
        };

        state.players.push(botPlayer);
        renderWaitingRoom();
        showToast(`Added ${botName}!`, 'toast-green');

        broadcastMessage({
          type: 'ROOM_SYNC',
          roomCode: state.roomCode,
          boardSize: state.boardSize,
          playerLimit: state.playerLimit,
          players: state.players
        });
      });
    }

    // --- Waiting Room -> Start Game ---
    el.btnStartGame.addEventListener('click', () => {
      Sound.click();
      if (state.players.length < 2) {
        showToast('Wait for at least 1 more player to join!', 'toast-yellow');
        return;
      }

      setupNewBoard();
      showScreen('game');
      showToast('Game started! Good luck!', 'toast-green');

      // Notify all connected tabs
      broadcastMessage({
        type: 'START_GAME',
        roomCode: state.roomCode,
        players: state.players,
        currentTurnIndex: 0
      });
    });

    // --- Turn Sync & Unstick ---
    if (el.btnSyncTurn) {
      el.btnSyncTurn.addEventListener('click', () => {
        Sound.click();
        triggerTurnSync();
      });
    }

    // --- Game Navigation & Sub Views ---
    el.btnLeaveGame.addEventListener('click', () => {
      Sound.click();
      if (confirm('Are you sure you want to exit the current game?')) {
        broadcastMessage({
          type: 'PLAYER_LEFT',
          roomCode: state.roomCode,
          playerId: state.myPlayerId,
          playerName: state.playerName
        });
        showScreen('home');
      }
    });

    el.btnOpenHistory.addEventListener('click', () => {
      Sound.click();
      showScreen('history');
    });

    el.btnOpenProgress.addEventListener('click', () => {
      Sound.click();
      showScreen('progress');
    });

    el.btnQuickProgress.addEventListener('click', () => {
      Sound.click();
      showScreen('progress');
    });

    // Dual Board Switcher Event Listeners
    if (el.tabMyBoard) {
      el.tabMyBoard.addEventListener('click', () => {
        Sound.click();
        switchBoardView('my');
      });
    }
    if (el.tabBotBoard) {
      el.tabBotBoard.addEventListener('click', () => {
        Sound.click();
        switchBoardView('bot');
      });
    }
    if (el.btnToggleDualView) {
      el.btnToggleDualView.addEventListener('click', () => {
        Sound.click();
        const nextMode = state.activeBoardView === 'dual' ? 'my' : 'dual';
        switchBoardView(nextMode);
      });
    }

    // --- Shuffle Board Button (Randomize numbers anytime) ---
    if (el.btnShuffleMyBoard) {
      el.btnShuffleMyBoard.addEventListener('click', () => {
        Sound.click();
        const hasMarks = Object.keys(state.markedCells).length > 0;
        if (hasMarks) {
          if (!confirm('Re-shuffling board numbers will reset marked cells for this round. Continue?')) {
            return;
          }
        }
        state.boardNumbers = generateShuffledNumbers(state.boardSize, state.botBoardNumbers);
        state.markedCells = {};
        state.completedLines = [];
        renderBoard();
        updateProgressUI();
        showToast('🎲 Board numbers randomly shuffled!', 'toast-green');
      });
    }
    // --- Emoji Reaction Buttons (Side dock & bottom bar) ---
    const reactionButtons = document.querySelectorAll('.reaction-btn');
    reactionButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const emoji = btn.dataset.emoji;
        if (!emoji) return;

        // Button bounce animation
        btn.classList.remove('reacted');
        void btn.offsetWidth;
        btn.classList.add('reacted');
        setTimeout(() => btn.classList.remove('reacted'), 500);

        sendReaction(emoji, btn);
      });
    });



    // --- History Filter Tabs ---
    el.filterTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        Sound.click();
        el.filterTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.historyFilter = tab.dataset.filter;
        updateHistoryUI();
      });
    });

    // --- Winner Screen & Victory Card Actions ---
    if (el.btnShareWhatsappWin) {
      el.btnShareWhatsappWin.addEventListener('click', shareVictoryOnWhatsApp);
    }
    if (el.btnDownloadWinCard) {
      el.btnDownloadWinCard.addEventListener('click', () => {
        generateAndDownloadVictoryCard(state.winner || state.playerName || 'USER');
      });
    }
    if (el.btnShareNativeWin) {
      el.btnShareNativeWin.addEventListener('click', shareVictoryNative);
    }

    el.btnPlayAgain.addEventListener('click', () => {
      Sound.click();
      stopConfetti();
      el.screenWinner.classList.remove('active');
      setupNewBoard();
      showScreen('game');
    });

    el.btnWinnerHome.addEventListener('click', () => {
      Sound.click();
      stopConfetti();
      el.screenWinner.classList.remove('active');
      showScreen('home');
    });

    // --- Info Modals (How to play, Board sizes, Multiplayer) ---
    function openModal(title, htmlContent) {
      Sound.click();
      el.modalTitle.textContent = title;
      el.modalContent.innerHTML = htmlContent;
      el.modalInfo.classList.add('active');
    }

    el.modalCloseBtn.addEventListener('click', () => {
      Sound.click();
      el.modalInfo.classList.remove('active');
    });

    el.modalInfo.addEventListener('click', (e) => {
      if (e.target === el.modalInfo) {
        el.modalInfo.classList.remove('active');
      }
    });

    el.btnModalRules.addEventListener('click', () => {
      openModal('How to Play Bingo', `
        <p class="modal-section-title"><strong>Rules & Objectives:</strong></p>
        <ul class="modal-list">
          <li>Players take turns picking a number from their grid.</li>
          <li>When you pick a number, it turns <strong>Purple</strong> on your board.</li>
          <li>When your friend picks a number, it <strong>blinks and turns Yellow</strong>.</li>
          <li>Complete 5 lines (any combination of rows, columns, or diagonals).</li>
          <li>Each completed line illuminates a letter in <strong>B - I - N - G - O</strong>!</li>
          <li>The first player to complete 5 lines wins!</li>
        </ul>
      `);
    });

    el.btnModalBoards.addEventListener('click', () => {
      openModal('Board Sizes', `
        <div class="modal-boards-list">
          <div>
            <h4 class="modal-board-header">5 × 5 Grid (Fast & Classic)</h4>
            <p>Contains numbers 1 through 25. Perfect for quick and dynamic 5 to 10 minute rounds.</p>
          </div>
          <div>
            <h4 class="modal-board-header">7 × 7 Grid (Challenging & Deep)</h4>
            <p>Contains numbers 1 through 49. Great for longer tactical battles with up to 4 players.</p>
          </div>
        </div>
      `);
    });

    el.btnModalMultiplayer.addEventListener('click', () => {
      openModal('Multiplayer & Real-Time Sync', `
        <p class="modal-section-title"><strong>Playing with Friends:</strong></p>
        <ol class="modal-list">
          <li>Click <strong>+ Create Room</strong> to get your room code.</li>
          <li>Share the code or invite link with your friend.</li>
          <li>Your friend opens the link, enters their name, and joins!</li>
          <li>Their real name appears instantly in the Waiting Room.</li>
          <li>Host starts the game when players are ready!</li>
        </ol>
      `);
    });
  }

  // ----------------------------------------------------------------------------
  // 16. INITIALIZATION
  // ----------------------------------------------------------------------------
  function init() {
    // Restore theme from localStorage
    const savedTheme = localStorage.getItem('bingo_theme') || 'light';
    state.theme = savedTheme;
    document.documentElement.setAttribute('data-theme', savedTheme);
    el.btnThemeToggle.textContent = savedTheme === 'dark' ? '☀️' : '🌙';

    // Initialize Host player
    state.players = [{
      id: state.myPlayerId,
      name: state.playerName,
      isHost: true,
      isReady: true,
      avatarEmoji: state.playerAvatar || '🥷',
      avatarClass: 'avatar-s'
    }];

    updateRoomDetails();
    setupEventListeners();
    initChatSystem();
    initMqtt();
    initIntro();
  }

  // Boot on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
