const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Create the Express application and HTTP server
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static assets from the public directory
app.use(express.static(__dirname + '/public'));

/**
 * Generate a random uppercase alphanumeric room code. Avoid letters
 * that are easily confused (I, O, 1, 0) to make entry easier. Room
 * codes must be unique across all active rooms.
 *
 * @param {number} length Number of characters in the code
 * @returns {string}
 */
function generateRoomCode(length = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Suit ranking used for bidding comparison: Clubs < Diamonds < Hearts < Spades
// Suit ranking used for bidding comparison: Clubs < Diamonds < Hearts < Spades < No Trump
const SUIT_RANKING = {
  C: 0,
  D: 1,
  H: 2,
  S: 3,
  N: 4, // No Trump ranks above Spades
};

/**
 * Build a new deck of 52 playing cards. Each card is an object with
 * a suit and a rank. Ranks are numbers from 2 to 14 where 14
 * represents Ace.
 *
 * @returns {Array<{suit:string,rank:number}>}
 */
function buildDeck() {
  const suits = ['C', 'D', 'H', 'S'];
  const deck = [];
  for (const suit of suits) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

/**
 * Shuffle an array in place using the Fisher–Yates algorithm.
 *
 * @param {Array<any>} array
 * @returns {Array<any>} the same array, shuffled
 */
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Format a card into a short string such as '7D' or 'AH'. Helpful
 * when sending card data to clients.
 *
 * @param {{suit:string,rank:number}} card
 * @returns {string}
 */
function formatCard(card) {
  const rankMap = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  const rankStr = card.rank <= 10 ? String(card.rank) : rankMap[card.rank];
  return rankStr + card.suit;
}

/**
 * Determine if bidA outranks bidB. A bid is an object with
 * properties level (1–7) and suit (C, D, H, S). Higher level wins;
 * if equal level then higher suit wins according to SUIT_RANKING.
 * If bidB is null (no current highest bid) then bidA always wins.
 *
 * @param {{level:number,suit:string}} bidA
 * @param {{level:number,suit:string}|null} bidB
 * @returns {boolean}
 */
function isHigherBid(bidA, bidB) {
  if (!bidB) return true;
  if (bidA.level > bidB.level) return true;
  if (bidA.level === bidB.level && SUIT_RANKING[bidA.suit] > SUIT_RANKING[bidB.suit]) {
    return true;
  }
  return false;
}

/**
 * Evaluate a completed trick and determine the winner. A trick is an
 * array of objects {player: number, card: {suit, rank}} in order of
 * play. The lead suit is the suit of the first card. If a trump
 * suit exists (the suit of the winning bid), any trump outranks
 * non‑trumps. Within the same suit, higher rank wins.
 *
 * @param {Array<{player:number,card:{suit:string,rank:number}}>} trick
 * @param {string|null} trumpSuit
 * @returns {number} the index of the player who won the trick
 */
function evaluateTrick(trick, trumpSuit) {
  const leadSuit = trick[0].card.suit;
  let winning = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const current = trick[i];
    const card = current.card;
    const winCard = winning.card;
    // If current card is trump and winning is not trump
    if (trumpSuit && card.suit === trumpSuit && winCard.suit !== trumpSuit) {
      winning = current;
    } else if (trumpSuit && card.suit === trumpSuit && winCard.suit === trumpSuit) {
      if (card.rank > winCard.rank) winning = current;
    } else if ((!trumpSuit || winCard.suit === leadSuit) && card.suit === winCard.suit && card.rank > winCard.rank) {
      winning = current;
    }
  }
  return winning.player;
}

// In‑memory store of all active rooms keyed by code
const rooms = {};

/**
 * Broadcast the current list of open rooms to all connected clients.
 * An open room is any room that has fewer than 4 players and is in
 * the waiting stage (not currently playing a round).
 */
function updateRoomsList() {
  const list = Object.values(rooms)
    .filter((room) => room.players.length < 4 && room.stage === 'waiting')
    .map((room) => ({ code: room.code, players: room.players.length }));
  io.emit('roomsList', { rooms: list });
}

/**
 * Start a new deal in a room. Cards are shuffled and dealt evenly
 * among the four players. Bidding is initialised and the first
 * bidding turn is set to the dealer's left (player 1).
 *
 * @param {string} roomCode
 */
function startDeal(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.stage = 'bidding';
  room.highestBid = null;
  room.highestBidder = null;
  room.passes = 0;
  room.trumpSuit = null;
  room.callCard = null;
  room.declarerTeamTricks = 0;
  room.defenderTeamTricks = 0;
  room.currentTrick = [];
  // Reset partner reveal state for the new deal
  room.partnerRevealed = false;
  room.partnerPos = null;
  // Reset player state
  room.players.forEach((player) => {
    player.hand = [];
    player.tricks = 0;
    player.isDeclarer = false;
    player.isPartner = false;
  });
  // Build and shuffle deck
  const deck = shuffle(buildDeck());
  // Deal 13 cards to each player
  for (let i = 0; i < 13; i++) {
    for (let p = 0; p < room.players.length; p++) {
      const card = deck.pop();
      room.players[p].hand.push(card);
    }
  }
  // Sort each player's hand for easier UI (by suit then rank)
  room.players.forEach((player) => {
    player.hand.sort((a, b) => {
      if (a.suit === b.suit) return a.rank - b.rank;
      return SUIT_RANKING[a.suit] - SUIT_RANKING[b.suit];
    });
  });
  // Determine bidding turn: dealer is player 0; bidding starts to dealer's left
  room.biddingTurn = (room.dealer + 1) % room.players.length;
  // Notify players of deal and send them their hands
  io.to(roomCode).emit('dealStarted', {
    players: room.players.map((p) => ({ id: p.id, name: p.name, pos: p.pos })),
    dealer: room.dealer,
  });
  room.players.forEach((player) => {
    io.to(player.id).emit('dealCards', {
      hand: player.hand.map((c) => formatCard(c)),
    });
  });
  // Announce whose turn it is to bid
  io.to(roomCode).emit('biddingTurn', { pos: room.biddingTurn, turnMs: room.turnMs });
  // Start timer for bidding turn
  startTurnTimer(room);
}

/**
 * Redeal the current game. Called when all players pass without a
 * single bid. Simply restarts the game with the same players and
 * rotates the dealer by one seat.
 *
 * @param {string} roomCode
 */
function redeal(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  // Advance dealer position
  room.dealer = (room.dealer + 1) % room.players.length;
  startDeal(roomCode);
}

/**
 * Finish the bidding phase. Determine the declarer and trump suit
 * based on the highest bid. If there is no highest bid the game is
 * redealt. Otherwise the game transitions to the call‑card phase
 * where the declarer selects a card to call for their secret
 * partner.
 *
 * @param {string} roomCode
 */
function endBidding(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  if (!room.highestBid) {
    // Everyone passed; redeal
    io.to(roomCode).emit('message', { message: 'No bids were made. Redealing...' });
    redeal(roomCode);
    return;
  }
  // Identify declarer and set trump suit
  const declarerIndex = room.highestBidder;
  // Determine trump suit: No Trump ('N') means no trump (null)
  const trumpSuit = room.highestBid.suit;
  room.trumpSuit = trumpSuit === 'N' ? null : trumpSuit;
  room.players.forEach((player) => {
    player.isDeclarer = player.pos === declarerIndex;
  });
  // Move to call‑card stage
  room.stage = 'callCard';
  io.to(roomCode).emit('biddingComplete', {
    highestBid: room.highestBid,
    declarer: declarerIndex,
    trumpSuit,
  });
  // Prompt declarer to select a partner card
  const declarer = room.players[declarerIndex];
  io.to(declarer.id).emit('yourTurnToCall');
  // Notify others that the declarer is choosing
  room.players.forEach((player) => {
    if (player.pos !== declarerIndex) {
      io.to(player.id).emit('waitingForCall');
    }
  });
}

/**
 * Determine which player holds the called card. If the declarer
 * happens to hold the called card then there is no partner (solo).
 * Set the partner flag on the appropriate player and inform them
 * privately. After assigning partner, begin the trick‑taking phase.
 *
 * @param {string} roomCode
 * @param {string} declarerId
 * @param {{rank:number,suit:string}} callCard
 */
function assignPartnerAndStartPlay(roomCode, declarerId, callCard) {
  const room = rooms[roomCode];
  if (!room) return;
  room.callCard = callCard;
  // Track that partner has not yet been revealed; partner will be
  // revealed when the called card is actually played. See handlePlay.
  room.partnerRevealed = false;
  room.partnerPos = null;
  let partnerIndex = null;
  // Find the partner by scanning players' hands
  for (let i = 0; i < room.players.length; i++) {
    const player = room.players[i];
    if (player.id === declarerId) continue;
    if (player.hand.some((card) => card.suit === callCard.suit && card.rank === callCard.rank)) {
      partnerIndex = i;
      break;
    }
  }
  if (partnerIndex !== null) {
    room.players[partnerIndex].isPartner = true;
    // Inform the partner privately
    io.to(room.players[partnerIndex].id).emit('youArePartner');
  }
  // Move to playing stage
  room.stage = 'playing';
  // Determine who leads: player to declarer's left
  const declarer = room.players.find((p) => p.id === declarerId);
  room.playingTurn = (declarer.pos + 1) % room.players.length;
  // Notify all players the call card and start of play (without revealing partner)
  io.to(roomCode).emit('callCardSelected', {
    rank: callCard.rank,
    suit: callCard.suit,
  });
  io.to(roomCode).emit('playTurn', { pos: room.playingTurn, turnMs: room.turnMs });
  // Start timer for playing turn
  startTurnTimer(room);
}

/**
 * Helper to compute indices of legal cards a player can play. If there
 * is a lead suit, the player must follow suit if possible. If no
 * follow suit, any card is legal.
 *
 * @param {object} room
 * @param {object} player
 * @returns {number[]}
 */
function legalCardIndices(room, player) {
  if (!room.currentTrick || room.currentTrick.length === 0) {
    return player.hand.map((_, i) => i);
  }
  const leadSuit = room.currentTrick[0].card.suit;
  const inSuit = player.hand
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.suit === leadSuit)
    .map((x) => x.i);
  if (inSuit.length > 0) return inSuit;
  return player.hand.map((_, i) => i);
}

