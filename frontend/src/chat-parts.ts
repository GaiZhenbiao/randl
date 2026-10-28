// Splits an assistant turn into text and tool-call groups in the order they occurred.
// `at` is the response length when a tool started; tools saved without it come first.
export type Positioned = { id: string; at?: number };
export type ChatPart<T extends Positioned> =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'actions'; key: string; actions: T[] };

export function chatParts<T extends Positioned>(response: string, actions: T[]): ChatPart<T>[] {
  const parts: ChatPart<T>[] = [];
  const ordered = actions
    .map((action, index) => ({
      action,
      index,
      at: Math.max(0, Math.min(response.length, action.at ?? 0)),
    }))
    .sort((a, b) => a.at - b.at || a.index - b.index);
  let position = 0;
  const text = (end: number) => {
    const value = response.slice(position, end);
    if (value.trim()) parts.push({ kind: 'text', key: 'text-' + position, text: value });
    position = end;
  };
  for (const { action, at } of ordered) {
    if (at > position) text(at);
    const last = parts.at(-1);
    if (last?.kind === 'actions') last.actions.push(action);
    else parts.push({ kind: 'actions', key: 'actions-' + action.id, actions: [action] });
  }
  text(response.length);
  return parts;
}
