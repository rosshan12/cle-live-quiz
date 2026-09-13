function defaultState(code) {
  return {
    code: code || 'LEARN6',
    phase: 'lobby',
    participants: {},
    question: null,
    answers: {},
    reveal: false,
    showBoard: false
  };
}

function reduce(state, msg, now) {
  state = state || defaultState();
  switch (msg.type) {

    case 'join': {
      if (!msg.id || !msg.name) return state;
      var existing = state.participants[msg.id];
      state.participants[msg.id] = {
        id: msg.id,
        name: String(msg.name).slice(0, 40),
        score: existing ? existing.score : 0,
        lastDelta: existing ? existing.lastDelta : 0
      };
      return state;
    }

    case 'launch': {
      if (!msg.text || !Array.isArray(msg.options) || msg.options.length < 2) return state;
      state.question = {
        text: String(msg.text).slice(0, 300),
        options: msg.options.slice(0, 6).map(function (o) { return String(o).slice(0, 200); }),
        correct: Number.isInteger(msg.correct) ? msg.correct : 0,
        duration: Math.max(5, Math.min(120, Number(msg.duration) || 20)),
        started: now
      };
      state.answers = {};
      state.reveal = false;
      state.showBoard = false;
      state.phase = 'live';
      return state;
    }

    case 'answer': {
      if (!msg.id || !state.question) return { state: state, rejected: 'no_active_question' };
      if (state.answers[msg.id]) return { state: state, rejected: 'already_answered' };
      var deadline = state.question.started + state.question.duration * 1000;
      if (now > deadline) return { state: state, rejected: 'time_expired' };
      if (!Number.isInteger(msg.option) || msg.option < 0 || msg.option >= state.question.options.length) {
        return { state: state, rejected: 'invalid_option' };
      }
      state.answers[msg.id] = { option: msg.option, time: now };
      return { state: state, rejected: null };
    }

    case 'reveal': {
      if (!state.question) return state;
      state.reveal = true;
      var all = Object.entries(state.answers || {});
      var correct = all
        .filter(function (e) { return e[1].option === state.question.correct; })
        .sort(function (a, b) { return a[1].time - b[1].time; });

      correct.forEach(function (entry, idx) {
        var id = entry[0], a = entry[1];
        var elapsed = Math.max(0, (a.time - state.question.started) / 1000);
        var remain = Math.max(0, 1 - elapsed / state.question.duration);
        var bonus = idx === 0 ? 1000 : Math.round(100 + 900 * remain);
        var delta = 1000 + bonus;
        if (!state.participants[id]) return;
        state.participants[id].score = (state.participants[id].score || 0) + delta;
        state.participants[id].lastDelta = delta;
        a.base = 1000;
        a.bonus = bonus;
        a.rank = 0;
      });

      var sorted = Object.values(state.participants).sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
      sorted.forEach(function (p, i) {
        var a = state.answers[p.id];
        if (a) a.rank = i + 1;
      });
      return state;
    }

    case 'showBoard': {
      state.showBoard = true;
      return state;
    }

    case 'reset': {
      return defaultState(state.code);
    }

    default:
      return state;
  }
}

export class SessionRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sockets = new Set();
    this.session = null;
  }

  async ensureLoaded(defaultCode) {
    if (this.session) return;
    let saved = null;
    try { saved = await this.ctx.storage.get('session'); } catch (e) { saved = null; }
    this.session = saved || defaultState(defaultCode);
  }

  async persistAndBroadcast() {
    try { await this.ctx.storage.put('session', this.session); } catch (e) {}
    const payload = JSON.stringify({ kind: 'state', state: this.session });
    for (const sock of this.sockets) {
      try { sock.send(payload); } catch (e) { this.sockets.delete(sock); }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const codeParam = (url.searchParams.get('code') || 'LEARN6').toUpperCase();
    await this.ensureLoaded(codeParam);
    if (!this.session.code) this.session.code = codeParam;

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade request', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);

    try { server.send(JSON.stringify({ kind: 'state', state: this.session })); } catch (e) {}

    server.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }
      const now = Date.now();

      if (msg.type === 'answer') {
        const result = reduce(this.session, msg, now);
        this.session = result.state;
        if (result.rejected) {
          try { server.send(JSON.stringify({ kind: 'error', reason: result.rejected })); } catch (e) {}
        } else {
          this.persistAndBroadcast();
        }
      } else {
        this.session = reduce(this.session, msg, now);
        this.persistAndBroadcast();
      }
    });

    server.addEventListener('close', () => { this.sockets.delete(server); });
    server.addEventListener('error', () => { this.sockets.delete(server); });

    return new Response(null, { status: 101, webSocket: client });
  }
}

