/**
 * CCITT Group 4 (ITU-T T.6) encoder for the synthetic office-scan fixture (`npm run
 * fixtures:documents`). Office scanners (e.g. Epson Scan 2 in 1-bit "text" mode) store each page
 * as one 1-bit CCITT G4 image inside a PDF; the fixture reproduces that format exactly, with made-up
 * content. Test tooling only: nothing in the product encodes CCITT.
 *
 * Input: one byte per pixel, 1 = black. Output: the T.6 bit stream ending with EOFB, for a PDF
 * image with `/Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns w /Rows h >>`.
 */

// Modified Huffman run-length codes (T.4 tables 2 and 3): [run length, code bits].
// prettier-ignore
const WHITE_TERM = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111', '10011', '10100', '00111',
  '01000', '001000', '000011', '110100', '110101', '101010', '101011', '0100111', '0001100',
  '0001000', '0010111', '0000011', '0000100', '0101000', '0101011', '0010011', '0100100',
  '0011000', '00000010', '00000011', '00011010', '00011011', '00010010', '00010011', '00010100',
  '00010101', '00010110', '00010111', '00101000', '00101001', '00101010', '00101011', '00101100',
  '00101101', '00000100', '00000101', '00001010', '00001011', '01010010', '01010011', '01010100',
  '01010101', '00100100', '00100101', '01011000', '01011001', '01011010', '01011011', '01001010',
  '01001011', '00110010', '00110011', '00110100',
];
// prettier-ignore
const BLACK_TERM = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011', '000101', '000100', '0000100',
  '0000101', '0000111', '00000100', '00000111', '000011000', '0000010111', '0000011000',
  '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101',
  '000001101000', '000001101001', '000001101010', '000001101011', '000011010010', '000011010011',
  '000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101',
  '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111',
  '000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011',
  '000000101100', '000001011010', '000001100110', '000001100111',
];
// Make-up codes for 64, 128, … 1728.
// prettier-ignore
const WHITE_MAKEUP = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101',
  '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100',
  '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011',
  '010011000', '010011001', '010011010', '011000', '010011011',
];
// prettier-ignore
const BLACK_MAKEUP = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100',
  '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011',
  '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100',
  '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011',
  '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100',
  '0000001100101',
];
// Extended make-up codes for 1792, 1856, … 2560 (both colours).
// prettier-ignore
const EXT_MAKEUP = [
  '00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100',
  '000000010101', '000000010110', '000000010111', '000000011100', '000000011101', '000000011110',
  '000000011111',
];
const VERTICAL: Record<number, string> = {
  0: '1',
  1: '011',
  2: '000011',
  3: '0000011',
  [-1]: '010',
  [-2]: '000010',
  [-3]: '0000010',
};

class BitWriter {
  readonly #bytes: number[] = [];
  #cur = 0;
  #n = 0;
  put(bits: string): void {
    for (const b of bits) {
      this.#cur = (this.#cur << 1) | (b === '1' ? 1 : 0);
      if (++this.#n === 8) {
        this.#bytes.push(this.#cur);
        this.#cur = 0;
        this.#n = 0;
      }
    }
  }
  done(): Uint8Array {
    if (this.#n) this.#bytes.push(this.#cur << (8 - this.#n));
    return Uint8Array.from(this.#bytes);
  }
}

function putRun(w: BitWriter, run: number, black: boolean): void {
  const term = black ? BLACK_TERM : WHITE_TERM;
  const makeup = black ? BLACK_MAKEUP : WHITE_MAKEUP;
  while (run > 2560) {
    w.put(EXT_MAKEUP[12] as string);
    run -= 2560;
  }
  if (run >= 1792) {
    w.put(EXT_MAKEUP[Math.floor(run / 64) - 28] as string);
    run %= 64;
  } else if (run >= 64) {
    w.put(makeup[Math.floor(run / 64) - 1] as string);
    run %= 64;
  }
  w.put(term[run] as string);
}

/** Position of the first changing element after `from` whose colour is `black` (or `width`). */
function nextChange(line: Uint8Array, width: number, from: number, black: boolean): number {
  for (let i = Math.max(from, 0); i < width; i++) {
    const prev = i === 0 ? 0 : (line[i - 1] ?? 0);
    const cur = line[i] ?? 0;
    if (cur !== prev && (cur === 1) === black && i > from) return i;
  }
  return width;
}

export function encodeCcittG4(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const w = new BitWriter();
  let ref = new Uint8Array(width); // the imaginary white line above the page
  for (let y = 0; y < height; y++) {
    const line = pixels.subarray(y * width, (y + 1) * width);
    let a0 = -1;
    let black = false; // colour of a0
    while (a0 < width) {
      const a1 = nextChange(line, width, a0, !black);
      const b1 = nextChange(ref, width, a0, !black);
      const b2 = nextChange(ref, width, b1, black);
      if (b2 < a1) {
        w.put('0001'); // pass
        a0 = b2;
      } else if (Math.abs(a1 - b1) <= 3) {
        w.put(VERTICAL[a1 - b1] as string);
        a0 = a1;
        black = !black;
      } else {
        const a2 = nextChange(line, width, a1, black);
        w.put('001');
        putRun(w, a1 - Math.max(a0, 0), black);
        putRun(w, a2 - a1, !black);
        a0 = a2;
      }
    }
    ref = Uint8Array.from(line);
  }
  w.put('000000000001000000000001'); // EOFB
  return w.done();
}
