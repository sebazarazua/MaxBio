// GS1 mod-10 check digit shared by legacy GTIN identifiers and GS1 AI 01. Callers validate digits/length.
export function hasValidGtinCheckDigit(digits: string) {
  let sum = 0;
  for (
    let index = digits.length - 2, weight = 3;
    index >= 0;
    index--, weight = weight === 3 ? 1 : 3
  )
    sum += Number(digits[index]) * weight;
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

// GTIN-8/12/13 and GTIN-14 share one key: left zero padding to 14 digits.
export const canonicalGtin = (digits: string) => digits.padStart(14, '0');
