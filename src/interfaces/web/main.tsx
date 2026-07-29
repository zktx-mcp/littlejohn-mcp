import {
  StrictMode,
  useEffect,
  useState,
  type MouseEvent,
} from "react";
import { createRoot } from "react-dom/client";

import {
  browserBaseLocationForPath,
  browserLocationHref,
  browserPageMetadata,
  parseBrowserLocation,
  type BrowserLocation,
} from "../browser-contract.js";
import { App } from "./app.js";
import { createLightweightChartsAdapter } from "./lightweight-charts-adapter.js";
import "./styles.css";

interface ParsedBrowserLocation {
  readonly status: "valid";
  readonly location: BrowserLocation;
}

interface InvalidBrowserLocation {
  readonly status: "invalid";
  readonly baseLocation: BrowserLocation;
}

type BrowserLocationState = ParsedBrowserLocation | InvalidBrowserLocation;

const currentBrowserLocation = (): BrowserLocationState => {
  try {
    return Object.freeze({
      status: "valid",
      location: parseBrowserLocation(
        window.location.pathname,
        window.location.search,
        window.location.hash,
      ),
    });
  } catch {
    return Object.freeze({
      status: "invalid",
      baseLocation: browserBaseLocationForPath(window.location.pathname),
    });
  }
};

const initialLocation = currentBrowserLocation();
document.title = initialLocation.status === "valid"
  ? browserPageMetadata(initialLocation.location).title
  : "Unavailable — Little John";
const referenceChart = createLightweightChartsAdapter();

const root = document.getElementById("root");
if (root === null) throw new Error("Browser application root is unavailable.");

const BrowserApplication = () => {
  const [locationState, setLocationState] =
    useState<BrowserLocationState>(initialLocation);
  const [navigationFocusVisible, setNavigationFocusVisible] = useState(false);

  useEffect(() => {
    const handlePopState = (): void => {
      const nextLocation = currentBrowserLocation();
      setNavigationFocusVisible(false);
      document.title = nextLocation.status === "valid"
        ? browserPageMetadata(nextLocation.location).title
        : "Unavailable — Little John";
      setLocationState(nextLocation);
    };
    window.addEventListener("popstate", handlePopState);
    return () => { window.removeEventListener("popstate", handlePopState); };
  }, []);

  const navigate = (
    nextLocation: BrowserLocation,
    event: MouseEvent<HTMLAnchorElement>,
  ): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) return;
    event.preventDefault();
    const href = browserLocationHref(nextLocation);
    const currentHref = `${window.location.pathname}${window.location.search}`;
    if (href === currentHref && window.location.hash === "") return;
    setNavigationFocusVisible(event.detail === 0);
    window.history.pushState(null, "", href);
    document.title = browserPageMetadata(nextLocation).title;
    setLocationState(Object.freeze({ status: "valid", location: nextLocation }));
  };

  return (
    <App
      referenceChart={referenceChart}
      locationState={locationState}
      navigationFocusVisible={navigationFocusVisible}
      onNavigate={navigate}
    />
  );
};

createRoot(root).render(
  <StrictMode>
    <BrowserApplication />
  </StrictMode>,
);
