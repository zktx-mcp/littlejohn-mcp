import {
  ChevronDown,
  ChevronRight,
  Copy,
  EllipsisVertical,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Wallet,
  X,
} from "lucide-react";

export type IconName =
  | "refresh"
  | "copy"
  | "plus"
  | "search"
  | "more"
  | "close"
  | "wallet-disconnect"
  | "wallet-disconnected"
  | "chevron-down"
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
    case "copy": return <Copy {...glyphProps} />;
    case "plus": return <Plus {...glyphProps} />;
    case "search": return <Search {...glyphProps} />;
    case "more": return <EllipsisVertical {...glyphProps} />;
    case "close": return <X {...glyphProps} />;
    case "wallet-disconnect": return <LogOut {...glyphProps} />;
    case "wallet-disconnected": return <Wallet {...glyphProps} />;
    case "chevron-down": return <ChevronDown {...glyphProps} />;
    case "chevron-right": return <ChevronRight {...glyphProps} />;
  }
};
