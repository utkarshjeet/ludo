/* Ludo UI: board, offline (pass & play + bots) and online rooms (Supabase). */
(function () {
  'use strict';
  var L = window.Ludo, CFG = window.LUDO_CONFIG || {};
  var SB_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
  var JOIN_ORDER = ['red', 'yellow', 'green', 'blue']; // 2 players sit opposite each other
  var NAMES = { red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue' };
  var HEX = { red: '#e53935', green: '#2e9e44', yellow: '#f6c90e', blue: '#1e88e5' };
  var LIGHT = { red: '#ffd9d6', green: '#d4f2db', yellow: '#fff3c2', blue: '#d6e8fb' };
  var FACES = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  var STACK_SCALE = [1, 1, .72, .62, .56];
  var STACK_OFF = [[[0, 0]], [[0, 0]], [[-.17, 0], [.17, 0]], [[-.17, -.13], [.17, -.13], [0, .15]],
    [[-.17, -.17], [.17, -.17], [-.17, .17], [.17, .17]]];

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  function rid(n) { var a = 'abcdefghijkmnpqrstuvwxyz23456789', s = ''; for (var i = 0; i < n; i++) s += a[(Math.random() * a.length) | 0]; return s; }
  var PID = store.get('ludo_pid');
  if (!PID) { PID = rid(12); store.set('ludo_pid', PID); }

  // ---------- state ----------
  var mode = null;          // 'off' | 'on'
  var S = null;             // game state currently shown
  var LS = null;            // lobby state (online)
  var sid = 0;              // session id, bumps when leaving so stale animations stop
  var queue = Promise.resolve();
  var busy = false, pending = false, botTimer = null;
  var sb = null, room = null, V = 0, chan = null, pollT = null, lastChange = 0;

  // ---------- small helpers ----------
  function show(id) {
    document.querySelectorAll('.screen').forEach(function (el) { el.classList.toggle('on', el.id === id); });
  }
  var toastT;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 2200);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } }
  // ---------- sounds (synthesized, no audio files) ----------
  var Snd = (function () {
    var ctx = null, on = store.get('ludo_snd') !== '0', noise = null;
    function ac() {
      if (!on) return null;
      if (!ctx) {
        var A = window.AudioContext || window.webkitAudioContext;
        if (!A) return null;
        try { ctx = new A(); } catch (e) { return null; }
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(f, dur, type, vol, f2, delay) {
      var c = ac(); if (!c) return;
      var t = c.currentTime + (delay || 0), o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      g.gain.setValueAtTime(vol || .2, t);
      g.gain.exponentialRampToValueAtTime(.001, t + dur);
      o.connect(g); g.connect(c.destination);
      o.start(t); o.stop(t + dur + .02);
    }
    function rattle(delay, vol) {
      var c = ac(); if (!c) return;
      if (!noise) {
        noise = c.createBuffer(1, c.sampleRate * .05, c.sampleRate);
        var d = noise.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
      }
      var t = c.currentTime + delay, src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
      src.buffer = noise; bp.type = 'bandpass'; bp.frequency.value = 1800 + Math.random() * 1600; bp.Q.value = 1.2;
      g.gain.value = vol;
      src.connect(bp); bp.connect(g); g.connect(c.destination);
      src.start(t);
    }
    return {
      unlock: function () { ac(); },
      roll: function () { for (var i = 0; i < 8; i++) rattle(i * .08 + Math.random() * .03, .9 - i * .06); },
      step: function () { tone(520, .09, 'triangle', .28, 880); },
      out: function () { tone(330, .22, 'triangle', .3, 990); },
      back: function () { tone(260, .05, 'square', .05); },
      cut: function () { tone(880, .4, 'sawtooth', .12, 110); },
      home: function () { tone(523, .14, 'triangle', .25, 0, 0); tone(659, .14, 'triangle', .25, 0, .12); tone(784, .3, 'triangle', .25, 0, .24); },
      isOn: function () { return on; },
      toggle: function () { on = !on; store.set('ludo_snd', on ? '1' : '0'); if (on) ac(); return on; }
    };
  })();
  document.addEventListener('pointerdown', Snd.unlock, true);

  function myName() { return ($('name').value || '').trim().slice(0, 12); }
  function seatName(c, seat) {
    if (!seat) return NAMES[c];
    if (mode === 'on') return (seat.name || NAMES[c]) + (seat.id === PID ? ' (you)' : '');
    return seat.name || NAMES[c];
  }
  function myColor(st) {
    var seats = (st || S || LS || {}).seats || {};
    for (var c in seats) if (seats[c] && seats[c].id === PID) return c;
    return null;
  }

  // ---------- board ----------
  var tokEls = {}, quads = {}, panels = {};
  // each player's dice keeps showing their last roll (random face before the first roll) — never blank
  var lastFace = {};
  L.COLORS.forEach(function (c) { lastFace[c] = 1 + ((Math.random() * 6) | 0); });
  function buildBoard() {
    function cell(p, fill) { return '<rect x="' + p[0] + '" y="' + p[1] + '" width="1" height="1" fill="' + fill + '" stroke="#9aa5b4" stroke-width=".04"/>'; }
    function star(cx, cy, col) {
      var pts = [];
      for (var i = 0; i < 10; i++) {
        var r = i % 2 ? .15 : .36, a = Math.PI / 5 * i - Math.PI / 2;
        pts.push((cx + r * Math.cos(a)).toFixed(3) + ',' + (cy + r * Math.sin(a)).toFixed(3));
      }
      return '<polygon points="' + pts.join(' ') + '" fill="' + col + '"/>';
    }
    var h = ['<svg viewBox="0 0 15 15" xmlns="http://www.w3.org/2000/svg"><rect width="15" height="15" fill="#fff"/>'];
    L.COLORS.forEach(function (c) {
      var o = L.YARD_ORIGIN[c];
      h.push('<rect x="' + o[0] + '" y="' + o[1] + '" width="6" height="6" fill="' + HEX[c] + '"/>');
      h.push('<rect x="' + (o[0] + .9) + '" y="' + (o[1] + .9) + '" width="4.2" height="4.2" rx=".5" fill="#fff"/>');
      L.YARD_SPOTS.forEach(function (s) {
        h.push('<circle cx="' + (o[0] + s[0] + .5) + '" cy="' + (o[1] + s[1] + .5) + '" r=".6" fill="' + LIGHT[c] + '" stroke="' + HEX[c] + '" stroke-width=".08"/>');
      });
    });
    L.TRACK.forEach(function (p, i) {
      var fill = '#fff';
      L.COLORS.forEach(function (c) { if (L.START[c] === i) fill = HEX[c]; });
      h.push(cell(p, fill));
      if (L.SAFE[i]) h.push(star(p[0] + .5, p[1] + .5, fill === '#fff' ? '#b6bfcc' : 'rgba(255,255,255,.9)'));
    });
    L.COLORS.forEach(function (c) { L.HOME[c].forEach(function (p) { h.push(cell(p, HEX[c])); }); });
    h.push('<polygon points="6,6 7.5,7.5 6,9" fill="' + HEX.red + '"/>');
    h.push('<polygon points="6,6 9,6 7.5,7.5" fill="' + HEX.green + '"/>');
    h.push('<polygon points="9,6 9,9 7.5,7.5" fill="' + HEX.yellow + '"/>');
    h.push('<polygon points="6,9 9,9 7.5,7.5" fill="' + HEX.blue + '"/>');
    h.push('</svg>');
    $('board').innerHTML = h.join('');

    L.COLORS.forEach(function (c) {
      var o = L.YARD_ORIGIN[c], q = document.createElement('div'), lb = document.createElement('div');
      q.className = 'quad ' + c + (o[1] === 0 ? ' top' : ' bot');
      q.style.left = (o[0] / 15 * 100) + '%'; q.style.top = (o[1] / 15 * 100) + '%';
      lb.className = 'lb'; q.appendChild(lb); $('quads').appendChild(q);
      quads[c] = { el: q, lb: lb };
      tokEls[c] = [];
      for (var i = 0; i < 4; i++) {
        var t = document.createElement('div');
        t.className = 'tok ' + c;
        $('toks').appendChild(t); tokEls[c].push(t);
      }
    });
    // one dice panel at each player's corner (whole panel is the tap target)
    L.COLORS.forEach(function (c) {
      var el = document.createElement('div'), pawn = document.createElement('span'), d = document.createElement('div'), pips = [];
      el.className = 'pp off ' + c; pawn.className = 'pawn'; d.className = 'dice';
      for (var k = 0; k < 9; k++) { var p = document.createElement('i'); d.appendChild(p); pips.push(p); }
      el.appendChild(pawn); el.appendChild(d); $('table').appendChild(el);
      el.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        if (canAct() && S.phase === 'roll' && L.cur(S) === c) act('roll');
      });
      panels[c] = { el: el, dice: d, pips: pips };
    });
  }
  function place(el, x, y, k) {
    el.style.transform = 'translate(' + (x * 100) + '%,' + (y * 100) + '%)' + (k !== 1 ? ' scale(' + k + ')' : '');
  }
  function setFace(c, n) {
    var on = FACES[n] || [];
    panels[c].pips.forEach(function (p, i) { p.classList.toggle('on', on.indexOf(i) >= 0); });
  }
  function hop(el) { el.classList.remove('hop'); void el.offsetWidth; el.classList.add('hop'); }

  // ---------- render ----------
  function canAct() {
    if (!S || S.status !== 'playing' || busy || pending) return false;
    var seat = S.seats[L.cur(S)];
    if (mode === 'off') return !seat.bot;
    return seat.id === PID;
  }

  function render() {
    if (!S) return;
    var c = L.cur(S), act = canAct();
    var mv = act && S.phase === 'move' ? L.movable(S) : [];
    var groups = {};

    L.COLORS.forEach(function (k) {
      var seat = S.seats[k];
      quads[k].lb.textContent = seat ? seatName(k, seat) : '';
      quads[k].el.classList.toggle('on', S.status === 'playing' && k === c);
      quads[k].el.classList.toggle('done', S.winners.indexOf(k) >= 0);
      var toks = S.tokens[k];
      tokEls[k].forEach(function (el, i) {
        el.style.display = toks ? '' : 'none';
        el.classList.remove('hop');
        el.style.transitionDuration = '';
        if (!toks) return;
        var p = toks[i], xy = L.pos(k, i, p), key = p < 0 ? k + i : xy[0] + ',' + xy[1];
        (groups[key] = groups[key] || []).push({ el: el, x: xy[0], y: xy[1], can: k === c && mv.indexOf(i) >= 0 });
      });
    });
    Object.keys(groups).forEach(function (key) {
      var g = groups[key], n = Math.min(g.length, 4);
      g.sort(function (a, b) { return a.can - b.can; }); // movable on top
      g.forEach(function (t, j) {
        var o = STACK_OFF[n][j % n];
        place(t.el, t.x + o[0], t.y + o[1], STACK_SCALE[n]);
        t.el.classList.toggle('can', t.can);
        t.el.style.zIndex = t.can ? 3 : 1;
      });
    });

    L.COLORS.forEach(function (k) {
      var pn = panels[k];
      pn.el.classList.toggle('off', !S.tokens[k]);
      pn.el.classList.toggle('on', S.status === 'playing' && k === c);
      if (k === S.roller && S.dice) lastFace[k] = S.dice;
      setFace(k, lastFace[k]);
      pn.dice.classList.toggle('ready', act && k === c && S.phase === 'roll');
    });
  }

  // ---------- applying states (with animation) ----------
  function applyState(ns) {
    var my = sid;
    queue = queue.then(function () { return doApply(ns, my); }).catch(function (e) { console.error(e); busy = false; render(); });
  }

  function doApply(ns, my) {
    if (my !== sid) return;
    var prev = S, same = !!(prev && prev.gameId === ns.gameId);
    busy = true;
    var p = Promise.resolve();
    if (same && ns.rollId !== prev.rollId && ns.dice) p = p.then(function () { return animDice(ns.dice, ns.roller); });
    if (same && ns.last && (!prev.last || prev.last.id !== ns.last.id)) p = p.then(function () { return animMove(ns.last); });
    return p.then(function () {
      if (my !== sid) return;
      S = ns; busy = false;
      render();
      afterApply(prev, same);
    });
  }

  function animDice(v, color) {
    var pn = panels[color];
    if (!pn) return Promise.resolve();
    pn.el.classList.remove('off'); pn.el.classList.add('on');
    pn.dice.classList.remove('ready'); pn.dice.classList.add('rolling');
    Snd.roll(); buzz(15);
    return new Promise(function (res) {
      var n = 0, t = setInterval(function () {
        setFace(color, 1 + ((Math.random() * 6) | 0));
        if (++n >= 9) { clearInterval(t); lastFace[color] = v; setFace(color, v); pn.dice.classList.remove('rolling'); setTimeout(res, 350); }
      }, 75);
    });
  }

  // walk a token cell by cell along its path
  function walk(el, c, i, steps, ms, onStep) {
    var k = 0;
    el.style.transitionDuration = Math.round(ms * .85) + 'ms';
    return new Promise(function (res) {
      (function next() {
        if (k >= steps.length) return setTimeout(res, ms * .4);
        var xy = L.pos(c, i, steps[k++]);
        place(el, xy[0], xy[1], 1);
        if (onStep) onStep(el);
        setTimeout(next, ms);
      })();
    });
  }

  function animMove(m) {
    var el = tokEls[m.c][m.t];
    document.querySelectorAll('.tok.can').forEach(function (e) { e.classList.remove('can'); });
    el.style.zIndex = 6;
    var steps = [];
    if (m.from < 0) steps.push(0); else for (var p = m.from + 1; p <= m.to; p++) steps.push(p);
    return walk(el, m.c, m.t, steps, m.from < 0 ? 320 : 260, function (e) {
      hop(e);
      if (m.from < 0) Snd.out(); else Snd.step();
    }).then(function () {
      if (m.to === L.LAST) Snd.home();
      if (!m.caps.length) return;
      Snd.cut(); buzz([40, 30, 40]);
      // cut pieces run back along their own path to the yard
      return wait(250).then(function () {
        return Promise.all(m.caps.map(function (k) {
          var e2 = tokEls[k[0]][k[1]], back = [];
          for (var q = k[2] - 1; q >= 0; q--) back.push(q);
          back.push(-1);
          e2.style.zIndex = 5;
          var ms = Math.max(45, Math.min(110, 2000 / back.length));
          return walk(e2, k[0], k[1], back, ms, Snd.back);
        }));
      });
    });
  }

  function afterApply(prev, same) {
    var ns = S;
    if (same) {
      if (ns.rollId !== prev.rollId && ns.skip === 'three') toast('Three 6s! Turn lost');
      if (ns.winners.length > prev.winners.length && ns.status === 'playing') {
        var w = ns.winners[ns.winners.length - 1];
        toast('🏆 ' + seatName(w, ns.seats[w]) + ' finished #' + ns.winners.length);
      }
      if (mode === 'on' && ns.status === 'playing' && canAct() && (L.cur(prev) !== L.cur(ns) || prev.status !== 'playing')) buzz(30);
    }
    if (ns.status === 'over') setTimeout(showOver, same ? 500 : 0);
    else $('over').classList.add('hide');

    if (mode === 'off') {
      if (ns.status === 'over') store.del('ludo_off'); else store.set('ludo_off', JSON.stringify(ns));
      scheduleBot();
    }
  }

  // ---------- actions ----------
  function act(kind, t) {
    if (!canAct()) return;
    var ns = kind === 'roll' ? L.rollAuto(S) : L.move(S, t);
    if (ns === S) return;
    commit(ns);
  }
  function commit(ns) {
    if (mode === 'off') { busy = true; applyState(ns); }
    else if (mode === 'on') write(ns);
  }

  function scheduleBot() {
    clearTimeout(botTimer);
    if (mode !== 'off' || !S || S.status !== 'playing' || !S.seats[L.cur(S)].bot) return;
    botTimer = setTimeout(function () {
      if (busy || !S || S.status !== 'playing' || !S.seats[L.cur(S)].bot) return;
      commit(S.phase === 'roll' ? L.rollAuto(S) : L.move(S, L.botPick(S)));
    }, S.phase === 'roll' ? 800 : 650);
  }

  // Tap anywhere near a glowing token (big touch target for small phones)
  $('boardWrap').addEventListener('pointerdown', function (e) {
    if (!canAct() || S.phase !== 'move') return;
    var r = this.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width * 15, y = (e.clientY - r.top) / r.height * 15;
    var c = L.cur(S), best = -1, bd = 2.2;
    L.movable(S).forEach(function (i) {
      var xy = L.pos(c, i, S.tokens[c][i]), dx = xy[0] + .5 - x, dy = xy[1] + .5 - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) act('move', best);
  });

  function showOver() {
    if (!S || S.status !== 'over') return;
    var medals = ['🥇', '🥈', '🥉', '4️⃣'], ol = $('rank');
    ol.innerHTML = '';
    S.winners.forEach(function (c, i) {
      var li = document.createElement('li'), dot = document.createElement('span');
      dot.className = 'dot'; dot.style.background = HEX[c];
      li.appendChild(dot);
      li.appendChild(document.createTextNode(medals[i] + ' ' + seatName(c, S.seats[c])));
      ol.appendChild(li);
    });
    var canAgain = mode === 'off' || S.host === PID;
    $('bAgain').classList.toggle('hide', !canAgain);
    $('oWait').classList.toggle('hide', canAgain);
    $('over').classList.remove('hide');
  }
  $('bAgain').addEventListener('click', function () {
    if (!S) return;
    $('over').classList.add('hide');
    commit(L.newGame(S.seats, S.host));
  });
  $('bHome2').addEventListener('click', goHome);

  // ---------- players menu (remove someone who left) ----------
  function openPlayers() {
    if (!S) return;
    var box = $('pList'), canRemove = S.status === 'playing' && (mode === 'off' || S.host === PID);
    box.innerHTML = '';
    S.players.forEach(function (c) {
      var row = document.createElement('div'), dot = document.createElement('span'), b = document.createElement('b');
      row.className = 'seat'; dot.className = 'dot'; dot.style.background = HEX[c];
      b.textContent = seatName(c, S.seats[c]) + (S.winners.indexOf(c) >= 0 ? ' 🏆' : '');
      row.appendChild(dot); row.appendChild(b);
      if (canRemove && !(mode === 'on' && S.seats[c].id === PID)) {
        var bt = document.createElement('button');
        bt.className = 'icon small'; bt.textContent = 'Remove';
        bt.addEventListener('click', function () {
          if (!S || busy || pending) return toast('Wait a moment…');
          if (!confirm('Remove ' + seatName(c, S.seats[c]) + '? All their pieces will disappear.')) return;
          $('pmenu').classList.add('hide');
          commit(L.removePlayer(S, c));
        });
        row.appendChild(bt);
      }
      box.appendChild(row);
    });
    $('pNote').classList.toggle('hide', canRemove || S.status !== 'playing');
    $('pmenu').classList.remove('hide');
  }
  $('bPlayers').addEventListener('click', openPlayers);
  $('bPClose').addEventListener('click', function () { $('pmenu').classList.add('hide'); });

  function soundIcon() { $('bSound').textContent = Snd.isOn() ? '🔊' : '🔇'; }
  $('bSound').addEventListener('click', function () { Snd.toggle(); soundIcon(); });
  soundIcon();
  $('bExit').addEventListener('click', function () {
    if (S && S.status === 'playing' && !confirm(mode === 'off' ? 'Leave? (You can continue later)' : 'Leave the room? You can rejoin with the code.')) return;
    goHome();
  });

  // ---------- offline ----------
  var offCfg = { red: 'human', green: 'off', yellow: 'human', blue: 'off' };
  try { var saved = JSON.parse(store.get('ludo_offcfg')); if (saved && saved.red) offCfg = saved; } catch (e) { /* ignore */ }

  function renderSeats() {
    var box = $('seats'); box.innerHTML = '';
    L.COLORS.forEach(function (c) {
      var row = document.createElement('div'), dot = document.createElement('span'), b = document.createElement('b'), seg = document.createElement('div');
      row.className = 'seat'; dot.className = 'dot'; dot.style.background = HEX[c]; b.textContent = NAMES[c]; seg.className = 'seg';
      [['human', 'Player'], ['bot', 'Bot'], ['off', 'Off']].forEach(function (o) {
        var bt = document.createElement('button');
        bt.textContent = o[1]; bt.className = offCfg[c] === o[0] ? 'on' : '';
        bt.addEventListener('click', function () { offCfg[c] = o[0]; store.set('ludo_offcfg', JSON.stringify(offCfg)); renderSeats(); });
        seg.appendChild(bt);
      });
      row.appendChild(dot); row.appendChild(b); row.appendChild(seg); box.appendChild(row);
    });
  }

  function startGameScreen(m, title) {
    sid++; mode = m; S = null; busy = false; pending = false; queue = Promise.resolve();
    $('gTitle').textContent = title;
    $('over').classList.add('hide');
    show('game');
  }

  $('bOffline').addEventListener('click', function () { renderSeats(); show('setup'); });
  $('bStartOff').addEventListener('click', function () {
    var seats = {}, n = 0, firstHuman = true, nm = myName();
    L.COLORS.forEach(function (c) {
      if (offCfg[c] === 'off') return;
      n++;
      var bot = offCfg[c] === 'bot', name = bot ? NAMES[c] + ' 🤖' : NAMES[c];
      if (!bot && firstHuman && nm) { name = nm; }
      if (!bot) firstHuman = false;
      seats[c] = { name: name, bot: bot };
    });
    if (n < 2) return toast('Pick at least 2 players');
    startGameScreen('off', 'Offline');
    applyState(L.newGame(seats));
  });
  $('bResume').addEventListener('click', function () {
    try {
      var st = JSON.parse(store.get('ludo_off'));
      if (!st || st.status !== 'playing') throw 0;
      startGameScreen('off', 'Offline');
      applyState(st);
    } catch (e) { store.del('ludo_off'); refreshHome(); }
  });

  // ---------- online (Supabase) ----------
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = function () { rej(new Error('Could not load online module. Check internet.')); };
      document.head.appendChild(s);
    });
  }
  function ensureSB() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) return Promise.reject(new Error('Online is not set up yet (fill config.js)'));
    if (sb) return Promise.resolve();
    return (window.supabase ? Promise.resolve() : loadScript(SB_SRC)).then(function () {
      sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    });
  }
  function needName() {
    if (myName()) { store.set('ludo_name', myName()); return false; }
    toast('Enter your name first'); $('name').focus(); return true;
  }
  function fetchRow(code) {
    return sb.from('rooms').select('code,state,version').eq('code', code).maybeSingle().then(function (r) {
      if (r.error) throw r.error;
      return r.data;
    });
  }
  // Optimistic write: only succeeds if nobody changed the room since version `ver`
  function cas(code, ver, st) {
    return sb.from('rooms').update({ state: st, version: ver + 1, updated_at: new Date().toISOString() })
      .eq('code', code).eq('version', ver).select('version').then(function (r) {
        if (r.error) throw r.error;
        return !!(r.data && r.data.length);
      });
  }

  function lockBtns(on) { ['bCreate', 'bJoin'].forEach(function (id) { $(id).disabled = on; }); }

  function createRoom() {
    if (needName()) return;
    lockBtns(true);
    ensureSB().then(function () {
      // tidy up rooms nobody touched for 2 days
      sb.from('rooms').delete().lt('updated_at', new Date(Date.now() - 2 * 864e5).toISOString()).then(function () {});
      var tries = 0;
      return (function attempt() {
        var code = rid(4).toUpperCase();
        var st = { status: 'lobby', host: PID, seats: { red: { id: PID, name: myName() } } };
        return sb.from('rooms').insert({ code: code, state: st, version: 1 }).then(function (r) {
          if (r.error) {
            if (r.error.code === '23505' && ++tries < 5) return attempt();
            throw r.error;
          }
          enterRoom(code, { code: code, state: st, version: 1 });
        });
      })();
    }).catch(function (e) { toast(e.message || 'Could not create room'); }).then(function () { lockBtns(false); });
  }

  function joinRoom(code) {
    code = (code || '').trim().toUpperCase();
    if (code.length < 4) return toast('Enter the room code');
    if (needName()) return;
    lockBtns(true);
    ensureSB().then(function () {
      var tries = 0;
      return (function attempt() {
        return fetchRow(code).then(function (row) {
          if (!row) throw new Error('Room ' + code + ' not found');
          var st = row.state;
          if (myColor(st)) return enterRoom(code, row);             // rejoin
          if (st.status !== 'lobby') { toast('Game already started — watching'); return enterRoom(code, row); }
          var free = JOIN_ORDER.filter(function (c) { return !st.seats[c]; })[0];
          if (!free) throw new Error('Room is full (4 players)');
          var ns = L.clone(st);
          ns.seats[free] = { id: PID, name: myName() };
          if (!ns.host) ns.host = PID;
          return cas(code, row.version, ns).then(function (ok) {
            if (ok) return enterRoom(code, { code: code, state: ns, version: row.version + 1 });
            if (++tries < 5) return attempt();
            throw new Error('Busy room, try again');
          });
        });
      })();
    }).catch(function (e) { toast(e.message || 'Could not join'); }).then(function () { lockBtns(false); });
  }

  function enterRoom(code, row) {
    sid++; mode = 'on'; room = code; V = 0; S = null; LS = null; busy = false; pending = false; queue = Promise.resolve();
    try { history.replaceState(null, '', location.pathname + '?room=' + code); } catch (e) { /* ignore */ }
    if (chan) sb.removeChannel(chan);
    chan = sb.channel('room-' + code)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: 'code=eq.' + code },
        function (p) { if (p.new && p.new.state) onRow(p.new); })
      .subscribe(function (status) { if (status === 'SUBSCRIBED') refetch(); });
    clearInterval(pollT);
    // safety net for flaky mobile connections: light poll while the tab is visible
    pollT = setInterval(function () { if (!document.hidden && !pending) refetch(); }, 4000);
    onRow(row);
  }

  function refetch() {
    if (mode !== 'on' || !room) return Promise.resolve();
    var r = room;
    return fetchRow(r).then(function (row) {
      if (room !== r) return;
      if (!row) { toast('Room closed'); return goHome(); }
      onRow(row);
    }).catch(function () { /* offline for a moment, poll will retry */ });
  }

  function onRow(row) {
    if (row.version <= V) return;
    V = row.version; lastChange = Date.now();
    route(row.state);
  }

  function route(st) {
    if (st.status === 'lobby') { LS = st; S = null; renderLobby(); return; }
    LS = null;
    if (!$('game').classList.contains('on')) {
      $('gTitle').textContent = 'Room ' + room;
      $('over').classList.add('hide');
      show('game');
    }
    applyState(st);
  }

  function write(ns) {
    if (pending) return;
    pending = true; render();
    var ver = V;
    cas(room, ver, ns).then(function (ok) {
      pending = false;
      if (!ok) { toast('Syncing…'); return refetch(); }
      if (V === ver) { V = ver + 1; lastChange = Date.now(); route(ns); }
    }).catch(function () {
      pending = false; render(); toast('Network issue, try again');
    });
  }

  function renderLobby() {
    show('lobby');
    $('lCode').textContent = room;
    var box = $('lSeats'); box.innerHTML = '';
    var n = 0;
    JOIN_ORDER.forEach(function (c) {
      var seat = LS.seats[c], row = document.createElement('div'), dot = document.createElement('span'), b = document.createElement('b'), tag = document.createElement('span');
      row.className = 'seat'; dot.className = 'dot'; dot.style.background = HEX[c]; tag.className = 'tag';
      if (seat) { n++; b.textContent = seat.name + (seat.id === PID ? ' (you)' : ''); tag.textContent = seat.id === LS.host ? 'host' : ''; }
      else { b.textContent = 'Waiting…'; b.style.opacity = .45; }
      row.appendChild(dot); row.appendChild(b); row.appendChild(tag); box.appendChild(row);
    });
    var host = LS.host === PID;
    $('bStartOn').classList.toggle('hide', !host);
    $('bStartOn').disabled = n < 2;
    $('bStartOn').textContent = n < 2 ? 'Need 2+ players' : 'Start game (' + n + ' players)';
    $('lWait').classList.toggle('hide', host);
  }

  $('bStartOn').addEventListener('click', function () {
    if (!LS || LS.host !== PID) return;
    write(L.newGame(LS.seats, LS.host));
  });
  $('bShare').addEventListener('click', function () {
    var url = location.origin + location.pathname + '?room=' + room;
    if (navigator.share) { navigator.share({ title: 'Ludo', text: 'Join my Ludo room ' + room, url: url }).catch(function () {}); return; }
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
      function () { toast('Invite link copied!'); },
      function () { prompt('Copy this link', url); });
  });
  $('bLeave').addEventListener('click', function () {
    if (!LS || !room) return goHome();
    var mine = myColor(LS);
    if (!mine) return goHome();
    var ns = L.clone(LS);
    delete ns.seats[mine];
    if (ns.host === PID) { var k = Object.keys(ns.seats)[0]; ns.host = k ? ns.seats[k].id : null; }
    cas(room, V, ns).catch(function () {}).then(goHome);
  });

  // Host can skip a stuck player (closed app / lost network)
  $('bSkip').addEventListener('click', function () {
    if (mode !== 'on' || !S || S.host !== PID || busy || pending) return;
    if (confirm('Skip ' + seatName(L.cur(S), S.seats[L.cur(S)]) + "'s turn?")) write(L.skipTurn(S));
  });
  setInterval(function () {
    var vis = mode === 'on' && S && S.status === 'playing' && S.host === PID &&
      S.seats[L.cur(S)].id !== PID && Date.now() - lastChange > 20000;
    $('bSkip').classList.toggle('hide', !vis);
  }, 1000);

  document.addEventListener('visibilitychange', function () { if (!document.hidden && mode === 'on') refetch(); });

  // ---------- home ----------
  function goHome() {
    sid++; mode = null; S = null; LS = null; room = null; V = 0; busy = false; pending = false;
    queue = Promise.resolve();
    clearTimeout(botTimer); clearInterval(pollT);
    if (chan && sb) { sb.removeChannel(chan); chan = null; }
    $('over').classList.add('hide'); $('pmenu').classList.add('hide');
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    refreshHome();
    show('home');
  }
  function refreshHome() {
    var has = false;
    try { var st = JSON.parse(store.get('ludo_off')); has = !!(st && st.status === 'playing'); } catch (e) { /* ignore */ }
    $('bResume').classList.toggle('hide', !has);
  }
  document.querySelectorAll('[data-home]').forEach(function (b) { b.addEventListener('click', goHome); });
  $('bCreate').addEventListener('click', createRoom);
  $('bJoin').addEventListener('click', function () { joinRoom($('code').value); });
  $('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinRoom($('code').value); });
  $('name').addEventListener('change', function () { store.set('ludo_name', myName()); });

  // ---------- boot ----------
  buildBoard();
  $('name').value = store.get('ludo_name') || '';
  refreshHome();
  var qRoom = new URLSearchParams(location.search).get('room');
  if (qRoom) {
    $('code').value = qRoom.toUpperCase();
    if (myName()) joinRoom(qRoom); else { toast('Enter your name, then tap Join'); $('name').focus(); }
  }
})();
