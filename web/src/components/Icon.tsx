export type IconName =
  | "arrow-left"
  | "arrow-right"
  | "book-open"
  | "close"
  | "edit"
  | "kiosk"
  | "library"
  | "list"
  | "login"
  | "logout"
  | "pages"
  | "search"
  | "spread"
  | "user";

type Props = {
  name: IconName;
  className?: string;
  size?: number;
};

/**
 * Eine kleine, gemeinsame Icon-Sprache fuer die Anwendung. Alle Zeichen
 * verwenden dieselbe Strichstaerke und erben ihre Farbe vom Bedienelement.
 */
export default function Icon({ name, className = "", size = 18 }: Props) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      {...common}
    >
      {name === "arrow-left" && (
        <><path d="M19 12H5" /><path d="m11 18-6-6 6-6" /></>
      )}
      {name === "arrow-right" && (
        <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>
      )}
      {name === "book-open" && (
        <><path d="M3.5 5.5A7 7 0 0 1 12 7v12a7 7 0 0 0-8.5-1.5z" /><path d="M20.5 5.5A7 7 0 0 0 12 7v12a7 7 0 0 1 8.5-1.5z" /></>
      )}
      {name === "close" && (
        <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>
      )}
      {name === "edit" && (
        <><path d="M4 20h4l11-11-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>
      )}
      {name === "kiosk" && (
        <><path d="M4 10v10h16V10" /><path d="M3 4h18l-1 6a3 3 0 0 1-4 0 3 3 0 0 1-4 0 3 3 0 0 1-4 0 3 3 0 0 1-4 0z" /><path d="M9 20v-5h6v5" /></>
      )}
      {name === "library" && (
        <><rect x="4" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="16" rx="1" /><path d="m16 5 3-1 3 15-3 1z" /></>
      )}
      {name === "list" && (
        <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>
      )}
      {name === "login" && (
        <><path d="M14 4h5v16h-5" /><path d="M3 12h12" /><path d="m10 7 5 5-5 5" /></>
      )}
      {name === "logout" && (
        <><path d="M10 4H5v16h5" /><path d="M21 12H9" /><path d="m16 7 5 5-5 5" /></>
      )}
      {name === "pages" && (
        <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M9 7h6M9 11h6M9 15h4" /></>
      )}
      {name === "search" && (
        <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>
      )}
      {name === "spread" && (
        <><path d="M12 5.5A6.5 6.5 0 0 0 4 4v15a6.5 6.5 0 0 1 8 1.5z" /><path d="M12 5.5A6.5 6.5 0 0 1 20 4v15a6.5 6.5 0 0 0-8 1.5z" /></>
      )}
      {name === "user" && (
        <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>
      )}
    </svg>
  );
}
