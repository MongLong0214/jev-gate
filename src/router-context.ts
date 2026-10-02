import { looksSecret } from './router-secret.ts';

/** Same input contract for every root adapter; screen whole previous turns before taking their tail. */
export const routingContext = (text: string, previousReply?: string, recentRequests: readonly string[] = []) => ({
  task: {
    text, source: 'current_human_request', truncated: false,
    ...(previousReply?.trim() && !looksSecret(previousReply) ? { previous_reply: previousReply.slice(-2000), previous_reply_source: 'completed_visible_assistant_reply', previous_reply_truncated: previousReply.length > 2000 } : {}),
    recent_requests: recentRequests.filter(t => t.trim() && !looksSecret(t)).slice(-3).map(t => ({ text: t.slice(-2000), source: 'recent_human_request', truncated: t.length > 2000 })),
  },
});
