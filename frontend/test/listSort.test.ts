import { describe, expect, it } from 'vitest';
import { firstDir, nextSort } from '@/app/invoices/listSort';

describe('nextSort', () => {
  it('starts text columns A→Z and dates or amounts newest / largest first', () => {
    expect(firstDir('number')).toBe('asc');
    expect(firstDir('client')).toBe('asc');
    expect(firstDir('issue_date')).toBe('desc');
    expect(firstDir('total')).toBe('desc');
  });

  it('cycles a column: sort, flip, then back to the default order', () => {
    const one = nextSort({ sort: '', dir: 'desc' }, 'total');
    expect(one).toEqual({ sort: 'total', dir: 'desc' });
    const two = nextSort(one, 'total');
    expect(two).toEqual({ sort: 'total', dir: 'asc' });
    expect(nextSort(two, 'total')).toEqual({ sort: '', dir: 'desc' });

    const a = nextSort({ sort: '', dir: 'desc' }, 'client');
    expect(a).toEqual({ sort: 'client', dir: 'asc' });
    expect(nextSort(nextSort(a, 'client'), 'client').sort).toBe('');
  });

  it('starts afresh on another column', () => {
    expect(nextSort({ sort: 'total', dir: 'asc' }, 'due_date')).toEqual({ sort: 'due_date', dir: 'desc' });
  });
});
