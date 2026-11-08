import type { ReactNode } from "react";

export default function Button({
  children,
  onPress,
  variant = "primary",
  size = "default",
}: {
  children: ReactNode;
  onPress: () => void;
  variant?: "primary" | "secondary" | "neutral";
  size?: "default" | "small";
}) {
  return (
    <button
      type="button"
      className={`button ${variant} ${size === "small" ? "button-small" : ""}`}
      onClick={onPress}
    >
      {children}
    </button>
  );
}
