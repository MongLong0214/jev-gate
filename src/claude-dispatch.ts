/** A correlation id, not a credential. Keep the old spelling readable for workers alive across an upgrade. */
export const dispatchMarker = (id: string): string => `\n\n[JEV_DISPATCH id=${id}]`;

const DISPATCH_MARKER = String.raw`\[JEV_DISPATCH (?:id|token)=([a-f0-9-]{36})\]`;

/** Settlement requires one identity; the Router reads only a marker at the end of the dispatch prompt. */
export const parseDispatchMarker = (text: string, atEnd = false): string | null => {
  const matches = [...text.matchAll(new RegExp(DISPATCH_MARKER + (atEnd ? '$' : ''), 'g'))];
  return matches.length === 1 ? matches[0]![1]! : null;
};
