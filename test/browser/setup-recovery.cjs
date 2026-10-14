const { rpcValue } = require('./fixtures/rpc.cjs');
/** Offline setup recovery regressions; every request is intercepted or aborted.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome
 * node test/browser/setup-recovery.cjs /path/to/build
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('./fixtures/browser.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE});
  const results=[];
  try {
    for (const scenario of ['cold','navigate','retry','cached','denied-cold','denied-refresh','signed-out','bootstrap-error','no-agent']) {
      if (process.env.SCENARIO && process.env.SCENARIO!==scenario) continue;
      const page=await browser.newPage({viewport:{width:390,height:900}});
      page.setDefaultTimeout(6000);
      let setupFails=scenario!=='cached' && scenario!=='no-agent';
      let denied=scenario==='denied-cold';
      let documents=0;
      const calls=[];
      const at=new Date().toISOString();
      const reconnect=()=>page.evaluate(async()=>{window.dispatchEvent(new Event('offline')); await new Promise(r=>setTimeout(r,50)); window.dispatchEvent(new Event('online'));});
      await page.route('**/*', async route=>{
        const u=new URL(route.request().url()), p=u.pathname;
        if(u.hostname!=='frontend.test') return route.abort();
        const error=(status,message)=>route.fulfill({status,json:{json:{defined:false,code:status===403?'FORBIDDEN':'INTERNAL_SERVER_ERROR',message}}});
        if(p==='/gw/me') {
          if(scenario==='bootstrap-error') return route.fulfill({status:503,json:{error:'Gateway unavailable'}});
          return route.fulfill({json:{agents:[{name:'payables',owner:'owner.near',dao:false}],invoices:null,viewer:scenario==='signed-out'?null:{account:'owner.near',access:{payables:{role:'operator',canPropose:true,canVote:true}}}}});
        }
        if(p.includes('/rpc/')) {
          const method=p.split('/rpc/')[1];calls.push(method);
          if(method==='setup' && setupFails) return error(503,'Setup fixture unavailable');
          if(denied && ['activity','unresolved','owner/actions'].includes(method)) return error(403,'Record access denied');
          const values={
            get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup:{executor:false,agentId:scenario==='no-agent'?null:'fixture',wallet:'agent.near',owner:{type:'near',account_id:'owner.near'},grant:{label:'payout',expiresAt:'2030-01-01T00:00:00Z'},dao:null},
            overview:{agentId:'fixture',digest:'fixture',notInForce:null,agreed:[],unmanaged:[],target:{usdc:1},rebalance:{minLegUsd:1,maxCostBps:100},book:[],policy:{policy:{actions:['transfer'],frozen:false,destinations:{mode:'only',list:[]},assets:'any',budget:{},limits:{}},usage:{budget:{}},cooldowns:{}}},
            'treasury/get':null,
            activity:[{at,kind:'payout',request:{asset:'usdc',amount:'123',recipient:'private-payee.near'},correlationId:'private-operation',status:'PROCESSING'},{at,kind:'probe',request:{asset:'usdc',amount:'1'},correlationId:'private-probe',status:'FAILED'}],
            unresolved:[{key:'private-unresolved',at,kind:'payout',status:'PROCESSING',sent:true}],
            'owner/actions':[{correlationId:'private-owner',type:'approval_vote',signer:'wallet',stage:'submitted',expiresAt:'2020-01-01T00:00:00Z',ownerSucceeded:false,status:null,payment:{correlationId:'private-operation',verdict:'approve'}}],
            'owner/pending':[],held:[],paymentHistory:{items:[],complete:true},'agreements/list':[],'inbox/list':[],invoices:[],ledger:[],reconcileBooks:[],
          };
          return route.fulfill({json:{json:rpcValue(values, method)}});
        }
        if(p.startsWith('/static/')) return route.fulfill({path:root+p,contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'font/woff2'});
        documents++;return route.fulfill({path:path.join(root,'index.html'),contentType:'text/html'});
      });
      try {
        await page.goto('http://frontend.test/a/payables/'+(scenario==='navigate'?'funding':'activity'));
        if(['signed-out','bootstrap-error'].includes(scenario)) {
          await page.getByRole('main').waitFor();
          if(scenario==='bootstrap-error') await page.getByText('Dashboard unavailable',{exact:true}).waitFor();
          assert.deepEqual(calls,[]);
        } else if(scenario==='no-agent') {
          await page.getByRole('button',{name:'Retry setup',exact:true}).waitFor({state:'hidden'});
          await page.getByRole('main').waitFor();
          assert.equal(calls.includes('activity'),false);
        } else {
          if(scenario==='cached') {
            await page.locator('#operation-private-operation').waitFor();
            setupFails=true; await reconnect();
          }
          await page.getByText('Setup unavailable',{exact:true}).waitFor({timeout:15000});
          if(scenario==='navigate') await page.getByRole('link',{name:'Review existing records in Activity',exact:true}).click();
          if(scenario==='denied-cold') {
            await page.getByText('Record access denied',{exact:false}).first().waitFor();
            assert.doesNotMatch(await page.locator('body').innerText(),/private-owner|private-operation|private-unresolved|No actions recorded|No owner actions|No unresolved operations/);
          } else {
            await page.locator('#owner-private-owner').waitFor();
            await page.locator('#operation-private-operation').waitFor();
            if(scenario==='retry') {
              const before=documents;
              const owner=await page.locator('#owner-private-owner').elementHandle();
              await page.getByRole('button',{name:'Retry setup',exact:true}).click();
              await page.getByRole('button',{name:'Retry setup',exact:true}).waitFor();
              assert.equal(await owner.evaluate(e=>e.isConnected),true,'Retry failure must retain the records');
              setupFails=false;
              await page.getByRole('button',{name:'Retry setup',exact:true}).click();
              await page.getByText('Setup unavailable',{exact:true}).waitFor({state:'hidden'});
              await page.getByRole('button',{name:'Connect wallet',exact:true}).first().waitFor();
              assert.equal(documents,before,'Retry must not reload');
            }
            if(scenario==='denied-refresh') {
              denied=true;await reconnect();
              await page.getByText('Record access denied',{exact:false}).first().waitFor();
              await page.waitForFunction(()=>!document.body.innerText.match(/private-owner|private-operation|private-unresolved|private-probe/),{},{timeout:12000});
              assert.doesNotMatch(await page.locator('body').innerText(),/No actions recorded|No owner actions|No unresolved operations/);
            }
          }
          if(scenario!=='retry') assert.equal(await page.getByRole('button',{name:/Connect wallet|Run now|Sign approval|Check status|Create agent/}).count(),0,'Recovery frame exposes no signing or money controls');
        }
        assert.equal(calls.some(x=>['owner/prepare','owner/submit','pay','recover','cancelPreparedInvoice','autopilot/tick'].includes(x)),false);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        results.push({scenario,pass:true});
      } catch(e) { results.push({scenario,pass:false,error:e.message}); }
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(results,null,2));process.exitCode=results.length > 0 && results.every(r=>r.pass)?0:1;
})();