/**
 * Start or restart the timer for the current turn. When the timer
 * expires, the server will play a random legal card for the current
 * player. Each room has its own timer duration stored on the room
 * object (room.turnMs). If turnMs is zero or undefined, no timer is
 * started.
 *
 * @param {object} room
 */
function startTurnTimer(room) {
  // Clear any existing timer
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (!room.turnMs) return;
  room.turnTimer = setTimeout(() => {
    // Auto play a legal card for the current turn owner
    if (room.stage === 'bidding') {
      // In bidding, auto pass
      const currentPlayer = room.players[room.biddingTurn];
      handleBid(room, currentPlayer, null);
    } else if (room.stage === 'playing') {
      const currentPlayer = room.players[room.playingTurn];
      const legal = legalCardIndices(room, currentPlayer);
      const idx = legal[Math.floor(Math.random() * legal.length)];
      const card = currentPlayer.hand[idx];
      handlePlay(room, currentPlayer, card);
    }
  }, room.turnMs);
}

/**
 * Internal helper to process a bid from a specific player. Accepts
 * either a bid object {level,suit} or null for a pass. This
 * function will update room state, broadcast updates, handle
 * redeals, and move to next bidding turn. Does not enforce turn
 * order; caller must validate.
 *
 * @param {object} room
 * @param {object} player
 * @param {{level:number,suit:string}|null} bid
 */
