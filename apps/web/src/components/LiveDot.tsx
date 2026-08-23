type Props = { readonly label?: string; readonly tone?: 'accent' | 'warn' };

export function LiveDot({ label = 'AO VIVO', tone = 'accent' }: Props) {
  const color = tone === 'warn' ? 'bg-warn' : 'bg-accent';
  const text = tone === 'warn' ? 'text-warn' : 'text-accent';

  return (
    <span className={`inline-flex items-center gap-2 text-[12px] font-semibold tracking-[0.08em] ${text}`}>
      <span className={`h-2 w-2 rounded-full ${color} animate-live`} aria-hidden="true" />
      {label}
    </span>
  );
}
