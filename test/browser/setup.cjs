/** Offline task journeys. Run through test/browser/run.cjs to retain failure diagnostics. */
const { runTask } = require('./fixtures/task.cjs');
const { rpcValue } = require('./fixtures/rpc.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');

async function setupAndReturn(browser, root) {
  const width = 390;
  for (const scenario of ['new', 'creation-submitted', 'creation-succeeded', 'records-error', 'return-payables', 'return-treasury', 'return-policy', 'return-proposal', 'return-complete']) {
   const page = await browser.newPage({ viewport: { width, height: 900 } }); page.setDefaultTimeout(6000);
   const returning = scenario.startsWith('return-'), treasury = scenario === 'return-treasury', calls = [], errors = [];
   let grantReported = false;
   page.on('pageerror', e => errors.push(e.message));
   await page.route('**/*', async route => {
    const { hostname, pathname: p } = new URL(route.request().url());
    if (hostname !== 'frontend.test') return route.abort();
    if (p === '/gw/me') return route.fulfill({ json: { agents: [{ name: 'fixture', area: treasury ? 'treasury' : 'payables', owner: 'owner.near', dao: true }], viewer: { account: 'owner.near', access: { fixture: { canSign: false, canPropose: true, canVote: true, canExecute: true, canManage: true } } } } });
    if (p.includes('/rpc/')) {
     const method = p.split('/rpc/')[1]; calls.push(method);
     if (scenario === 'records-error' && method === 'owner/actions') return route.fulfill({ status: 503, json: { json: { defined: false, code: 'INTERNAL_SERVER_ERROR', message: 'Setup records unavailable' } } });
     const values = {
      instance: { agentId: returning ? 'fixture' : null, area: treasury ? 'treasury' : 'payables', executor: true },
      setup: { agentId: returning ? 'fixture' : null, executor: true, wallet: 'agent.near', owner: { type: 'near', account_id: 'owner.near' }, grant: grantReported ? { id: 'reported', label: 'payout', expiresAt: '2099-01-01T00:00:00Z' } : null, dao: { id: 'owner.sputnik-dao.near', funded: true, owner: { account_id: 'owner.near' } } },
      overview: { agentId: 'fixture', area: treasury ? 'treasury' : 'payables', digest: 'fixture', notInForce: scenario === 'return-policy' ? 'revision 1 is not yet synchronized with the provider' : null, agreed: [], book: [], unmanaged: [], target: {}, grants: [], rebalance: { minLegUsd: 1, maxCostBps: 100 }, policy: { status: 'APPLIED', revision: 1, policy: { actions: treasury ? ['swap'] : ['transfer'], assets: 'any', budget: {}, limits: {}, frozen: false, owner_approval: true, destinations: { mode: 'only', list: [] } }, usage: { budget: {} }, cooldowns: {} } },
      'owner/actions': ['creation-submitted', 'creation-succeeded', 'return-proposal', 'return-complete'].includes(scenario) ? [{ correlationId: 'existing-setup', type: returning ? 'grant_issue' : 'agent_create', signer: 'dao', stage: scenario === 'creation-succeeded' ? 'settled' : 'submitted', ownerSucceeded: scenario === 'creation-succeeded', status: scenario === 'creation-succeeded' ? 'SUCCESS' : null }] : [],
      'owner/pending': [], 'treasury/get': null, policyHistory: [], unresolved: [], held: [], activity: [], 'inbox/list': [],
     };
     assert.ok(method in values, `Unexpected RPC ${method}`); return route.fulfill({ json: { json: rpcValue(values, method) } });
    }
    return route.fulfill({ path: p.startsWith('/static/') ? root + p : root + '/index.html' });
   });
   await page.goto('http://frontend.test/a/fixture/');
   if (returning) {
    await page.getByRole('heading', { name: 'Continue setup', exact: true }).waitFor();
    if (scenario === 'return-proposal' || scenario === 'return-complete') {
     await page.getByText('existing-setup', { exact: true }).waitFor();
     if (scenario === 'return-complete') {
      grantReported = true;
      await page.getByRole('button', { name: 'Check setup status', exact: true }).click();
      const next = page.getByRole('link', { name: 'Continue to Payments in Payables', exact: true });
      await next.waitFor(); assert.equal(await next.getAttribute('href'), 'https://payables.multiagency.ai/a/fixture/');
      await page.getByText(/Each action still requires its own authorization and balance checks/).waitFor();
     }
    }
    else {
     const next = page.getByRole('heading', { name: 'Continue setup', exact: true }).locator('..').locator('..').locator('..');
     // Policy, grant and strategy are reviewed and signed in the agent's app.
     const link = next.getByRole('link', { name: scenario === 'return-treasury' ? 'Review and authorize the strategy in Treasury' : scenario === 'return-policy' ? 'Review policy and permissions in Payables' : 'Review the grant in Payables', exact: true });
     await link.waitFor();
     assert.equal(await link.getAttribute('href'), scenario === 'return-treasury' ? 'https://treasury.multiagency.ai/a/fixture/automations'
       : `https://payables.multiagency.ai/a/fixture/policy${scenario === 'return-policy' ? '' : '#grants'}`);
    }
   } else {
    await page.getByRole('heading', { name: 'Existing setup actions', exact: true }).waitFor();
    const create = page.getByRole('button', { name: 'Propose creating the agent', exact: true });
    await create.waitFor();
    if (scenario === 'new') await page.getByText(/No matching setup actions recorded on this instance/).waitFor();
    else if (scenario === 'records-error') await page.getByText(/Setup actions could not be loaded/).waitFor();
    else await page.getByText('existing-setup', { exact: true }).waitFor();
    assert.equal(await create.isDisabled(), scenario !== 'new');
    await page.getByRole('button', { name: 'Check setup status', exact: true }).click();
   }
   assert.deepEqual(errors, []); assert.ok(!calls.some(m => /prepare|submit|^pay$|stop|tick/.test(m)));
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
   console.log(`PASS onboarding ${width}px: ${scenario}`); await page.close();
  }
}

