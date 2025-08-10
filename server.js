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
 * properties level (1–7) and suit (C, D, H, S, N). Higher level wins;
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
