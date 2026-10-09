export function formatMac(value) {
  return (
    String(value)
      .replace(/[^0-9a-f]/gi, '')
      .slice(0, 12)
      .toUpperCase()
      .match(/.{1,2}/g)
      ?.join(':') || ''
  );
}

export function bindMacInput(input) {
  if (!input) return;
  // Remove the adjacent byte on separator deletion, so Backspace/Delete keep working.
  input.addEventListener('beforeinput', (event) => {
    const start = input.selectionStart,
      end = input.selectionEnd;
    if (start !== end) return;
    if (event.inputType === 'deleteContentBackward' && input.value[start - 1] === ':')
      input.setSelectionRange(start - 2, start);
    if (event.inputType === 'deleteContentForward' && input.value[start] === ':')
      input.setSelectionRange(start, start + 2);
  });
  input.addEventListener('input', (event) => {
    if (event.isComposing) return;
    const position = input.selectionStart ?? input.value.length;
    const digits = input.value.slice(0, position).replace(/[^0-9a-f]/gi, '').length;
    const value = formatMac(input.value);
    const caret = Math.min(value.length, digits + Math.max(0, Math.floor((digits - 1) / 2)));
    input.value = value;
    input.setSelectionRange(caret, caret);
  });
}
