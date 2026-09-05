import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PGlite } from '../artifacts/api-server/node_modules/@electric-sql/pglite/dist/index.js';
import { vector } from '../artifacts/api-server/node_modules/@electric-sql/pglite-pgvector/dist/index.js';
import { pgDump } from '../.storyhold-data/recovery-tools/node_modules/@electric-sql/pglite-tools/dist/pg_dump.js';
import { acquireStoryholdVaultOwnership } from '../artifacts/api-server/src/storyhold/vaultOwnership';
const finalSnapshot=process.argv.includes('--final');
const dir=path.resolve(finalSnapshot?'.storyhold-data/postgres-recovered-20260905':'.storyhold-data/recovery-current-20260905');
const outputPrefix=finalSnapshot?'vault-current-20260905':'recovered-current-20260905';
const lease=await acquireStoryholdVaultOwnership(dir,{purpose:'read-only current-vault salvage export'});
const db=await PGlite.create({dataDir:lease.dataDir,extensions:{vector}})
 .catch(e=>{console.error('Recovery copy failed to open:',e.message);process.exit(1);});
try {
 await db.exec("SET default_transaction_read_only=on; SET TIME ZONE 'UTC';");
 const tables=await db.query<{schema:string;name:string}>(`SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename`);
 const manifest=[];
 for(const t of tables.rows){
   const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"';
   const data=await db.query<{data:string}>(`SELECT row_to_json(t)::text AS data FROM ${ident(t.schema)}.${ident(t.name)} t`);
   const digest=createHash('sha256');
   for(const row of data.rows.map(r=>r.data).sort())digest.update(row+'\n');
   manifest.push({...t,rows:data.rows.length,sha256:digest.digest('hex')});
 }
 console.log(JSON.stringify({opened:true,tables:manifest.length,nonempty:manifest.filter(t=>t.rows),accounts:(await db.query('SELECT id,email,role,credits,created_at,updated_at FROM storyhold.players ORDER BY id')).rows,worlds:(await db.query('SELECT id,name FROM storyhold.worlds')).rows}));
 await writeFile(`.storyhold-data/${outputPrefix}-manifest.json`,JSON.stringify(manifest,null,2),{mode:0o600});
 console.log('Exporting logical SQL with the version-matched official pg_dump tool.');
 const dump=await pgDump({pg:db,args:['--no-owner','--no-privileges']});
 const sql=await dump.text();
 await writeFile(`.storyhold-data/${outputPrefix}.sql`,sql,{mode:0o600});
 console.log(JSON.stringify({logicalDumpBytes:Buffer.byteLength(sql),sha256:createHash('sha256').update(sql).digest('hex')}));
} finally {await db.close();await lease.release();}
