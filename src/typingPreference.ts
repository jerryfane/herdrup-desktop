import type { PredictionMode } from "./predictiveEcho";

const listeners = new Set<() => void>();
export function predictionMode(): PredictionMode {
  try {
    const value = localStorage.getItem("predictiveEcho");
    return value === "always" || value === "off" ? value : "auto";
  } catch { return "auto"; }
}
export function changePredictionMode(mode: PredictionMode) {
  localStorage.setItem("predictiveEcho", mode);
  for (const listener of listeners) listener();
}
export function onPredictionModeChanged(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
