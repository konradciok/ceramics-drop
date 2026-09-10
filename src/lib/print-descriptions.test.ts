import { describe, expect, it } from 'vitest';
import pl from '../../messages/pl.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import de from '../../messages/de.json';
import { PRINT_DESIGNS_RAW } from './prints';

const messagesByLocale = { pl, en, es, de } as const;
const placeholderPattern =
  /placeholder|copy pending|opis do uzupełnienia|marcador de posición|texto pendiente|platzhalter|text ausstehend/i;

describe('fine-art print descriptions', () => {
  it.each(Object.entries(messagesByLocale))(
    'provides market-ready %s fallback copy for every stable source print',
    (_locale, messages) => {
      const designs = PRINT_DESIGNS_RAW;
      const notes = messages.notes['fine-art-prints'];

      expect(notes).toHaveLength(designs.length);
      const seen = new Set<string>();
      for (const design of designs) {
        const note = notes[design.noteIndex];
        expect(note, design.id).toBeTypeOf('string');
        expect(note.trim(), design.id).not.toBe('');
        expect(note, design.id).not.toMatch(placeholderPattern);
        // Catches an accidental note reused across two designs (e.g. a
        // shuffled noteIndex), without requiring the id embedded in the copy.
        expect(seen.has(note), design.id).toBe(false);
        seen.add(note);
      }
    },
  );
});
