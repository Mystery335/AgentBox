export default function StatusBadge({ text }: { text: string }) {
  return (
    <span className={`ws-badge ws-${text.toLowerCase().replaceAll(" ", "-")}`}>
      {text}
    </span>
  );
}
