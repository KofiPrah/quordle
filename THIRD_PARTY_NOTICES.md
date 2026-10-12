# Third-Party Notices

## English vocabulary expansion

`engine/src/guessWords.txt` preserves the existing guess vocabulary and adds
five-letter lowercase entries from **dwyl/english-words**, `words_alpha.txt`.

- Source: https://github.com/dwyl/english-words
- License: Unlicense (public domain), https://github.com/dwyl/english-words/blob/master/LICENSE.md
- Retrieved: 2026-10-11
- Source file SHA-256: `3ed0c94610d8bcf7c11bbb49c56aa49c7234d32b66824df91f554169e572da48`

`engine/src/answerWords.additional.txt` contains 896 manually filtered entries
from **Allison Parrish's wordfreq-en-25000** export, intersected with that
dictionary. Names, brands, misspellings, and explicit terms were excluded from
the new answer candidates. Existing answers are retained unchanged.

- Source: https://github.com/aparrish/wordfreq-en-25000
- Upstream frequency data: https://github.com/rspeer/wordfreq
- License: Creative Commons Attribution-ShareAlike 4.0 International
- License text: https://creativecommons.org/licenses/by-sa/4.0/
- Retrieved: 2026-10-11
- Source `wordfreq-en-25000-log.json` SHA-256: `51cc5521d1ff8cf4353f72199fd4d3ce3cbff9ca9e61858414b94314c9df35a6`

The additional-answer file is distributed under CC BY-SA 4.0. English practice
uses the expanded pool immediately; daily puzzles dated before 2026-10-12 keep
the original 1,838-entry pool to preserve their answers.

## Korean dictionary text

The generated Korean dictionary snapshot in `engine/src/koDictionary.generated.json`
contains text derived from the **National Institute of Korean Language Korean
Basic Dictionary**.

- Source: https://krdict.korean.go.kr/eng
- Copyright holder: National Institute of Korean Language
- License: Creative Commons Attribution-ShareAlike 2.0 Korea
- License text: https://creativecommons.org/licenses/by-sa/2.0/kr/
- Source snapshot date: 2026-07-19

The generated dictionary snapshot is distributed under the same license. No
KRDICT audio, images, video, or other multimedia files are included.

## Chinese dictionary text

The generated Chinese lexicon, pinyin candidate index, and dictionary shards in
`engine/src/zh*.generated.*`, `engine/src/zhDictionaryShards/`, and
`engine/src/zhPinyinShards/` contain derivative data from **CC-CEDICT**.

- Source: https://www.mdbg.net/chinese/dictionary?page=cc-cedict
- Project: https://cc-cedict.org/
- License: Creative Commons Attribution-ShareAlike 4.0 International
- License text: https://creativecommons.org/licenses/by-sa/4.0/
- Source release timestamp: 2026-08-07T00:21:50Z
- Source archive SHA-256: `f85dd3de95c7e2ec1542e8d600d6d332cf78f8889c00b01fc598bbdb22e166b5`

The generated derivative data is distributed under the same license. It keeps
only filtered two-character Simplified Chinese entries, pronunciation metadata,
and English glosses used by the game; it includes no CC-CEDICT source archive.
