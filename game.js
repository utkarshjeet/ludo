/* Ludo rules engine — pure functions on plain JSON state (no DOM).
   Same code runs offline and online (state is stored in Supabase as-is). */
(function (root) {
  'use strict';

  var COLORS = ['red', 'green', 'yellow', 'blue']; // clockwise turn order
  var START = { red: 0, green: 13, yellow: 26, blue: 39 }; // index on the 52-cell track
  var SAFE = { 0: 1, 8: 1, 13: 1, 21: 1, 26: 1, 34: 1, 39: 1, 47: 1 }; // start + star cells
  var LAST = 56; // progress: -1 = yard, 0..50 = track, 51..55 = home column, 56 = finished

  function line(x, y, dx, dy, n, out) {
    for (var i = 0; i < n; i++) out.push([x + dx * i, y + dy * i]);
    return out;
  }

  // 15x15 grid, [col,row]. Track starts at red's start cell and goes clockwise.
  var TRACK = [];
  line(1, 6, 1, 0, 5, TRACK);
  line(6, 5, 0, -1, 6, TRACK);
  line(7, 0, 1, 0, 2, TRACK);
  line(8, 1, 0, 1, 5, TRACK);
  line(9, 6, 1, 0, 6, TRACK);
  line(14, 7, 0, 1, 2, TRACK);
  line(13, 8, -1, 0, 5, TRACK);
  line(8, 9, 0, 1, 6, TRACK);
  line(7, 14, -1, 0, 2, TRACK);
  line(6, 13, 0, -1, 5, TRACK);
  line(5, 8, -1, 0, 6, TRACK);
  line(0, 7, 0, -1, 2, TRACK);

  var HOME = {
    red: line(1, 7, 1, 0, 5, []),
    green: line(7, 1, 0, 1, 5, []),
    yellow: line(13, 7, -1, 0, 5, []),
    blue: line(7, 13, 0, -1, 5, [])
  };
  var YARD_ORIGIN = { red: [0, 0], green: [9, 0], yellow: [9, 9], blue: [0, 9] };
  var YARD_SPOTS = [[1.5, 1.5], [3.5, 1.5], [1.5, 3.5], [3.5, 3.5]];
  var FINISH = { red: [6.2, 7], green: [7, 6.2], yellow: [7.8, 7], blue: [7, 7.8] };

  // Top-left corner (in cells) where token i of color c sits at progress p
  function pos(c, i, p) {
    if (p < 0) { var o = YARD_ORIGIN[c], s = YARD_SPOTS[i]; return [o[0] + s[0], o[1] + s[1]]; }
    if (p <= 50) return TRACK[(START[c] + p) % 52];
    if (p < LAST) return HOME[c][p - 51];
    return FINISH[c];
  }

  // Unbiased crypto dice
  function rand6() {
    var cr = root.crypto;
    if (cr && cr.getRandomValues) {
      var a = new Uint8Array(1);
      do { cr.getRandomValues(a); } while (a[0] >= 252);
      return (a[0] % 6) + 1;
    }
    return 1 + Math.floor(Math.random() * 6);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function cur(s) { return s.players[s.turn]; }
  function canMove(p, d) { return p < 0 ? d === 6 : p + d <= LAST; }

  function newGame(seats, host) {
    var players = COLORS.filter(function (c) { return seats[c]; });
    var tokens = {};
    players.forEach(function (c) { tokens[c] = [-1, -1, -1, -1]; });
    return {
      status: 'playing', gameId: Math.random().toString(36).slice(2, 9), host: host || null,
      seats: seats, players: players, tokens: tokens,
      turn: 0, phase: 'roll', dice: 0, roller: null, sixes: 0, rollId: 0, skip: null,
      last: null, winners: []
    };
  }

  function movable(s) {
    var c = cur(s), d = s.dice, out = [];
    if (s.phase !== 'move') return out;
    s.tokens[c].forEach(function (p, i) { if (canMove(p, d)) out.push(i); });
    return out;
  }

  // Movable tokens, de-duplicated by position (two tokens on the same cell = same choice)
  function choices(s) {
    var c = cur(s), seen = {}, out = [];
    movable(s).forEach(function (i) {
      var p = s.tokens[c][i];
      if (!seen[p]) { seen[p] = 1; out.push(i); }
    });
    return out;
  }

  function nextTurn(s) {
    s.sixes = 0;
    var n = s.players.length;
    for (var k = 0; k < n; k++) {
      s.turn = (s.turn + 1) % n;
      if (s.winners.indexOf(s.players[s.turn]) < 0) break;
    }
    s.phase = 'roll';
  }

  function roll(s0, forced) {
    if (s0.status !== 'playing' || s0.phase !== 'roll') return s0;
    var s = clone(s0), c = cur(s), d = forced || rand6();
    s.dice = d; s.roller = c; s.rollId++; s.skip = null;
    s.sixes = d === 6 ? s.sixes + 1 : 0;
    if (s.sixes >= 3) { s.skip = 'three'; nextTurn(s); return s; }
    s.phase = 'move';
    if (!movable(s).length) { s.skip = 'none'; nextTurn(s); }
    return s;
  }

  function move(s0, t) {
    if (s0.status !== 'playing' || s0.phase !== 'move') return s0;
    var c = cur(s0), d = s0.dice, from = s0.tokens[c][t];
    if (!canMove(from, d)) return s0;
    var s = clone(s0), to = from < 0 ? 0 : from + d, caps = [];
    s.tokens[c][t] = to;

    if (to <= 50) {
      var a = (START[c] + to) % 52;
      if (!SAFE[a]) {
        s.players.forEach(function (o) {
          if (o === c) return;
          s.tokens[o].forEach(function (q, i) {
            if (q >= 0 && q <= 50 && (START[o] + q) % 52 === a) { s.tokens[o][i] = -1; caps.push([o, i, q]); }
          });
        });
      }
    }
    s.last = { id: (s.last ? s.last.id : 0) + 1, c: c, t: t, from: from, to: to, caps: caps };

    var bonus = d === 6 || caps.length > 0 || to === LAST;
    if (s.tokens[c].every(function (p) { return p === LAST; })) { s.winners.push(c); bonus = false; }
    var left = s.players.filter(function (p) { return s.winners.indexOf(p) < 0; });
    if (left.length <= 1) {
      s.winners = s.winners.concat(left);
      s.status = 'over'; s.phase = 'over';
      return s;
    }
    if (bonus) s.phase = 'roll'; else nextTurn(s);
    return s;
  }

  // Roll; if there is only one possible move, make it right away (fewer taps, fewer network writes)
  function rollAuto(s0) {
    var s = roll(s0);
    if (s.phase === 'move') {
      var ch = choices(s);
      if (ch.length === 1) return move(s, ch[0]);
    }
    return s;
  }

  function skipTurn(s0) {
    if (s0.status !== 'playing') return s0;
    var s = clone(s0);
    s.skip = 'host';
    nextTurn(s);
    return s;
  }

  // Kick a player out mid-game: their pieces vanish, play continues
  function removePlayer(s0, c) {
    var idx = s0.players.indexOf(c);
    if (s0.status !== 'playing' || idx < 0) return s0;
    var s = clone(s0), wasCur = idx === s.turn;
    s.players.splice(idx, 1);
    delete s.tokens[c]; delete s.seats[c];
    s.winners = s.winners.filter(function (w) { return w !== c; });
    if (idx < s.turn) s.turn--;
    var n = s.players.length;
    if (s.turn >= n) s.turn = 0;
    var left = s.players.filter(function (p) { return s.winners.indexOf(p) < 0; });
    if (left.length <= 1) {
      s.winners = s.winners.concat(left);
      s.status = 'over'; s.phase = 'over';
      return s;
    }
    if (wasCur) {
      for (var k = 0; k < n && s.winners.indexOf(s.players[s.turn]) >= 0; k++) s.turn = (s.turn + 1) % n;
      s.phase = 'roll'; s.sixes = 0;
    }
    return s;
  }

  // Simple greedy bot
  function botPick(s) {
    var c = cur(s), d = s.dice, best = -1, bs = -1e9;
    function oppAt(a) {
      return s.players.some(function (o) {
        return o !== c && s.tokens[o].some(function (q) { return q >= 0 && q <= 50 && (START[o] + q) % 52 === a; });
      });
    }
    function danger(a) {
      if (SAFE[a]) return false;
      return s.players.some(function (o) {
        return o !== c && s.tokens[o].some(function (q) {
          if (q < 0 || q > 50) return false;
          var dist = (a - (START[o] + q) % 52 + 52) % 52;
          return dist >= 1 && dist <= 6;
        });
      });
    }
    movable(s).forEach(function (i) {
      var p = s.tokens[c][i], to = p < 0 ? 0 : p + d, sc = to / 10 + Math.random() * 3;
      if (p < 0) sc += 50;
      if (to === LAST) sc += 70;
      if (to <= 50) {
        var a = (START[c] + to) % 52;
        if (!SAFE[a] && oppAt(a)) sc += 100;
        if (SAFE[a]) sc += 15;
        if (danger(a)) sc -= 30;
      } else if (p <= 50) sc += 35;
      if (p >= 0 && p <= 50 && danger((START[c] + p) % 52)) sc += 20;
      if (sc > bs) { bs = sc; best = i; }
    });
    return best;
  }

  var Ludo = {
    COLORS: COLORS, START: START, SAFE: SAFE, LAST: LAST, TRACK: TRACK, HOME: HOME,
    YARD_ORIGIN: YARD_ORIGIN, YARD_SPOTS: YARD_SPOTS, FINISH: FINISH,
    pos: pos, cur: cur, newGame: newGame, movable: movable, choices: choices,
    roll: roll, move: move, rollAuto: rollAuto, skipTurn: skipTurn, removePlayer: removePlayer, botPick: botPick, clone: clone
  };
  root.Ludo = Ludo;
  if (typeof module !== 'undefined' && module.exports) module.exports = Ludo;
})(typeof window !== 'undefined' ? window : globalThis);
