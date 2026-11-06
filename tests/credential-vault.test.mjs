import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CredentialVault,parseCredentialLines} from '../lib/credential-vault.js';
import {createAdminHandler} from '../lib/admin-route.js';
const INTERNAL='host-private-key-not-exposed-to-client';
function sandbox(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'c2a-vault-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const SAMPLE=['alice@example.invalid----pA#1&2*3----ABCDEF234567TEST','bob@example.invalid----p@55:word%42----XYZ234ABCDE99999'].join('\r\n');

test('parse one email----password----auxiliary record per line, preserve punctuation and CRLF',()=>{
  const v=parseCredentialLines('\uFEFF'+SAMPLE+'\r\n');
  assert.equal(v.accounts.length,2);assert.equal(v.errors.length,0);
  assert.equal(v.accounts[0].password,'pA#1&2*3');assert.equal(v.accounts[1].auxiliary,'XYZ234ABCDE99999');
});
test('support 3-dash separator (---) and email containing hyphens',()=>{
  const sample3 = [
    'alice-fixture+1@example.invalid---test-only-Pass#1---JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    'bob-fixture+2@example.invalid---test-only-Pass!2---GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  ].join('\n');
  const v = parseCredentialLines(sample3);
  assert.equal(v.accounts.length, 2);
  assert.equal(v.errors.length, 0);
  assert.equal(v.accounts[0].email, 'alice-fixture+1@example.invalid');
  assert.equal(v.accounts[0].password, 'test-only-Pass#1');
  assert.equal(v.accounts[0].auxiliary, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  assert.equal(v.accounts[1].email, 'bob-fixture+2@example.invalid');
  assert.equal(v.accounts[1].password, 'test-only-Pass!2');
  assert.equal(v.accounts[1].auxiliary, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});
test('support 4-field format with email----password----2fa----accessToken',()=>{
  const sample4 = 'token.fixture@example.invalid----test-only-Pass#3----JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP----eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE4MDAwMDAwMDB9.signature';
  const v = parseCredentialLines(sample4);
  assert.equal(v.accounts.length, 1);
  assert.equal(v.errors.length, 0);
  assert.equal(v.accounts[0].email, 'token.fixture@example.invalid');
  assert.equal(v.accounts[0].password, 'test-only-Pass#3');
  assert.equal(v.accounts[0].auxiliary, 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  assert.equal(v.accounts[0].accessToken, 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE4MDAwMDAwMDB9.signature');
});
test('support 4-field format with email----password----2fa----mailUrl',()=>{
  const sampleMail = 'mail.fixture@example.invalid----test-only-Pass#4----GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ----https://mail.example.invalid/m/TEST-ONLY-MAILBOX-LINK';
  const v = parseCredentialLines(sampleMail);
  assert.equal(v.accounts.length, 1);
  assert.equal(v.errors.length, 0);
  assert.equal(v.accounts[0].email, 'mail.fixture@example.invalid');
  assert.equal(v.accounts[0].password, 'test-only-Pass#4');
  assert.equal(v.accounts[0].auxiliary, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(v.accounts[0].mailUrl, 'https://mail.example.invalid/m/TEST-ONLY-MAILBOX-LINK');
  assert.equal(v.accounts[0].accessToken, undefined);
});
test('reject malformed rows by number, never include secrets in error messages',()=>{
  const bad='bademail----secret----ABCDEFG\nuser@example.invalid----secret\nuser@example.invalid----secret----ok';
  const v=parseCredentialLines(bad);
  assert.equal(v.accounts.length,1);assert.equal(v.errors.length,2);
  assert.deepEqual(v.errors.map(x=>x.line),[1,2]);
  assert.doesNotMatch(JSON.stringify(v.errors),/secret|ABCDEFG/);
});
test('deduplicate case-insensitive emails in same batch and across imports',t=>{
  const vault=new CredentialVault({root:sandbox(t),secret:INTERNAL});
  let a=vault.importText(SAMPLE+'\nalice@example.invalid----other----TOTP3');
  assert.equal(a.added,2);assert.equal(a.skipped,1);
  a=vault.importText(SAMPLE);assert.equal(a.added,0);assert.equal(a.skipped,2);
  assert.equal(vault.list().count,2);
});
test('on-disk storage is encrypted and browser list never exposes password or third field',t=>{
  const root=sandbox(t),vault=new CredentialVault({root,secret:INTERNAL});
  vault.importText(SAMPLE);const f=fs.readFileSync(path.join(root,'pending-credentials.enc.json'),'utf8');
  assert.doesNotMatch(f,/alice@example|pA#1|ABCDEF234567TEST|bob@example|p@55/);
  assert.match(f,/ciphertext/);
  const response=JSON.stringify(vault.list());assert.match(response,/alice@example/);
  assert.doesNotMatch(response,/password|auxiliary|pA#1|ABCDEF234567TEST/);
});
test('reject incorrect encryption key; corrupted file fails closed without overwrite',t=>{
  const root=sandbox(t),v=new CredentialVault({root,secret:INTERNAL});v.importText(SAMPLE);
  const wrong=new CredentialVault({root,secret:'other-private-key-0123456789'});
  assert.throws(()=>wrong.list(),/验证失败/);
  const stored=fs.readFileSync(v.file,'utf8');assert.throws(()=>wrong.importText(SAMPLE),/验证失败/);
  assert.equal(fs.readFileSync(v.file,'utf8'),stored);
});
test('deletes individual pending record and keeps remaining values encrypted',t=>{
  const root=sandbox(t),v=new CredentialVault({root,secret:INTERNAL});v.importText(SAMPLE);
  const id=v.list().items[0].id;assert.equal(v.delete(id).removed,1);assert.equal(v.list().count,1);
  assert.equal(v.delete(id).removed,0);
});
test('input rejects over 1000 rows or 1MB, never creating a vault',t=>{
  const v=new CredentialVault({root:sandbox(t),secret:INTERNAL});
  assert.throws(()=>v.importText('alice@example.invalid----abc----xyz\n'.repeat(1001)),/最多 1000/);
  assert.throws(()=>v.importText('x'.repeat(1024*1024+1)),/1MB/);
});
test('DSH Host route imports pending records locally without forwarding to upstream',async t=>{
  const root=sandbox(t),vault=new CredentialVault({root,secret:INTERNAL});let fetchCount=0;
  const handler=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:INTERNAL,vault,fetcher:()=>{fetchCount++;throw Error('upstream should not be called')}});
  const createReq=(path,method='GET',body)=>new Request('http://localhost/api/chatgpt2api-native/manage',{method:'POST',body:JSON.stringify({path,method,body})});
  let res=await handler.route(createReq('/local/credential-vault','POST',{text:SAMPLE}));const imported=await res.json();
  assert.equal(imported.added,2);assert.doesNotMatch(JSON.stringify(imported),/pA#1|ABCDEF234567TEST/);
  res=await handler.route(createReq('/local/credential-vault'));const listed=await res.json();assert.equal(listed.items.length,2);
  assert.doesNotMatch(JSON.stringify(listed),/pA#1|ABCDEF234567TEST/);
  res=await handler.route(createReq('/local/credential-vault/'+listed.items[0].id,'DELETE'));assert.equal((await res.json()).removed,1);
  assert.equal(fetchCount,0);
});
test('unsupported vault methods and arbitrary paths are rejected',async t=>{
  const vault=new CredentialVault({root:sandbox(t),secret:INTERNAL});
  const handler=createAdminHandler({baseUrl:'http://127.0.0.1:38650',secret:INTERNAL,vault});
  const req=x=>new Request('http://localhost/api/chatgpt2api-native/manage',{method:'POST',body:JSON.stringify(x)});
  for(const value of [{path:'/local/credential-vault',method:'DELETE'},{path:'/local/credential-vault/../../api/settings',method:'DELETE'}]){
    const r=await handler.route(req(value));assert.equal(r.status,404);
  }
});
test('vault get, getAll, and updateStatus support internal authentication flow',t=>{
  const root=sandbox(t),vault=new CredentialVault({root,secret:INTERNAL});
  vault.importText(SAMPLE);
  const all=vault.getAll();
  assert.equal(all.length,2);
  assert.equal(all[0].email,'alice@example.invalid');
  assert.equal(all[0].password,'pA#1&2*3');
  const target=vault.get(all[0].id);
  assert.equal(target.auxiliary,'ABCDEF234567TEST');
  assert.equal(vault.get('00000000-0000-0000-0000-000000000000'),null);
  assert.equal(vault.updateStatus(all[0].id,{state:'auth_failed',lastError:'wrong password'}),true);
  const updated=vault.list().items.find(x=>x.id===all[0].id);
  assert.equal(updated.state,'auth_failed');
  assert.equal(updated.lastError,'wrong password');
});
test('authenticate route logs in, exchanges tokens, enrolls into account pool, and removes from vault',async t=>{
  const root=sandbox(t),vault=new CredentialVault({root,secret:INTERNAL});
  vault.importText(SAMPLE);
  const allBefore=vault.getAll();
  const upstreamCalls=[];
  const mockFetcher=async (url,opts)=>{
    upstreamCalls.push({url,method:opts.method,body:opts.body&&JSON.parse(opts.body)});
    return {
      status:200,
      ok:true,
      headers:{get:()=>null},
      text:async()=>JSON.stringify({added:1,skipped:0,refreshed:1,errors:[]})
    };
  };
  const mockAuthenticator=async ({accounts})=>{
    return {
      results: accounts.map(a=>{
        if(a.email.includes('alice')){
          return {
            id: a.id,
            email: a.email,
            ok: true,
            access_token: 'tok_alice_12345',
            refresh_token: 'rt_alice_67890',
            id_token: 'id_alice_abc'
          };
        }
        return {
          id: a.id,
          email: a.email,
          ok: false,
          error: 'password_verify_failed_400'
        };
      })
    };
  };
  const handler=createAdminHandler({
    baseUrl:'http://127.0.0.1:38650',
    secret:INTERNAL,
    vault,
    fetcher:mockFetcher,
    authenticator:mockAuthenticator
  });
  const req=x=>new Request('http://localhost/api/chatgpt2api-native/manage',{method:'POST',body:JSON.stringify(x)});
  const res=await handler.route(req({path:'/local/credential-vault/authenticate',method:'POST',body:{all:true}}));
  const data=await res.json();
  assert.equal(data.total,2);
  assert.equal(data.succeeded,1);
  assert.equal(data.failed,1);
  assert.equal(data.enrolled.added,1);
  assert.equal(data.enrolled.refreshed,1);
  assert.equal(data.failures.length,1);
  assert.equal(data.failures[0].email,'bob@example.invalid');
  assert.doesNotMatch(JSON.stringify(data),/tok_alice_12345|rt_alice_67890|pA#1&2\*3|p@55:word/);
  // Upstream /api/accounts received the tokens
  assert.equal(upstreamCalls.length,1);
  assert.equal(upstreamCalls[0].url,'http://127.0.0.1:38650/api/accounts');
  assert.equal(upstreamCalls[0].body.tokens[0],'tok_alice_12345');
  assert.equal(upstreamCalls[0].body.accounts[0].email,'alice@example.invalid');
  // Succeeded account removed from vault, failed account kept with updated state
  const remaining=vault.list().items;
  assert.equal(remaining.length,1);
  assert.equal(remaining[0].email,'bob@example.invalid');
  assert.equal(remaining[0].state,'auth_failed');
  assert.match(remaining[0].lastError,/password_verify_failed_400/);
});
