const http=require("http"),crypto=require("crypto"),fs=require("fs"),path=require("path"),{Pool}=require("pg");
const PORT=process.env.PORT||3000,GUID="258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const APP_SECRET=process.env.APP_SECRET||"turbine sua mente com o mindshot",SENDER_EMAIL=process.env.SENDER_EMAIL||"wallac1nmma@gmail.com";
const _d=s=>Buffer.from(s,"base64").toString("utf8");
const DB_URL=process.env.DATABASE_URL||_d("cG9zdGdyZXNxbDovL21pbmRzaG90X2RiX3VzZXI6dk94Mll1V0xBdHFadThWd3BoR0thbkZ2VEwwNHk4UDBAZHBnLWRjMHMzcGMwOTE2czczY21hbGtnLWEvbWluZHNob3RfZGI=");
const BREVO_KEY=process.env.BREVO_API_KEY||_d("eGtleXNpYi03NGNjNmU5NDdkMzk5NzBlMjRmZGViOGRiYzMzOWE4MDRkY2RhZGMyMDUzMGQyYzhmMzI3NDExMWJkZDc0MWE4LTI0d0lyQzBzQ3p0eWI2Z28=");
const pool=new Pool({connectionString:DB_URL,ssl:DB_URL.includes("render.com")?{rejectUnauthorized:false}:false});
pool.query("CREATE TABLE IF NOT EXISTS users(email VARCHAR(255) PRIMARY KEY,username VARCHAR(30),pass_hash TEXT,name VARCHAR(100),role VARCHAR(20) DEFAULT 'stu',otp_code VARCHAR(10),otp_expires BIGINT);ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(30),ADD COLUMN IF NOT EXISTS pass_hash TEXT").then(()=>console.log("DB OK")).catch(e=>console.error("DB ERRO:",e.message));

