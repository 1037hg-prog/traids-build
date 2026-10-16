const fs=require("fs"),path=require("path");
const RC=require("./lib/reconcile.js"), L2=require("./lib/gbm.js"), MLF=require("./lib/ml-features.js");
const M4=require("./lib/ml-improve5.js");
const et=(ms)=>new Date(ms).toLocaleDateString("en-CA",{timeZone:"America/New_York"});
const mean=(a)=>(a.length?a.reduce((s,x)=>s+x,0)/a.length:null);
const log=JSON.parse(fs.readFileSync(path.join(__dirname,"data","trade_log.json"),"utf8"));
const rowsAll=Array.isArray(log)?log:(log.rows||log.trades||[]);
const mrows=rowsAll.filter((t)=>Number.isFinite(t.rMult)&&t.openedAt&&et(t.openedAt)>="2026-07-20"&&t.obs&&t.cls!=="Options"&&!/r2[145]/.test(t.id||"")&&t.sleeve!=="R24-v1");
const BAKEOFF_BAR=0.30, EXCLUDE=/^(modelScore|modelRank|wComposite|bakeoff)/;
const mcov={};for(const t of mrows)for(const[k,v]of Object.entries(t.obs))if(Number.isFinite(v)&&!EXCLUDE.test(k))mcov[k]=(mcov[k]||0)+1;
// 2026-09-24 (weekly audit 2026-09-23, ml lens): lib/feature-manifest.js refuses the post-entry news-stamp family, as in model-bakeoff.js / ml-daily.js.
const FM=require("./lib/feature-manifest.js");
const ADMIT=FM.admitBoardObs(Object.entries(mcov).filter(([,n])=>n>=mrows.length*BAKEOFF_BAR).map(([k])=>k).sort());
const FEATS=ADMIT.keep;FM.assertBoardObsAdmissible(FEATS);
const CLS=["Equity","Crypto","Futures","FX"];
const vec=(t)=>[...FEATS.map((k)=>(Number.isFinite(t.obs[k])?t.obs[k]:NaN)),t.dir>0?1:-1,t.ctrl?1:0,...CLS.map((c)=>(t.cls===c?1:0))];
const X=mrows.map(vec),y=mrows.map((t)=>t.rMult),mday=mrows.map((t)=>et(t.openedAt));
const msessions=[...new Set(mday)].sort(),sIdx=Object.fromEntries(msessions.map((s,i)=>[s,i]));
const PURGE=1,MIN_TRAIN=8;
const pred=new Array(mrows.length).fill(null);
for(let k=MIN_TRAIN;k<msessions.length;k++){
  const train=mrows.map((_,i)=>i).filter((i)=>sIdx[mday[i]]<=k-1-PURGE);
  const test=mrows.map((_,i)=>i).filter((i)=>sIdx[mday[i]]===k);
  if(train.length<100||!test.length)continue;
  const gm=L2.gbmFit(X,y,train,{rounds:60,lr:0.1,depth:2});
  for(const i of test)pred[i]=L2.gbmPredict(gm,X[i]);
}
const D=require("./data/ml-daily.json");
const gbmT=D.models.gbm.dayCorrT_signalsOnly ?? D.models.gbm.dayCorrT;   // 2026-09-04 (ML lens): the rule refuses SIGNALS; the pooled figure borrowed its precision from control rows (t -1.63 pooled vs -0.60 signals-only tonight)
const g=M4.grade(mrows,pred,(t)=>et(t.openedAt),gbmT,M4.BAR.evidenceStart);
console.log("MLI-5 "+M4.BAR.id+"  gbm day-corr t at this read: "+gbmT);
console.log("  MOTIVATING SAMPLE (pre-"+M4.BAR.evidenceStart+"): "+g.motivatingSample.sessions+" sessions · mean lift "+g.motivatingSample.meanLiftR+"R · t "+g.motivatingSample.t+" · refused "+g.motivatingSample.refusedTickets+" tickets carrying "+g.motivatingSample.refusedTotalR+"R");
console.log("  EVIDENCE (>= "+M4.BAR.evidenceStart+"): "+g.evidence.sessions+" sessions · mean lift "+g.evidence.meanLiftR+"R · t "+g.evidence.t+" · refused "+g.evidence.refusedTickets);
for(const[k,c]of Object.entries(g.checks))console.log("    "+(c.pass?"PASS":"FAIL")+"  "+k+": need "+c.need+", got "+c.got);
console.log("  CLEARED: "+(g.cleared?"YES":"NO"));
console.log("  "+g.effectiveN);
console.log("  per-session (last 12):");
for(const p of g.perSession.slice(-12))console.log("    "+p.day+"  n"+String(p.n).padStart(4)+"  refused "+String(p.refused).padStart(3)+"  fullR "+String(p.fullR).padStart(8)+"  survR "+String(p.survR).padStart(8)+"  lift "+String(p.liftR).padStart(8)+"  refusedR "+p.refusedR);
fs.writeFileSync(path.join(__dirname,"data","mli5-shadow.json"),JSON.stringify({runAt:new Date().toISOString(),gbmDayCorrT:gbmT,...g},null,2));
console.log("written data/mli5-shadow.json");
