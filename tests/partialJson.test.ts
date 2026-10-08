import { describe, expect, it } from 'vitest';
import { extractPartialStringField } from '../src/server/core/orchestration/partialJson.js';

describe('extractPartialStringField', () => {
  it('returns null before the field starts', () => {
    expect(extractPartialStringField('{"repl', 'reply')).toBeNull();
    expect(extractPartialStringField('{"other": 1, "x', 'reply')).toBeNull();
  });

  it('extracts a complete simple value', () => {
    expect(extractPartialStringField('{"reply": "hello"}', 'reply')).toBe('hello');
  });

  it('extracts progressively as the buffer grows', () => {
    const chunks = ['{"reply": "gro', '{"reply": "greenhouse', '{"reply": "greenhouse idea"'];
    expect(extractPartialStringField(chunks[0]!, 'reply')).toBe('gro');
    expect(extractPartialStringField(chunks[1]!, 'reply')).toBe('greenhouse');
    expect(extractPartialStringField(chunks[2]!, 'reply')).toBe('greenhouse idea');
  });

  it('decodes escape sequences', () => {
    expect(extractPartialStringField('{"reply": "line1\\nline2"}', 'reply')).toBe('line1\nline2');
    expect(extractPartialStringField('{"reply": "quote \\" and backslash \\\\"}', 'reply')).toBe(
      'quote " and backslash \\',
    );
    expect(extractPartialStringField('{"reply": "cup \\u2728"}', 'reply')).toBe('cup ✨');
  });

  it('handles escapes cut off mid-stream', () => {
    expect(extractPartialStringField('{"reply": "abc\\', 'reply')).toBe('abc'); // escape itself cut off
    expect(extractPartialStringField('{"reply": "abc\\n', 'reply')).toBe('abc\n'); // complete \\n escape decoded
    expect(extractPartialStringField('{"reply": "abc\\u27', 'reply')).toBe('abc'); // unicode escape cut off
  });

  it('ignores the field name appearing inside another string', () => {
    const buf = '{"note": "the word \\"reply:\\" appears here", "reply": "actual"}';
    expect(extractPartialStringField(buf, 'reply')).toBe('actual');
  });

  it('works when reply is not the first field', () => {
    const buf = '{"proposal": {"title": "x"}, "reply": "done"}';
    expect(extractPartialStringField(buf, 'reply')).toBe('done');
  });

  it('does not match a key in a nested position incorrectly', () => {
    // A key must be preceded by { or , — not part of a longer key name.
    expect(extractPartialStringField('{"my_reply": "x", "reply": "y"}', 'reply')).toBe('y');
  });
});