// The agent frame's own failure states. Record retention during a setup failure belongs to the apps' Activity screens.
async function setupRecovery(browser, root) {
  const results=[];
  for (const scenario of ['retry','signed-out','bootstrap-error','no-agent']) {
    if (process.env.SCENARIO && process.env.SCENARIO!==scenario) continue;
    const page=await browser.newPage({viewport:{width:390,height:900}});
    page.setDefaultTimeout(6000);
    let setupFails=scenario==='retry';
    let documents=0;
    const calls=[];
    await page.route('**/*', async route=>{
      const u=new URL(route.request().url()), p=u.pathname;
      if(u.hostname!=='frontend.test') return route.abort();
      if(p==='/gw/me') {
        if(scenario==='bootstrap-error') return route.fulfill({status:503,json:{error:'Gateway unavailable'}});
        return route.fulfill({json:{agents:[{name:'payables',owner:'owner.near',dao:false}],invoices:null,viewer:scenario==='signed-out'?null:{account:'owner.near',access:{payables:{canSign:true,canPropose:true,canVote:true,canExecute:true,canManage:true}}}}});
      }
      if(p.includes('/rpc/')) {
        const method=p.split('/rpc/')[1];calls.push(method);
        if(method==='setup' && setupFails) return route.fulfill({status:503,json:{json:{defined:false,code:'INTERNAL_SERVER_ERROR',message:'Setup fixture unavailable'}}});
        const values={
          get instance() { return { agentId: this.setup?.agentId ?? null, executor: this.setup?.executor !== false }; }, setup:{executor:false,agentId:scenario==='no-agent'?null:'fixture',wallet:'agent.near',owner:{type:'near',account_id:'owner.near'},grant:{label:'payout',expiresAt:'2030-01-01T00:00:00Z'},dao:null},
          overview:{agentId:'fixture',area:'payables',digest:'fixture',notInForce:null,agreed:[],unmanaged:[],grants:[],target:{usdc:1},rebalance:{minLegUsd:1,maxCostBps:100},book:[],policy:{policy:{actions:['transfer'],frozen:false,destinations:{mode:'only',list:[]},assets:'any',budget:{},limits:{}},usage:{budget:{}},cooldowns:{}}},
          'owner/actions':[],'owner/pending':[],
        };
        return route.fulfill({json:{json:rpcValue(values, method)}});
      }
      if(p.startsWith('/static/')) return route.fulfill({path:root+p,contentType:p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'font/woff2'});
      documents++;return route.fulfill({path:path.join(root,'index.html'),contentType:'text/html'});
    });
    try {
      await page.goto('http://frontend.test/a/payables/');
      if(['signed-out','bootstrap-error'].includes(scenario)) {
        await page.getByRole('main').waitFor();
        if(scenario==='bootstrap-error') await page.getByText('Dashboard unavailable',{exact:true}).waitFor();
        assert.deepEqual(calls,[]);
      } else if(scenario==='no-agent') {
        await page.getByRole('button',{name:'Retry setup',exact:true}).waitFor({state:'hidden'});
        await page.getByRole('main').waitFor();
      } else {
        await page.getByText('Setup unavailable',{exact:true}).waitFor({timeout:15000});
        const before=documents;
        await page.getByRole('button',{name:'Retry setup',exact:true}).click();
        await page.getByRole('button',{name:'Retry setup',exact:true}).waitFor();
        setupFails=false;
        await page.getByRole('button',{name:'Retry setup',exact:true}).click();
        await page.getByText('Setup unavailable',{exact:true}).waitFor({state:'hidden'});
        await page.getByRole('heading',{name:'Payables agent',exact:true}).waitFor();
        assert.equal(documents,before,'Retry must not reload');
      }
      assert.equal(calls.some(x=>['owner/prepare','owner/submit','pay','recover','cancelPreparedInvoice','autopilot/tick'].includes(x)),false);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      results.push({scenario,pass:true});
    } catch(e) { results.push({scenario,pass:false,error:e.message}); }
    await page.close();
  }
  console.log(JSON.stringify(results,null,2));
  assert.ok(results.length > 0 && results.every(r=>r.pass), "All scenarios must pass");
}

runTask([setupAndReturn, setupRecovery]);
