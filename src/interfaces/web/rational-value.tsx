import {
  formatRationalForDisplay,
  type NonnegativeRational,
} from "../../core/browser.js";

export interface RationalValueProps {
  readonly value: NonnegativeRational;
  readonly prefix?: string;
  readonly suffix?: string;
}

export const RationalValue = ({
  value,
  prefix = "",
  suffix = "",
}: RationalValueProps) => {
  const display = formatRationalForDisplay(value);
  const relation = display.relation === "exact" ? "Exact" : "Approximately";
  return (
    <span
      className="human-rational"
      aria-label={`${relation} ${
        display.notation === "plain"
          ? `${prefix}${display.coefficient}`
          : `${prefix}${display.coefficient} times ten to the power ${display.exponent}`
      }${suffix}`}
    >
      {display.relation === "approximately" ? (
        <span className="approximation-mark" aria-hidden="true">≈</span>
      ) : null}
      {prefix}
      <span>{display.coefficient}</span>
      {display.notation === "scientific" ? (
        <span aria-hidden="true"> × 10<sup>{display.exponent}</sup></span>
      ) : null}
      {suffix}
    </span>
  );
};
