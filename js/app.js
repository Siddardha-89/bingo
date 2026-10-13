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

  // ----------------------------------------------------------------------------
  // 1. STATE MANAGEMENT
  // ----------------------------------------------------------------------------
  const state = {
    currentScreen: 'intro',
    playerName: localStorage.getItem('bingo_user_name') || 'Siddardha',
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
    gameActive: false,
    winner: null,
    historyFilter: 'all'
  };

  // BroadcastChannel for cross-tab real-time multiplayer synchronization
  let channel = null;
  try {
    channel = new BroadcastChannel('bingo_realtime_channel');
    channel.onmessage = (event) => handleIncomingBroadcast(event.data);
  } catch (e) {
    console.warn('BroadcastChannel not supported in this environment');
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

    // Join Elements
    inputJoinName: document.getElementById('input-join-name'),
    inputJoinCode: document.getElementById('input-join-code'),
    btnPasteLink: document.getElementById('btn-paste-link'),

    // Waiting Room Elements
    waitingRoomCode: document.getElementById('waiting-room-code'),
    waitingPlayerCount: document.getElementById('waiting-player-count'),
    waitingPlayersContainer: document.getElementById('waiting-players-container'),
    waitingStatusText: document.getElementById('waiting-status-text'),
    btnAddTestBot: document.getElementById('btn-add-test-bot'),
    btnCopyWaitingCode: document.getElementById('btn-copy-waiting-code'),

    // Game Elements
    gameRoomCode: document.getElementById('game-room-code'),
    gameSizeBadge: document.getElementById('game-size-badge'),
    gamePlayersBadge: document.getElementById('game-players-badge'),
    turnBanner: document.getElementById('turn-announcement-banner'),
    turnIcon: document.getElementById('turn-icon'),
    turnText: document.getElementById('turn-text'),
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

    // Winner Screen
    winnerPlayerName: document.getElementById('winner-player-name'),
    btnPlayAgain: document.getElementById('btn-play-again'),
    btnWinnerHome: document.getElementById('btn-winner-home'),
    confettiCanvas: document.getElementById('confetti-canvas'),

    // Toast
    toast: document.getElementById('toast-notify'),
    toastIcon: document.getElementById('toast-icon'),
    toastMessage: document.getElementById('toast-message'),

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
    liveHistoryCounter: document.getElementById('live-history-counter')
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
      state.roomCode = roomParam.trim().toUpperCase();
      el.inputJoinCode.value = state.roomCode;
      showScreen('join');
      showToast(`Invited to Room ${state.roomCode}! Enter your name to join.`, 'toast-green');
      return;
    }

    const timer = setTimeout(() => {
      if (state.currentScreen === 'intro') {
        showScreen('home');
      }
    }, 2200);

    el.btnSkipIntro.addEventListener('click', () => {
      clearTimeout(timer);
      Sound.click();
      showScreen('home');
    });
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
    let origin = (window.location.origin && window.location.origin !== 'null') ? window.location.origin : 'http://localhost:3000';
    // If hosting locally on laptop, provide the laptop's Wi-Fi network IP so phones can connect directly!
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      origin = 'http://192.168.29.17:3000';
    }
    return `${origin}/?room=${code}`;
  }

  function updateRoomDetails() {
    const code = state.roomCode;
    const url = getInviteUrl(code);

    el.displayRoomCode.textContent = code;
    el.displayRoomUrl.textContent = url;
    el.waitingRoomCode.textContent = code;
    el.gameRoomCode.textContent = code;
    el.headerUserName.textContent = state.playerName;

    el.gameSizeBadge.textContent = `${state.boardSize} × ${state.boardSize}`;
    el.gamePlayersBadge.textContent = `👥 ${state.players.length}/${state.playerLimit}`;
    el.waitingPlayerCount.textContent = `${state.players.length}/${state.playerLimit}`;
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

    // 1. Render actual joined players
    state.players.forEach((p, index) => {
      const isMe = p.id === state.myPlayerId;
      const playerItem = document.createElement('div');
      playerItem.className = 'player-item';

      const avatarLetter = (p.name[0] || 'U').toUpperCase();
      const avatarColorClass = p.avatarClass || getAvatarClass(index);

      playerItem.innerHTML = `
        <div class="player-info">
          <div class="player-avatar ${avatarColorClass}">${avatarLetter}</div>
          <div class="player-name">
            <span>${p.name}${isMe ? ' (You)' : ''}</span>
            ${p.isHost ? '<span>👑</span>' : ''}
          </div>
        </div>
        <span class="player-status-tag ${p.isHost ? 'host' : 'ready'}">
          ${p.isHost ? 'Host' : 'Ready'}
        </span>
      `;
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
  function setupNewBoard() {
    const totalCells = state.boardSize * state.boardSize;
    state.markedCells = {};
    state.selectionsHistory = [];
    state.completedLines = [];
    state.currentTurnIndex = 0;
    state.winner = null;

    // Generate randomized numbers for this player's board
    const pool = [];
    for (let i = 1; i <= totalCells; i++) pool.push(i);

    // Fisher-Yates Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    state.boardNumbers = pool;
    renderBoard();
    updateProgressUI();
    updateHistoryUI();
    updateTurnDisplay();

    // Reset next number circle
    el.activeNumberBall.textContent = '--';
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
  function handleCellClick(index, num, cellElement) {
    if (state.winner) return;

    // If cell already marked, ignore
    if (state.markedCells[index]) return;

    // Check if it's player's turn
    const currentPlayer = state.players[state.currentTurnIndex];
    if (!currentPlayer) return;

    const isYourTurn = currentPlayer.id === state.myPlayerId;

    if (!isYourTurn) {
      showToast(`⏳ Please wait! It is ${currentPlayer.name}'s turn.`, 'toast-yellow');
      return;
    }

    // Execute Your Move (Screen 9: Number Clicked - Your Turn)
    markNumber(num, 'you', `${state.playerName} (You)`);
    Sound.yourPick();
    showToast(`🟢 ${state.playerName} (You) selected ${num}`, 'toast-green');

    // Broadcast move to other connected tabs
    broadcastMessage({
      type: 'PLAYER_MOVE',
      roomCode: state.roomCode,
      number: num,
      playerId: state.myPlayerId,
      playerName: state.playerName
    });

    // Check game win
    checkGameWin();

    if (!state.winner) {
      advanceTurn();
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

    // If it's a simulated Bot player's turn, automate bot pick
    const activePlayer = state.players[state.currentTurnIndex];
    if (activePlayer && activePlayer.isBot && !state.winner) {
      setTimeout(() => {
        if (state.currentScreen === 'game' && !state.winner) {
          executeBotPick(activePlayer);
        }
      }, 2000);
    }
  }

  function updateTurnDisplay() {
    if (state.players.length === 0) return;
    const currentPlayer = state.players[state.currentTurnIndex] || state.players[0];
    const isYourTurn = currentPlayer.id === state.myPlayerId;

    if (isYourTurn) {
      el.turnBanner.className = 'turn-banner your-turn';
      el.turnIcon.textContent = '🟢';
      el.turnText.textContent = 'Your Turn! Pick a number on the board.';
    } else {
      el.turnBanner.className = 'turn-banner friend-turn';
      el.turnIcon.textContent = '🟡';
      el.turnText.textContent = `${currentPlayer.name}'s turn to pick...`;
    }
  }

  function executeBotPick(botPlayer) {
    if (state.winner) return;

    // Pick an unmarked number from the board or 1..total
    const totalCells = state.boardSize * state.boardSize;
    const availableNumbers = [];

    for (let n = 1; n <= totalCells; n++) {
      const alreadyMarked = state.selectionsHistory.some(h => h.number === n);
      if (!alreadyMarked) availableNumbers.push(n);
    }

    if (availableNumbers.length === 0) return;

    const randomPick = availableNumbers[Math.floor(Math.random() * availableNumbers.length)];

    // Mark number as friend
    markNumber(randomPick, 'friend', botPlayer.name, true);
    Sound.friendPick();
    showToast(`🟡 ${botPlayer.name} selected ${randomPick}`, 'toast-yellow');

    broadcastMessage({
      type: 'PLAYER_MOVE',
      roomCode: state.roomCode,
      number: randomPick,
      playerId: botPlayer.id,
      playerName: botPlayer.name
    });

    checkGameWin();
    if (!state.winner) {
      advanceTurn();
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
    el.winnerPlayerName.textContent = `${winnerName} Won!`;
    el.screenWinner.classList.add('active');
    Sound.win();
    startConfetti();
  }

  function startConfetti() {
    const canvas = el.confettiCanvas;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    particles = [];
    const colors = ['#23a46f', '#ecab08', '#2dd4bf', '#ffffff', '#3b82f6', '#ec4899'];
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
  // 14. REAL-TIME BROADCAST PROTOCOL (Live Multiplayer Across Tabs)
  // ----------------------------------------------------------------------------
  function broadcastMessage(payload) {
    if (channel) {
      channel.postMessage(payload);
    }
  }

  function handleIncomingBroadcast(data) {
    if (!data || !data.roomCode || data.roomCode !== state.roomCode) return;

    // A player joined the room
    if (data.type === 'PLAYER_JOINED') {
      const incoming = data.player;
      if (incoming.id !== state.myPlayerId) {
        const alreadyIn = state.players.some(p => p.id === incoming.id);
        if (!alreadyIn && state.players.length < state.playerLimit) {
          state.players.push(incoming);
          Sound.join();
          showToast(`🎉 ${incoming.name} joined the room!`, 'toast-green');
          renderWaitingRoom();

          // Host replies with full room state to synchronize joiner
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
    }

    // Room synchronization packet
    else if (data.type === 'ROOM_SYNC') {
      state.boardSize = data.boardSize;
      state.playerLimit = data.playerLimit;
      state.players = data.players;
      renderWaitingRoom();
    }

    // Host started the game
    else if (data.type === 'START_GAME') {
      state.players = data.players || state.players;
      setupNewBoard();
      showScreen('game');
      Sound.join();
      showToast('Game has started! Good luck!', 'toast-green');
    }

    // A player made a move
    else if (data.type === 'PLAYER_MOVE') {
      if (data.playerId !== state.myPlayerId) {
        markNumber(data.number, 'friend', data.playerName, true);
        Sound.friendPick();
        showToast(`🟡 ${data.playerName} selected ${data.number}`, 'toast-yellow');
        checkGameWin();
        if (!state.winner) {
          advanceTurn();
        }
      }
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

    // Player left
    else if (data.type === 'PLAYER_LEFT') {
      state.players = state.players.filter(p => p.id !== data.playerId);
      showToast(`${data.playerName} left the room.`, 'toast-yellow');
      if (state.currentScreen === 'waiting') {
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
  // 15. EVENT LISTENERS
  // ----------------------------------------------------------------------------
  function setupEventListeners() {

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
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', state.theme);
      el.btnThemeToggle.textContent = state.theme === 'dark' ? '☀️' : '🌙';
      localStorage.setItem('bingo_theme', state.theme);
      Sound.click();
    }
    el.btnThemeToggle.addEventListener('click', toggleTheme);

    // Profile / Name Prompt
    el.btnLoginModal.addEventListener('click', () => {
      Sound.click();
      const newName = prompt('Enter your player name:', state.playerName);
      if (newName && newName.trim()) {
        state.playerName = newName.trim();
        localStorage.setItem('bingo_user_name', state.playerName);
        if (state.players.length > 0 && state.players[0].id === state.myPlayerId) {
          state.players[0].name = state.playerName;
        }
        updateRoomDetails();
        renderWaitingRoom();
        showToast(`Name updated to ${state.playerName}!`, 'toast-green');
      }
    });

    // --- Home Navigation ---
    el.btnGotoCreate.addEventListener('click', () => {
      Sound.click();
      el.inputCreatorName.value = state.playerName;
      showScreen('create');
    });

    el.btnGotoJoin.addEventListener('click', () => {
      Sound.click();
      el.inputJoinName.value = state.playerName;
      showScreen('join');
    });

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
      }

      state.roomCode = generateRoomCode();
      state.isHost = true;

      // Only Host is present initially! NO DUMMY PLAYERS!
      state.players = [{
        id: state.myPlayerId,
        name: state.playerName,
        isHost: true,
        isReady: true,
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

      // Joiner registers self
      const myPlayerObj = {
        id: state.myPlayerId,
        name: state.playerName,
        isHost: false,
        isReady: true,
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

      showToast(`Joined Room ${code}! Connecting...`, 'toast-green');
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
        const botNames = ['Karthik (Bot)', 'Ramesh (Bot)', 'Suresh (Bot)'];
        const botName = botNames[botIdx - 1] || `Player ${botIdx + 1} (Bot)`;

        const botPlayer = {
          id: 'bot_' + Date.now(),
          name: botName,
          isHost: false,
          isReady: true,
          isBot: true,
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
        players: state.players
      });
    });

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

    // --- Winner Screen Actions ---
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
          <li>When you pick a number, it turns <strong>Green</strong> on your board.</li>
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
      avatarClass: 'avatar-s'
    }];

    updateRoomDetails();
    setupEventListeners();
    initIntro();
  }

  // Boot on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
