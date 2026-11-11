export function board() {
  return Array.from({length:64}, (_, i) => {
    const row = i >> 3;
    return (row + i % 8) % 2 ? (row < 3 ? -1 : row > 4 ? 1 : 0) : 0;
  });
}
export function moves(cells, side, forced = null) {
  const jumps = [], steps = [];
  for (let from = 0; from < 64; from++) {
    const piece = cells[from];
    if (Math.sign(piece) !== side || (forced !== null && from !== forced)) continue;
    for (const dy of Math.abs(piece) === 2 ? [-1, 1] : [-side]) {
      for (const dx of [-1, 1]) {
        const y = (from >> 3) + dy, x = from % 8 + dx;
        if (y < 0 || y > 7 || x < 0 || x > 7) continue;
        const mid = y * 8 + x;
        if (!cells[mid]) steps.push({from, to:mid});
        const yy = y + dy, xx = x + dx;
        if (Math.sign(cells[mid]) === -side && yy >= 0 && yy < 8 && xx >= 0 && xx < 8 && !cells[yy*8+xx]) {
          jumps.push({from, to: yy*8+xx, capture:mid});
        }
      }
    }
  }
  return jumps.length || forced !== null ? jumps : steps;
}
const TURN = 120000;
const WARNING = 15000;
const fail = message => { throw new Error(message); };
const other = seat => 1 - seat;

function settle(state, match, winner, reason) {
  match.status = 'finished';
  match.winner = winner;
  match.reason = reason;
  if (winner === null) {
    match.players.forEach((id, i) => { state.users[id].coins += match.stakes[i]; });
  } else {
    const player = state.users[match.players[winner]];
    player.coins += match.stakes[0] + match.stakes[1];
    player.wins++;
  }
}

function startMatch(players) {
  return {id:crypto.randomUUID(), players, stakes:[null,null], agreed:[false,false], status:'lobby',
    cells:board(), turn:0, forced:null, quiet:0, positions:{}, drawOffer:null};
}
function activate(state, match, now) {
  for (let i = 0; i < 2; i++) {
    if (state.users[match.players[i]].coins < match.stakes[i]) fail('A player has insufficient coins.');
  }
  match.players.forEach((id, i) => { state.users[id].coins -= match.stakes[i]; });
  match.status = 'playing';
  match.deadline = now + TURN;
  match.extended = false;
  match.positions['0:' + match.cells.join(',')] = 1;
}

