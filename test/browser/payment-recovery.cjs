/** Offline browser regressions. Every request is fulfilled by a fixture or aborted.
 * PLAYWRIGHT_MODULE=/path/to/playwright-core BROWSER_EXECUTABLE=/path/to/chrome
 * node test/browser/payment-recovery.cjs /path/to/build
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = require('node:path').resolve(process.argv[2] || 'web/dist');
const results = [];
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE});
  try {
    for (const scenario of ['latest-terms','wallet-submitted','owner-read-error','receipt','history-error','unverified-history','status-error','rejection','grantless','focused-card','held-error','history-incomplete']) {
      if (process.env.SCENARIO && process.env.SCENARIO !== scenario) continue;
      const page = await browser.newPage({viewport:{width:390,height:900}});
      page.setDefaultTimeout(5000);
      const at = new Date(Date.now()-3600000).toISOString();
      const expiresAt = new Date(Date.now()+3600000).toISOString();
      const request = {asset:'usdc',amount:'123456789',recipient:'payee.near',confidential:true};
      const writes=[];
      let statusReads=0;
      let reloaded=false;
      await page.route('**/*', async route => {
        const u=new URL(route.request().url()), p=u.pathname;
        if(u.hostname!=='frontend.test') return route.abort();
        if(p==='/gw/me') return route.fulfill({json:{agents:[{name:'payables',owner:'owner.near',dao:false}],invoices:null,viewer:{account:'owner.near',access:{payables:{role:'operator',canPropose:true,canVote:true}}}}});
        if(p.includes('/rpc/')) {
          const method=p.split('/rpc/')[1];
          if(method==='paymentStatus') statusReads++;
          if(['owner/prepare','owner/submit','pay'].includes(method)) writes.push(method);
          if((scenario==='held-error' && method==='held') || (scenario==='owner-read-error' && method==='owner/actions') || (scenario==='history-error' && method==='paymentHistory') || (scenario==='status-error' && method==='paymentStatus')) return route.fulfill({status:500,json:{json:{defined:false,code:'INTERNAL_SERVER_ERROR',message:'Fixture read unavailable'}}});
          const settled=scenario==='rejection'||scenario==='unverified-history'||(scenario==='receipt'&&reloaded);
          const held=['latest-terms','wallet-submitted','owner-read-error','status-error','rejection','focused-card'].includes(scenario)||(scenario==='receipt'&&!reloaded);
          const values={
            setup:{executor:false,agentId:'fixture',wallet:'agent.near',owner:{type:'near',account_id:'owner.near'},grant:scenario==='grantless'?null:{label:'payout',expiresAt},dao:null},
            overview:{agentId:'fixture',digest:'fixture',notInForce:null,agreed:[],unmanaged:[],target:{usdc:1},rebalance:{minLegUsd:1,maxCostBps:100},book:[{asset:'usdc',symbol:'USDC',decimals:6,public:'0',confidential:'10000000',usd:10,price:1}],policy:{policy:{actions:['transfer'],frozen:false,destinations:{mode:'only',list:[]},assets:'any',budget:{},limits:{}},usage:{budget:{}},cooldowns:{}}},
            'treasury/get':null,held:scenario==='focused-card' ? [...(!reloaded?[{at,kind:'remote',request,correlationId:'payment',approvalId:'approval'}]:[]),{at,kind:'remote',request:{...request,amount:'2000000'},correlationId:'second-payment',approvalId:'second-approval'}] : held?[{at,kind:'remote',request,correlationId:'payment',approvalId:'approval'}]:[],unresolved:[],activity:[],'inbox/list':[],'agreements/list':scenario==='latest-terms' ? [
              {id:'declined',payee:'payee.near',status:'declined',terms:{maxAmount:'1',until:'2030-01-01T00:00:00Z'}},
              {id:'other',payee:'other.near',status:'agreed',terms:{maxAmount:'2',until:'2030-01-01T00:00:00Z'}},
              {id:'new',payee:'payee.near',status:'agreed',terms:{maxAmount:'200000000',until:'2030-01-01T00:00:00Z'}},
              {id:'old',payee:'payee.near',status:'agreed',terms:{maxAmount:'100000000',until:'2020-01-01T00:00:00Z'}}
            ] : [],'owner/pending':[],
            'owner/actions':['wallet-submitted','rejection'].includes(scenario)?[{correlationId:'wallet-action',type:'approval_vote',signer:'wallet',stage:scenario==='rejection'?'settled':'submitted',expiresAt:'2020-01-01T00:00:00Z',ownerSucceeded:scenario==='rejection',status:scenario==='rejection'?'FAILED':null,payment:{correlationId:'payment',verdict:scenario==='rejection'?'reject':'approve'}}]:[],
            paymentHistory:{items:scenario==='receipt'&&reloaded?[{correlationId:'payment',at}]:[],complete:scenario!=='history-incomplete'},
            paymentStatus:{status:scenario==='rejection'?'FAILED':settled?'SUCCESS':'PENDING_APPROVAL',failureCode:null,createdAt:at,updatedAt:at,request,approvalId:scenario==='unverified-history'?null:'approval',expiresAt,detailError:null},
            'autopilot/get':{on:false,everyMin:60,maxUsd:10},'autopilot/evidence':{ticks:[]},'strategy/get':{},invoices:[],ledger:[],reconcileBooks:[],
          };
          return route.fulfill({json:{json:values[method]??null}});
        }
        if(p.startsWith('/static/')) return route.fulfill({path:root+p,contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'font/woff2'});
        return route.fulfill({path:root+'/index.html',contentType:'text/html'});
      });
      try {
        await page.goto('http://frontend.test/a/payables/'+(scenario==='grantless'?'activity':scenario==='unverified-history'?'follow/payment?payment=payment':''));
        await page.waitForTimeout(1800);
        if(scenario==='latest-terms') { await page.getByText(/Each invoice up to 200 USDC/).waitFor(); await page.getByText('Within recorded terms',{exact:true}).waitFor(); assert.equal(await page.getByText('Outside agreed terms',{exact:true}).count(),0); }
        if(scenario==='receipt') { reloaded=true; await page.reload(); await page.getByText('Paid',{exact:true}).waitFor(); assert.match(await page.locator('body').innerText(),/123\.456789 USDC/); }
        if(scenario==='wallet-submitted') { await page.getByText(/Submission attempted.*checking/i).first().waitFor(); assert.equal(await page.getByRole('button',{name:'Sign approval',exact:true}).count(),0); assert.equal(await page.getByRole('button',{name:'Sign rejection',exact:true}).count(),0); await page.reload(); await page.getByText(/Submission attempted.*checking/i).first().waitFor(); assert.equal(await page.getByRole('button',{name:'Sign approval',exact:true}).count(),0); }
        if(scenario==='wallet-submitted') { await page.getByRole('link',{name:'Review the existing owner action',exact:true}).click(); await page.locator('#owner-wallet-action').waitFor(); await page.getByRole('link',{name:'Follow the payment outcome',exact:true}).waitFor(); }
        if(scenario==='owner-read-error') { await page.getByText(/Fixture read unavailable/).first().waitFor(); assert.equal(await page.getByRole('button',{name:'Sign approval',exact:true}).count(),0); }
        if(scenario==='held-error') { await page.getByText(/Fixture read unavailable/).first().waitFor({timeout:12000}); assert.doesNotMatch(await page.locator('body').innerText(),/Checking payments and owner actions/); }
        if(scenario==='history-error') { await page.getByText(/Fixture read unavailable/).first().waitFor(); assert.doesNotMatch(await page.locator('body').innerText(),/Nothing waits for a vote/); }
        if(scenario==='status-error') {
          await page.getByText(/Fixture read unavailable/).first().waitFor();
          const reads=statusReads;
          await page.waitForTimeout(1600);
          assert.equal(statusReads,reads,'A failed status read must stop automatic polling until explicit retry');
          await page.getByRole('button',{name:'Check again',exact:true}).first().click();
          await page.waitForTimeout(300);
          assert.ok(statusReads>reads,'Explicit retry must remain available');
        }
        if(scenario==='history-incomplete') { assert.match(await page.locator('body').innerText(),/history is incomplete/); assert.doesNotMatch(await page.locator('body').innerText(),/Nothing waits for a vote/); }
        if(scenario==='unverified-history') { await page.getByText('Paid',{exact:true}).waitFor(); assert.match(await page.locator('body').innerText(),/Approval history is unverified/); assert.doesNotMatch(await page.locator('body').innerText(),/invoice stays with the invoice host|Each payment is held until/); }
        if(scenario==='rejection') { const text=await page.locator('body').innerText(); assert.match(text,/Rejection submitted/); assert.doesNotMatch(text,/Not paid|nothing is paid/); }
        if(scenario==='grantless') await page.getByRole('link',{name:'Activity',exact:true}).first().waitFor();
        if(scenario==='focused-card') {
          const receiptLink=page.getByRole('link',{name:'Link to this payment',exact:true}).first();
          await receiptLink.focus();
          const href=await receiptLink.getAttribute('href');
          reloaded=true;
          await page.waitForTimeout(16500);
          assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('href')),href, 'Reviewed card must not move into collapsed history after polling');
        }
        if(scenario==='wallet-submitted') {
          for(const width of [320,1280]) {
            await page.setViewportSize({width,height:900});
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
          }
        }
        assert.deepEqual(writes,[], 'Recovery must never prepare, sign or submit a new action');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        if(process.env.ARTIFACT_DIR) { require("node:fs").mkdirSync(process.env.ARTIFACT_DIR,{recursive:true}); await page.screenshot({path:require("node:path").join(process.env.ARTIFACT_DIR,scenario+".png"),fullPage:true}); }
        results.push({scenario,pass:true});
      } catch(e) {results.push({scenario,pass:false,error:e.message});}
      await page.close();
    }
  } finally {await browser.close();}
  console.log(JSON.stringify(results,null,2)); process.exitCode=results.length > 0 && results.every(r=>r.pass)?0:1;
})();
