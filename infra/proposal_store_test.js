const fs = require('fs');
const path = require('path');
const { ProposalStore } = require('../proposals');

const filePath = path.join('/tmp', 'proposal_store_test.json');
if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

const store1 = new ProposalStore({ filePath, ttlSeconds: 3 });
const proposal = store1.createProposal(
  'tasks_create',
  { title: 'Test', dueDateTime: '2026-02-18T17:00:00-05:00', contactId: 'CONTACT_ID' },
  'hash',
  'tasks_create (fields: title, dueDateTime, contactId)'
);

const store2 = new ProposalStore({ filePath, ttlSeconds: 3 });
const loaded = store2.get(proposal.proposal_id);

if (!loaded) {
  console.error('Proposal not persisted');
  process.exit(1);
}

setTimeout(() => {
  const expired = store2.get(proposal.proposal_id);
  if (expired) {
    console.error('Proposal should have expired');
    process.exit(1);
  }
  fs.unlinkSync(filePath);
  console.log('OK: persistence + expiry');
}, 3500);