function handleBid(room, player, bid) {
  const roomCode = room.code;
  if (bid === null) {
    // Pass
    room.passes++;
    io.to(roomCode).emit('bidUpdate', {
      bidder: player.pos,
      bid: null,
      passes: room.passes,
    });
    // If nobody has bid and all four pass: redeal
    if (!room.highestBid && room.passes >= 4) {
      io.to(roomCode).emit('message', { message: 'All players passed. Redealing...' });
      redeal(roomCode);
      return;
    }
    // If there is a bid and three consecutive passes, end bidding
    if (room.highestBid && room.passes >= 3) {
      endBidding(roomCode);
      return;
    }
    // Advance bidding turn
    room.biddingTurn = (room.biddingTurn + 1) % room.players.length;
    io.to(roomCode).emit('biddingTurn', { pos: room.biddingTurn, turnMs: room.turnMs });
    startTurnTimer(room);
    return;
  }
  // Validate and compare bid
  if (!isHigherBid(bid, room.highestBid)) {
    io.to(player.id).emit('errorMessage', { message: 'Bid must be higher than the current bid.' });
    return;
  }
  // Accept bid
  room.highestBid = bid;
  room.highestBidder = player.pos;
  room.passes = 0;
  io.to(roomCode).emit('bidUpdate', {
    bidder: player.pos,
    bid,
    passes: room.passes,
  });
  // Advance bidding turn
  room.biddingTurn = (room.biddingTurn + 1) % room.players.length;
  io.to(roomCode).emit('biddingTurn', { pos: room.biddingTurn, turnMs: room.turnMs });
  startTurnTimer(room);
}

