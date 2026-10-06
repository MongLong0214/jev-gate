import type { DigestMessage } from '../../mods/compact/hooks/digest.ts';
export const dependencyFact = 'The receipt must use reservation.allocation_pair.model; only the native response confirms resolved_model.';
export const dependencyConversation = (): DigestMessage[] => {
  const messages: DigestMessage[] = [{ role: 'user', text: 'Repair incorrect routing receipts while distinguishing selected and observed models.', toolUses: [] }];
  for (let i = 0; i < 20; i++) {
    const text = i === 2 ? dependencyFact : (`Archive inventory ${i}: completed unrelated formatting. `).repeat(60);
    messages.push({ role: 'assistant', text: 'Recorded previous evidence.', toolUses: [{ tool_use_id: `call${i}`, tool: 'Bash', input: { command: `inspect archive ${i}` }, text, outcome: 'success' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `call${i}`, text }] });
  }
  messages.push({ role: 'assistant', text: 'Continue the requested repair.', toolUses: [] });
  return messages;
};
export const dependencyReply = (request: string, invalid = false) => {
  const { model, questions } = JSON.parse(request);
  const answers = Object.fromEntries(Object.keys(questions).map(id => {
    const choice = id === 'm5t0' ? 'required' : 'unrelated';
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(['required', 'related', 'unrelated', 'unclear'].map(k => [k, k === choice ? 1 : 0])) }];
  }));
  if (invalid) delete answers['m5t0'];
  return { status: 200, text: JSON.stringify({ model, answers, usage: { input_tokens: 10, output_tokens: 2 } }) };
};
