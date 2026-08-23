type Props = { readonly onHome: () => void };

export function NotFound({ onHome }: Props) {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="text-[17px]">página não encontrada</p>
      <button
        type="button"
        onClick={onHome}
        className="text-[13px] text-muted transition-colors duration-150 hover:text-text"
      >
        ir para o início
      </button>
    </main>
  );
}
