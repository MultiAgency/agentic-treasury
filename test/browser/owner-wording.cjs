const { rpcValue } = require('./fixtures/rpc.cjs');
/** Offline owner-facing copy regressions; every request is intercepted.
 * PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE select an installed browser.
 * node test/browser/owner-wording.cjs /path/to/build
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('./fixtures/browser.cjs');
const root = path.resolve(process.argv[2] || 'web/dist');
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE});
  const results = [];
  try {
    for (const width of [390,1280]) for (const scenario of ['approved','rejected','unknown','dao','schedule-on','schedule-off']) {
      if (process.env.SCENARIO && process.env.SCENARIO !== scenario) continue;
      const page = await browser.newPage({viewport:{width,height:900}});
      page.setDefaultTimeout(5000);
      const treasury = scenario.startsWith('schedule-');
      const name = treasury ? 'treasury' : 'payables';
      const dao = scenario === 'dao';
      const at = new Date().toISOString();
      const expiresAt = '2030-01-01T00:00:00Z';
      const request = {asset:'usdc',amount:'123456789',recipient:'payee.near',confidential:true};
      const errors = [], writes = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), p = url.pathname;
        if (url.hostname !== 'frontend.test') return route.abort();
        if (p === '/gw/me') return route.fulfill({json:{agents:[{name,owner:dao?'owner.sputnik-dao.near':'owner.near',dao}],invoices:null,viewer:{account:'owner.near',access:{[name]:{role:'operator',canPropose:true,canVote:true}}}}});
        if (p === '/gw/proposals') return route.fulfill({json:[{id:42,hash:'fixture-hash',status:'Approved',votes:{'owner.near':'Approve'},submittedAt:at}]});
        if (p.includes('/rpc/')) {
          const method = p.split('/rpc/')[1];
          const values = {
            get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup:{executor:false,agentId:'fixture',wallet:'agent.near',owner:{type:'near',account_id:dao?'owner.sputnik-dao.near':'owner.near'},grant:{label:treasury?'treasury':'payout',expiresAt},dao:null},
            overview:{agentId:'fixture',digest:'fixture',notInForce:null,agreed:[],unmanaged:[],target:{usdc:1},rebalance:{minLegUsd:1,maxCostBps:100},book:[{asset:'usdc',symbol:'USDC',decimals:6,public:'0',confidential:'10000000',usd:10,price:1}],policy:{policy:{actions:treasury?['swap','transfer']:['transfer'],frozen:false,destinations:{mode:'only',list:[]},assets:'any',budget:{},limits:{}},usage:{budget:{}},cooldowns:{}}},
            'treasury/get':null,held:[],unresolved:treasury?[{key:'unresolved-fixture',at,kind:'swap',sent:true,status:'PROCESSING'}]:[],activity:[],'inbox/list':[],'agreements/list':[],
            'owner/pending':dao?[{correlationId:'owner-record',hash:'fixture-hash',state:'done',expiresAt,payment:{correlationId:'payment',verdict:'approve'}}]:[],
            'owner/status':{stage:'submitted',status:'SUCCESS'},
            'owner/actions':['approved','rejected'].includes(scenario)?[{correlationId:'owner-record',type:'approval_vote',signer:'wallet',stage:'settled',expiresAt,ownerSucceeded:true,status:scenario==='rejected'?'FAILED':'SUCCESS',payment:{correlationId:'payment',verdict:scenario==='rejected'?'reject':'approve'}}]:[],
            paymentHistory:{items:[{correlationId:'payment',at}],complete:true},
            paymentStatus:{status:scenario==='rejected'?'FAILED':'SUCCESS',failureCode:null,createdAt:at,updatedAt:at,request,approvalId:scenario==='unknown'?null:'approval',expiresAt,detailError:null},
            'autopilot/get':{on:scenario==='schedule-on',everyMin:60,maxUsd:10},'autopilot/evidence':{ticks:[]},
          };
          if (!(method in values)) { writes.push(method); return route.abort(); }
          return route.fulfill({json:{json:rpcValue(values, method)}});
        }
        if (p.startsWith('/static/')) return route.fulfill({path:root+p,contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'font/woff2'});
        return route.fulfill({path:path.join(root,'index.html'),contentType:'text/html'});
      });
      try {
        await page.goto(`http://frontend.test/a/${name}/${treasury?'':'follow/payment?payment=payment'}`);
        for (let visit=0;visit<2;visit++) {
          if (visit) await page.reload();
          if (treasury) {
            await page.getByText(scenario==='schedule-on'?'Schedule on: every 60 minutes; configured rebalance limit $10.00 per run.':'Autopilot is off.',{exact:false}).waitFor();
            await page.getByText(/Nothing new moves until it is resolved/).waitFor();
            await page.getByRole('link',{name:'Strategy and schedule',exact:true}).waitFor();
            assert.doesNotMatch(await page.locator('body').innerText(),/executing rebalances/);
          } else {
            await page.getByText(scenario==='rejected'?'Provider reported failed':'Paid',{exact:true}).first().waitFor();
            await page.getByText('Payment history and public visibility', { exact: true }).click();
            const title = scenario==='approved'?"Approved by the owner's wallet":scenario==='rejected'?"Rejected by the owner's wallet":scenario==='unknown'?'Owner wallet decision · unverified':'Proposal filed and voted';
            const stage = page.getByRole('heading',{name:new RegExp(`^${title.replaceAll("'", "['’]")}$`)}).locator('..');
            await stage.waitFor();
            if (['approved','rejected'].includes(scenario)) assert.doesNotMatch(await stage.innerText(),/No .*evidence|unverified/);
            if (scenario==='unknown') assert.match(await stage.innerText(),/No .*evidence/);
            if (dao) assert.match(await stage.innerText(),/Proposal #42: approved, 1 vote/);
            const completed = await stage.locator('..').locator('span.relative.bg-brand').count();
            assert.equal(completed,scenario==='unknown'?0:1,'Stage marker must agree with its evidence');
          }
        }
        assert.deepEqual(errors,[]);
        assert.deepEqual(writes,[], 'Read-only review must never invoke an action');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        if (process.env.ARTIFACT_DIR) {
          fs.mkdirSync(process.env.ARTIFACT_DIR,{recursive:true});
          await page.screenshot({path:path.join(process.env.ARTIFACT_DIR,`${scenario}-${width}.png`),fullPage:true});
        }
        results.push({scenario,width,pass:true});
      } catch(e) { results.push({scenario,width,pass:false,error:e.message}); }
      await page.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(results,null,2));
  process.exitCode = results.length > 0 && results.every(r=>r.pass)?0:1;
})();
