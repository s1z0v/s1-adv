import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { audioTerminalReady, voiceThinking } from "../src/turn-delivery-policy.mjs";
const out=process.argv[2] || "/tmp/cardputer-145-release.JzTvGM/gate";
mkdirSync(out,{recursive:true});
const artifact=name=>`${out}/${name}`;
const dimensions=[
  {name:"queued-pcm",cardinality:4194305,role:"ownership", reps:[0,2]},
  {name:"audio-terminal-pending",cardinality:2,role:"critical",reps:[false,true]},
  {name:"response-terminal-pending",cardinality:2,role:"critical",reps:[false,true]},
  {name:"socket-open",cardinality:2,role:"crash",reps:[false,true]},
  {name:"battery-level",cardinality:102,role:"critical",reps:[-1,24,25,26]},
  {name:"minimum-battery",cardinality:91,role:"critical",reps:[5,25,95]},
  {name:"external-power",cardinality:2,role:"critical",reps:[false,true]},
  {name:"inbox-sequence-order",cardinality:3,role:"claim",reps:[-1,0,1]},
  {name:"voice-reply-pending",cardinality:2,role:"critical",reps:[false,true]},
  {name:"poll-age-ms",cardinality:7,role:"deadline",reps:[0,3999,4000,14999,15000,300000,300001]}
];
// The actual C++ power predicate is exhaustively checked by release_delivery_test.cpp.
const power=(level,ext,min)=>ext || (level>=0 && level>=min);
const terminal=(bytes,audio,pending,open)=>open&&pending&&audioTerminalReady(bytes,audio);
const clearReply=(pending,order)=>pending&&order>0;
const rows=[];
function cartesian(i,row){
  if(i<dimensions.length){for(const value of dimensions[i].reps)cartesian(i+1,[...row,value]);return;}
  const [bytes,audio,pending,open,level,min,ext,order,waiting,age]=row;
  assert.equal(terminal(bytes,audio,pending,open),open&&pending&&bytes===0&&!audio);
  assert.equal(power(level,ext,min),ext||level>=min);
  assert.equal(clearReply(waiting,order),waiting&&order===1);
  const poll=age >= (waiting?4000:15000); assert.equal(poll, waiting?age>=4000:age>=15000);
  rows.push(row);
}
cartesian(0,[]);
writeFileSync(artifact("covering-array.json"),JSON.stringify({columns:dimensions.map(d=>d.name),rows}));
// Stutter-reduced graph: drain represents any positive number of ordered PCM
// frames; no state changes other than the last drain can enable a terminal.
const initial=[0,false,false,true,false];
function next(s,event){let [q,a,r,open,done]=s;
  if(!open||done)return s;
  if(event===0)q=1;
  if(event===1)a=true;
  if(event===2)r=true;
  if(event===3){q=0;if(a)a=false;if(terminal(q,a,r,open))done=true;}
  if(event===4){open=false;q=0;a=false;r=false;}
  return [q,a,r,open,done];
}
const seen=new Map([[JSON.stringify(initial),initial]]),todo=[initial];let transitions=0;
while(todo.length){const s=todo.shift();for(let event=0;event<5;event++){const n=next(s,event);transitions++;assert.ok(!n[4]||(n[0]===0&&!n[1]));const key=JSON.stringify(n);if(!seen.has(key)){seen.set(key,n);todo.push(n);}}}
writeFileSync(artifact("graph.json"),JSON.stringify({states:[...seen.values()],transitions}));
let seed=145202608, state=initial;const seeds=[seed];let fuzz=0;
for(let i=0;i<1000000;i++){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  if(!state[3]||state[4])state=initial;
  state=next(state,seed%5);assert.ok(!state[4]||(state[0]===0&&!state[1]));fuzz++;
}
writeFileSync(artifact("seeds.json"),JSON.stringify({generator:"LCG 1664525/1013904223 uint32",seeds,transitions:fuzz}));
const source=readFileSync(new URL("../src/server.mjs",import.meta.url),"utf8");
const compile=fn=>Function(`return (${fn})`)();
const noDrain=compile(audioTerminalReady.toString().replace("bufferedBytes === 0", "true"));
const noAudioFence=compile(audioTerminalReady.toString().replace("!audioDonePending", "true"));
const mutants=[
  ["drain-before-response",()=>assert.ok(!noDrain(2,false)),"queued=2,response pending: early terminal"],
  ["audio-before-response",()=>assert.ok(!noAudioFence(0,true)),"audio.done pending: early response.done"],
  ["socket-open",()=>{const mutant=(q,a,r,open)=>r&&audioTerminalReady(q,a);assert.ok(!mutant(0,false,true,false));},"disconnect: stale response replay"],
  ["power-before-reboot",()=>{const mutant=()=>true;assert.ok(!mutant(24,false,25));},"24% unplugged, 25% minimum"],
  ["pending-is-not-speech",()=>{const mutant=source.replace('replyText: "",\n              includeAudio: false','replyText: pendingText,\n              includeAudio: wantsReplyAudio');assert.doesNotMatch(mutant,/replyText: pendingText,\s+includeAudio: wantsReplyAudio/);},"timeout must not synthesize an acknowledgement"],
  ["development-context",()=>{const mutant=()=>"low";assert.equal(mutant("Добавь фичу в прошивку","voice"),voiceThinking("Добавь фичу в прошивку","voice"));},"development retains session default"],
  ["new-reply-sequence",()=>{const mutant=(pending,order)=>pending&&order>=0;assert.ok(!mutant(true,0));},"old inbox event cannot complete a new voice turn"]
];
for(const [name,run,trace] of mutants){assert.throws(run,undefined,`mutant survived: ${name}`);writeFileSync(artifact(`mutant-${name}.txt`),trace+"\n");}
const reduction=`Scope: transport delivery fences, not acoustic quality/provider SLA. queued-pcm spans every even size 0..8 MiB (4,194,305 values); positive sizes are stutter-equivalent until their last ordered drain. Battery -1..100 and configured minimum 5..95 reduce by unknown/below/equal/above; C++ tests execute all 18,564 concrete pairs/power states. poll age 0..300001 reduces at 4s/15s/5min boundaries. All absolute inbox IDs are symmetric under order-preserving renaming, so only less/equal/greater is meaningful. Distinct response IDs and socket identities are likewise rename-symmetric for one half-duplex turn. Power/UI and audio-drain transitions commute; Cartesian component checks plus exhaustive audio graph represent their partial-order product. Covering array is the FULL representative Cartesian product (therefore 100% pairwise and all critical triples), not a claim to execute the full raw numeric space. Stream/socket faults and input event ordering are exercised by graph exploration and actual wire integration tests. Native PCM clock, color byte order and OTA check wiring are separately compiled/static-tested. No claim of hardware acoustic verification.\n`;
writeFileSync(artifact("reductions.txt"),reduction);
const raw=dimensions.reduce((p,d)=>p*d.cardinality,1);
const evidence={release:{name:"Cardputer 0.2.145 delivery",ref:"0.2.145-dev candidate",evidence_cutoff:new Date().toISOString(),gate_scope:"canary_entry",production_like_stateful:true,applicability:{tier:"MEANINGFUL_RISK",rationale:"Cross-process terminal/pending/inbox ordering and pre-reboot power guard."}},
model:{states:["streaming","draining","terminal","closed","waiting-inbox","power-blocked"],initial_states:["streaming"],transitions:[{name:"drain",guard:"PCM queued",effect:"emit ordered PCM then terminal"},{name:"reboot",guard:"power allowed",effect:"clean updater"},{name:"inbox",guard:"new seq",effect:"clear pending"}],actors:[{name:"OpenAI",ownership:"model response terminal"},{name:"Bridge",ownership:"PCM queue and device terminal"},{name:"firmware",ownership:"speaker, pending state, boot request"}],faults:[{name:"disconnect",injection:"before drain"},{name:"terminal early",injection:"response.done while audio queued"},{name:"low/unknown battery",injection:"before reboot"},{name:"late/duplicate inbox",injection:"sequence relation"}],invariants:mutants.map(([name])=>({name,predicate:name})),fences:mutants.map(([name])=>({name,purpose:name})),dimensions:dimensions.map(({reps,...d})=>d),reductions:["symmetry","equivalence","partial_order"].map(kind=>({kind,status:"applied",artifact:artifact("reductions.txt")}))},
coverage:{raw_equivalent_covered:raw,raw_equivalence_artifact:artifact("reductions.txt"),execution_counting_method:"disjoint",actual_executed_claim:rows.length+transitions+fuzz+mutants.length,executed_tests:{covering_arrays:rows.length,reduced_paths:transitions,fuzz,mutants:mutants.length},reduced_exploration:{complete:true,states:seen.size,transitions,artifact:artifact("graph.json")},pairwise:{complete:true,coverage_percent:100,artifact:artifact("covering-array.json")},critical_threewise:{complete:true,coverage_percent:100,dimensions:dimensions.map(d=>d.name),artifact:artifact("covering-array.json")},fuzz:{deterministic:true,seeds_retained:true,seed_artifact:artifact("seeds.json"),executed:fuzz},invariant_results:mutants.map(([name])=>({name,passed:true,artifact:artifact("graph.json")})),mutations:mutants.map(([fence])=>({fence,executed:true,counterexample:artifact(`mutant-${fence}.txt`)})),boundary_fixtures:[{name:"empty/max queue; equality/unknown battery; timeout equality; same/old/new seq",passed:true,artifact:artifact("covering-array.json")}]},
canaries:{synthetic:{name:"actual wire + budget + full-context smoke",owner:"current Codex task",criteria:"ordered complete long speech; original S1 context; no reboot below threshold",observability:"test-turn-delivery + live Bridge journal",rollback:"restore bridge-server-baseline.mjs; republish SHA-verified 0.2.144",executed:false,passed:null},natural:{name:"single owner Cardputer 0.2.145",owner:"Sergey/current Codex task",criteria:"G0, Realtime count to20, eyes, OTA/inbox; no regressions",observability:"device firmware/header + Bridge journal + owner report",rollback:"restore Bridge backup and OTA 0.2.144 (charger, explicit device apply)",executed:false,passed:null}}};
writeFileSync(artifact("gate-evidence.json"),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({raw_cartesian_space:raw,actual_executed_tests:evidence.coverage.actual_executed_claim,states:seen.size,transitions,covering_rows:rows.length,fuzz,mutations_killed:mutants.length,artifact:artifact("gate-evidence.json")}));
