import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { AiTextResult, GenerateAiTextInput } from "./aiGateway";
import { executeJournaledPremiumCall, premiumReviewJournalSchemaSql } from "./premiumReviewJournal";
import {
  prepareWorldClockVerificationPages, validateWorldClockVerification,
  type WorldClockVerificationInput, type WorldClockVerificationReceipt,
} from "./worldClockVerification";
import {
  applyVerifiedWorldClockProjection, ensureWorldClockPersistence, WorldClockPersistenceError,
} from "./worldClockPersistence";

const PLAYER="00000000-0000-4000-8000-000000000001";
const WORLD="00000000-0000-4000-8000-000000000002";
const EDITION="00000000-0000-4000-8000-000000000003";
const RUN="00000000-0000-4000-8000-000000000004";
const SOURCE="00000000-0000-4000-8000-000000000005";
const CHUNK="00000000-0000-4000-8000-000000000006";
const MIRA="00000000-0000-4000-8000-000000000007";
const PASSAGE="Mira opened the sealed gate before dawn. Later, Mira destroyed the gate so the pursuing army could not enter.";

function input():WorldClockVerificationInput{return{
  version:1,scope:{worldId:WORLD,editionId:EDITION,analysisRunId:RUN},
  chunks:[{id:CHUNK,sourceId:SOURCE,sourceTitle:"The Gate",index:0,content:PASSAGE}],
  entities:[{id:MIRA,name:"Mira",entityType:"character",aliases:["Captain Mira"]}],
  ownerConstraints:[{id:"00000000-0000-4000-8000-000000000008",kind:"timeline",instruction:"Opening precedes destruction.",scopeEntityId:MIRA}],
  chronology:[
    {name:"Mira Opens the Gate",aliases:["The Gate Opens"],summary:"Mira opens the sealed gate.",details:[],relationships:[],factionMemberships:[],
      evidence:[{chunkId:CHUNK,sourceId:SOURCE,quote:"Mira opened the sealed gate before dawn."}],confidence:.9,worldTimeLabel:"Before dawn",
      temporalStatus:"relative",importance:"major",sourceChapterKeys:[`${SOURCE}:chapter-1`],actors:["Mira"],truthStatus:"fact",epistemicHolderId:null,
      eventRelations:[{targetEvent:"Mira Destroys the Gate",relationType:"enables",summary:"Opening the gate makes its later destruction possible.",
        evidence:[{chunkId:CHUNK,sourceId:SOURCE,quote:PASSAGE}],confidence:.7}]},
    {name:"Mira Destroys the Gate",aliases:[],summary:"Mira destroys the gate to stop the army.",details:[],relationships:[],factionMemberships:[],
      evidence:[{chunkId:CHUNK,sourceId:SOURCE,quote:"Mira destroyed the gate so the pursuing army could not enter."}],confidence:.95,
      worldTimeLabel:"Later",temporalStatus:"relative",importance:"turning_point",sourceChapterKeys:[`${SOURCE}:chapter-1`],actors:["Mira"],truthStatus:"fact",epistemicHolderId:null},
  ],
};}