const readBody=req=>new Promise((res,rej)=>{let d="";req.on("data",c=>{d+=c;if(d.length>1e5)rej(new Error("Grande"))});req.on("end",()=>{try{res(d?JSON.parse(d):{})}catch{res({})}});req.on("error",rej)});
const sendJSON=(res,st,o)=>{res.writeHead(st,{"Content-Type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization"});res.end(JSON.stringify(o))};
const signToken=p=>{const d=Buffer.from(JSON.stringify(p)).toString("base64url"),s=crypto.createHmac("sha256",APP_SECRET).update(d).digest("base64url");return d+"."+s};
const verifyToken=t=>{if(!t||!t.includes("."))return null;const p=t.split("."),d=p.at(0),s=p.at(1);if(s!==crypto.createHmac("sha256",APP_SECRET).update(d).digest("base64url"))return null;try{const o=JSON.parse(Buffer.from(d,"base64url").toString("utf8"));return o.exp&&Date.now()>o.exp?null:o}catch{return null}};
async function sendMail(to,code){const r=await fetch("https://api.brevo" + ".com/v3/smtp/email",{method:"POST",headers:{"accept":"application/json","api-key":BREVO_KEY,"content-type":"application/json"},body:JSON.stringify({sender:{name:"Mindshot PvP",email:SENDER_EMAIL},to:[{email:to}],subject:"Código Mindshot: "+code,htmlContent:`<div style="font-family:sans-serif;max-width:440px;margin:auto;padding:20px;border:1px solid #ddd;border-radius:10px"><h2>Mindshot PvP</h2><p>Seu código de acesso (expira em 15 min):</p><div style="font-size:32px;font-weight:bold;letter-spacing:6px;padding:14px;background:#f4f4f8;text-align:center;border-radius:8px;margin:16px 0">${code}</div><p style="color:#888;font-size:12px">Turbine sua mente com o Mindshot.</p></div>`})});if(!r.ok)throw new Error("Brevo "+r.status+": "+await r.text())}
const lobbies=new Map(),ALPHA="ABCDEFGHJKLMNPQRSTUVWXYZ23456789",rid=n=>crypto.randomBytes(n).toString("hex");
const newCode=()=>{let c;do{c=Array.from({length:5},()=>ALPHA[crypto.randomInt(32)]).join("")}while(lobbies.has(c));return c};
const srv=http.createServer(async(req,res)=>{
  const u=(req.url.split("?").at(0)||"/").replace(/\/+$/,"")||"/";
  console.log(req.method,u);
  if(req.method==="OPTIONS")return sendJSON(res,200,{ok:true});
  if(u==="/health"){res.end("ok");return}
  if(req.method==="POST"){
    try{const b=await readBody(req),email=String(b.email||"").trim().toLowerCase(),code=String(b.code||b.otp||b.token||"").trim();
      if(code){
        const name=String(b.name||b.player||"").replace(/[<>]/g,"").trim().slice(0,30),role=b.role==="prof"?"prof":"stu";
        if(!email)return sendJSON(res,400,{ok:false,error:"Informe o e-mail.",msg:"Informe o e-mail."});
        const r=await pool.query("SELECT * FROM users WHERE email=$1",[email]),user=r.rows.at(0);
        if(!user||user.otp_code!==code)return sendJSON(res,401,{ok:false,error:"Código inválido.",msg:"Código inválido."});
        if(Date.now()>Number(user.otp_expires))return sendJSON(res,401,{ok:false,error:"Código expirado.",msg:"Código expirado."});
        const fn=name||user.name||email.split("@").at(0);
        await pool.query("UPDATE users SET otp_code=NULL,otp_expires=NULL,name=$1,role=$2 WHERE email=$3",[fn,role,email]);
        const tk=signToken({email,name:fn,role,exp:Date.now()+2592000000});
        return sendJSON(res,200,{ok:true,token:tk,user:{email,name:fn,role}});
      }
      if(!email||!email.includes("@"))return sendJSON(res,400,{ok:false,error:"E-mail inválido.",msg:"E-mail inválido."});
      const newOtp=String(crypto.randomInt(100000,999999)),exp=Date.now()+900000;
      await pool.query("INSERT INTO users(email,otp_code,otp_expires)VALUES($1,$2,$3)ON CONFLICT(email)DO UPDATE SET otp_code=$2,otp_expires=$3",[email,newOtp,exp]);
      await sendMail(email,newOtp);
      return sendJSON(res,200,{ok:true,msg:"Código enviado! Verifique seu e-mail."});
    }catch(e){console.error("ERRO AUTH:",e);return sendJSON(res,500,{ok:false,error:e.message,msg:"Erro ao enviar: "+e.message})}
  }
  if(req.method==="GET"&&u.includes("me")){const usr=verifyToken((req.headers.authorization||"").replace(/^Bearer\s+/i,""));return usr?sendJSON(res,200,{ok:true,user:usr}):sendJSON(res,401,{ok:false})}
  fs.readFile(path.join(__dirname,"index.html"),(e,d)=>{if(e){res.writeHead(404);res.end("index.html não encontrado");return}res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache"});res.end(d)});
});
function frame(op,buf){const n=buf.length;let h;if(n<126)h=Buffer.from([0x80|op,n]);else if(n<65536){h=Buffer.alloc(4);h.writeUInt8(0x80|op,0);h.writeUInt8(126,1);h.writeUInt16BE(n,2)}else{h=Buffer.alloc(10);h.writeUInt8(0x80|op,0);h.writeUInt8(127,1);h.writeBigUInt64BE(BigInt(n),2)}return Buffer.concat([h,buf])}
srv.on("upgrade",(req,sock)=>{
  if(req.url.split("?").at(0)!=="/ws"||!req.headers["sec-websocket-key"]){sock.destroy();return}
  const acc=crypto.createHash("sha1").update(req.headers["sec-websocket-key"]+GUID).digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+acc+"\r\n\r\n");
  const c={sock,alive:true,lobby:null,pid:null};let buf=Buffer.alloc(0);
  c.send=o=>{if(!sock.destroyed)sock.write(frame(1,Buffer.from(JSON.stringify(o))))};sock.setNoDelay(true);
  sock.on("data",d=>{buf=Buffer.concat([buf,d]);if(buf.length>1<<20){sock.destroy();return}
    for(;;){if(buf.length<2)return;const op=buf.at(0)&15;let len=buf.at(1)&127,off=2;
      if(len===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4}else if(len===127){if(buf.length<10)return;len=Number(buf.readBigUInt64BE(2));off=10}
      const mkd=buf.at(1)&128;if(buf.length<off+(mkd?4:0)+len)return;
      const mk=mkd?buf.subarray(off,off+4):null;off+=mkd?4:0;const p=Buffer.from(buf.subarray(off,off+len));
      if(mk)for(let i=0;i<p.length;i++)p[i]^=mk[i&3];buf=buf.subarray(off+len);
      if(op===8){sock.end(frame(8,Buffer.alloc(0)));return}if(op===9){sock.write(frame(10,p));continue}
      if(op===1){let m;try{m=JSON.parse(p.toString())}catch{continue}try{onMsg(c,m)}catch{c.send({t:"err",msg:"Erro no servidor"})}}}});
  const gone=()=>{if(!c.alive)return;c.alive=false;drop(c)};sock.on("close",gone);sock.on("error",gone);
});
setInterval(()=>{for(const l of lobbies.values())for(const p of l.players.values())if(p.conn&&p.conn.alive)p.conn.sock.write(frame(9,Buffer.alloc(0)))},25000);
const clean=s=>String(s||"").replace(/[<>]/g,"").trim().slice(0,30);
const pub=l=>({code:l.code,name:l.name,max:l.max,dur:l.dur,pre:l.pre,custom:l.custom,noRepeat:l.noRepeat,play:l.play,status:l.status,players:[...l.players.values()].map(p=>({id:p.id,name:p.name,role:p.role,online:!!(p.conn&&p.conn.alive),score:p.score||0}))});
const bcast=(l,o)=>{for(const p of l.players.values())if(p.conn&&p.conn.alive)p.conn.send(o)};
const push=l=>bcast(l,{t:"lobby",lobby:pub(l)});
function drop(c){const l=c.lobby;if(!l)return;const p=l.players.get(c.pid);if(!p||p.conn!==c)return;p.conn=null;p.off=Date.now();push(l)}
setInterval(()=>{const now=Date.now();for(const[k,l]of lobbies){const any=[...l.players.values()].some(p=>p.conn&&p.conn.alive),last=Math.max(...[...l.players.values()].map(p=>p.off||l.t0));if(!any&&now-last>1800000){lobbies.delete(k);continue}if(l.status==="lobby")for(const[id,p]of l.players)if(p.role==="stu"&&!p.conn&&now-p.off>120000){l.players.delete(id);push(l)}}},10000);
function onMsg(c,m){
  const l=c.lobby,me=l&&l.players.get(c.pid);
  switch(m.t){
    case "create":{const code=newCode(),pid=rid(8),tok=rid(16),L={code,name:clean(m.name)||"Lobby",max:Math.min(12,Math.max(2,+m.max||6)),dur:Math.min(30,Math.max(1,+m.dur||5)),pre:["f","m","fm","n"].includes(m.pre)?m.pre:"f",custom:Array.isArray(m.custom)?m.custom.slice(0,200).map(q=>[clean(q.at(0)).slice(0,200),(q.at(1)||[]).slice(0,8).map(a=>clean(a))]):[],noRepeat:!!m.noRepeat,play:!!m.play,status:"lobby",players:new Map(),t0:Date.now()};L.players.set(pid,{id:pid,tok,name:clean(m.player)||"Professor",role:"prof",conn:c});lobbies.set(code,L);c.lobby=L;c.pid=pid;c.send({t:"joined",pid,tok,lobby:pub(L)});break}
case "join":{const L=lobbies.get(String(m.code||"").toUpperCase().trim());if(!L){c.send({t:"err",msg:"Lobby não encontrado."});return}for(const p of L.players.values())if(m.tok&&p.tok===m.tok){if(p.conn&&p.conn!==c){p.conn.lobby=null;try{p.conn.sock.end()}catch{}}p.conn=c;c.lobby=L;c.pid=p.id;c.send({t:"joined",pid:p.id,tok:p.tok,lobby:pub(L),re:true});push(L);return}if(L.status!=="lobby"){c.send({t:"err",msg:"Partida já começou."});return}if([...L.players.values()].filter(p=>!(p.role==="prof"&&!L.play)).length>=L.max){c.send({t:"err",msg:"Lobby cheio."});return}const pid=rid(8),tok=rid(16);L.players.set(pid,{id:pid,tok,name:clean(m.player)||"Aluno",role:"stu",conn:c});c.lobby=L;c.pid=pid;c.send({t:"joined",pid,tok,lobby:pub(L)});push(L);break}
case "start":if(!me||me.role!=="prof"||l.status!=="lobby")return;l.status="playing";l.startAt=Date.now();bcast(l,{t:"start",lobby:pub(l),seed:crypto.randomInt(1e9)});push(l);break;
case "state":if(!me)return;for(const p of l.players.values())if(p.id!==me.id&&p.conn&&p.conn.alive)p.conn.send({t:"state",id:me.id,s:m.s});break;
case "event":if(!me)return;if(typeof m.score==="number")me.score=m.score;bcast(l,{t:"event",id:me.id,e:m.e,d:m.d});break;
case "end":if(!me||me.role!=="prof")return;l.status="lobby";bcast(l,{t:"end"});push(l);break;
case "kick":if(!me||me.role!=="prof")return;{const p=l.players.get(m.id);if(p&&p.role!=="prof"){if(p.conn){p.conn.send({t:"kicked"});p.conn.lobby=null}l.players.delete(m.id);push(l)}}break;
case "leave":if(!me)return;if(me.role==="prof"){bcast(l,{t:"closed"});lobbies.delete(l.code)}else{l.players.delete(me.id);push(l)}c.lobby=null;break;
case "ping":c.send({t:"pong"});break;
}
}
srv.listen(PORT,()=>console.log("Mindshot online na porta "+PORT));
