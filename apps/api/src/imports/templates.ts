import { writeXlsx, type OutCell, type OutSheet } from '../spreadsheet/xlsx';
import { EXAMPLE_PREFIX, TEMPLATE_FILES, tableSpec, type TableKey } from './spec';

const IMPORT_ORDER =
  'Vendors → Items → Purchase orders with their lines → Goods receipts with their lines.';

function instructions(tables: readonly TableKey[], title: string): OutSheet {
  const rows: OutCell[][] = [
    [{ text: `Veyra business records: ${title}`, bold: true }],
    [
      {
        text: 'Fill in one row per record on the sheet(s) of this workbook, then upload the file in Veyra under ERP → Import and export.',
        wrap: true,
      },
    ],
    [
      {
        text: `Rows whose first column starts with ${EXAMPLE_PREFIX} are examples: they are never imported. Delete them or leave them.`,
        wrap: true,
      },
    ],
    [
      {
        text: 'Veyra checks the whole upload before anything is imported. If any row has a problem, nothing is imported: fix the rows it lists and upload again.',
        wrap: true,
      },
    ],
    [
      {
        text: 'Records that already exist with the same details are skipped. Veyra never changes an existing record.',
        wrap: true,
      },
    ],
    [
      {
        text: `Order: ${IMPORT_ORDER} Lines must be uploaded together with their order or receipt (same workbook or same upload).`,
        wrap: true,
      },
    ],
    [null],
  ];
  for (const key of tables) {
    const t = tableSpec(key);
    rows.push([{ text: `Sheet “${t.sheet}”`, bold: true }]);
    rows.push([
      { text: 'Column', bold: true },
      { text: 'Required', bold: true },
      { text: 'What to enter', bold: true },
      { text: 'Example', bold: true },
    ]);
    for (const c of t.columns)
      rows.push([
        c.name,
        c.required ? 'Required' : 'Optional',
        { text: c.description, wrap: true },
        c.example,
      ]);
    rows.push([null]);
  }
  return { name: 'How to fill in', widths: [26, 11, 70, 36], rows, header: false };
}

/** A data sheet: the column names, then the given rows. */
export function dataSheet(key: TableKey, rows: readonly OutCell[][]): OutSheet {
  const t = tableSpec(key);
  return {
    name: t.sheet,
    widths: t.columns.map((c) => c.width),
    rows: [t.columns.map((c) => c.name), ...rows],
    header: true,
  };
}

export function templateWorkbook(file: string): Buffer | null {
  const spec = TEMPLATE_FILES[file];
  if (!spec) return null;
  return writeXlsx([
    instructions(spec.tables, spec.title),
    ...spec.tables.map((key) => dataSheet(key, [tableSpec(key).columns.map((c) => c.example)])),
  ]);
}

export const templateFiles = (): { file: string; title: string }[] =>
  Object.entries(TEMPLATE_FILES).map(([file, s]) => ({ file, title: s.title }));
