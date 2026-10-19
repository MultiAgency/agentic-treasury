import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { environment } from './environment.mjs';
import { browserContext } from './wallet.mjs';
import { BUILDER, OWNER, sign } from './provider.mjs';
import { ownerRpc, payeeApi } from './payables-steps.mjs';

// Shared builder payouts on the real stack: one-time setup as owner steps (a signed policy update that adds the builder,
// then funding the payout agent), then one report paid from the shared balance with a single held approval. The
// payout agent starts unfunded and without the builder. Provider, chain, signatures, deposits and settlement are simulated.
test('shared builder payout: setup once as owner steps, then a report paid once from the shared balance', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const stack = await environment(info.outputPath('environment'), { accounts: [BUILDER], payoutFunding: 0n });
  const owner = await browserContext(browser, stack, OWNER), builder = await browserContext(browser, stack, BUILDER);
  const steps = [];
  try {
    const rpc = await ownerRpc(await owner.context.newPage(), stack);
    const reviewed = async () => { const overview = await rpc('overview'); return { revision: overview.policy.revision, digest: overview.digest }; };
    const signed = async prepared => { const s = await sign(OWNER, prepared.intent.payload); return { ...prepared.intent, public_key: s.publicKey, signature: s.signature }; };
    const ownerStep = async action => {
      const prepared = await rpc('owner/prepare', { action, signer: 'wallet' });
      await rpc('owner/submit', { correlationId: prepared.correlationId, signedData: await signed(prepared) });
      // An approval's own status follows the payment it releases (settled later); its signature is accepted first.
      if (action.type === 'approval_vote') await expect.poll(async () => (await rpc('owner/actions')).find(a => a.correlationId === prepared.correlationId)?.ownerSucceeded).toBe(true);
      else await expect.poll(async () => (await rpc('owner/status', { correlationId: prepared.correlationId })).status).toBe('SUCCESS');
      return prepared.correlationId;
    };

    // Setup 1 (once): the owner adds the builder as an agreed confidential payee with a signed policy update.
    const payees = stack.simulated.payoutPolicy().policy.destinations.list.filter(d => d.action === 'transfer').map(({ address, confidential }) => ({ address, confidential }));
    expect(payees.map(p => p.address)).not.toContain(BUILDER);
    await ownerStep({ type: 'policy_update', expectedPolicy: await reviewed(), changes: { destinations: [...payees, { address: BUILDER, confidential: true }] } });
    expect(stack.simulated.payoutPolicy().revision).toBe(2);
    expect(stack.simulated.payoutPolicy().policy.destinations.list.map(d => d.address)).toContain(BUILDER);
    steps.push('setup: builder added to the payout policy (owner signature)');

    // The builder's agreement; each report is approved with an explicit amount and prepared on the shared payout.
    const agreementId = randomUUID(), amount = '2000000';
    await rpc('compensation/agreement', { commandId: randomUUID(), id: agreementId, expectedVersion: 0, terms: { payee: BUILDER, title: 'Builder grant',
      document: 'https://example.test/builder', signedOn: '2026-10-01', start: '2026-10-01', end: '2026-10-31', ceiling: '10000000', openingApproved: '0', scope: 'Recurring builder work' } });
    const report = await payeeApi(await builder.context.newPage(), stack);
    const version = async id => (await rpc('compensation/list')).requests.find(r => r.id === id).version;
    const payment = async id => (await rpc('compensation/list')).payments.find(p => p.requestId === id);
    const sharedReport = async (start, end) => {
      const id = randomUUID();
      expect((await report('POST', '/api/compensation', { commandId: randomUUID(), id, expectedVersion: 0, submit: true,
        report: { agreementId, start, end, contributions: 'Shipped the integration', assessment: 'Done', evidence: [] } })).status).toBe(200);
      await rpc('compensation/review', { commandId: randomUUID(), id, expectedVersion: await version(id), decision: 'approved', approvedAmount: amount, feedback: 'Approved' });
      await rpc('compensation/prepare', { type: 'prepare', command: { commandId: randomUUID(), id, expectedVersion: await version(id), mode: 'shared' } });
      expect((await payment(id)).status).toBe('PREPARED');
      return id;
    };
    const send = async id => rpc('compensation/send', { type: 'send', id, expectedPolicy: await reviewed() });

    // Before funding, a send is refused before submission and the payment stays prepared on its identity.
    const first = await sharedReport('2026-10-01', '2026-10-07');
    await expect(send(first)).rejects.toThrow(/insufficient_balance/);
    expect(stack.simulated.transfers).toHaveLength(0);
    expect((await payment(first)).status).toBe('PREPARED');

    // Setup 2 (once): the payout agent is funded (simulated deposit).
    stack.simulated.fundPayout(5_000_000n);
    steps.push('setup: payout agent funded (simulated deposit)');

    // Per report: one send, held for the owner; a repeated send returns the same record and submits nothing.
    await send(first);
    expect(stack.simulated.transfers).toHaveLength(1);
    expect((await payment(first)).status).toBe('PENDING_APPROVAL');
    await send(first);
    expect(stack.simulated.transfers, 'a repeated send never submits again').toHaveLength(1);
    const [transfer] = stack.simulated.transfers;
    expect(transfer.body).toMatchObject({ recipient: BUILDER, amount });
    steps.push('per report: one send, held for the owner');
    // The owner approves the one held payout (one signature); settlement is recorded separately.
    await ownerStep({ type: 'approval_vote', approvalId: transfer.approval, verdict: 'approve', correlationId: transfer.correlation });
    steps.push('per report: held payout approved (owner signature)');
    stack.simulated.settle(transfer.correlation);
    await expect.poll(async () => { await rpc('recover').catch(() => {}); return (await payment(first)).status; }, { timeout: 30_000 }).toBe('SUCCESS');
    expect(stack.simulated.created(), 'no order agent, grant or deposit per report').toEqual([]);
    steps.push('per report: settled');

    // A lost send response: the effect is kept, the payment stays unknown (no operation id to read), it is never
    // sent again, and the payout agent's other sends are blocked until it is reviewed (the documented fail-safe).
    const lost = await sharedReport('2026-10-08', '2026-10-14');
    stack.simulated.dropTransferResponse();
    await send(lost).catch(() => {});
    expect(stack.simulated.transfers).toHaveLength(2);
    await send(lost).catch(() => {});
    expect(stack.simulated.transfers, 'the unknown payment is never sent again').toHaveLength(2);
    expect((await payment(lost)).status).toBe('UNKNOWN');
    const next = await sharedReport('2026-10-15', '2026-10-21');
    await expect(send(next), 'an unknown outcome blocks the next send').rejects.toThrow(/executor_busy/);
    expect(stack.simulated.transfers).toHaveLength(2);
    expect((await payment(next)).status).toBe('PREPARED');
    steps.push('lost response: unknown, never resent; later sends blocked until reviewed');
  } finally {
    writeFileSync(info.outputPath('steps.json'), JSON.stringify(steps, null, 2));
    await owner.context.close(); await builder.context.close(); await stack.close();
    expect(stack.simulated.errors).toEqual([]);
  }
});