function adminHtml() {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Live Quiz Admin</title><style>" +
":root{--blue:#0000FF;--neon:#CFF91C;--sky:#00A2FF;--yellow:#FEDA00;--green:#09BC09;--navy:#0E1540;--ink:#1A1E36;--bg:#F6F7FB}" +
"*{box-sizing:border-box}" +
"body{margin:0;font-family:Arial,sans-serif;background:radial-gradient(circle at 10% 0,#eef0ff 0,transparent 28%),radial-gradient(circle at 90% 10%,#e8f8ff 0,transparent 32%),var(--bg);color:var(--ink)}" +
".top{height:6px;background:var(--neon)}" +
"header{padding:20px 28px;background:white;border-bottom:1px solid #e3e5ed;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}" +
".brand{font-weight:900;color:var(--navy)}" +
".pill{border-radius:999px;padding:7px 12px;font-size:12px;font-weight:700}" +
".live{background:#ecffec;color:#067806}" +
".wrap{max-width:1100px;margin:28px auto;padding:0 18px}" +
".card{background:#fff;border:1px solid #e2e5ee;border-radius:18px;padding:22px;box-shadow:0 8px 24px rgba(14,21,64,.08)}" +
"h1,h2{color:var(--navy);margin-top:0}" +
"button,input,select{font:inherit}" +
"button{border:0;border-radius:12px;padding:12px 18px;font-weight:800;cursor:pointer}" +
".primary{background:var(--blue);color:#fff}" +
".secondary{background:#eef0ff;color:var(--blue)}" +
".danger{background:#ffeded;color:#b50000}" +
".grid{display:grid;gap:16px}" +
".g2{grid-template-columns:repeat(2,minmax(0,1fr))}" +
".stat{padding:16px;border-radius:14px;background:#f8f9fd}" +
".stat b{display:block;font-size:28px;color:var(--navy)}" +
"label{font-weight:700;font-size:13px;color:var(--navy)}" +
"input,select{width:100%;padding:13px;border:1px solid #ccd1df;border-radius:11px;margin:6px 0 14px;background:white}" +
".muted{color:#687086}" +
".hide{display:none!important}" +
".bar{height:14px;background:#e9ebf3;border-radius:8px;overflow:hidden}" +
".fill{height:100%;background:var(--blue);transition:width .5s}" +
".toast{position:fixed;right:20px;bottom:20px;background:var(--navy);color:white;border-radius:14px;padding:14px 18px;box-shadow:0 8px 24px #0003;z-index:50}" +
".leader{list-style:none;padding:0;margin:0}" +
".leader li{display:grid;grid-template-columns:42px 1fr auto;gap:10px;align-items:center;padding:12px;border-bottom:1px solid #edf0f5}" +
".leader li:first-child{background:#f7ffe2;border-radius:12px}" +
".delta{color:var(--green);font-weight:900}" +
".timer{height:8px;background:#e9ebf3;border-radius:6px;overflow:hidden}" +
".timer div{height:100%;background:var(--neon);transition:width 1s linear}" +
".code{font-size:40px;letter-spacing:8px;font-weight:900;color:var(--blue)}" +
".msg{display:none;border-radius:10px;padding:10px 12px;margin:6px 0 14px;font-size:13px;font-weight:700}" +
".msg.show{display:block}" +
".msg.err{background:#ffeded;color:#b50000}" +
".debug{background:#111;color:#0f0;font-family:monospace;font-size:11px;padding:6px 14px;word-break:break-all}" +
".joinlink{font-size:13px;color:#687086;word-break:break-all}" +
"@media(max-width:720px){.g2{grid-template-columns:1fr}header{padding:16px}.wrap{margin:18px auto}.code{font-size:30px}}" +
"</style></head><body>" +
"<div class=\"top\"></div>" +
"<header><div class=\"brand\">ONITY CENTER OF LEARNING EXCELLENCE ADMIN</div><span class=\"pill live\" id=\"connpill\">Connecting</span></header>" +
"<div id=\"debugstrip\" class=\"debug\">Connecting to live backend</div>" +
"<main class=\"wrap grid\">" +
"<section class=\"card\"><div class=\"grid g2\">" +
"  <div><div class=\"muted\">SESSION CODE</div><div class=\"code\" id=\"code\">------</div>" +
"  <div class=\"joinlink\">Participants join at: <span id=\"joinlink\"></span></div></div>" +
"  <div class=\"grid g2\"><div class=\"stat\"><span>Participants</span><b id=\"pc\">0</b></div><div class=\"stat\"><span>Answered</span><b id=\"ac\">0</b></div></div>" +
"</div></section>" +
"<section class=\"card\" id=\"setup\"><h2>Quiz setup</h2>" +
"<div class=\"grid g2\">" +
"  <div>" +
"    <label>Question</label><input id=\"q\" value=\"Which behavior best demonstrates effective acknowledgement?\">" +
"    <label>Duration seconds</label><select id=\"duration\"><option>10</option><option selected>20</option><option>30</option></select>" +
"  </div>" +
"  <div>" +
"    <label>Answers, correct option first</label>" +
"    <input class=\"opt\" value=\"Recognize the concern and its impact\">" +
"    <input class=\"opt\" value=\"Repeat the customers exact words\">" +
"    <input class=\"opt\" value=\"Move directly to the solution\">" +
"    <input class=\"opt\" value=\"Explain the process in detail\">" +
"  </div>" +
"</div>" +
"<div class=\"msg err\" id=\"setupMsg\"></div>" +
"<button class=\"primary\" id=\"launch\">Launch question</button>" +
"</section>" +
"<section class=\"card hide\" id=\"live\">" +
"  <div class=\"timer\"><div id=\"timerbar\" style=\"width:100%\"></div></div>" +
"  <p class=\"muted\" id=\"status\">Question live</p>" +
"  <h1 id=\"qview\"></h1>" +
"  <div id=\"dist\"></div>" +
"  <div style=\"display:flex;gap:10px;flex-wrap:wrap;margin-top:18px\">" +
"    <button class=\"primary\" id=\"reveal\">Reveal answer and score</button>" +
"    <button class=\"secondary\" id=\"board\">Show leaderboard</button>" +
"    <button class=\"danger\" id=\"reset\">Reset session</button>" +
"  </div>" +
"</section>" +
"<section class=\"card hide\" id=\"lb\"><h2>Leaderboard</h2><ol class=\"leader\" id=\"leader\"></ol></section>" +
"</main>" +
"<div id=\"toast\" class=\"toast hide\"></div>" +
"<script>" +
"(function(){" +
"\"use strict\";" +
"function genCode(){var c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',s='';for(var i=0;i<6;i++)s+=c[Math.floor(Math.random()*c.length)];return s;}" +
"var params=new URLSearchParams(location.search);" +
"var code=(params.get('code')||'').toUpperCase();" +
"if(!code){code=genCode();var u=new URL(location.href);u.searchParams.set('code',code);history.replaceState(null,'',u);}" +
"document.getElementById('code').textContent=code;" +
"document.getElementById('joinlink').textContent=location.origin+'/join?code='+code;" +
"var state={code:code,phase:'lobby',participants:{},question:null,answers:{},reveal:false,showBoard:false};" +
"var ws=null, reconnectDelay=1000, clickCount=0;" +
"function updateDebug(extra){" +
"  var d=document.getElementById('debugstrip');" +
"  if(!d)return;" +
"  d.textContent='ws:'+(ws&&ws.readyState===1?'open':'closed')+' clicks:'+clickCount+' phase:'+state.phase+' answered:'+Object.keys(state.answers||{}).length+(extra?(' '+extra):'');" +
"}" +
"function setConnPill(ok, label){" +
"  var p=document.getElementById('connpill');" +
"  p.textContent=label;" +
"  p.className = ok ? 'pill live' : 'pill';" +
"  p.style.background = ok ? '' : '#ffeded';" +
"  p.style.color = ok ? '' : '#b50000';" +
"}" +
"function connect(){" +
"  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';" +
"  ws = new WebSocket(proto + '//' + location.host + '/ws?code=' + encodeURIComponent(code) + '&role=admin');" +
"  ws.onopen = function(){ reconnectDelay = 1000; setConnPill(true, 'Live connected'); updateDebug('connected'); };" +
"  ws.onmessage = function(evt){" +
"    var msg; try { msg = JSON.parse(evt.data); } catch(e){ return; }" +
"    if (msg.kind === 'state') { state = msg.state; render(); updateDebug('state update'); }" +
"  };" +
"  ws.onclose = function(){" +
"    setConnPill(false, 'Reconnecting');" +
"    updateDebug('disconnected retrying');" +
"    setTimeout(connect, reconnectDelay);" +
"    reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);" +
"  };" +
"  ws.onerror = function(){ try{ ws.close(); }catch(e){} };" +
"}" +
"connect();" +
"function send(obj){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }" +
"function showMsg(id, text){" +
"  var el=document.getElementById(id);" +
"  el.textContent=text; el.classList.add('show');" +
"  setTimeout(function(){ el.classList.remove('show'); }, 3000);" +
"}" +
"function toast(t){" +
"  var x=document.getElementById('toast');" +
"  x.textContent=t; x.classList.remove('hide');" +
"  setTimeout(function(){ x.classList.add('hide'); }, 1800);" +
"}" +
"function render(){" +
"  document.getElementById('pc').textContent=Object.keys(state.participants).length;" +
"  document.getElementById('ac').textContent=Object.keys(state.answers||{}).length;" +
"  document.getElementById('setup').classList.toggle('hide', state.phase==='live');" +
"  document.getElementById('live').classList.toggle('hide', state.phase!=='live');" +
"  if (state.question){ document.getElementById('qview').textContent=state.question.text; renderDist(); startTimer(); }" +
"  renderLeader();" +
"  updateDebug();" +
"}" +
"function renderDist(){" +
"  var opts=state.question.options;" +
"  var counts=opts.map(function(_,i){ return Object.values(state.answers||{}).filter(function(a){return a.option===i;}).length; });" +
"  var max=Math.max(1, Math.max.apply(null, counts));" +
"  var colors=['#0000FF','#00A2FF','#FEDA00','#09BC09'];" +
"  document.getElementById('dist').innerHTML = opts.map(function(o,i){" +
"    return '<div style=\"margin:13px 0\"><b>'+String.fromCharCode(65+i)+'. '+o+'</b>'+" +
"      '<span style=\"float:right\">'+counts[i]+'</span>'+" +
"      '<div class=\"bar\"><div class=\"fill\" style=\"width:'+(counts[i]/max*100)+'%;background:'+colors[i]+'\"></div></div></div>';" +
"  }).join('');" +
"}" +
"function renderLeader(){" +
"  var arr=Object.values(state.participants).sort(function(a,b){return (b.score||0)-(a.score||0);});" +
"  document.getElementById('leader').innerHTML = arr.map(function(p,i){" +
"    return '<li><b>'+(i+1)+'</b><span>'+p.name+'</span><b>'+(p.score||0)+" +
"      ' <span class=\"delta\">'+(p.lastDelta?('+'+p.lastDelta):'')+'</span></b></li>';" +
"  }).join('');" +
"  document.getElementById('lb').classList.toggle('hide', !state.showBoard);" +
"}" +
"document.getElementById('launch').onclick=function(){" +
"  clickCount++; updateDebug('Launch clicked');" +
"  var opts=Array.prototype.map.call(document.querySelectorAll('.opt'), function(x){return x.value.trim();});" +
"  var qtext=document.getElementById('q').value.trim();" +
"  if(!qtext || opts.some(function(o){return !o;})){ showMsg('setupMsg','Please fill in the question and all four answer options.'); return; }" +
"  send({type:'launch', text:qtext, options:opts, correct:0, duration:+document.getElementById('duration').value});" +
"};" +
"var timerInterval;" +
"function startTimer(){" +
"  clearInterval(timerInterval);" +
"  if(!state.question) return;" +
"  var d=state.question.duration, end=state.question.started+d*1000;" +
"  timerInterval=setInterval(function(){" +
"    var left=Math.max(0, end-Date.now());" +
"    document.getElementById('timerbar').style.width=(left/(d*1000)*100)+'%';" +
"    document.getElementById('status').textContent = left ? ('Question live '+Math.ceil(left/1000)+'s') : 'Time is up, you can reveal now';" +
"    if(!left) clearInterval(timerInterval);" +
"  }, 250);" +
"}" +
"document.getElementById('reveal').onclick=function(){" +
"  clickCount++; updateDebug('Reveal clicked');" +
"  send({type:'reveal'});" +
"  toast('Scores released with speed bonuses');" +
"};" +
"document.getElementById('board').onclick=function(){ clickCount++; send({type:'showBoard'}); };" +
"document.getElementById('reset').onclick=function(){ clickCount++; send({type:'reset'}); };" +
"render();" +
"})();" +
"</script></body></html>";
}

