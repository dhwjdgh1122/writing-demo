type Name = 'pen' | 'arrow' | 'document' | 'select' | 'check' | 'info' | 'close';
const paths: Record<Name, string> = {
  pen: 'm15 4 5 5M4 20l5-1L20 8a2.1 2.1 0 0 0-5-5L4 14v6Z',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  document: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8M8 17h5',
  select: 'M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M8 8h8v8H8Z',
  check: 'm5 12 4 4L19 6',
  info: 'M12 8h.01M12 11v6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  close: 'm6 6 12 12M6 18 18 6',
};
export function Icon({ name, size = 20 }: { name: Name; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
