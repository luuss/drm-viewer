import Icon from "../components/Icon";

type Props = {
  direction: "previous" | "next";
  label: string;
  disabled: boolean;
  onClick: () => void;
};

/** Sichtbarer Blaetterknopf, klein genug um Seite und Artikel nicht zu verdecken. */
export default function ReaderTurnButton({
  direction,
  label,
  disabled,
  onClick,
}: Props) {
  return (
    <button
      type="button"
      className={`reader-turn ${direction}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Icon name={direction === "previous" ? "arrow-left" : "arrow-right"} size={24} />
    </button>
  );
}
