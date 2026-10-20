'use client';

/** Previous / next pager under a paged table. */
export function Pager({
  page, pageSize, total, onPage,
}: {
  page: number; pageSize: number; total: number; onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs text-slate-500 border-t border-slate-100">
      <span>{total === 0 ? 'No lines' : `${first}–${last} of ${total}`}</span>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          ‹ Previous
        </button>
        <span>Page {page} of {pages}</span>
        <button type="button" className="btn-secondary px-2 py-1 text-xs" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next ›
        </button>
      </div>
    </div>
  );
}
