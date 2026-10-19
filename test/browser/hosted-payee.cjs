/** Per-owner URLs and retained drafts never fall back to another owner's intake. */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { runTask } = require('./fixtures/task.cjs');
const bases = ['/i/own-' + 'a'.repeat(24), '/i/own-' + 'b'.repeat(24)];
const fixtures = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import {invoicePage,invoiceBrowser} from './src/invoice-page.ts'; console.log(JSON.stringify({pages:${JSON.stringify(bases)}.map(base=>invoicePage('Contributor invoices',base)),script:invoiceBrowser}));`], {encoding:'utf8'}));
runTask([async function isolatedPayeeDrafts(browser) {
  const context = await browser.newContext({viewport:{width:390,height:900}});
  const page = await context.newPage(); const writes = [], errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdn.jsdelivr.net') return route.fulfill({contentType:'text/javascript',body:'export class NearConnector {}'});
    const index = bases.findIndex(base => url.pathname.startsWith(base + '/'));
    assert.ok(index >= 0, 'no request may fall back to the agency or another intake root: ' + url.pathname);
    const p = url.pathname.slice(bases[index].length);
    if (p === '/') return route.fulfill({contentType:'text/html',body:fixtures.pages[index]});
    if (p === '/invoice-browser.js') return route.fulfill({contentType:'text/javascript',body:fixtures.script});
    if (p === '/api/session') return route.fulfill({json:{account:'contributor.near',agreed:false}});
    if (p === '/api/work-orders') return route.fulfill({json:{orders:[]}});
    if (p === '/api/invoices' && route.request().method() === 'POST') {
      writes.push({base:bases[index],body:route.request().postDataJSON()});
      return route.fulfill({json:{status:'unknown'}});
    }
    if (p === '/api/invoices') return route.fulfill({json:{invoices:[],agreements:[],agreed:false}});
    throw new Error('Unexpected route: ' + p);
  });
  await page.goto('https://invoices.test' + bases[0] + '/');
  await page.getByLabel('Amount (USDC)').fill('1.25');
  await page.getByLabel("What's it for? (optional)").fill('Original owner work');
  await page.getByRole('button',{name:'Send request',exact:true}).click();
  await page.getByText(/payment outcome is unknown/).waitFor();
  assert.equal(writes.length,1);
  const original = writes[0].body.submission;
  await page.goto('https://invoices.test' + bases[1] + '/');
  await page.getByRole('button',{name:'Send request',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Amount (USDC)').inputValue(),'');
  await page.goto('https://invoices.test' + bases[0] + '/');
  await page.getByText(/retains a previous submission/).waitFor();
  assert.equal(await page.getByLabel('Amount (USDC)').inputValue(),'1.25');
  const draft = await page.evaluate(key=>JSON.parse(localStorage.getItem(key)), 'invoice-draft:' + bases[0] + ':contributor.near');
  assert.equal(draft.submission,original);
  assert.equal(writes.length,1,'navigation and reload never resubmit');
  assert.deepEqual(errors,[]);
  console.log('PASS scoped contributor API routing, draft isolation and exact identity retained on reload');
}]);