/**
 * Internal helper to process a card play. Does not validate that it
 * is the player's turn; caller should ensure order. Updates trick
 * state, broadcasts updates, determines trick winner when four cards
 * have been played, and rotates turn. If the hand ends, calls
 * startDeal again.
 *
 * @param {object} room
 * @param {object} player
 * @param {{suit:string,rank:number}} cardObj (actual card object)
 */
function handlePlay(room, player, cardObj) {
  const roomCode = room.code;
  // Remove card from player's hand
  const idx = player.hand.findIndex((c) => c.suit === cardObj.suit && c.rank === cardObj.rank);
  if (idx === -1) {
    io.to(player.id).emit('errorMessage', { message: 'Card not found in hand.' });
    return;
  }
  const [playedCard] = player.hand.splice(idx, 1);
  // Validate follow suit
  if (room.currentTrick.length > 0) {
    const leadSuit = room.currentTrick[0].card.suit;
    const hasSuit = player.hand.some((c) => c.suit === leadSuit);
    if (playedCard.suit !== leadSuit && hasSuit) {
      // illegal
      player.hand.splice(idx, 0, playedCard);
      io.to(player.id).emit('errorMessage', { message: `You must follow suit ${leadSuit}.` });
      return;
    }
  }
  // Record play
  room.currentTrick.push({ player: player.pos, card: playedCard });

  // Check if this card reveals the partner (call card). The partner is
  // considered revealed only when the declarer's called card is
  // actually played by someone other than the declarer. Once
  // revealed, broadcast to all players.
  if (
    room.callCard &&
    !room.partnerRevealed &&
    playedCard.suit === room.callCard.suit &&
    playedCard.rank === room.callCard.rank
  ) {
    // If the declarer is playing their own call card, there is no partner;
    // do not reveal. Otherwise, mark the player as partner.
    const declarerPos = room.highestBidder;
    if (player.pos !== declarerPos) {
      room.partnerRevealed = true;
      room.partnerPos = player.pos;
      // Mark player as partner (in case not already set)
      room.players[player.pos].isPartner = true;
      io.to(room.code).emit('partnerRevealed', { partner: player.pos });
    }
  }
  io.to(roomCode).emit('cardPlayed', {
    player: player.pos,
    card: formatCard(playedCard),
    remaining: player.hand.length,
  });
  // Check if trick complete
  if (room.currentTrick.length === room.players.length) {
    // Determine winner
    const winnerPos = evaluateTrick(room.currentTrick, room.trumpSuit);
    // Award trick to team and increment individual trick count
    const declarer = room.players[room.highestBidder];
    const partner = room.players.find((p) => p.isPartner);
    const declarerTeam = new Set([declarer.pos]);
    if (partner) declarerTeam.add(partner.pos);
    if (declarerTeam.has(winnerPos)) room.declarerTeamTricks++;
    else room.defenderTeamTricks++;
    // Track individual tricks won by each player. Initialize if undefined.
    const winnerPlayer = room.players[winnerPos];
    if (winnerPlayer) {
      winnerPlayer.tricks = (winnerPlayer.tricks || 0) + 1;
    }
    // Notify players. Include per-player trick counts so clients can show "won hands"
    io.to(roomCode).emit('trickComplete', {
      trick: room.currentTrick.map((entry) => ({ player: entry.player, card: formatCard(entry.card) })),
      winner: winnerPos,
      declarerTeamTricks: room.declarerTeamTricks,
      defenderTeamTricks: room.defenderTeamTricks,
      playersTricks: room.players.map((p) => p.tricks || 0),
    });
    // Reset trick and set new starting turn
    room.currentTrick = [];
    room.playingTurn = winnerPos;
    // Check if hand finished
    const cardsRemaining = room.players.reduce((sum, p) => sum + p.hand.length, 0);
    if (cardsRemaining === 0) {
      // Determine contract success
      const tricksNeeded = (room.highestBid.level || 0) + 6;
      const contractMade = room.declarerTeamTricks >= tricksNeeded;
      // Update sets (round wins) for players. If contract is made,
      // declarer and partner each get a set; otherwise defenders get
      // a set. The partner may be null if declarer held the call card.
      const declarerIndex = room.highestBidder;
      const partnerIndex = room.players.findIndex((p) => p.isPartner);
      if (contractMade) {
        room.players.forEach((plr) => {
          if (plr.pos === declarerIndex || plr.pos === partnerIndex) {
            plr.sets = (plr.sets || 0) + 1;
          }
        });
      } else {
        room.players.forEach((plr) => {
          if (!(plr.pos === declarerIndex || plr.pos === partnerIndex)) {
            plr.sets = (plr.sets || 0) + 1;
          }
        });
      }
      // Add to round history for scoreboard
      room.history.push({
        declarer: declarerIndex,
        partner: partnerIndex,
        declarerTeamTricks: room.declarerTeamTricks,
        defenderTeamTricks: room.defenderTeamTricks,
        contractMade,
        highestBid: room.highestBid,
      });
      // Emit round finished event with scoreboard info
      io.to(roomCode).emit('roundFinished', {
        declarer: declarerIndex,
        partner: partnerIndex,
        declarerTeamTricks: room.declarerTeamTricks,
        defenderTeamTricks: room.defenderTeamTricks,
        contractMade,
        highestBid: room.highestBid,
        playersSets: room.players.map((p) => p.sets || 0),
        history: room.history,
      });
      // Prepare for scoreboard/waiting stage. Do not auto redeal.
      // Advance dealer for next round (will be used when a new game starts)
      room.dealer = (room.dealer + 1) % room.players.length;
      // Transition room back to waiting state. Reset round-specific data but
      // keep player sets intact. Players will need to ready up again.
      room.stage = 'waiting';
      room.highestBid = null;
      room.highestBidder = null;
      room.passes = 0;
      room.trumpSuit = null;
      room.callCard = null;
      room.declarerTeamTricks = 0;
      room.defenderTeamTricks = 0;
      room.currentTrick = [];
      room.biddingTurn = 0;
      room.playingTurn = 0;
      room.partnerRevealed = false;
      room.partnerPos = null;
      // Reset players state for next round: clear hands, tricks and ready flags
      room.players.forEach((plr) => {
        plr.hand = [];
        plr.tricks = 0;
        plr.ready = false;
        plr.isDeclarer = false;
        plr.isPartner = false;
      });
      // Clear any running timer
      if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
      }
      // Broadcast updated player list to show resets (including sets)
      io.to(roomCode).emit('playerList', {
        players: room.players.map((p) => ({
          id: p.id,
          name: p.name,
          pos: p.pos,
          ready: p.ready,
          sets: p.sets || 0,
        })),
        hostId: room.hostId,
      });
      updateRoomsList();
    } else {
      io.to(roomCode).emit('playTurn', { pos: room.playingTurn, turnMs: room.turnMs });
      startTurnTimer(room);
    }
  } else {
    // Move to next player
    room.playingTurn = (room.playingTurn + 1) % room.players.length;
    io.to(roomCode).emit('playTurn', { pos: room.playingTurn, turnMs: room.turnMs });
    startTurnTimer(room);
  }
}