export function update(state, id, input, now) {
  const user = state.users[id];
  const busy = player => Object.values(state.matches).some(m => m.status !== 'finished' && m.players.includes(player));
  const {action, target, matchId, amount, from, to} = input;
  for (const match of Object.values(state.matches)) {
    if (match.status === 'playing' && now >= match.deadline + (match.extended ? 0 : WARNING)) {
      settle(state, match, other(match.turn), 'Time expired');
    }
  }
  if (action === 'status') return;
  if (action === 'name') {
    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 24) fail('Enter a display name of 2–24 characters.');
    user.name = name;
    return;
  }
  if (action === 'friend' || action === 'acceptFriend') {
    const peer = Object.values(state.users).find(p => p.code === target);
    if (!peer || peer.id === id) fail('Player code not found.');
    const key = [id, peer.id].sort().join(':');
    const request = state.friends[key];
    if (action === 'acceptFriend' && request?.to !== id) fail('Friend request unavailable.');
    state.friends[key] = request?.to === id ? {...request, accepted:true} : request ?? {from:id,to:peer.id,accepted:false};
    return;
  }
  if (action === 'cancelQueue') { delete state.queue[id]; return; }
  if (['invite','join','queue','challenge'].includes(action)) {
    if (busy(id)) fail('Finish or leave your current match first.');
    let match;
    if (action === 'join') {
      match = state.matches[target];
      if (match?.status !== 'lobby' || match.players.length !== 1) fail('This invite is unavailable.');
      if (match.invited && match.invited !== id) fail('This challenge belongs to another player.');
      match.players.push(id);
    } else if (action === 'queue') {
      const peer = Object.keys(state.queue).find(p => p !== id && state.queue[p] > now - 12000 && !busy(p));
      if (!peer) { state.queue[id] = now; return; }
      match = startMatch([peer,id]);
      delete state.queue[peer];
    } else {
      match = startMatch([id]);
      if (action === 'challenge') {
        const peer = Object.values(state.users).find(p => p.code === target);
        if (!peer || !state.friends[[id,peer.id].sort().join(':')]?.accepted) fail('Choose an accepted friend.');
        match.invited = peer.id;
      }
    }
    state.matches[match.id] = match;
    delete state.queue[id];
    return;
  }
  const match = state.matches[matchId];
  const seat = match?.players.indexOf(id) ?? -1;
  if (seat < 0 || match.status === 'finished') fail('Match unavailable.');
  if (match.status === 'lobby') {
    if (action === 'leave') { delete state.matches[matchId]; return; }
    if (action === 'stake') {
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > user.coins) fail('Enter a whole coin amount within your balance.');
      if (match.stakes[seat] !== amount) { match.stakes[seat] = amount; match.agreed = [false,false]; }
      return;
    }
    if (action !== 'agree' || match.players.length !== 2 || match.stakes.includes(null)) fail('Both players must submit stakes first.');
    if (!Array.isArray(input.stakes) || !match.stakes.every((stake,i) => stake === input.stakes[i])) fail('Stakes changed. Review the new amounts.');
    if (match.stakes[seat] > match.stakes[other(seat)] && input.unequal !== true) fail('Confirm that you accept the higher stake.');
    match.agreed[seat] = true;
    if (match.agreed.every(Boolean)) activate(state, match, now);
    return;
  }
  if (action === 'resign') { settle(state, match, other(seat), 'Resignation'); return; }
  if (action === 'draw') {
    if (match.drawOffer === other(seat)) settle(state, match, null, 'Draw agreed');
    else match.drawOffer = seat;
    return;
  }
  if (match.turn !== seat) fail('Wait for your turn.');
  if (action === 'present') {
    if (now < match.deadline || match.extended) fail('The inactivity warning is unavailable.');
    match.extended = true;
    match.deadline = now + TURN;
    return;
  }
  if (action !== 'move' || now >= match.deadline) fail('Confirm you are still playing to continue.');
  const side = seat === 0 ? 1 : -1;
  const move = moves(match.cells, side, match.forced).find(m => m.from === from && m.to === to);
  if (!move) fail('That move is illegal.');
  const piece = match.cells[from];
  const crowned = Math.abs(piece) === 1 && (to >> 3) === (side === 1 ? 0 : 7);
  match.cells[from] = 0;
  match.cells[to] = crowned ? 2 * side : piece;
  if (move.capture !== undefined) match.cells[move.capture] = 0;
  match.quiet = move.capture !== undefined || Math.abs(piece) === 1 ? 0 : match.quiet + 1;
  if (!crowned && move.capture !== undefined && moves(match.cells, side, to).length) {
    match.forced = to;
    return;
  }
  match.forced = null;
  match.drawOffer = null;
  match.turn = other(seat);
  match.deadline = now + TURN;
  match.extended = false;
  if (!moves(match.cells, -side).length) { settle(state, match, seat, 'No legal moves remain'); return; }
  const position = match.turn + ':' + match.cells.join(',');
  match.positions[position] = (match.positions[position] ?? 0) + 1;
  if (match.positions[position] >= 3 || match.quiet >= 80) settle(state, match, null, 'Draw by repetition or move limit');
}

