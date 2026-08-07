import { describe, expect, it } from 'vitest';
import {
  buildChineseSnapshots,
  isAcceptedCedictEntry,
  numericSyllableToMarked,
  parseCedictLine,
} from '../scripts/cccedict-import-lib.mjs';

describe('CC-CEDICT v1 import', () => {
  it('parses traditional, simplified, two pinyin syllables, senses, and glosses', () => {
    expect(parseCedictLine('學生 学生 [xue2 sheng1] /student/schoolchild; pupil/')).toEqual({
      traditional: '學生',
      simplified: '学生',
      pinyin: 'xue2 sheng1',
      syllables: ['xue2', 'sheng1'],
      senses: [['student'], ['schoolchild', 'pupil']],
    });
  });

  it('accepts ordinary two-character words and prunes names, references, and malformed entries', () => {
    expect(isAcceptedCedictEntry(parseCedictLine('學生 学生 [xue2 sheng1] /student/'))).toBe(true);
    expect(isAcceptedCedictEntry(parseCedictLine('王氏 王氏 [Wang2 shi4] /the Wang family/'))).toBe(false);
    expect(isAcceptedCedictEntry(parseCedictLine('學子 学子 [xue2 zi3] /variant of 學生|学生[xue2 sheng1]/'))).toBe(false);
    expect(isAcceptedCedictEntry(parseCedictLine('量詞 量词 [liang4 ci2] /classifier for nouns/'))).toBe(false);
    expect(isAcceptedCedictEntry(parseCedictLine('古語 古语 [gu3 yu3] /(archaic) old expression/'))).toBe(false);
    expect(isAcceptedCedictEntry(parseCedictLine('學生们 学生们 [xue2 sheng1 men5] /students/'))).toBe(false);
  });

  it('merges readings and creates dictionary, pinyin, and answer metadata deterministically', () => {
    const source = `#! date=2026-08-07T00:21:50Z\n學生 学生 [xue2 sheng1] /student/\n學生 学生 [xue2 sheng5] /schoolchild/\n学聲 学声 [xue2 sheng1] /learned voice/\n`;
    const result = buildChineseSnapshots(source, ['学生'], 'a'.repeat(64));
    expect(result.answerWords).toEqual(['学生']);
    expect(result.dictionary.entries['学生']).toMatchObject({
      traditional: ['學生'],
      answerEligible: true,
      translations: ['student', 'schoolchild'],
    });
    expect(result.dictionary.entries['学生'].pronunciations).toHaveLength(2);
    expect(result.pinyinIndex.candidates.xuesheng.map((candidate) => candidate.word)).toEqual(['学生', '学生', '学声']);
  });

  it('places pinyin marks using standard vowel precedence', () => {
    expect(numericSyllableToMarked('hao3')).toBe('hǎo');
    expect(numericSyllableToMarked('liu2')).toBe('liú');
    expect(numericSyllableToMarked('nu:3')).toBe('nǚ');
  });
});