// Handle new socket connections
io.on('connection', (socket) => {
  console.log('New socket connected', socket.id);
  // Immediately send list of open rooms
  updateRoomsList();

  // Create room. Only sets up the room; host must join to claim hostId.
  socket.on('createRoom', ({ name }) => {
    // Validate name
    const trimmed = (name || '').trim();
    if (!trimmed) {
      socket.emit('errorMessage', { message: 'Name required.' });
      return;
    }
    let code;
    do {
      code = generateRoomCode();
    } while (rooms[code]);
    rooms[code] = {
      code,
      hostId: socket.id,
      players: [],
      stage: 'waiting',
      dealer: 0,
      highestBid: null,
      highestBidder: null,
      passes: 0,
      biddingTurn: 0,
      playingTurn: 0,
      trumpSuit: null,
      callCard: null,
      declarerTeamTricks: 0,
      defenderTeamTricks: 0,
      currentTrick: [],
      turnMs: null,
      turnTimer: null,
      // History of completed rounds. Each entry stores declarer position,
      // partner position, number of tricks taken by each side, and
      // whether the contract was made. Used for scoreboard.
      history: [],
    };
    socket.emit('roomCreated', { roomCode: code });
    // Broadcast new rooms list
    updateRoomsList();
  });

  // Join room. Accepts code and name. Validates duplicates.
  socket.on('joinRoom', ({ roomCode, name }) => {
    const code = (roomCode || '').toUpperCase();
    const trimmed = (name || '').trim();
    if (!trimmed) {
      socket.emit('errorMessage', { message: 'Name required.' });
      return;
    }
    const room = rooms[code];
    if (!room) {
      socket.emit('errorMessage', { message: 'Room not found.' });
      return;
    }
    if (room.players.length >= 4) {
      socket.emit('errorMessage', { message: 'Room is full.' });
      return;
    }
    // Check duplicate names (case insensitive)
    if (room.players.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      socket.emit('errorMessage', { message: 'Name already taken in this room.' });
      return;
    }
    // Add player to room
    const player = {
      id: socket.id,
      name: trimmed,
      hand: [],
      pos: room.players.length,
      ready: false,
      tricks: 0,
      // Number of sets (rounds) won by this player across all deals
      sets: room.players && room.players.length >= 0 ? 0 : 0,
      isDeclarer: false,
      isPartner: false,
    };
    room.players.push(player);
    socket.join(code);
    // Send player list and update rooms list (player count changed)
    io.to(code).emit('playerList', {
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        pos: p.pos,
        ready: p.ready,
        sets: p.sets || 0,
      })),
      hostId: room.hostId,
    });
    updateRoomsList();
  });

  // Player toggles ready/unready
  socket.on('setReady', ({ roomCode, ready }) => {
    const code = roomCode;
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    player.ready = !!ready;
    io.to(code).emit('playerList', {
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        pos: p.pos,
        ready: p.ready,
        sets: p.sets || 0,
      })),
      hostId: room.hostId,
    });
  });

  // Host starts the game. Expects timer seconds; must have 4 players and all ready.
  socket.on('startGame', ({ roomCode, turnMs }, callback) => {
    const code = roomCode;
    const room = rooms[code];
    if (!room) {
      if (callback) callback({ ok: false, error: 'Room not found.' });
      return;
    }
    if (socket.id !== room.hostId) {
      if (callback) callback({ ok: false, error: 'Only the host can start the game.' });
      return;
    }
    if (room.players.length !== 4) {
      if (callback) callback({ ok: false, error: 'Need 4 players to start.' });
      return;
    }
    if (!room.players.every((p) => p.ready)) {
      if (callback) callback({ ok: false, error: 'All players must be ready.' });
      return;
    }
    // Set timer (milliseconds). Bound between 5s and 120s.
    const ms = parseInt(turnMs, 10);
    room.turnMs = Math.max(5000, Math.min(120000, ms || 20000));
    // Reset dealer position for new game (host chooses or continue previous). Keep existing.
    // Start first deal
    startDeal(code);
    if (callback) callback({ ok: true });
  });

  // Player places a bid. Expects level 1–7 and suit or passes with null.
  socket.on('placeBid', ({ roomCode, level, suit }) => {
    const room = rooms[roomCode];
    if (!room || room.stage !== 'bidding') return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    if (player.pos !== room.biddingTurn) {
      socket.emit('errorMessage', { message: 'It is not your turn to bid.' });
      return;
    }
    // Interpret pass
    const isPass = !level || level === 0 || !suit;
    if (isPass) {
      handleBid(room, player, null);
      return;
    }
    const bid = { level: Number(level), suit };
    if (bid.level < 1 || bid.level > 7 || !SUIT_RANKING.hasOwnProperty(bid.suit)) {
      socket.emit('errorMessage', { message: 'Invalid bid.' });
      return;
    }
    handleBid(room, player, bid);
  });

  // Declarer calls card for partner
  socket.on('callCard', ({ roomCode, rank, suit }) => {
    const room = rooms[roomCode];
    if (!room || room.stage !== 'callCard') return;
    const declarer = room.players[room.highestBidder];
    if (!declarer || declarer.id !== socket.id) {
      socket.emit('errorMessage', { message: 'Only the declarer can call a card.' });
      return;
    }
    const validRanks = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
    if (!validRanks.includes(Number(rank)) || !SUIT_RANKING.hasOwnProperty(suit)) {
      socket.emit('errorMessage', { message: 'Invalid call card.' });
      return;
    }
    assignPartnerAndStartPlay(roomCode, declarer.id, { rank: Number(rank), suit });
  });

  // Player plays a card
  socket.on('playCard', ({ roomCode, card }) => {
    const room = rooms[roomCode];
    if (!room || room.stage !== 'playing') return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return;
    if (player.pos !== room.playingTurn) {
      socket.emit('errorMessage', { message: 'It is not your turn to play.' });
      return;
    }
    // Convert card string (e.g., '7D') back to object
    const rankStr = card.slice(0, -1);
    const suit = card.slice(-1);
    let rank;
    if (rankStr === 'A') rank = 14;
    else if (rankStr === 'K') rank = 13;
    else if (rankStr === 'Q') rank = 12;
    else if (rankStr === 'J') rank = 11;
    else rank = Number(rankStr);
    handlePlay(room, player, { suit, rank });
  });

  // Player toggles name (not used currently)

  // On disconnect
  socket.on('disconnect', () => {
    // Remove the player from any room they belonged to
    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      const index = room.players.findIndex((p) => p.id === socket.id);
      if (index !== -1) {
        const [removed] = room.players.splice(index, 1);
        // Inform remaining players
        io.to(code).emit('message', { message: `${removed.name} has left the game.` });
        io.to(code).emit('playerList', {
          players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            pos: p.pos,
            ready: p.ready,
            sets: p.sets || 0,
          })),
          hostId: room.hostId,
        });
        // Reset room state if game was active
        room.stage = 'waiting';
        room.highestBid = null;
        room.highestBidder = null;
        room.passes = 0;
        room.trumpSuit = null;
        room.callCard = null;
        room.declarerTeamTricks = 0;
        room.defenderTeamTricks = 0;
        room.currentTrick = [];
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
        updateRoomsList();
        // If no players remain in the room, remove it entirely
        if (room.players.length === 0) {
          delete rooms[code];
          updateRoomsList();
        }
        break;
      }
    }
  });
});

// Start listening on the specified port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});