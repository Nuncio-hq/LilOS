export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 font-medium text-xs">{label}</div>
      {children}
    </div>
  );
}
