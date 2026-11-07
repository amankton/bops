import { MacPip } from "@/components/app/mac-pip";
import { WINDOWS } from "@/lib/platform";

/** The popped-out Mac previews: a small window of its own that floats over every app (desktop/main.cjs). */
export default function Pip() {
  return WINDOWS ? <p className="p-4">Open Your PC in Bops to view a display or window.</p> : <MacPip />;
}
