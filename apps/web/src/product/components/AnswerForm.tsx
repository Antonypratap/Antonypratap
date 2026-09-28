import { useState, type FormEvent } from 'react';
import type { ApiInputSpec } from '@veyra/shared';
import styles from './AnswerForm.module.css';

/**
 * The input an answer needs: a corrected value, a goods receipt, or a new item's details.
 * It only collects what the user types; the server parses and validates it (never the browser).
 */
export function AnswerForm({
  spec,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  spec: ApiInputSpec;
  submitLabel: string;
  busy: boolean;
  onSubmit: (input: unknown) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(spec.kind === 'value' ? spec.initial : '');
  const [grnDate, setGrnDate] = useState('');
  const [qty, setQty] = useState<Record<number, { received: string; accepted: string }>>({});
  const [item, setItem] = useState(
    spec.kind === 'item' ? spec.initial : { name: '', hsnSac: '', uom: '', gstRate: '' },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (spec.kind === 'value') onSubmit(value);
    else if (spec.kind === 'item') onSubmit(item);
    else
      onSubmit({
        grnDate,
        lines: spec.lines.map((l) => ({
          poLineNo: l.poLineNo,
          received: qty[l.poLineNo]?.received ?? '',
          accepted: qty[l.poLineNo]?.accepted ?? '',
        })),
      });
  };

  const numeric =
    spec.kind === 'value' && ['money', 'signedMoney', 'qty', 'rate'].includes(spec.field);

  return (
    <form className={styles.form} onSubmit={submit}>
      {spec.kind === 'value' && (
        <label className={styles.field}>
          <span>{spec.label}</span>
          <input
            autoFocus
            value={value}
            inputMode={numeric ? 'decimal' : 'text'}
            type={spec.field === 'date' ? 'date' : 'text'}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
      )}

      {spec.kind === 'grn' && (
        <>
          <label className={styles.field}>
            <span>Date the goods were received</span>
            <input
              type="date"
              required
              min={spec.minDate}
              max={spec.maxDate}
              value={grnDate}
              onChange={(e) => setGrnDate(e.target.value)}
            />
          </label>
          {spec.lines.map((l) => (
            <fieldset key={l.poLineNo} className={styles.line}>
              <legend>{l.label}</legend>
              <label className={styles.field}>
                <span>Received ({l.uom})</span>
                <input
                  inputMode="decimal"
                  required
                  value={qty[l.poLineNo]?.received ?? ''}
                  onChange={(e) =>
                    setQty((q) => ({
                      ...q,
                      [l.poLineNo]: {
                        received: e.target.value,
                        accepted: q[l.poLineNo]?.accepted ?? '',
                      },
                    }))
                  }
                />
              </label>
              <label className={styles.field}>
                <span>Accepted ({l.uom})</span>
                <input
                  inputMode="decimal"
                  required
                  value={qty[l.poLineNo]?.accepted ?? ''}
                  onChange={(e) =>
                    setQty((q) => ({
                      ...q,
                      [l.poLineNo]: {
                        received: q[l.poLineNo]?.received ?? '',
                        accepted: e.target.value,
                      },
                    }))
                  }
                />
              </label>
            </fieldset>
          ))}
          <button
            type="button"
            className={styles.link}
            onClick={() =>
              setQty(
                Object.fromEntries(
                  spec.lines.map((l) => [
                    l.poLineNo,
                    { received: l.suggestedQty, accepted: l.suggestedQty },
                  ]),
                ),
              )
            }
          >
            Fill with the invoiced quantities
          </button>
        </>
      )}

      {spec.kind === 'item' && (
        <>
          {(
            [
              ['name', 'Item name'],
              ['hsnSac', 'HSN code'],
              ['uom', 'Unit'],
              ['gstRate', 'GST rate'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className={styles.field}>
              <span>{label}</span>
              <input
                value={item[key]}
                onChange={(e) => setItem((i) => ({ ...i, [key]: e.target.value }))}
              />
            </label>
          ))}
        </>
      )}

      <div className={styles.actions}>
        <button type="submit" className={styles.submit} disabled={busy}>
          {busy ? 'Recording…' : submitLabel}
        </button>
        <button type="button" className={styles.link} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
