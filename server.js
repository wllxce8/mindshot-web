// Mindshot — servidor de lobbies em tempo real (Node 18+, SEM dependências).
// Serve o jogo (index.html) e fala WebSocket em /ws.
const http=require("http"),crypto=require("crypto"),fs=require("fs"),path=require("path");
const PORT=process.env.PORT||3000,GUID="258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const lobbies=new Map(); // code -> lobby
const ALPHA="ABCDEFGHJKLMNPQRSTUVWXYZ23456789",rid=n=>crypto.randomBytes(n).toString("hex");
const newCode=()=>{let c;do{c=Array.from({length:5},()=>ALPHA[crypto.randomInt(32)]).join("")}while(lobbies.has(c));return c};

const srv=http.createServer((req,res)=>{
  if(req.url==="/health"){res.end("ok");return}
  fs.readFile(path.join(__dirname,"index.html"),(e,d)=>{
    if(e){res.writeHead(404);res.end("index.html não encontrado");return}
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache"});res.end(d)})});

/* --- WebSocket mínimo (RFC 6455) --- */
function frame(op,buf){const n=buf.length;let h;
  if(n<126)h=Buffer.from([0x80|op,n]);else if(n<65536){h=Buffer.alloc(4);h[0]=0x80|op;h[1]=126;h.writeUInt16BE(n,2)}
  else{h=Buffer.alloc(10);h[0]=0x80|op;h[1]=127;h.writeBigUInt64BE(BigInt(n),2)}return Buffer.concat([h,buf])}
srv.on("upgrade",(req,sock)=>{
  if(req.url.split("?")[0]!=="/ws"||!req.headers["sec-websocket-key"]){sock.destroy();return}
  const acc=crypto.createHash("sha1").update(req.headers["sec-websocket-key"]+GUID).digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+acc+"\r\n\r\n");
  const c={sock,alive:true,lobby:null,pid:null};let buf=Buffer.alloc(0);
  c.send=o=>{if(!sock.destroyed)sock.write(frame(1,Buffer.from(JSON.stringify(o))))};
  sock.setNoDelay(true);
  sock.on("data",d=>{buf=Buffer.concat([buf,d]);if(buf.length>1<<20){sock.destroy();return}
    for(;;){if(buf.length<2)return;const op=buf[0]&15;let len=buf[1]&127,off=2;
      if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4}
      else if(len===127){if(buf.length<10)return;len=Number(buf.readBigUInt64BE(2));off=10}
      const masked=buf[1]&128;if(buf.length<off+(masked?4:0)+len)return;
      let mk=masked?buf.subarray(off,off+4):null;off+=masked?4:0;
      const p=Buffer.from(buf.subarray(off,off+len));if(mk)for(let i=0;i<p.length;i++)p[i]^=mk[i&3];
      buf=buf.subarray(off+len);
      if(op===8){sock.end(frame(8,Buffer.alloc(0)));return}
      if(op===9){sock.write(frame(10,p));continue}
      if(op===1){let m;try{m=JSON.parse(p.toString())}catch(_){continue}try{onMsg(c,m)}catch(e){c.send({t:"err",msg:"Erro no servidor"})}}}});
  const gone=()=>{if(!c.alive)return;c.alive=false;drop(c)};sock.on("close",gone);sock.on("error",gone);
});
setInterval(()=>{for(const l of lobbies.values())for(const p of l.players.values())if(p.conn&&p.conn.alive)p.conn.sock.write(frame(9,Buffer.alloc(0)))},25000);

/* --- lobbies --- */
const clean=s=>String(s||"").replace(/[<>]/g,"").trim().slice(0,30);
const pub=l=>({code:l.code,name:l.name,max:l.max,dur:l.dur,pre:l.pre,custom:l.custom,noRepeat:l.noRepeat,play:l.play,status:l.status,
  players:[...l.players.values()].map(p=>({id:p.id,name:p.name,role:p.role,online:!!(p.conn&&p.conn.alive),score:p.score||0}))});
const bcast=(l,o)=>{for(const p of l.players.values())if(p.conn&&p.conn.alive)p.conn.send(o)};
const push=l=>bcast(l,{t:"lobby",lobby:pub(l)});
function drop(c){const l=c.lobby;if(!l)return;const p=l.players.get(c.pid);if(!p||p.conn!==c)return;p.conn=null;p.off=Date.now();push(l)}
setInterval(()=>{const now=Date.now();for(const [k,l] of lobbies){ // limpa lobbies vazios após 30 min; alunos offline >2 min saem se ainda no lobby
  const any=[...l.players.values()].some(p=>p.conn&&p.conn.alive);const last=Math.max(...[...l.players.values()].map(p=>p.off||l.t0));
  if(!any&&now-last>30*60*1000){lobbies.delete(k);continue}
  if(l.status==="lobby")for(const [id,p] of l.players)if(p.role==="stu"&&!p.conn&&now-p.off>120000){l.players.delete(id);push(l)}}},10000);

function onMsg(c,m){
  const l=c.lobby,me=l&&l.players.get(c.pid);
  switch(m.t){
  case "create":{
    const code=newCode(),pid=rid(8),tok=rid(16);
    const L={code,name:clean(m.name)||"Lobby",max:Math.min(12,Math.max(2,+m.max||6)),dur:Math.min(30,Math.max(1,+m.dur||5)),pre:["f","m","fm","n"].includes(m.pre)?m.pre:"f",
      custom:Array.isArray(m.custom)?m.custom.slice(0,200).map(q=>[clean(q[0]).slice(0,200),(q[1]||[]).slice(0,8).map(a=>clean(a))]):[],noRepeat:!!m.noRepeat,play:!!m.play,status:"lobby",players:new Map(),t0:Date.now()};
    const p={id:pid,tok,name:clean(m.player)||"Professor",role:"prof",conn:c};L.players.set(pid,p);lobbies.set(code,L);c.lobby=L;c.pid=pid;
    c.send({t:"joined",pid,tok,lobby:pub(L)});break}
  case "join":{
    const L=lobbies.get(String(m.code||"").toUpperCase().trim());if(!L){c.send({t:"err",msg:"Lobby não encontrado. Confira o código."});return}
    // reconexão
    for(const p of L.players.values())if(m.tok&&p.tok===m.tok){if(p.conn&&p.conn!==c){p.conn.lobby=null;try{p.conn.sock.end()}catch(_){}}p.conn=c;c.lobby=L;c.pid=p.id;c.send({t:"joined",pid:p.id,tok:p.tok,lobby:pub(L),re:true});push(L);return}
    if(L.status!=="lobby"){c.send({t:"err",msg:"A partida já começou."});return}
    const humans=[...L.players.values()].filter(p=>!(p.role==="prof"&&!L.play)).length;
    if(humans>=L.max){c.send({t:"err",msg:"Lobby cheio."});return}
    const pid=rid(8),tok=rid(16),p={id:pid,tok,name:clean(m.player)||"Aluno",role:"stu",conn:c};L.players.set(pid,p);c.lobby=L;c.pid=pid;
    c.send({t:"joined",pid,tok,lobby:pub(L)});push(L);break}
  case "start":if(!me||me.role!=="prof"||l.status!=="lobby")return;l.status="playing";l.startAt=Date.now();bcast(l,{t:"start",lobby:pub(l),seed:crypto.randomInt(1e9)});push(l);break;
  case "state":if(!me)return; // relay de posição/estado a todos (para a sincronização em partida)
    for(const p of l.players.values())if(p.id!==me.id&&p.conn&&p.conn.alive)p.conn.send({t:"state",id:me.id,s:m.s});break;
  case "event":if(!me)return;if(typeof m.score==="number")me.score=m.score; // pergunta/resposta/eliminação/pontos
    bcast(l,{t:"event",id:me.id,e:m.e,d:m.d});break;
  case "end":if(!me||me.role!=="prof")return;l.status="lobby";bcast(l,{t:"end"});push(l);break;
  case "kick":if(!me||me.role!=="prof")return;{const p=l.players.get(m.id);if(p&&p.role!=="prof"){if(p.conn){p.conn.send({t:"kicked"});p.conn.lobby=null}l.players.delete(m.id);push(l)}}break;
  case "leave":if(!me)return;if(me.role==="prof"){bcast(l,{t:"closed"});lobbies.delete(l.code)}else{l.players.delete(me.id);push(l)}c.lobby=null;break;
  case "ping":c.send({t:"pong"});break}
}
srv.listen(PORT,()=>console.log("Mindshot online na porta "+PORT));
