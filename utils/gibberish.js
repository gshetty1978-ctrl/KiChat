// Blocks keyboard-mash usernames (e.g. "djvdjvdshjdsh") while letting real
// ones through, including short names and non-Latin scripts. Returns true
// when the text looks like gibberish.
function isGibberish(raw) {
  const t = (raw || '').trim();
  if (!t) return false;

  // Non-Latin (Devanagari etc.): length-check only. The vowel and consonant
  // rules below are Latin-specific and would wrongly reject those scripts.
  if (/[^\u0000-ʯ]/.test(t)) return t.length < 2;

  const letters = t.replace(/[^a-z]/gi, '');
  if (letters.length < 2) return true;

  // Real 2-letter names can be vowel-free ("Ng"), so the letter rules only
  // apply from 3 letters up; repeat/keyboard checks still catch junk.
  if (letters.length > 2) {
    // "y" counts as a vowel so names like Cyd are not flagged
    const vowels = (letters.match(/[aeiouy]/gi) || []).length;
    const ratio = vowels / letters.length;
    if (ratio < 0.15) return true;
    if (letters.length >= 5 && ratio > 0.9) return true;
    if (/[bcdfghjklmnpqrstvwxz]{5,}/i.test(letters)) return true;
  }
  if (/(.)\1{3,}/i.test(t)) return true;
  if (/(qwer|wert|erty|asdf|sdfg|dfgh|zxcv|xcvb|hjkl|1234|abcd)/i.test(t)) return true;
  return false;
}

module.exports = { isGibberish };
