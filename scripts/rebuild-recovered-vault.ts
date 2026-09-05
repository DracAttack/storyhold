import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PGlite } from '../artifacts/api-server/node_modules/@electric-sql/pglite/dist/index.js';
import { vector } from '../artifacts/api-server/node_modules/@electric-sql/pglite-pgvector/dist/index.js';
import { acquireStoryholdVaultOwnership } from '../artifacts/api-server/src/storyhold/vaultOwnership';
const target=path.resolve('.storyhold-data/postgres-recovered-20260905');
try {await stat(target);throw new Error('Refusing to overwrite an existing recovery destination.');} catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const sql=await readFile('.storyhold-data/recovered-current-20260905.sql','utf8');
if(createHash('sha256').update(sql).digest('hex')!=='51629f50f84af618f11e77b37697811e3b21f4e2e49cfee6c4bcbbd2b7561fe6')throw new Error('Logical dump fingerprint changed.');
const expected=JSON.parse(await readFile('.storyhold-data/recovered-current-manifest-20260905.json','utf8')) as Array<{schema:string;name:string;rows:number;sha256:string}>;
const lease=await acquireStoryholdVaultOwnership(target,{purpose:'logical rebuild of recovered current records'});
const db=await PGlite.create({dataDir:lease.dataDir,extensions:{vector}});
try {
 console.log('Restoring the recovered SQL into a new empty database.');
 await db.exec(sql);
 await db.exec("SET TIME ZONE 'UTC'; SET SEARCH_PATH TO public;");
 const actual=[];
 for(const t of expected){
   const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"';
   const data=await db.query<{data:string}>(`SELECT row_to_json(t)::text AS data FROM ${ident(t.schema)}.${ident(t.name)} t`);
   const digest=createHash('sha256');
   for(const row of data.rows.map(r=>r.data).sort())digest.update(row+'\n');
   const verified={...t,rows:data.rows.length,sha256:digest.digest('hex')};
   if(verified.rows!==t.rows||verified.sha256!==t.sha256)throw new Error(`Recovered data mismatch in ${t.schema}.${t.name}`);
   actual.push(verified);
 }
 const invalid=await db.query(`SELECT conname FROM pg_constraint WHERE connamespace='storyhold'::regnamespace AND NOT convalidated`);
 if(invalid.rows.length)throw new Error('Unvalidated database constraints remain.');
 await writeFile('.storyhold-data/recovered-rebuild-verification-20260905.json',JSON.stringify({allTablesMatch:true,tables:actual,constraintsValidated:true},null,2),{mode:0o600});
 console.log(JSON.stringify({restored:true,allTablesMatch:true,tables:actual.length,constraintsValidated:true,worlds:(await db.query('SELECT id,name FROM storyhold.worlds')).rows,accounts:(await db.query('SELECT email,role,credits FROM storyhold.players')).rows}));
} catch(e){console.error('Rebuild failed:',e instanceof Error?e.message:String(e));process.exitCode=1;}
finally {await db.close();await lease.release();}