function view(state, id, now) {
  const {users, matches, friends, queue} = state;
  const profile = p => ({name:p.name, code:p.code, wins:p.wins});
  const match = Object.values(matches).reverse().find(m => m.players.includes(id) && m.status !== 'finished')
    ?? Object.values(matches).reverse().find(m => m.players.includes(id));
  return {now, me:users[id], queued:queue[id] > now - 12000,
    leaders:Object.values(users).filter(p => p.wins > 0).sort((a,b) => b.wins-a.wins || a.name.localeCompare(b.name)).slice(0,3).map(profile),
    friends:Object.values(friends).filter(r => r.from === id || r.to === id)
      .map(r => ({...profile(users[r.from === id ? r.to : r.from]), incoming:r.to === id, accepted:r.accepted})),
    challenges:Object.values(matches).filter(m => m.invited === id && m.players.length === 1)
      .map(m => ({id:m.id, name:users[m.players[0]].name})),
    match:match ? {...match, positions:undefined, seat:match.players.indexOf(id), names:match.players.map(p => users[p].name)} : null};
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(HTML, {headers:{'content-type':'text/html; charset=utf-8'}});
    }
    if (url.pathname !== '/api') return new Response('Not found', {status:404});
    const id = request.headers.get('oai-authenticated-user-id');
    if (!id) return Response.json({error:'Sign in to play.'}, {status:401});
    if (request.method !== 'GET' && (request.method !== 'POST' || request.headers.get('origin') !== url.origin)) {
      return Response.json({error:'Invalid request origin.'}, {status:403});
    }
    let input;
    try { input = request.method === 'GET' ? {action:'status'} : await request.json(); }
    catch { return Response.json({error:'Invalid request.'}, {status:400}); }
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const row = await env.DB.prepare('SELECT revision, data FROM game_state WHERE id = 1').first();
        const state = JSON.parse(row.data);
        const now = Date.now();
        state.users[id] ??= {id, name:'Player ' + crypto.randomUUID().slice(0,4), code:crypto.randomUUID().slice(0,12), coins:500,wins:0};
        let error;
        const before = JSON.stringify(state);
        try { update(state, id, input, now); } catch (err) { error = err.message; }
        const next = error ? before : JSON.stringify(state);
        if (next !== row.data) {
          const result = await env.DB.prepare('UPDATE game_state SET revision = revision + 1, data = ? WHERE id = 1 AND revision = ?')
            .bind(next,row.revision).run();
          if (!result.meta.changes) continue;
        }
        return Response.json(error ? {error} : view(state,id,now), {status:error ? 400 : 200,headers:{'cache-control':'no-store'}});
      }
      return Response.json({error:'Server busy. Try again.'}, {status:503});
    } catch (err) {
      console.error(err);
      return Response.json({error:'Game storage is unavailable.'}, {status:503});
    }
  }
};

