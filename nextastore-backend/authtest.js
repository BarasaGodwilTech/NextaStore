process.env.JWT_SECRET='test-secret';
process.env.JWT_SESSION_EXPIRES_IN='2d';
process.env.JWT_REMEMBER_EXPIRES_IN='30d';

const path=require('path');
// Stub the DB before anything requires it, so we exercise the real auth
// middleware without needing Postgres.
const prismaPath=require.resolve('./src/prisma');
require.cache[prismaPath]={id:prismaPath,filename:prismaPath,loaded:true,exports:{
  user:{findUnique:async({where})=> where.id==='u1'?{id:'u1',name:'A',email:'a@e.com',role:'seller',accountStatus:'active',adminRole:null}:null}
}};

const express=require('express');
const jwt=require('jsonwebtoken');
const config=require('./src/config');
const {requireAuth,signSessionToken,errorHandler}=require('./src/middleware');

const app=express();
app.get('/me',requireAuth,(req,res)=>res.json({ok:true}));
app.use(errorHandler);
const server=app.listen(4555,async()=>{
  const day=86400;
  const life=t=>{const d=jwt.decode(t);return d.exp-d.iat;};

  const plain=signSessionToken({id:'u1',role:'seller',tokenVersion:0},false), remember=signSessionToken({id:'u1',role:'seller',tokenVersion:0},true);
  console.log('unticked login  :', life(plain)/day,'days | rm =',jwt.decode(plain).rm);
  console.log('remember-me     :', life(remember)/day,'days | rm =',jwt.decode(remember).rm);

  async function call(token,label){
    const r=await fetch('http://127.0.0.1:4555/me',{headers:{Authorization:'Bearer '+token}});
    const fresh=r.headers.get('x-session-token');
    const body=await r.json().catch(()=>({}));
    console.log(label.padEnd(42), 'status',r.status,
      '| renewed:',fresh?('yes -> '+(life(fresh)/day)+'d, rm='+jwt.decode(fresh).rm):'no',
      body.code?('| code '+body.code):'');
  }

  const mint=(rm,ageFrac)=>{const lt=rm?30*day:2*day;const now=Math.floor(Date.now()/1000);
    const iat=now-Math.floor(lt*ageFrac);
    return jwt.sign({userId:'u1',rm,iat,exp:iat+lt},config.jwtSecret);};

  await call(mint(false,0.10),'fresh token (10% used)');
  await call(mint(false,0.49),'just under halfway (49%)');
  await call(mint(false,0.55),'past halfway (55%)');
  await call(mint(false,0.95),'nearly dead (95%)');
  await call(mint(true ,0.80),'remember-me past halfway (80%)');
  await call(jwt.sign({userId:'u1',rm:false},config.jwtSecret,{expiresIn:'-1s'}),'already expired');
  await call(jwt.sign({userId:'ghost',rm:false},config.jwtSecret,{expiresIn:'2d'}),'valid signature, deleted user');
  await call('garbage.token.here','malformed token');
  server.close();
});
