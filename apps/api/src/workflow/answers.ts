import { z } from 'zod';
import { parseUserInput, type JsonValue } from '../engine/fields';
import type { InputSpec } from '../engine/types';

/**
 * Answer inputs come from the browser and are untrusted. Each is parsed against the input the
 * question itself asked for; the canonical value (paise, milli-units, basis points) is what gets
 * stored. Anything else is refused with a message the user can act on.
 */
export type ParsedInput = { ok: true; value: JsonValue } | { ok: false; message: string };

const GrnBody = z.object({
  grnDate: z.string(),
  lines: z
    .array(z.object({ poLineNo: z.int().positive(), received: z.string(), accepted: z.string() }))
    .min(1),
});

const ItemBody = z.object({
  name: z.string(),
  hsnSac: z.string(),
  uom: z.string(),
  gstRate: z.string(),
});

export function parseAnswerInput(spec: InputSpec | null, raw: unknown): ParsedInput {
  if (spec === null) {
    return raw === null || raw === undefined
      ? { ok: true, value: null }
      : { ok: false, message: 'This option takes no input.' };
  }
  switch (spec.kind) {
    case 'value': {
      if (typeof raw !== 'string') return { ok: false, message: 'Enter a value.' };
      const r = parseUserInput(spec.field, raw);
      return r.ok ? { ok: true, value: r.value } : r;
    }
    case 'grn': {
      const body = GrnBody.safeParse(raw);
      if (!body.success) return { ok: false, message: 'Enter the receipt date and quantities.' };
      const date = parseUserInput('date', body.data.grnDate);
      if (!date.ok) return date;
      const grnDate = String(date.value);
      if (grnDate < spec.minDate || grnDate > spec.maxDate)
        return { ok: false, message: 'The receipt date must be between the order date and today.' };
      const expected = spec.lines.map((l) => l.poLineNo).sort((a, b) => a - b);
      const given = body.data.lines.map((l) => l.poLineNo).sort((a, b) => a - b);
      if (JSON.stringify(expected) !== JSON.stringify(given))
        return { ok: false, message: 'Enter quantities for every line of the order.' };
      const lines: { poLineNo: number; receivedQtyMilli: number; acceptedQtyMilli: number }[] = [];
      for (const l of body.data.lines) {
        const received = parseUserInput('qty', l.received);
        const accepted = parseUserInput('qty', l.accepted);
        if (!received.ok) return received;
        if (!accepted.ok) return accepted;
        if (Number(accepted.value) > Number(received.value))
          return { ok: false, message: 'Accepted cannot be more than received.' };
        lines.push({
          poLineNo: l.poLineNo,
          receivedQtyMilli: Number(received.value),
          acceptedQtyMilli: Number(accepted.value),
        });
      }
      if (!lines.some((l) => l.receivedQtyMilli > 0))
        return { ok: false, message: 'Enter the quantity received.' };
      return { ok: true, value: { grnDate, lines } };
    }
    case 'item': {
      const body = ItemBody.safeParse(raw);
      if (!body.success) return { ok: false, message: 'Enter the item details.' };
      const name = parseUserInput('text', body.data.name);
      const hsn = parseUserInput('hsn', body.data.hsnSac);
      const uom = parseUserInput('uom', body.data.uom);
      const rate = parseUserInput('rate', body.data.gstRate);
      for (const r of [name, hsn, uom, rate]) if (!r.ok) return r;
      return {
        ok: true,
        value: {
          name: String(name.ok && name.value),
          hsnSac: String(hsn.ok && hsn.value),
          uom: String(uom.ok && uom.value),
          gstRateBp: Number(rate.ok && rate.value),
        },
      };
    }
  }
}
