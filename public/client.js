/* Client‑side logic for the Singaporean Bridge game.
 * Connects to the server via Socket.IO and updates the UI based on
 * events. Supports lobby with list of open rooms, ready system,
 * host‑only start, bidding with auto pass after timer, call card,
 * trick play with centre display, and per‑turn timer. See server.js
 * for details on game flow.
 */

(() => {
  const socket = io();

  // --- Global state ---
  let myId = null;
  let myPos = null;
  let currentRoomCode = null;
  let players = [];
  let hand = [];
  let biddingTurn = null;
  let playingTurn = null;
  let highestBid = null;
  let declarer = null;
  let partnerPos = null;
  // Card called by the declarer (rank & suit) and trump suit
  let callCard = null;
  let trumpSuit = null;
  // Sets won by each player; array of 4 numbers updated after each round
  let playersSets = [0, 0, 0, 0];
  // Tracks the number of tricks (won hands) each player has taken in the current deal
  let playersTricks = [0, 0, 0, 0];
  // History of rounds; each item contains declarer, partner, trick counts, contract, result
  let scoreHistory = [];
  // Whether logs are hidden
  let logsHidden = true;
  let hostId = null;
  let ready = false;
  let isHost = false;
  let stage = 'lobby'; // lobby|bidding|callCard|playing
  let trick = [];

  // --- DOM elements ---
  const lobbyDiv = document.getElementById('lobby');
  const roomsListDiv = document.getElementById('roomsList');
  const playerNameInput = document.getElementById('playerName');
  const roomCodeInput = document.getElementById('roomCodeInput');
  const createBtn = document.getElementById('createBtn');
  const joinBtn = document.getElementById('joinBtn');
  const lobbyMessageDiv = document.getElementById('lobbyMessage');
  const playersHeading = document.getElementById('playersHeading');
  const currentPlayersDiv = document.getElementById('currentPlayers');
  const readyBtn = document.getElementById('readyBtn');
  const startBtn = document.getElementById('startBtn');
  const timerSelect = document.getElementById('timerSelect');
  const gameDiv = document.getElementById('game');
  const tableDiv = document.getElementById('table');
  const trickArea = document.getElementById('trick-area');
  const myHandDiv = document.getElementById('my-hand');
  const messageArea = document.getElementById('message-area');
  const scoreboardDiv = document.getElementById('scoreboard');

  // New UI elements
  const bidTrumpInfoDiv = document.getElementById('bidTrumpInfo');
  const toggleLogsBtn = document.getElementById('toggleLogsBtn');
  const bidButtonsDiv = document.getElementById('bidButtons');

  const countdownDiv = document.getElementById('countdown');
  const biddingPanel = document.getElementById('bidding-panel');
  // Bid buttons container for simplified bidding UI (already declared above)
  const passBidBtn = document.getElementById('passBidBtn');
  const bidStatusDiv = document.getElementById('bidStatus');
  const callCardPanel = document.getElementById('call-card-panel');
  const callRankSelect = document.getElementById('callRank');
  const callSuitSelect = document.getElementById('callSuit');
  const confirmCallBtn = document.getElementById('confirmCallBtn');

  // Create bidding buttons once
  createBidButtons();

  // --- Audio ---
  let audioCtx;
  let musicInterval;
  function startBackgroundMusic() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      // Ensure the audio context is resumed (required on some browsers)
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      // Define a simple soothing chord progression (C, D, E major). Each chord plays softly and lingers.
      const chords = [
        [261.63, 329.63, 392.0], // C major (C E G)
        [293.66, 369.99, 440.0], // D major (D F# A)
        [329.63, 415.30, 493.88], // E major (E G# B)
      ];
      let chordIndex = 0;
      function playChord(freqs) {
        freqs.forEach((freq) => {
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
          // Fade in and out gently
          gain.gain.setValueAtTime(0, audioCtx.currentTime);
          // Increase volume slightly for audibility
          gain.gain.linearRampToValueAtTime(0.06, audioCtx.currentTime + 0.2);
          gain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 3.0);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start();
          osc.stop(audioCtx.currentTime + 3.0);
        });
      }
      function playNextChord() {
        const freqs = chords[chordIndex % chords.length];
        chordIndex++;
        playChord(freqs);
      }
      // Play the first chord immediately
      playNextChord();
      if (musicInterval) clearInterval(musicInterval);
      musicInterval = setInterval(playNextChord, 8000);
    } catch (e) {
      console.error('Audio error:', e);
    }
  }

  /**
   * Play a short beep sound. Used in countdown when only a few seconds remain.
   */
  function playBeep() {
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.15);
    } catch (e) {
      console.error('Beep error', e);
    }
  }

  // Countdown timer state
  let countdownInterval = null;
  let lastBeepAt = null;
  /**
   * Start displaying a countdown for the given duration (ms). Shows the
   * remaining seconds and plays a beep every second when only a few
   * seconds remain (<=3). If turnMs is falsy or zero, no countdown
   * runs.
   * @param {number} turnMs
   */
  function startCountdown(turnMs) {
    stopCountdown();
    if (!turnMs || turnMs <= 0) {
      return;
    }
    const endTime = Date.now() + turnMs;
    lastBeepAt = null;
    if (countdownDiv) {
      countdownDiv.classList.remove('hidden');
    }
    countdownInterval = setInterval(() => {
      const remainingMs = endTime - Date.now();
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
      if (countdownDiv) {
        countdownDiv.textContent = `${remainingSec}s`;
      }
      // Beep when 3s or less remain, beep once per second
      if (remainingSec <= 3 && remainingSec > 0 && remainingSec !== lastBeepAt) {
        playBeep();
        lastBeepAt = remainingSec;
      }
      if (remainingSec <= 0) {
        stopCountdown();
      }
    }, 200);
  }
  /**
   * Stop the current countdown timer and hide the display.
   */
  function stopCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    if (countdownDiv) {
      countdownDiv.textContent = '';
      countdownDiv.classList.add('hidden');
    }
    lastBeepAt = null;
  }

  // --- Utility functions ---
  function prettyCard(cardStr) {
    // Accepts already formatted string (e.g. '10H', 'AS'); returns string for display with Unicode suits
    const rank = cardStr.slice(0, -1);
    const suit = cardStr.slice(-1);
    const suitMap = { C: '♣', D: '♦', H: '♥', S: '♠' };
    return `${rank}${suitMap[suit] || suit}`;
  }
  function clearChildNodes(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // Suit ranking for bidding comparison: Clubs < Diamonds < Hearts < Spades < No Trump
  const SUIT_RANKING = { C: 0, D: 1, H: 2, S: 3, N: 4 };

  /**
   * Compare two bids to determine if bidA outranks bidB. If bidB is null,
   * bidA outranks automatically. Each bid is an object with level and suit.
   * @param {{level:number,suit:string}} bidA
   * @param {{level:number,suit:string}|null} bidB
   */
  function isHigherBid(bidA, bidB) {
    if (!bidB) return true;
    if (bidA.level > bidB.level) return true;
    if (bidA.level === bidB.level && SUIT_RANKING[bidA.suit] > SUIT_RANKING[bidB.suit]) return true;
    return false;
  }

  /**
   * Create bidding buttons (1–7 for each suit) and attach click handlers. This
   * function is called once on page load. Buttons are disabled/enabled
   * dynamically during bidding based on the current highest bid.
   */
  function createBidButtons() {
    if (!bidButtonsDiv) return;
    clearChildNodes(bidButtonsDiv);
    // Define suits including No Trump; 'N' will be shown as 'NT'
    const suits = ['C', 'D', 'H', 'S', 'N'];
    const suitSymbols = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' };
    // Create one row per suit. Each row has a label and seven buttons for levels 1–7.
    suits.forEach((suit) => {
      const rowDiv = document.createElement('div');
      rowDiv.className = 'bid-row';
      // Suit label at the start of the row
      const labelSpan = document.createElement('span');
      labelSpan.className = `bid-row-label suit-${suit}`;
      labelSpan.textContent = suitSymbols[suit];
      rowDiv.appendChild(labelSpan);
      for (let level = 1; level <= 7; level++) {
        const btn = document.createElement('button');
        btn.className = `bid-button suit-${suit}`;
        btn.dataset.level = String(level);
        btn.dataset.suit = suit;
        const suitSymbol = suitSymbols[suit];
        // Build button content: level number and suit symbol separately
        btn.innerHTML = `<span class="bid-level">${level}</span><span class="bid-suit suit-${suit}">${suitSymbol}</span>`;
        btn.addEventListener('click', () => {
          // Only allow bidding if it's your turn and stage is bidding
          if (stage !== 'bidding' || myPos !== biddingTurn) return;
          const levelNum = Number(btn.dataset.level);
          const suitVal = btn.dataset.suit;
          socket.emit('placeBid', { roomCode: currentRoomCode, level: levelNum, suit: suitVal });
        });
        rowDiv.appendChild(btn);
      }
      bidButtonsDiv.appendChild(rowDiv);
    });
  }

  /**
   * Enable or disable bid buttons based on the current highest bid. Buttons
   * representing bids that do not outrank the current highest bid will be
   * disabled (greyed out) for the active bidder. Other players do not see
   * this state because buttons are hidden when it's not their turn.
   */
  function updateBidButtons() {
    if (!bidButtonsDiv) return;
    const buttons = bidButtonsDiv.querySelectorAll('.bid-button');
    buttons.forEach((btn) => {
      const levelNum = Number(btn.dataset.level);
      const suitVal = btn.dataset.suit;
      const bidCandidate = { level: levelNum, suit: suitVal };
      const disabled = highestBid ? !isHigherBid(bidCandidate, highestBid) : false;
      if (disabled) {
        btn.classList.add('disabled');
      } else {
        btn.classList.remove('disabled');
      }
    });
  }

  /**
   * Update the contract/trump/call/partner info panel. This displays
   * the current highest bid (contract), trump suit, declarer, call
   * card and partner when known. It is hidden when there is no
   * contract yet.
   */
  function updateBidTrumpInfo() {
    if (!bidTrumpInfoDiv) return;
    // If no contract (no highestBid) or not in game stage, hide the info
    if (!highestBid || !stage || (stage !== 'callCard' && stage !== 'playing')) {
      bidTrumpInfoDiv.classList.add('hidden');
      bidTrumpInfoDiv.innerHTML = '';
      return;
    }
    const suitMap = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' };
    const suitClassMap = { C: 'suit-C', D: 'suit-D', H: 'suit-H', S: 'suit-S', N: 'suit-N' };
    let html = '';
    const bidSuit = highestBid.suit;
    // Contract: handle No Trump separately. For NT, display 'NT' next to level without suit colour.
    let contractStr;
    if (bidSuit === 'N') {
      contractStr = `<span>${highestBid.level}<span class="suit-N">NT</span></span>`;
    } else {
      contractStr = `<span>${highestBid.level}<span class="${suitClassMap[bidSuit]}">${suitMap[bidSuit]}</span></span>`;
    }
    html += `<div><strong>Contract:</strong> ${contractStr}</div>`;
    // Trump: for NT, show 'No Trump'; otherwise the suit symbol coloured
    if (bidSuit === 'N') {
      html += `<div><strong>Trump:</strong> No&nbsp;Trump</div>`;
    } else {
      html += `<div><strong>Trump:</strong> <span class="${suitClassMap[bidSuit]}">${suitMap[bidSuit]}</span></div>`;
    }
    // Declarer: show name rather than P#
    if (declarer !== null && declarer !== undefined && players[declarer]) {
      html += `<div><strong>Declarer:</strong> ${players[declarer].name}</div>`;
    }
    // Call card (not shown if no callCard)
    if (callCard) {
      const rankMap = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
      const rankStr = callCard.rank <= 10 ? String(callCard.rank) : rankMap[callCard.rank];
      if (callCard.suit === 'N') {
        // No Trump call card should not occur but handle gracefully
        html += `<div><strong>Call:</strong> ${rankStr}</div>`;
      } else {
        const callSuitClass = suitClassMap[callCard.suit];
        html += `<div><strong>Call:</strong> <span>${rankStr}<span class="${callSuitClass}">${suitMap[callCard.suit]}</span></span></div>`;
      }
    }
    // Do not display partner here; partner will be shown in scoreboard instead
    bidTrumpInfoDiv.innerHTML = html;
    bidTrumpInfoDiv.classList.remove('hidden');
  }

  /**
   * Update the scoreboard. Displays sets (round wins) for each player
   * and the history of rounds. History is an array of objects with
   * declarer, partner, declarerTeamTricks, defenderTeamTricks,
   * contractMade, highestBid. playersSets is an array of ints.
   */
  function updateScoreboard(history = [], playersSetsArray = []) {
    if (!scoreboardDiv) return;
    clearChildNodes(scoreboardDiv);
    // Determine winners of the last round based on the last history entry
    let lastRound = null;
    if (Array.isArray(history) && history.length > 0) {
      lastRound = history[history.length - 1];
    }
    let winnersSet = new Set();
    let declarerPos = null;
    if (lastRound) {
      declarerPos = lastRound.declarer;
      if (lastRound.contractMade) {
        winnersSet.add(lastRound.declarer);
        if (lastRound.partner !== null && lastRound.partner !== undefined) {
          winnersSet.add(lastRound.partner);
        }
      } else {
        // Defenders win: all except declarer and partner
        players.forEach((p, idx) => {
          if (idx !== lastRound.declarer && idx !== lastRound.partner) {
            winnersSet.add(idx);
          }
        });
      }
    }
    // Create a row for each player displaying their name, sets, and crown if declarer
    players.forEach((p, idx) => {
      const row = document.createElement('div');
      row.className = 'scoreboard-player';
      if (winnersSet.has(idx)) {
        row.classList.add('winner');
      } else {
        row.classList.add('loser');
      }
      // Player name with crown if declarer
      let nameHtml = p.name;
      if (declarerPos !== null && idx === declarerPos) {
        nameHtml += ' <span class="crown-icon">👑</span>';
      }
      // Ready indicator (tick) if player has readied up and stage is waiting
      const readyIcon = (stage === 'waiting' && p.ready) ? ' ✓' : '';
      const setsCount = playersSetsArray[idx] || 0;
      // Build the content container
      const nameSpan = document.createElement('span');
      nameSpan.className = 'player-name';
      nameSpan.innerHTML = nameHtml + readyIcon;
      const setsSpan = document.createElement('span');
      setsSpan.className = 'player-sets';
      setsSpan.textContent = `(${setsCount} set${setsCount === 1 ? '' : 's'})`;
      row.appendChild(nameSpan);
      row.appendChild(setsSpan);
      // If this row corresponds to the current player, add a ready/unready toggle button
      if (idx === myPos) {
        const readyToggleBtn = document.createElement('button');
        readyToggleBtn.className = 'scoreboard-ready-btn';
        readyToggleBtn.textContent = p.ready ? 'Unready' : 'Ready';
        readyToggleBtn.addEventListener('click', () => {
          // Toggle ready state for the local player
          const newReady = !p.ready;
          socket.emit('setReady', { roomCode: currentRoomCode, ready: newReady });
          // Locally update ready variable; p.ready will be updated on next playerList event
          ready = newReady;
        });
        row.appendChild(readyToggleBtn);
      }
      scoreboardDiv.appendChild(row);
    });
    // Append a New Game button for the host to start another deal
    if (isHost && currentRoomCode) {
      const btnDiv = document.createElement('div');
      btnDiv.style.marginTop = '0.8em';
      const newGameBtn = document.createElement('button');
      newGameBtn.id = 'newGameBtn';
      newGameBtn.textContent = 'Start New Game';
      newGameBtn.style.padding = '6px 12px';
      newGameBtn.style.fontSize = '1em';
      newGameBtn.addEventListener('click', () => {
        const turnSeconds = parseInt(timerSelect?.value || '0', 10);
        socket.emit('startGame', { roomCode: currentRoomCode, turnMs: turnSeconds * 1000 }, (res) => {
          if (!res || !res.ok) {
            alert(res?.error || 'Failed to start game');
          }
        });
      });
      btnDiv.appendChild(newGameBtn);
      scoreboardDiv.appendChild(btnDiv);
    }
  }
  function updateLobbyRooms(list) {
    // Populate the rooms list with join buttons
    clearChildNodes(roomsListDiv);
    if (!list || list.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'No open rooms. Create one!';
      roomsListDiv.appendChild(p);
      return;
    }
    list.forEach((room) => {
      const div = document.createElement('div');
      div.className = 'room-entry';
      const info = document.createElement('span');
      info.textContent = `${room.code} (${room.players}/4)`;
      div.appendChild(info);
      const btn = document.createElement('button');
      btn.textContent = 'Join';
      btn.addEventListener('click', () => {
        // Auto join the selected room instead of just filling the code
        const name = playerNameInput?.value?.trim?.();
        if (!name) {
          alert('Please enter your name');
          return;
        }
        currentRoomCode = room.code;
        startBackgroundMusic();
        socket.emit('joinRoom', { roomCode: room.code, name });
      });
      div.appendChild(btn);
      roomsListDiv.appendChild(div);
    });
  }

  /**
   * Update the list of players displayed in the lobby once a room is joined.
   * Shows each player's name and ready status.
   * @param {Array<{id:string,name:string,pos:number,ready:boolean}>} list
   */
  function updateCurrentPlayers(list) {
    if (!currentPlayersDiv) return;
    clearChildNodes(currentPlayersDiv);
    list.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'player-entry';
      div.textContent = p.name + (p.ready ? ' (ready)' : '');
      currentPlayersDiv.appendChild(div);
    });
  }
  function updatePlayersUI() {
    // Determine relative seating for each player based on my position
    const seatOrder = ['bottom', 'right', 'top', 'left'];
    players.forEach((p) => {
      const rel = (p.pos - myPos + 4) % 4;
      const seat = seatOrder[rel];
      const seatDiv = document.getElementById(`player-${seat}`);
      if (!seatDiv) return;
      const nameDiv = seatDiv.querySelector('.name');
      const countDiv = seatDiv.querySelector('.card-count');
      const setsDiv = seatDiv.querySelector('.sets-count');
      const playedDiv = seatDiv.querySelector('.played-card');
      // Build name HTML: always show name, append ready tick in lobby/waiting, and crown icon for declarer after bidding
      let nameHtml = p.name;
      if (stage === 'lobby' || stage === 'waiting') {
        nameHtml += p.ready ? ' ✓' : '';
      }
      // Show crown for the highest bidder/declarer in callCard, playing, or waiting stage
      if (declarer !== null && declarer !== undefined && p.pos === declarer && (stage === 'callCard' || stage === 'playing' || stage === 'waiting')) {
        nameHtml += ' <span class="crown-icon">👑</span>';
      }
      nameDiv.innerHTML = nameHtml;
      // Do not show remaining card count during play. Hide this text completely
      if (countDiv) {
        countDiv.textContent = '';
      }
      // Display number of won hands (tricks) for this player during a deal. If no tricks yet, show 0.
      if (setsDiv) {
        const tricks = p.tricks !== undefined ? p.tricks : (Array.isArray(playersTricks) ? playersTricks[p.pos] : 0);
        setsDiv.textContent = tricks !== undefined ? String(tricks) : '';
      }
      // Clear played card; will update via cardPlayed event
      // Highlight whose turn it is
      seatDiv.classList.remove('active-turn');
      if (stage === 'bidding' && p.pos === biddingTurn) {
        seatDiv.classList.add('active-turn');
      } else if (stage === 'playing' && p.pos === playingTurn) {
        seatDiv.classList.add('active-turn');
      }
    });
  }
  function updateHandUI() {
    clearChildNodes(myHandDiv);
    hand.forEach((card) => {
      const btn = document.createElement('button');
      btn.className = 'card';
      btn.textContent = prettyCard(card);
      // Assign suit class for colouring
      const suit = card.slice(-1);
      btn.classList.add('suit-' + suit);
      btn.addEventListener('click', () => {
        // Only allow playing card when it's your turn and stage is playing
        if (stage !== 'playing' || myPos !== playingTurn) return;
        socket.emit('playCard', { roomCode: currentRoomCode, card });
      });
      myHandDiv.appendChild(btn);
    });
  }
  function updateTrickCenter() {
    clearChildNodes(trickArea);
    trick.forEach((entry, i) => {
      const div = document.createElement('div');
      div.className = 'trick-card';
      if (i === trick.length - 1) div.classList.add('latest');
      div.textContent = prettyCard(entry.card);
      trickArea.appendChild(div);
    });
  }
  function showMessage(msg) {
    // Replace any generic 'player X' with the actual player name for clarity
    const processed = replacePlayerPlaceholders(msg);
    const p = document.createElement('p');
    p.textContent = processed;
    messageArea.appendChild(p);
    messageArea.scrollTop = messageArea.scrollHeight;
  }

  /**
   * Replace occurrences of 'player {number}' in a message string with the
   * corresponding player's name. Preserves the rest of the string.
   * @param {string} msg
   * @returns {string}
   */
  function replacePlayerPlaceholders(msg) {
    if (!msg) return msg;
    return msg.replace(/player\s(\d+)/gi, (_, num) => {
      const idx = parseInt(num, 10);
      return players[idx] ? players[idx].name : `player ${num}`;
    });
  }
  function resetGameUI() {
    hand = [];
    // Stop any existing countdown timer
    stopCountdown();
    highestBid = null;
    declarer = null;
    partnerPos = null;
    biddingTurn = null;
    playingTurn = null;
    trick = [];
    clearChildNodes(myHandDiv);
    clearChildNodes(trickArea);
    clearChildNodes(messageArea);
    bidStatusDiv.textContent = '';
    scoreboardDiv.textContent = '';
    biddingPanel.classList.add('hidden');
    callCardPanel.classList.add('hidden');
    updatePlayersUI();
  }

  // --- Lobby event handlers ---
  // Guard each element in case the DOM is missing it. This prevents
  // "Cannot read properties of null" errors if the HTML structure
  // changes or elements are not present.
  if (createBtn) {
    createBtn.addEventListener('click', () => {
      const name = playerNameInput?.value?.trim?.();
      if (!name) {
        alert('Please enter your name');
        return;
      }
      startBackgroundMusic();
      socket.emit('createRoom', { name });
    });
  }
  if (joinBtn) {
    joinBtn.addEventListener('click', () => {
      const name = playerNameInput?.value?.trim?.();
      const code = roomCodeInput?.value?.trim?.().toUpperCase?.() || '';
      if (!name) {
        alert('Please enter your name');
        return;
      }
      if (!code) {
        alert('Please enter or select a room code');
        return;
      }
      startBackgroundMusic();
      currentRoomCode = code;
      socket.emit('joinRoom', { roomCode: code, name });
    });
  }
  if (readyBtn) {
    readyBtn.addEventListener('click', () => {
      if (!currentRoomCode) return;
      ready = !ready;
      socket.emit('setReady', { roomCode: currentRoomCode, ready });
    });
  }
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      if (!currentRoomCode) return;
      const turnSeconds = parseInt(timerSelect?.value || '0', 10);
      socket.emit(
        'startGame',
        { roomCode: currentRoomCode, turnMs: turnSeconds * 1000 },
        (res) => {
          if (!res || !res.ok) {
            alert(res?.error || 'Failed to start game');
          }
        },
      );
    });
  }
  if (passBidBtn) {
    passBidBtn.addEventListener('click', () => {
      if (!currentRoomCode) return;
      socket.emit('placeBid', { roomCode: currentRoomCode, level: 0, suit: null });
    });
  }
  if (confirmCallBtn) {
    confirmCallBtn.addEventListener('click', () => {
      if (!currentRoomCode) return;
      const rank = callRankSelect?.value;
      const suit = callSuitSelect?.value;
      socket.emit('callCard', { roomCode: currentRoomCode, rank: Number(rank), suit });
      callCardPanel?.classList?.add('hidden');
    });
  }

  // Toggle logs visibility
  if (toggleLogsBtn) {
    toggleLogsBtn.addEventListener('click', () => {
      logsHidden = !logsHidden;
      if (logsHidden) {
        messageArea.classList.add('hidden');
        toggleLogsBtn.textContent = 'Show Logs';
      } else {
        messageArea.classList.remove('hidden');
        toggleLogsBtn.textContent = 'Hide Logs';
      }
    });
    // Initialize button text based on default hidden state
    toggleLogsBtn.textContent = logsHidden ? 'Show Logs' : 'Hide Logs';
  }

  // --- Socket event handlers ---
  socket.on('connect', () => {
    myId = socket.id;
  });
  socket.on('roomsList', ({ rooms }) => {
    updateLobbyRooms(rooms);
  });
  socket.on('roomCreated', ({ roomCode }) => {
    // auto fill code input
    roomCodeInput.value = roomCode;
    showMessage(`Room ${roomCode} created. You have been added as host.`);
    // Automatically join the newly created room as the host
    const name = playerNameInput?.value?.trim?.();
    if (name) {
      currentRoomCode = roomCode;
      socket.emit('joinRoom', { roomCode, name });
    }
  });
  socket.on('errorMessage', ({ message }) => {
    alert(message);
  });
  socket.on('message', ({ message }) => {
    showMessage(message);
  });
  socket.on('playerList', ({ players: pList, hostId: hId }) => {
    players = pList;
    hostId = hId;
    isHost = myId === hostId;
    // Determine my position
    const me = players.find((p) => p.id === myId);
    if (me) {
      myPos = me.pos;
    }
    // In lobby/waiting stage, show ready/start controls and list players
    if (stage === 'lobby' || stage === 'waiting') {
      readyBtn?.classList?.remove('hidden');
      // Only host sees start button and timer
      if (isHost) {
        startBtn?.classList?.remove('hidden');
        timerSelect?.classList?.remove('hidden');
      } else {
        startBtn?.classList?.add('hidden');
        timerSelect?.classList?.add('hidden');
      }
      // Show or hide current players list depending on whether in a room
      if (currentRoomCode) {
        playersHeading?.classList?.remove('hidden');
        currentPlayersDiv?.classList?.remove('hidden');
        updateCurrentPlayers(players);
      } else {
        playersHeading?.classList?.add('hidden');
        currentPlayersDiv?.classList?.add('hidden');
      }
    }
    updatePlayersUI();
    // Update playersSets from server data if available
    if (Array.isArray(pList) && pList.length === 4) {
      playersSets = pList.map((p) => p.sets || 0);
      updateScoreboard(scoreHistory, playersSets);
    }
  });
  socket.on('dealStarted', ({ players: pList, dealer }) => {
    stage = 'bidding';
    players = pList;
    callCard = null;
    trumpSuit = null;
    partnerPos = null;
    highestBid = null;
    declarer = null;
    // Reset per-player trick counts for new deal
    playersTricks = [0, 0, 0, 0];
    players.forEach((p) => {
      p.tricks = 0;
    });
    // Determine my pos
    const me = players.find((p) => p.id === myId);
    if (me) myPos = me.pos;
    // Hide lobby, show game
    lobbyDiv.classList.add('hidden');
    gameDiv.classList.remove('hidden');
    resetGameUI();
    // Replace dealer index with name
    const dealerName = pList && pList[dealer] ? pList[dealer].name : `Player ${dealer}`;
    showMessage(`New deal started. Dealer is ${dealerName}.`);
    // Hide contract/trump info until a contract is established
    updateBidTrumpInfo();
  });
  socket.on('dealCards', ({ hand: h }) => {
    hand = h;
    updateHandUI();
  });
  socket.on('biddingTurn', ({ pos, turnMs }) => {
    biddingTurn = pos;
    const bidderName = players[pos] ? players[pos].name : `Player ${pos}`;
    showMessage(`${bidderName} to bid.`);
    // Show bidding panel for the current player and update bid buttons
    if (stage === 'bidding' && myPos === pos) {
      biddingPanel.classList.remove('hidden');
      updateBidButtons();
    } else {
      biddingPanel.classList.add('hidden');
    }
    updatePlayersUI();
    // Start countdown timer if provided
    if (typeof turnMs === 'number') {
      startCountdown(turnMs);
    } else {
      stopCountdown();
    }
  });
  socket.on('bidUpdate', ({ bidder, bid, passes }) => {
    // Update highest bid string
    if (bid) {
      highestBid = bid;
      const suitMap = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' };
      const bidderName = players[bidder] ? players[bidder].name : `Player ${bidder}`;
      bidStatusDiv.textContent = `${bidderName} bids ${bid.level}${suitMap[bid.suit] || ''}`;
    } else {
      const bidderName = players[bidder] ? players[bidder].name : `Player ${bidder}`;
      showMessage(`${bidderName} passes.`);
    }
    // Refresh bid buttons to disable bids lower than new highest bid
    updateBidButtons();
  });
  socket.on('biddingComplete', ({ highestBid: bid, declarer: dec, trumpSuit }) => {
    stage = 'callCard';
    declarer = dec;
    highestBid = bid;
    trumpSuit = trumpSuit;
    const suitMap = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' };
    const declarerName = players[dec] ? players[dec].name : `Player ${dec}`;
    let contractStr;
    if (bid.suit === 'N') {
      contractStr = `${bid.level}NT`;
    } else {
      contractStr = `${bid.level}${suitMap[bid.suit]}`;
    }
    let trumpStr;
    if (bid.suit === 'N') {
      trumpStr = 'No Trump';
    } else {
      trumpStr = suitMap[trumpSuit] || '';
    }
    showMessage(`Bidding complete. Declarer is ${declarerName}, contract ${contractStr}, trump ${trumpStr}.`);
    biddingPanel.classList.add('hidden');
    updateBidTrumpInfo();
  });
  socket.on('yourTurnToCall', () => {
    // Prompt declarer to call a card
    showMessage('Select rank and suit of your partner card.');
    callCardPanel.classList.remove('hidden');
  });
  socket.on('waitingForCall', () => {
    showMessage('Waiting for declarer to call a card...');
    callCardPanel.classList.add('hidden');
  });

  // When the partner card is played by someone other than the declarer,
  // the server reveals the partner's position. Update the UI accordingly.
  socket.on('partnerRevealed', ({ partner }) => {
    partnerPos = partner;
    const partnerName = players[partner] ? players[partner].name : `Player ${partner}`;
    showMessage(`Partner revealed: ${partnerName}.`);
    updateBidTrumpInfo();
  });
  socket.on('callCardSelected', ({ rank, suit }) => {
    stage = 'playing';
    // Clear call panel
    callCardPanel.classList.add('hidden');
    const suitMap = { C: '♣', D: '♦', H: '♥', S: '♠' };
    const declarerName = players[declarer] ? players[declarer].name : `Player ${declarer}`;
    showMessage(`${declarerName} called ${rank}${suitMap[suit]}. Play begins.`);
    // Save call card for display
    callCard = { rank, suit };
    updateBidTrumpInfo();
  });
  socket.on('playTurn', ({ pos, turnMs }) => {
    playingTurn = pos;
    const playerName = players[pos] ? players[pos].name : `Player ${pos}`;
    showMessage(`${playerName} to play.`);
    // Hide bidding panel
    biddingPanel.classList.add('hidden');
    updatePlayersUI();
    // Start countdown timer if provided
    if (typeof turnMs === 'number') {
      startCountdown(turnMs);
    } else {
      stopCountdown();
    }
  });
  socket.on('cardPlayed', ({ player: p, card, remaining }) => {
    // Update trick array and player's card count
    trick.push({ player: p, card });
    if (players[p]) players[p].cardsRemaining = remaining;
    // Remove the card from my hand if I played it
    if (p === myPos) {
      const idx = hand.indexOf(card);
      if (idx !== -1) hand.splice(idx, 1);
      updateHandUI();
    }
    updateTrickCenter();
    updatePlayersUI();
  });
  socket.on('trickComplete', ({ trick: completedTrick, winner, declarerTeamTricks, defenderTeamTricks, playersTricks: pTricks }) => {
    const winnerName = players[winner] ? players[winner].name : `Player ${winner}`;
    showMessage(`Trick won by ${winnerName}.`);
    // Reset trick state after short delay
    trick = [];
    updateTrickCenter();
    // Show current trick totals in message area
    showMessage(`Declarer team now has ${declarerTeamTricks} trick${declarerTeamTricks === 1 ? '' : 's'}, defenders have ${defenderTeamTricks}.`);
    // Update per-player trick counts if provided
    if (Array.isArray(pTricks)) {
      playersTricks = pTricks;
      // Reflect these counts on player objects for display
      players.forEach((pl, i) => {
        pl.tricks = pTricks[i] || 0;
      });
    }
    updatePlayersUI();
  });
  socket.on('roundFinished', ({
    declarer: dec,
    partner,
    declarerTeamTricks,
    defenderTeamTricks,
    contractMade,
    highestBid: bid,
    playersSets: pSets,
    history,
  }) => {
    const suitMap = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' };
    const declarerName = players[dec] ? players[dec].name : `Player ${dec}`;
    const partnerName = partner >= 0 && players[partner] ? players[partner].name : '-';
    let contractStr;
    if (bid.suit === 'N') {
      contractStr = `${bid.level}NT`;
    } else {
      contractStr = `${bid.level}${suitMap[bid.suit]}`;
    }
    showMessage(
      `Round finished. Declarer ${declarerName} with partner ${partnerName} took ${declarerTeamTricks} tricks against ${defenderTeamTricks}. Contract ${contractStr} was ${contractMade ? 'made' : 'not made'}.`,
    );
    // Update local sets and round history
    if (Array.isArray(pSets) && pSets.length === 4) {
      playersSets = pSets;
    }
    if (Array.isArray(history)) {
      scoreHistory = history;
    }
    // Reset call card and partner for next round display
    callCard = null;
    partnerPos = null;
    // Stop countdown timer as round has ended
    stopCountdown();
    // Move to waiting/scoreboard stage: clear game UI
    stage = 'waiting';
    resetGameUI();
    // Show updated scoreboard and player states
    updateScoreboard(scoreHistory, playersSets);
    updatePlayersUI();
    updateBidTrumpInfo();
  });
})();