async function database(){
  const db=new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players(id uuid PRIMARY KEY);
    CREATE TABLE storyhold.worlds(id uuid PRIMARY KEY);
    CREATE TABLE storyhold.canon_editions(id uuid PRIMARY KEY,world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE);
    CREATE TABLE storyhold.world_sources(id uuid PRIMARY KEY,world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,processing_status text NOT NULL,canon_status text NOT NULL);
    CREATE TABLE storyhold.world_source_chunks(id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES storyhold.world_sources(id) ON DELETE CASCADE,
      world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
      chunk_index integer NOT NULL,content text NOT NULL,content_hash text NOT NULL);
    CREATE TABLE storyhold.world_analysis_runs(id uuid PRIMARY KEY,world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,requested_by_player_id uuid NOT NULL REFERENCES storyhold.players(id),
      analysis_kind text NOT NULL,status text NOT NULL DEFAULT 'running');
    CREATE TABLE storyhold.credit_reservations(id uuid PRIMARY KEY,world_id uuid,player_id uuid,operation text,request_id text,status text,usage jsonb);
    CREATE TABLE storyhold.world_entities(id uuid PRIMARY KEY,world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,name text NOT NULL,entity_type text NOT NULL,aliases jsonb NOT NULL,
      pull_status text NOT NULL,merged_into_entity_id uuid REFERENCES storyhold.world_entities(id));
    CREATE TABLE storyhold.world_owner_canon_constraints(id uuid PRIMARY KEY,world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,constraint_kind text NOT NULL,instruction text NOT NULL,
      scope_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE SET NULL,
      status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE storyhold.world_clock_events(id uuid PRIMARY KEY,world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,campaign_id uuid,source_id uuid REFERENCES storyhold.world_sources(id) ON DELETE SET NULL,
      created_by_player_id uuid REFERENCES storyhold.players(id) ON DELETE SET NULL,visible_to_character_id uuid,causal_parent_id uuid REFERENCES storyhold.world_clock_events(id),
      canonical_key text NOT NULL,event_kind text NOT NULL,title text NOT NULL,summary text NOT NULL DEFAULT '',world_time_label text NOT NULL DEFAULT '',
      chronology_order bigint NOT NULL DEFAULT 0,visibility text NOT NULL DEFAULT 'world',knowledge_status text NOT NULL DEFAULT 'observed',
      known_effects jsonb NOT NULL DEFAULT '[]',internal_effects jsonb NOT NULL DEFAULT '[]',evidence jsonb NOT NULL DEFAULT '[]',scheduled_for_label text NOT NULL DEFAULT '',
      reveal_rule jsonb NOT NULL DEFAULT '{}',status text NOT NULL DEFAULT 'committed',temporal_status text NOT NULL DEFAULT 'relative',importance text NOT NULL DEFAULT 'major',
      source_chapter_keys jsonb NOT NULL DEFAULT '[]',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(world_id,canonical_key));
    CREATE TABLE storyhold.world_event_participants(id uuid PRIMARY KEY,world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,event_id uuid NOT NULL REFERENCES storyhold.world_clock_events(id) ON DELETE CASCADE,
      entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,participant_role text NOT NULL,evidence jsonb NOT NULL DEFAULT '[]',confidence real NOT NULL,
      assignment_source text NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(event_id,entity_id,participant_role));
    CREATE TABLE storyhold.world_event_relations(id uuid PRIMARY KEY,world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,source_event_id uuid NOT NULL REFERENCES storyhold.world_clock_events(id) ON DELETE CASCADE,
      target_event_id uuid NOT NULL REFERENCES storyhold.world_clock_events(id) ON DELETE CASCADE,relation_type text NOT NULL,summary text NOT NULL DEFAULT '',
      evidence jsonb NOT NULL DEFAULT '[]',confidence real NOT NULL,assignment_source text NOT NULL,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
      UNIQUE(source_event_id,target_event_id,relation_type));`);
  await db.exec(premiumReviewJournalSchemaSql);await ensureWorldClockPersistence(db);
  await db.query("INSERT INTO storyhold.players VALUES($1)",[PLAYER]);await db.query("INSERT INTO storyhold.worlds VALUES($1)",[WORLD]);
  await db.query("INSERT INTO storyhold.canon_editions VALUES($1,$2)",[EDITION,WORLD]);
  await db.query("INSERT INTO storyhold.world_sources VALUES($1,$2,$3,'ready','canon')",[SOURCE,WORLD,EDITION]);
  await db.query("INSERT INTO storyhold.world_source_chunks VALUES($1,$2,$3,$4,0,$5,'hash')",[CHUNK,SOURCE,WORLD,EDITION,PASSAGE]);
  await db.query("INSERT INTO storyhold.world_analysis_runs VALUES($1,$2,$3,$4,'ai_enrichment','running')",[RUN,WORLD,EDITION,PLAYER]);
  await db.query("INSERT INTO storyhold.world_entities VALUES($1,$2,$3,'Mira','character',$4::jsonb,'active',NULL)",[MIRA,WORLD,EDITION,JSON.stringify(["Captain Mira"])]);
  await db.query("INSERT INTO storyhold.world_owner_canon_constraints(id,world_id,canon_edition_id,constraint_kind,instruction,scope_entity_id,status) VALUES($1,$2,$3,'chronology',$4,$5,'active')",
    ["00000000-0000-4000-8000-000000000008",WORLD,EDITION,"Opening precedes destruction.",MIRA]);
  return db;
}
function rawFor(request:ReturnType<typeof prepareWorldClockVerificationPages>[number]){
  const evidence=new Map(request.evidence.map((entry)=>[entry.id,entry]));
  return {chronology:[],clockVerification:{requestFingerprint:request.fingerprint,decisions:request.proposals.map((proposal)=>{
    const anchor=evidence.get(proposal.evidenceIds[0]!);if(!anchor)throw new Error("fixture proposal lacks evidence");
    return {proposalId:proposal.id,verdict:"verified",correctedPayload:null,supportingEvidence:[{chunkId:anchor.chunkId,quote:anchor.quote}],
      contradictingEvidence:[],confidence:proposal.confidence,explanation:"The exact passage supports this bounded record.",retrievalRequests:[]};
  })}};
}
function result(text:string):AiTextResult{return{text,provider:"openrouter",model:"requested-model",reasoning:"high",usage:{inputUnits:100,outputUnits:100,
  cachedInputUnits:0,cacheWriteInputUnits:0,reasoningUnits:0,estimatedCostMicros:100,pricingKnown:true,pricingVersion:"test",costEstimated:true},
  runtime:{configured:true,mode:"connected",provider:"openrouter",model:"requested-model",billable:true,sendsSourceTextOffDevice:true,explanation:"offline fixture",
    stage:"verification",execution:{connectionId:"test",credentialSource:"environment",connectionSource:"storyhold_managed",billingSource:"storyhold_credits",
      requestedModel:"requested-model",resolvedModel:"resolved-model",upstreamProvider:"fixture",privacyMode:"standard"},
    localExtraction:{enabled:false,configured:false,provider:"gliner2",model:"none",endpoint:null,endpointKind:null,sendsSourceTextOffDevice:false,explanation:"off"},
    providers:[],routing:{director:null,narration:null,adultNarration:null,analysis:null,canonReview:"openrouter"},
    stageRouting:{extraction:null,verification:"openrouter",dossier:null,chronology:"openrouter",director:null,narration:null,adaptation:null}}};}
async function journal(db:PGlite,clockInput:WorldClockVerificationInput,mutate?:(raw:ReturnType<typeof rawFor>,request:ReturnType<typeof prepareWorldClockVerificationPages>[number])=>void){
  const receipts:WorldClockVerificationReceipt[]=[];
  for(const request of prepareWorldClockVerificationPages(clockInput)){
    const raw=rawFor(request);mutate?.(raw,request);const generated=await executeJournaledPremiumCall(db,{runId:RUN,stepKey:request.page.stepKey,
      scopeFingerprint:request.fingerprint,provider:"openrouter",model:"requested-model",request:{task:"canon_review",stage:"verification",system:"clock",
        messages:[{role:"user",content:JSON.stringify(raw)}],reasoning:"high",maxOutputTokens:4000,temperature:0} as GenerateAiTextInput,invoke:async()=>result(JSON.stringify(raw))});
    receipts.push(validateWorldClockVerification(clockInput,JSON.parse(generated.text),{provider:generated.provider,
      model:generated.runtime.execution!.resolvedModel!,completedAt:generated.journalCompletedAt!},request.page.index));
  }
  return receipts;
}

test("exact paid receipts project complete events and individually approved roles/relations without deleting unrelated rows",async()=>{
  const db=await database();try{
    const unrelated="00000000-0000-4000-8000-000000000020";
    await db.query(`INSERT INTO storyhold.world_clock_events(id,world_id,canon_edition_id,created_by_player_id,canonical_key,event_kind,title)
      VALUES($1,$2,$3,$4,'owner-event','canon','Owner Event')`,[unrelated,WORLD,EDITION,PLAYER]);
    const clockInput=input();const receipts=await journal(db,clockInput);
    const saved=await db.transaction((tx)=>applyVerifiedWorldClockProjection(tx,{reviews:[{input:clockInput,receipts}]}));
    assert.deepEqual(saved,{events:2,participants:2,relations:1,replayed:false,withheld:[]});
    const events=(await db.query<Record<string,unknown>>("SELECT * FROM storyhold.world_clock_events ORDER BY chronology_order,id")).rows;
    assert.equal(events.length,3);assert.ok(events.some((row)=>row.id===unrelated));
    const verified=events.filter((row)=>row.assignment_source==="ai");assert.deepEqual(verified.map((row)=>row.chronology_order),[0,1000]);
    assert.deepEqual(verified.map((row)=>row.truth_status),["fact","fact"]);assert.deepEqual(verified.map((row)=>row.verified_importance),["major","turning_point"]);
    assert.deepEqual(verified.map((row)=>row.source_analysis_run_id),[RUN,RUN]);assert.deepEqual(verified[0]!.aliases,["The Gate Opens"]);
    assert.equal((await db.query("SELECT * FROM storyhold.world_event_participants")).rows.length,2);
    assert.equal((await db.query("SELECT * FROM storyhold.world_event_relations")).rows.length,1);
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_clock_reviews")).rows.length,receipts.length);
    assert.equal((await db.query("SELECT * FROM storyhold.world_clock_event_verifications")).rows.length,2);
    const replay=await db.transaction((tx)=>applyVerifiedWorldClockProjection(tx,{reviews:[{input:clockInput,receipts}]}));
    assert.deepEqual(replay,{events:0,participants:0,relations:0,replayed:true,withheld:[]});
    assert.equal((await db.query("SELECT * FROM storyhold.world_clock_events")).rows.length,3);
  }finally{await db.close();}
});

test("source, owner-constraint, or complete canonical-registry drift blocks all writes and retains the recoverable journal",async()=>{
  for(const drift of ["source","status","alias","constraint","constraint_scope"] as const){const db=await database();try{
    const clockInput=input();const receipts=await journal(db,clockInput);
    if(drift==="source")await db.query("UPDATE storyhold.world_source_chunks SET content=content||' changed' WHERE id=$1",[CHUNK]);
    if(drift==="status")await db.query("UPDATE storyhold.world_sources SET canon_status='excluded' WHERE id=$1",[SOURCE]);
    if(drift==="alias")await db.query("UPDATE storyhold.world_entities SET aliases='[\"Renamed\"]'::jsonb WHERE id=$1",[MIRA]);
    if(drift==="constraint")await db.query("UPDATE storyhold.world_owner_canon_constraints SET instruction='Destruction precedes opening.'");
    if(drift==="constraint_scope")await db.query("UPDATE storyhold.world_owner_canon_constraints SET scope_entity_id=NULL");
    await assert.rejects(db.transaction((tx)=>applyVerifiedWorldClockProjection(tx,{reviews:[{input:clockInput,receipts}]})),
      (error:unknown)=>error instanceof WorldClockPersistenceError&&["CLOCK_SOURCE_CHANGED","CLOCK_REGISTRY_CHANGED","CLOCK_CONSTRAINTS_CHANGED"].includes(error.code));
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_clock_reviews")).rows.length,0);
    assert.ok((await db.query("SELECT * FROM storyhold.world_analysis_ai_calls")).rows.length>0);
    assert.equal((await db.query("SELECT * FROM storyhold.world_clock_events")).rows.length,0);
  }finally{await db.close();}}
});

test("tampering, extra chronology journal rows and non-receipt collisions fail atomically without omission cleanup",async()=>{
  for(const mode of ["tamper","extra","owner","local"] as const){const db=await database();try{
    const clockInput=input();let receipts=await journal(db,clockInput);
    if(mode==="tamper"){receipts=structuredClone(receipts);receipts[0]!.verifier.model="forged-model";}
    if(mode==="extra")await executeJournaledPremiumCall(db,{runId:RUN,stepKey:"chronology:99",provider:"openrouter",model:"requested-model",
      request:{task:"canon_review",stage:"verification",system:"extra",messages:[{role:"user",content:"extra"}],reasoning:"low",maxOutputTokens:10,temperature:0},
      invoke:async()=>result('{"chronology":[]}')});
    if(mode==="owner"||mode==="local"){
      const projected=(await import("./worldClockVerification")).approvedWorldClockProjection(clockInput,receipts);
      const event=projected.events[0]!.payload;
      await db.query(`INSERT INTO storyhold.world_clock_events(id,world_id,canon_edition_id,created_by_player_id,canonical_key,event_kind,title,summary,
        world_time_label,chronology_order,temporal_status,importance,source_chapter_keys,evidence) VALUES($1,$2,$3,$4,$5,'canon',$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)`,
      [event.eventId,WORLD,EDITION,mode==="owner"?PLAYER:null,event.canonicalKey,event.name,event.summary,event.worldTimeLabel,event.chronologyOrder*1000,event.temporalStatus,
        event.importance==="unspecified"?"major":event.importance,JSON.stringify(event.sourceChapterKeys),JSON.stringify(projected.events[0]!.evidence)]);
    }
    await assert.rejects(db.transaction((tx)=>applyVerifiedWorldClockProjection(tx,{reviews:[{input:clockInput,receipts}]})),
      (error:unknown)=>error instanceof Error&&/receipt|journal manifest|owner-controlled|existing/i.test(error.message));
    assert.equal((await db.query("SELECT * FROM storyhold.world_clock_event_verifications")).rows.length,0);
  }finally{await db.close();}}
});

test("clock receipt links are immutable while an explicit world deletion can cascade the audit aggregate",async()=>{
  const db=await database();try{const clockInput=input();const receipts=await journal(db,clockInput);
    await db.transaction((tx)=>applyVerifiedWorldClockProjection(tx,{reviews:[{input:clockInput,receipts}]}));
    await assert.rejects(db.query("UPDATE storyhold.world_analysis_clock_reviews SET receipt_fingerprint='changed'"),/immutable/);
    await assert.rejects(db.query("UPDATE storyhold.world_clock_event_verifications SET payload_fingerprint='changed'"),/immutable/);
    await db.query("DELETE FROM storyhold.worlds WHERE id=$1",[WORLD]);
    assert.equal((await db.query("SELECT * FROM storyhold.world_analysis_clock_reviews")).rows.length,0);
  }finally{await db.close();}
});

test("verified dependents of a rejected event stay explicitly withheld and never become dangling rows",async()=>{
  const db=await database();try{const clockInput=input();const receipts=await journal(db,clockInput,(raw,request)=>{
    const rejected=request.proposals.find((proposal)=>proposal.payload.recordType==="event"&&proposal.payload.name==="Mira Destroys the Gate")!;
    const decision=raw.clockVerification.decisions.find((entry)=>entry.proposalId===rejected.id)!;
    decision.verdict="rejected";decision.supportingEvidence=[];decision.confidence=.9;
  });
  const saved=await db.transaction((tx)=>applyVerifiedWorldClockProjection(tx,{reviews:[{input:clockInput,receipts}]}));
  assert.equal(saved.events,1);assert.equal(saved.participants,1);assert.equal(saved.relations,0);
  assert.deepEqual(saved.withheld.map((entry)=>entry.recordType).sort(),["event_relation","participant"]);
  assert.equal((await db.query("SELECT * FROM storyhold.world_clock_events")).rows.length,1);
  assert.equal((await db.query("SELECT * FROM storyhold.world_event_relations")).rows.length,0);
  assert.equal((await db.query("SELECT * FROM storyhold.world_event_participants")).rows.length,1);
  }finally{await db.close();}
});