const HTML = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crownline Checkers</title>
<style>
:root{color-scheme:dark;--ink:#f4efe3;--muted:#aaa6a0;--panel:#201f23;--line:#353238;--gold:#f4c775;--red:#e67664}
*{box-sizing:border-box}body{margin:0;background:#151418;color:var(--ink);font:15px system-ui,sans-serif}header{border-bottom:1px solid var(--line);padding:18px clamp(18px,5vw,72px);display:flex;justify-content:space-between;align-items:center}.brand{font: bold 26px Georgia,serif}.brand span,.balance{color:var(--gold)}main{max-width:1200px;margin:auto;padding:36px 24px;display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,350px);gap:38px}h1,h2{font-family:Georgia,serif;margin:0 0 14px}h1{font-size:clamp(29px,5vw,52px);letter-spacing:-.04em}h2{font-size:22px}p{color:var(--muted);margin:0 0 15px;line-height:1.45}.board{display:grid;grid-template-columns:repeat(8,1fr);border:7px solid #352a27;border-radius:9px;overflow:hidden;aspect-ratio:1;box-shadow:0 16px 45px #0006}.cell{border:0;border-radius:0;padding:0;display:grid;place-items:center;position:relative;min-width:0;background:#e6cba9}.cell.dark{background:#7b5147}.cell.selected{box-shadow:inset 0 0 0 4px #ffdb75}.cell.hint:after{content:'';width:23%;aspect-ratio:1;border-radius:50%;background:#ffdf8a;position:absolute}.piece{width:73%;aspect-ratio:1;border-radius:50%;display:grid;place-items:center;background:#ae3f36;color:#ffe4aa;border:3px solid #e77b69;box-shadow:inset 0 0 0 4px #0002,0 4px 3px #25100d80;font-size:clamp(11px,3vw,28px)}.piece.black{background:#29272e;border-color:#57505b;color:#fff0bd}.bar{display:flex;align-items:center;justify-content:space-between;padding:13px 0;color:var(--muted);min-height:48px}.timer{font:700 17px ui-monospace,monospace;color:var(--gold)}aside{display:grid;gap:15px;align-content:start}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:19px}.row{display:flex;align-items:center;gap:8px;margin:9px 0;flex-wrap:wrap}.split{justify-content:space-between}button,a,input{font:inherit}button,a.action{background:#373239;color:var(--ink);border:1px solid #4c444e;border-radius:7px;padding:9px 12px;text-decoration:none;cursor:pointer}.primary{background:var(--gold)!important;color:#271a12!important;border-color:var(--gold)!important;font-weight:700}button:disabled{cursor:default;opacity:.65}button.cell{border:0;border-radius:0;padding:0;background:#e6cba9;opacity:1}button.cell.dark{background:#7b5147}input{min-width:0;max-width:100%;background:#17161a;color:var(--ink);border:1px solid #4c444e;border-radius:6px;padding:9px;width:155px}code{color:var(--gold);overflow-wrap:anywhere}.notice{padding:12px;background:#382a23;border:1px solid #b57952;border-radius:8px;margin:10px 0;color:#ffdeac}.flash{animation:pulse 1.2s alternate 4}@keyframes pulse{to{background:#7c422a}}@media(prefers-reduced-motion:reduce){.flash{animation:none}}#error{color:#ff9a89;min-height:20px}ol{padding-left:22px;margin-bottom:0}li{padding:5px 0}small{color:var(--muted)}@media(max-width:760px){main{grid-template-columns:1fr;gap:20px;padding:22px 14px}}
</style></head><body><header><div class="brand"><span>♛</span> Crownline</div><div class="balance" id="balance">Checkers</div></header>
<main><section><h1>Play checkers</h1><div class="bar"><span id="opponent">Opponent</span><span id="clock" class="timer"></span></div><div id="board" class="board" aria-label="Checkers board"></div><div class="bar"><span id="player">You</span><span id="turn"></span></div><div id="warning" aria-live="polite"></div><p id="error" role="alert"></p></section>
<aside><section class="panel"><h2>Play online</h2><div id="play"></div></section><section class="panel"><h2>Top 3 by wins</h2><div id="leaderboard"></div></section><section class="panel"><h2>Friends</h2><div id="friends"></div></section></aside></main>
<script>
function board() {
  return Array.from({length:64}, (_, i) => {
    const row = i >> 3;
    return (row + i % 8) % 2 ? (row < 3 ? -1 : row > 4 ? 1 : 0) : 0;
  });
}
function moves(cells, side, forced = null) {
  const jumps = [], steps = [];
  for (let from = 0; from < 64; from++) {
    const piece = cells[from];
    if (Math.sign(piece) !== side || (forced !== null && from !== forced)) continue;
    for (const dy of Math.abs(piece) === 2 ? [-1, 1] : [-side]) {
      for (const dx of [-1, 1]) {
        const y = (from >> 3) + dy, x = from % 8 + dx;
        if (y < 0 || y > 7 || x < 0 || x > 7) continue;
        const mid = y * 8 + x;
        if (!cells[mid]) steps.push({from, to:mid});
        const yy = y + dy, xx = x + dx;
        if (Math.sign(cells[mid]) === -side && yy >= 0 && yy < 8 && xx >= 0 && xx < 8 && !cells[yy*8+xx]) {
          jumps.push({from, to: yy*8+xx, capture:mid});
        }
      }
    }
  }
  return jumps.length || forced !== null ? jumps : steps;
}

let data, selection, queueing=false, pending=false, offset=0, invite=new URLSearchParams(location.search).get('invite');
const el=id=>document.getElementById(id);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(label,action,attrs='')=>'<button data-action="'+action+'" '+attrs+'>'+label+'</button>';
const target=value=>'data-target="'+escapeHtml(value)+'"';
function put(id, html){if(el(id).dataset.html!==html){el(id).dataset.html=html;el(id).innerHTML=html;}}
async function api(action='status', extra={}){
  if(pending)return;
  pending=true;
  try{
    const response=await fetch('/api',action==='status'?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,matchId:data?.match?.id,...extra})});
    const result=await response.json();
    if(response.status===401){
      put('play','<p>Sign in to challenge friends and keep your coin balance.</p><a class="action primary" target="_top" href="/signin-with-chatgpt?returnTo='+encodeURIComponent(location.pathname+location.search)+'">Sign in</a>');
      return;
    }
    if(!response.ok)throw Error(result.error);
    if(action!=='status'&&action!=='queue')el('error').textContent='';
    data=result;offset=result.now-Date.now();
    if(data.match?.status==='lobby'||data.match?.status==='playing')queueing=false;
    render();
  }catch(err){el('error').textContent=err.message;}
  finally{pending=false;}
}
function tick(){
  const m=data?.match;
  if(m?.status!=='playing'){el('clock').textContent='';put('warning','');return;}
  const left=m.deadline-(Date.now()+offset), warn=left<=0&&!m.extended;
  const seconds=Math.max(0,Math.ceil((left+(warn?15000:0))/1000));
  el('clock').textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  put('warning',warn&&m.turn===m.seat&&seconds>0?'<div class="notice" role="alert">Still playing? Confirm before the warning clock expires. '+button('I’m still playing','present','class="primary"')+'</div>':'');
}
function render(){
  const m=data?.match, seat=m?.seat??0, own=m?.status==='playing'&&m.turn===seat;
  const cells=m?.cells??board(), legal=own?moves(cells,seat===0?1:-1,m.forced):[];
  const active=m?.forced??selection;
  const indexes=Array.from({length:64},(_,i)=>seat===1?63-i:i);
  put('board',indexes.map(i=>{
    const piece=cells[i], dark=((i>>3)+i%8)%2, square='abcdefgh'[i%8]+(8-(i>>3));
    return '<button class="cell '+(dark?'dark ':'')+(active===i&&own?'selected ':'')+(legal.some(x=>x.from===active&&x.to===i)?'hint':'')+'" data-square="'+i+'" aria-label="'+square+(piece?(piece>0?' red':' black')+(Math.abs(piece)===2?' king':' piece'):' empty')+'">'+(piece?'<span class="piece '+(piece<0?'black':'')+'">'+(Math.abs(piece)===2?'♛':'')+'</span>':'')+'</button>';
  }).join(''));
  el('opponent').textContent=m?.names[1-seat]??'Opponent';
  el('player').textContent=data?.me.name??'You';
  el('turn').textContent=m?.status==='playing'?(own?'Your turn':'Opponent’s turn'):'';
  tick();
  if(!data)return;
  el('balance').textContent=data.me.coins+' coins';
  const open=m?.status==='playing'||m?.status==='lobby';
  let play='';
  if(!open){
    if(m?.status==='finished')play='<div class="notice">'+(m.winner===null?'Draw':m.winner===seat?'You won':'You lost')+' · '+escapeHtml(m.reason)+'</div>';
    if(invite)play+=button('Join private match','join',target(invite));
    play+='<div class="row">'+(queueing?button('Cancel search','cancelQueue'):button('Quick match','queue','class="primary"')+button('Private link','invite'))+'</div>';
    if(queueing)play+='<p>Searching for an opponent…</p>';
  }else if(m.status==='lobby'){
    if(m.players.length===1)play=m.invited?'<p>Waiting for your friend to accept.</p>':'<p>Share this private match link.</p>'+button('Copy invite link','copy');
    else play='<p>Both players must approve the stakes.</p>';
    const [mine,theirs]=[m.stakes[seat],m.stakes[1-seat]];
    play+='<form class="row" data-form="stake"><input name="amount" type="number" min="0" max="'+data.me.coins+'" value="'+(mine??0)+'" aria-label="Your stake" required>'+button('Set stake','stake')+'</form>';
    play+='<p>Your stake '+(mine??'—')+' · Opponent '+(theirs??'—')+'</p>';
    if(mine!==null&&theirs!==null){
      if(mine!==theirs)play+='<div class="notice flash" role="alert">Unequal stakes. '+(mine>theirs?'Are you sure you want to risk '+mine+' coins when your opponent risks '+theirs+'?':'Your opponent is risking more coins than you.')+'</div>';
      play+=m.agreed[seat]?'<p>Confirmed. Waiting for opponent.</p>':button(mine>theirs?'Yes, accept higher risk':'Confirm stakes','agree','class="primary"');
    }
    play+=' <span class="row">'+button('Leave lobby','leave')+'</span>';
  }else{
    play='<p>Stakes · You '+m.stakes[seat]+' / Opponent '+m.stakes[1-seat]+'</p><div class="row">'+button(m.drawOffer===1-seat?'Accept draw':m.drawOffer===seat?'Draw offered':'Offer draw','draw',m.drawOffer===seat?'disabled':'')+button('Resign','resign')+'</div>';
  }
  put('play',play);
  put('leaderboard',data.leaders.length?'<ol>'+data.leaders.map(p=>'<li>'+escapeHtml(p.name)+' · '+p.wins+' wins</li>').join('')+'</ol>':'<p>No wins yet.</p>');
  put('friends','<small>Your player code</small> <code>'+escapeHtml(data.me.code)+'</code><form data-form="friend" class="row"><input name="target" placeholder="Player code" aria-label="Friend’s player code" required>'+button('Add friend','friend')+'</form>'+
    '<form class="row" data-form="name"><input name="name" placeholder="Display name" aria-label="Display name" minlength="2" maxlength="24" required>'+button('Save name','name')+'</form>'+
    data.friends.map(f=>'<div class="row split">'+escapeHtml(f.name)+(f.accepted?(open?'':button('Challenge','challenge',target(f.code))):f.incoming?button('Accept','acceptFriend',target(f.code)):'<small>Pending</small>')+'</div>').join('')+
    data.challenges.map(c=>'<div class="row split">'+escapeHtml(c.name)+' invited you '+button('Join','join',target(c.id))).map(row=>row+'</div>').join(''));
}
document.addEventListener('submit',event=>{
  const action=event.target.dataset.form;
  if(!action)return;
  event.preventDefault();
  const fields=Object.fromEntries(new FormData(event.target));
  if(action==='stake')fields.amount=Number(fields.amount);
  api(action,fields);
});
document.addEventListener('click',async event=>{
  const btn=event.target.closest('button');if(!btn)return;
  if(btn.dataset.square!==undefined){
    const m=data?.match;
    if(m?.status!=='playing'||m.seat!==m.turn||Date.now()+offset>=m.deadline)return;
    const clicked=Number(btn.dataset.square), legal=moves(m.cells,m.seat===0?1:-1,m.forced);
    const move=legal.find(x=>x.from===(m.forced??selection)&&x.to===clicked);
    if(move){selection=null;await api('move',{from:move.from,to:move.to});}
    else{selection=legal.some(x=>x.from===clicked)?clicked:null;render();}
    return;
  }
  if(btn.closest('form'))return;
  const action=btn.dataset.action;if(!action)return;
  if(action==='copy'){
    const url=new URL(location.origin);url.searchParams.set('invite',data.match.id);
    try{await navigator.clipboard.writeText(url.href);btn.textContent='Link copied';}
    catch{window.prompt('Copy invite link',url.href);}
    return;
  }
  if(action==='resign'&&!confirm('Resign and forfeit your stake?'))return;
  if(action==='queue')queueing=true;
  if(action==='cancelQueue')queueing=false;
  const m=data?.match;
  await api(action,{target:btn.dataset.target,...(action==='agree'?{stakes:m.stakes,unequal:m.stakes[m.seat]>m.stakes[1-m.seat]}:{})});
  if(action==='join'&&data?.match?.players.length===2&&data.match.id===btn.dataset.target){invite=null;history.replaceState(null,'','/');render();}
});
render();api();setInterval(()=>api(queueing?'queue':'status'),1500);setInterval(tick,250);
</script></body></html>`;