function participantHtml() {
  return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Join Live Quiz</title><style>" +
":root{--blue:#0000FF;--neon:#CFF91C;--sky:#00A2FF;--yellow:#FEDA00;--green:#09BC09;--navy:#0E1540;--ink:#1A1E36;--bg:#F6F7FB}" +
"*{box-sizing:border-box}" +
"body{margin:0;font-family:Arial,sans-serif;background:radial-gradient(circle at 10% 0,#eef0ff 0,transparent 28%),radial-gradient(circle at 90% 10%,#e8f8ff 0,transparent 32%),var(--bg);color:var(--ink)}" +
".top{height:6px;background:var(--neon)}" +
"header{padding:20px 28px;background:white;border-bottom:1px solid #e3e5ed;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px}" +
".brand{font-weight:900;color:var(--navy)}" +
".pill{border-radius:999px;padding:7px 12px;font-size:12px;font-weight:700}" +
".live{background:#ecffec;color:#067806}" +
".wrap{max-width:760px;margin:28px auto;padding:0 18px}" +
".card{background:#fff;border:1px solid #e2e5ee;border-radius:18px;padding:22px;box-shadow:0 8px 24px rgba(14,21,64,.08)}" +
"h1,h2{color:var(--navy);margin-top:0}" +
"button,input{font:inherit}" +
"button{border:0;border-radius:12px;padding:12px 18px;font-weight:800;cursor:pointer;width:100%}" +
".primary{background:var(--blue);color:#fff}" +
"label{font-weight:700;font-size:13px;color:var(--navy)}" +
"input{width:100%;padding:13px;border:1px solid #ccd1df;border-radius:11px;margin:6px 0 14px;background:white}" +
".muted{color:#687086}" +
".hide{display:none!important}" +
".answers{display:grid;grid-template-columns:1fr 1fr;gap:12px}" +
".answer{min-height:74px;text-align:left;padding:17px;color:white;font-size:16px;border-radius:12px;border:3px solid transparent;position:relative}" +
".answer[data-i='0']{background:var(--blue)}" +
".answer[data-i='1']{background:var(--sky)}" +
".answer[data-i='2']{background:var(--yellow);color:#000}" +
".answer[data-i='3']{background:var(--green)}" +
".answer.selected{border-color:#000;box-shadow:0 0 0 3px rgba(0,0,0,.15)}" +
".answer.selected::after{content:'Selected';position:absolute;top:8px;right:12px;font-size:12px;background:rgba(0,0,0,.25);padding:2px 8px;border-radius:999px}" +
".answer[disabled]{opacity:.55;cursor:default}" +
".bonus{font-size:52px;font-weight:900;color:var(--green);animation:pop .55s ease-out}" +
".basepts{font-size:28px;color:var(--blue);font-weight:900}" +
".rank{font-size:20px;font-weight:800;color:var(--navy)}" +
"@keyframes pop{0%{transform:scale(.3);opacity:0}70%{transform:scale(1.18)}100%{transform:scale(1);opacity:1}}" +
".leader{list-style:none;padding:0;margin:0}" +
".leader li{display:grid;grid-template-columns:42px 1fr auto;gap:10px;align-items:center;padding:12px;border-bottom:1px solid #edf0f5}" +
".leader li:first-child{background:#f7ffe2;border-radius:12px}" +
".delta{color:var(--green);font-weight:900}" +
".timer{height:8px;background:#e9ebf3;border-radius:6px;overflow:hidden}" +
".timer div{height:100%;background:var(--neon);transition:width 1s linear}" +
".center{text-align:center}" +
".code{font-size:40px;letter-spacing:8px;font-weight:900;color:var(--blue)}" +
".msg{display:none;border-radius:10px;padding:10px 12px;margin:6px 0 14px;font-size:13px;font-weight:700}" +
".msg.show{display:block}" +
".msg.err{background:#ffeded;color:#b50000}" +
".msg.info{background:#eef3ff;color:#0000FF}" +
".debug{background:#111;color:#0f0;font-family:monospace;font-size:11px;padding:6px 14px;word-break:break-all}" +
".dot-pulse{display:flex;gap:8px;justify-content:center;margin-top:14px}" +
".dot-pulse span{width:10px;height:10px;border-radius:50%;background:var(--blue);animation:dotpulse 1.2s infinite ease-in-out}" +
".dot-pulse span:nth-child(2){animation-delay:.2s;background:var(--sky)}" +
".dot-pulse span:nth-child(3){animation-delay:.4s;background:var(--green)}" +
"@keyframes dotpulse{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}" +
"@media(max-width:720px){.answers{grid-template-columns:1fr}header{padding:16px}.wrap{margin:18px auto}.code{font-size:30px}.bonus{font-size:44px}}" +
"</style></head><body>" +
"<div class=\"top\"></div>" +
"<header><div class=\"brand\">ONITY LIVE LEARNING</div><span class=\"pill live\" id=\"connpill\">Connecting</span></header>" +
"<div id=\"debugstrip\" class=\"debug\">Connecting to live backend</div>" +
"<main class=\"wrap\">" +
"<section class=\"card\" id=\"join\">" +
"  <h1>Join the live quiz</h1>" +
"  <label>Session code</label><input id=\"codein\" maxlength=\"6\" placeholder=\"e.g. AB12CD\">" +
"  <label>Your display name</label><input id=\"name\" placeholder=\"Enter your name\">" +
"  <div class=\"msg err\" id=\"joinMsg\"></div>" +
"  <button class=\"primary\" id=\"joinbtn\">Join session</button>" +
"  <p class=\"muted\">Ask the presenter for the session code shown on their screen.</p>" +
"</section>" +
"<section class=\"card center hide\" id=\"waiting\">" +
"  <h2>You are in</h2>" +
"  <div class=\"code\" id=\"waitCode\">------</div>" +
"  <p class=\"muted\">Waiting for the presenter to launch a question.</p>" +
"</section>" +
"<section class=\"card hide\" id=\"quiz\">" +
"  <div class=\"timer\"><div id=\"timerbar\" style=\"width:100%\"></div></div>" +
"  <p class=\"muted\" id=\"status\">Choose your answer</p>" +
"  <h1 id=\"qview\"></h1>" +
"  <div class=\"msg info\" id=\"quizMsg\"></div>" +
"  <div class=\"answers\" id=\"answers\"></div>" +
"</section>" +
"<section class=\"card center hide\" id=\"submitted\">" +
"  <h2>Answer submitted</h2>" +
"  <p class=\"muted\" id=\"submittedChoice\"></p>" +
"  <p class=\"muted\">Waiting for the presenter to reveal the results</p>" +
"  <div class=\"dot-pulse\"><span></span><span></span><span></span></div>" +
"</section>" +
"<section class=\"card center hide\" id=\"missed\">" +
"  <h2>Time is up</h2>" +
"  <p class=\"muted\">You did not submit an answer in time for this question.</p>" +
"</section>" +
"<section class=\"card center hide\" id=\"result\"><div id=\"resultBody\"></div></section>" +
"<section class=\"card hide\" id=\"lb\"><h2>Leaderboard</h2><ol class=\"leader\" id=\"leader\"></ol></section>" +
"</main>" +
"<script>" +
"(function(){" +
"\"use strict\";" +
"var params=new URLSearchParams(location.search);" +
"var codeFromUrl=(params.get('code')||'').toUpperCase();" +
"if(codeFromUrl) document.getElementById('codein').value=codeFromUrl;" +
"var pid;" +
"try { pid = sessionStorage.getItem('pid') || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())); sessionStorage.setItem('pid', pid); }" +
"catch(e){ pid = 'p_' + Math.random().toString(36).slice(2); }" +
"var state={code:'', phase:'lobby', participants:{}, question:null, answers:{}, reveal:false, showBoard:false};" +
"var ws=null, reconnectDelay=1000, clickCount=0, joined=false, myCode='';" +
"var lastRenderedQuestionKey=null, localSelectedOption=null, timerInterval;" +
"function updateDebug(extra){" +
"  var d=document.getElementById('debugstrip'); if(!d) return;" +
"  d.textContent='ws:'+(ws&&ws.readyState===1?'open':'closed')+' clicks:'+clickCount+' phase:'+state.phase+" +
"    ' myAnswer:'+(state.answers&&state.answers[pid]?('option '+state.answers[pid].option):'none')+(extra?(' '+extra):'');" +
"}" +
"function setConnPill(ok, label){" +
"  var p=document.getElementById('connpill');" +
"  p.textContent=label;" +
"  p.style.background = ok ? '#ecffec' : '#ffeded';" +
"  p.style.color = ok ? '#067806' : '#b50000';" +
"}" +
"function connectTo(code){" +
"  myCode = code;" +
"  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';" +
"  ws = new WebSocket(proto + '//' + location.host + '/ws?code=' + encodeURIComponent(code) + '&role=participant');" +
"  ws.onopen = function(){" +
"    reconnectDelay = 1000; setConnPill(true, 'Connected'); updateDebug('connected');" +
"    if (joined) send({type:'join', id:pid, name:document.getElementById('name').value.trim()||'Guest'});" +
"  };" +
"  ws.onmessage = function(evt){" +
"    var msg; try { msg = JSON.parse(evt.data); } catch(e){ return; }" +
"    if (msg.kind === 'state') { state = msg.state; render(); updateDebug('state update'); }" +
"    else if (msg.kind === 'error') { handleServerError(msg.reason); }" +
"  };" +
"  ws.onclose = function(){" +
"    setConnPill(false, 'Reconnecting'); updateDebug('disconnected retrying');" +
"    setTimeout(function(){ connectTo(myCode); }, reconnectDelay);" +
"    reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);" +
"  };" +
"  ws.onerror = function(){ try{ ws.close(); }catch(e){} };" +
"}" +
"function send(obj){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }" +
"function showMsg(id, text){" +
"  var el=document.getElementById(id);" +
"  el.textContent=text; el.classList.add('show');" +
"  setTimeout(function(){ el.classList.remove('show'); }, 3000);" +
"}" +
"function handleServerError(reason){" +
"  if (reason === 'time_expired'){ showMsg('quizMsg','Time is up for this question, your answer was not recorded.'); }" +
"  else if (reason === 'invalid_option'){ showMsg('quizMsg','That option could not be recorded. Please try again.'); }" +
"  else if (reason === 'no_active_question'){ showMsg('quizMsg','There is no active question right now.'); }" +
"}" +
"document.getElementById('joinbtn').onclick=function(){" +
"  clickCount++; updateDebug('Join clicked');" +
"  var code=document.getElementById('codein').value.trim().toUpperCase();" +
"  var nm=document.getElementById('name').value.trim();" +
"  if(!code){ showMsg('joinMsg','Please enter the session code.'); return; }" +
"  if(!nm){ showMsg('joinMsg','Please enter your display name.'); return; }" +
"  joined = true;" +
"  document.getElementById('waitCode').textContent = code;" +
"  if (ws && ws.readyState === 1 && myCode === code) { send({type:'join', id:pid, name:nm}); }" +
"  else { connectTo(code); }" +
"  document.getElementById('join').classList.add('hide');" +
"  document.getElementById('waiting').classList.remove('hide');" +
"};" +
"document.getElementById('answers').addEventListener('click', function(ev){" +
"  var btn = ev.target.closest('.answer');" +
"  if (!btn || btn.hasAttribute('disabled')) return;" +
"  var i = +btn.getAttribute('data-i');" +
"  answerClicked(i, btn);" +
"});" +
"function buildAnswerButtons(){" +
"  var opts=state.question.options;" +
"  document.getElementById('answers').innerHTML = opts.map(function(o,i){" +
"    return '<button type=\"button\" class=\"answer\" data-i=\"'+i+'\">'+String.fromCharCode(65+i)+'. '+o+'</button>';" +
"  }).join('');" +
"}" +
"function render(){" +
"  var me = state.participants[pid];" +
"  var showJoinScreen = !joined || !me;" +
"  document.getElementById('join').classList.toggle('hide', joined);" +
"  document.getElementById('waiting').classList.toggle('hide', showJoinScreen || state.phase === 'live');" +
"  var alreadyAnswered = !!(state.answers && state.answers[pid]);" +
"  var inLiveQuestion = !!(me && state.phase === 'live' && state.question);" +
"  var timeIsUp = !!(state.question && Date.now() > state.question.started + state.question.duration*1000);" +
"  var missedIt = inLiveQuestion && !alreadyAnswered && timeIsUp && !state.reveal;" +
"  document.getElementById('quiz').classList.toggle('hide', showJoinScreen || !inLiveQuestion || alreadyAnswered || missedIt);" +
"  document.getElementById('missed').classList.toggle('hide', showJoinScreen || !missedIt);" +
"  document.getElementById('submitted').classList.toggle('hide', showJoinScreen || !inLiveQuestion || !alreadyAnswered || state.reveal);" +
"  document.getElementById('result').classList.toggle('hide', showJoinScreen || !inLiveQuestion || !alreadyAnswered || !state.reveal);" +
"  document.getElementById('lb').classList.toggle('hide', showJoinScreen || !state.showBoard);" +
"  if (!showJoinScreen && inLiveQuestion){" +
"    document.getElementById('qview').textContent = state.question.text;" +
"    var qKey = state.question.started;" +
"    if (qKey !== lastRenderedQuestionKey){ buildAnswerButtons(); lastRenderedQuestionKey = qKey; localSelectedOption = null; }" +
"    var selected = alreadyAnswered ? state.answers[pid].option : localSelectedOption;" +
"    Array.prototype.forEach.call(document.querySelectorAll('#answers .answer'), function(b){" +
"      var i = +b.getAttribute('data-i');" +
"      b.classList.toggle('selected', i === selected);" +
"      if (alreadyAnswered) b.setAttribute('disabled','disabled');" +
"    });" +
"    if (!alreadyAnswered) startTimer();" +
"    var a = state.answers && state.answers[pid];" +
"    if (a && state.reveal) showResult(a);" +
"    if (a && !state.reveal){ document.getElementById('submittedChoice').textContent = 'You chose: ' + state.question.options[a.option]; }" +
"  }" +
"  renderLeader();" +
"  updateDebug();" +
"}" +
"function answerClicked(i, btnEl){" +
"  clickCount++; updateDebug('Answer ' + i + ' clicked');" +
"  localSelectedOption = i;" +
"  Array.prototype.forEach.call(document.querySelectorAll('#answers .answer'), function(b){" +
"    b.classList.toggle('selected', b === btnEl);" +
"    b.setAttribute('disabled','disabled');" +
"  });" +
"  document.getElementById('quizMsg').classList.remove('show');" +
"  if (state.answers && state.answers[pid]) return;" +
"  send({type:'answer', id: pid, option: i});" +
"}" +
"function startTimer(){" +
"  clearInterval(timerInterval);" +
"  if (!state.question) return;" +
"  var d=state.question.duration, end=state.question.started+d*1000;" +
"  timerInterval=setInterval(function(){" +
"    var left=Math.max(0, end-Date.now());" +
"    var bar=document.getElementById('timerbar'), st=document.getElementById('status');" +
"    if (bar) bar.style.width=(left/(d*1000)*100)+'%';" +
"    if (st) st.textContent = left ? ('Choose your answer '+Math.ceil(left/1000)+'s') : 'Time is up';" +
"    if (!left){ clearInterval(timerInterval); render(); }" +
"  }, 250);" +
"}" +
"function showResult(a){" +
"  var ok = a.option === state.question.correct;" +
"  var body = document.getElementById('resultBody');" +
"  if (ok){" +
"    body.innerHTML = '<h2>Correct</h2><div class=\"basepts\">Base points +'+a.base+'</div>'+" +
"      '<div class=\"bonus\">+'+a.bonus+'</div><p class=\"muted\">Speed bonus</p>'+" +
"      '<div class=\"rank\">Total earned +'+(a.base+a.bonus)+' Rank #'+a.rank+'</div>';" +
"  } else {" +
"    body.innerHTML = '<h2>Not quite</h2><div class=\"bonus\" style=\"color:#929292\">+0</div>'+" +
"      '<p>The correct answer is <b>'+state.question.options[state.question.correct]+'</b>.</p>';" +
"  }" +
"}" +
"function renderLeader(){" +
"  if (!state.participants) return;" +
"  var arr=Object.values(state.participants).sort(function(a,b){return (b.score||0)-(a.score||0);});" +
"  document.getElementById('leader').innerHTML = arr.map(function(p,i){" +
"    return '<li><b>'+(i+1)+'</b><span>'+p.name+'</span><b>'+(p.score||0)+" +
"      ' <span class=\"delta\">'+(p.lastDelta?('+'+p.lastDelta):'')+'</span></b></li>';" +
"  }).join('');" +
"}" +
"if (codeFromUrl){ connectTo(codeFromUrl); } else { setConnPill(false, 'Enter a code to connect'); }" +
"render();" +
"})();" +
"</script></body></html>";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', application: 'CLE Live Quiz', realtime: 'active' });
    }

    if (url.pathname === '/ws') {
      const code = (url.searchParams.get('code') || 'LEARN6').toUpperCase();
      const id = env.SESSION_ROOM.idFromName(code);
      const stub = env.SESSION_ROOM.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/admin') {
      return new Response(adminHtml(), {
        headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' }
      });
    }

    if (url.pathname === '/join' || url.pathname === '/') {
      return new Response(participantHtml(), {
        headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store' }
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
