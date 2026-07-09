'use client';

/* Generic stacked admin table. Owns only the <table> chrome (headers, per-cell
   data-label for the mobile stacked view, and the empty state); filtering,
   sorting and search stay in the caller. Columns are configured with a render
   fn so callers keep full control of cell content. */
import type { ReactNode } from 'react';

/** Column definition for {@link DataTable}: a header plus a per-row render fn. */
export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** data-label for the stacked mobile view; defaults to `header`. */
  label?: string;
}

/** Generic stacked admin table; caller supplies columns, rows and a row key. */
export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  empty = 'Brak danych.',
}: {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  empty?: ReactNode;
}) {
  return (
    <div className="adm-tablewrap">
      <table className="adm-table adm-table--stack">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.label ?? c.header}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="adm-empty">
                {empty}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
