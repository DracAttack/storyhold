import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireStoryholdVaultOwnership, VaultOwnershipError } from '../artifacts/api-server/src/storyhold/vaultOwnership';
const settings=new Map((await readFile('.storyhold.env','utf8')).split(/\r?\n/).filter(l=>/^[A-Z][A-Z0-9_]*=/.test(l)).map(l=>{const p=l.indexOf('=');return [l.slice(0,p),l.slice(p+1).trim().replace(/^['"]|['"]$/g,'')];}));
const base='http://127.0.0.1:3000';
const health=await fetch(base+'/api/healthz');
if(!health.ok)throw new Error('Server unhealthy.');
const denied=await fetch(base+'/api/storyhold/admin/manual-storyteller');
if(denied.status!==401)throw new Error('Unauthenticated private queue was not denied.');
const login=await fetch(base+'/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:settings.get('STORYHOLD_LOCAL_ADMIN_EMAIL'),password:settings.get('STORYHOLD_LOCAL_ADMIN_PASSWORD')})});
if(!login.ok)throw new Error(`Configured owner login failed (${login.status}).`);
const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
const account=await login.json() as {role:string;credits:number};
try {
 const worldsResponse=await fetch(base+'/api/storyhold/worlds',{headers:{cookie}});
 const worlds=await worldsResponse.json() as {worlds:unknown[]};
 if(!worldsResponse.ok||!Array.isArray(worlds.worlds)||worlds.worlds.length)throw new Error('World list was not empty.');
 const queueResponse=await fetch(base+'/api/storyhold/admin/manual-storyteller',{headers:{cookie}});
 const queue=await queueResponse.json() as {enabled:boolean;entries:unknown[]};
 if(!queueResponse.ok||!queue.enabled||!Array.isArray(queue.entries)||queue.entries.length)throw new Error('Manual test queue not ready/empty.');
 let blocked=false;
 try {const lease=await acquireStoryholdVaultOwnership(path.resolve(settings.get('STORYHOLD_LOCAL_DATA_DIR')!),{purpose:'verifying live-owner exclusion without opening database'});await lease.release();}
 catch(e){if(e instanceof VaultOwnershipError)blocked=true;else throw e;}
 if(!blocked)throw new Error('Concurrent maintenance was not blocked.');
 console.log(JSON.stringify({healthy:true,ownerLogin:true,role:account.role,credits:account.credits,worlds:worlds.worlds.length,manualQueueEnabled:queue.enabled,manualEntries:queue.entries.length,privateQueueUnauthenticatedStatus:denied.status,liveVaultExcludedOtherProcess:true}));
} finally {await fetch(base+'/api/admin/logout',{method:'POST',headers:{cookie}});}
