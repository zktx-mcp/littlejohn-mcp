import {
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

export type IconName =
  | "refresh"
  | "plus"
  | "more"
  | "trash"
  | "chevron-left"
  | "chevron-right";

const glyphProps = Object.freeze({
  size: 18,
  strokeWidth: 1.75,
  "aria-hidden": true,
  focusable: false,
});

export const Icon = ({ name }: { readonly name: IconName }) => {
  switch (name) {
    case "refresh": return <RefreshCw {...glyphProps} />;
    case "plus": return <Plus {...glyphProps} />;
    case "more": return <EllipsisVertical {...glyphProps} />;
    case "trash": return <Trash2 {...glyphProps} />;
    case "chevron-left": return <ChevronLeft {...glyphProps} />;
    case "chevron-right": return <ChevronRight {...glyphProps} />;
  }
};
